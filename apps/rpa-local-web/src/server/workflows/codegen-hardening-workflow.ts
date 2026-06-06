import { readFile } from 'node:fs/promises';
import type {
  ArtifactsResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateWorkspaceRequest,
  PublicWorkspace,
  UploadWorkspaceFileResponse,
} from '../../shared/daemon-types.js';
import type {
  CodegenQuestionAnswers,
  SubmitCodegenQuestionAnswersRequest,
} from '../../shared/codegen-types.js';
import type { CodegenSessionStore } from '../codegen/codegen-session-store.js';
import { parseQuestionFormFromTranscript } from './question-form-parser.js';
import { consumeDaemonRun as consumeDaemonRunEvents } from './daemon-run-consumer.js';
import { persistRequiredGenerationArtifacts } from './generation-artifact-service.js';

export interface CodegenHardeningDaemonClient {
  createWorkspace(request: CreateWorkspaceRequest): Promise<PublicWorkspace>;
  uploadWorkspaceFile(input: {
    workspaceId: string;
    file: File | Blob;
    targetPath: string;
    fileName?: string;
  }): Promise<UploadWorkspaceFileResponse>;
  createRun(request: CreateRunRequest): Promise<CreateRunResponse>;
  cancelRun(runId: string): Promise<{ ok: true }>;
  listRunArtifacts(runId: string): Promise<ArtifactsResponse>;
  downloadArtifact(input: { runId: string; artifactId: string }): Promise<Response>;
  subscribeRunEvents(runId: string, after?: string): AsyncGenerator<{ id: string; event: unknown }>;
}

export interface CodegenHardeningWorkflowOptions {
  daemonClient: CodegenHardeningDaemonClient;
  defaultProfileId: string;
  storageRoot: string;
  store: CodegenSessionStore;
}

export interface CodegenHardeningWorkflow {
  startHardening(sessionId: string): Promise<void>;
  submitQuestionAnswers(sessionId: string, request: SubmitCodegenQuestionAnswersRequest): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

const initialPrompt = 'Harden the recorded Playwright codegen script at input/flow.py into the required RPA MVP artifacts.';
const followUpPrompt = "Continue hardening the RPA flow after the user's question-form answers.";

export function createCodegenHardeningWorkflow(options: CodegenHardeningWorkflowOptions): CodegenHardeningWorkflow {
  const { daemonClient, defaultProfileId, store } = options;

  async function startHardening(sessionId: string): Promise<void> {
    const session = await store.getSession(sessionId);
    await store.transition(sessionId, 'hardening');
    await store.appendLog(sessionId, 'Creating daemon workspace for codegen hardening.');

    const workspace = await daemonClient.createWorkspace({
      profileId: defaultProfileId,
      workspace: {
        originId: 'rpa-local-web',
        userId: 'local-user',
        projectId: `codegen_${session.flowId}_${session.sessionId}`,
      },
      metadata: {
        codegenSessionId: session.sessionId,
        flowId: session.flowId,
        source: 'playwright-codegen',
      },
    });

    await uploadRecordedScript({
      daemonClient,
      scriptPath: session.recording.absoluteInputPath,
      workspaceId: workspace.workspaceId,
    });

    const run = await daemonClient.createRun({
      profileId: defaultProfileId,
      workspaceId: workspace.workspaceId,
      kind: 'generate',
      promptMode: 'business-context',
      currentPrompt: initialPrompt,
      skillId: 'playwright-rpa-harden',
      collectionMode: 'diagnostic',
      eventVisibility: 'normal',
      businessContext: {
        stage: 'codegen-hardening',
        codegenSessionId: session.sessionId,
        flowId: session.flowId,
        targetUrl: session.targetUrl,
        inputFiles: ['input/flow.py'],
        recording: {
          source: 'playwright-codegen',
          scriptPath: 'input/flow.py',
        },
      },
      metadata: {
        app: 'rpa-local-web',
        workflow: 'codegen-hardening',
        codegenSessionId: session.sessionId,
        flowId: session.flowId,
      },
    });

    await store.setDaemonRun(sessionId, {
      workspaceId: workspace.workspaceId,
      daemonRunId: run.runId,
      conversationId: run.conversationId,
    });
    await consumeDaemonRun(sessionId, run.runId);
  }

  async function submitQuestionAnswers(
    sessionId: string,
    request: SubmitCodegenQuestionAnswersRequest,
  ): Promise<void> {
    const session = await store.getSession(sessionId);
    if (session.status !== 'needs_input' || !session.questionForm) {
      throw new Error('Codegen session is not waiting for question-form answers.');
    }
    if (session.questionForm.formId !== request.formId) {
      throw new Error('Question form id does not match the current codegen session.');
    }
    if (!session.workspaceId || !session.daemonRunId) {
      throw new Error('Codegen session is missing daemon run metadata.');
    }

    await store.transition(sessionId, 'hardening');
    await store.setQuestionForm(sessionId, null);

    const run = await daemonClient.createRun({
      profileId: defaultProfileId,
      workspaceId: session.workspaceId,
      conversationId: session.conversationId,
      kind: 'revise',
      promptMode: 'business-context',
      currentPrompt: followUpPrompt,
      skillId: 'playwright-rpa-harden',
      collectionMode: 'diagnostic',
      eventVisibility: 'normal',
      businessContext: {
        stage: 'codegen-hardening-follow-up',
        codegenSessionId: session.sessionId,
        flowId: session.flowId,
        previousRunId: session.daemonRunId,
        artifactPaths: ['input/flow.py', ...session.artifacts.map((artifact) => artifact.relativePath)],
        formAnswers: request.answers as CodegenQuestionAnswers,
      },
      metadata: {
        app: 'rpa-local-web',
        workflow: 'codegen-hardening-follow-up',
        codegenSessionId: session.sessionId,
        flowId: session.flowId,
      },
    });

    await store.setDaemonRun(sessionId, {
      workspaceId: session.workspaceId,
      daemonRunId: run.runId,
      conversationId: run.conversationId,
    });
    await consumeDaemonRun(sessionId, run.runId);
  }

  async function cancel(sessionId: string): Promise<void> {
    const session = await store.getSession(sessionId);
    const shouldCancelDaemonRun = session.daemonRunId !== undefined && session.status === 'hardening';
    if (session.status === 'hardening' || session.status === 'needs_input') {
      await store.transition(sessionId, 'cancelled');
    }
    if (shouldCancelDaemonRun) {
      try {
        await daemonClient.cancelRun(session.daemonRunId!);
      } catch (error) {
        await store.appendLog(
          sessionId,
          error instanceof Error ? `Daemon cancel failed: ${error.message}` : 'Daemon cancel failed.',
        );
      }
    }
  }

  async function consumeDaemonRun(sessionId: string, runId: string): Promise<void> {
    try {
      const consumed = await consumeDaemonRunEvents({
        daemonClient,
        runId,
        appendLog: (message) => store.appendLog(sessionId, message).then(() => undefined),
      });

      if (consumed.terminalStatus !== 'succeeded') {
        await failSession(sessionId, 'DAEMON_RUN_FAILED', `Daemon run ended with status: ${consumed.terminalStatus ?? 'unknown'}.`);
        return;
      }

      const questionForm = parseQuestionFormFromTranscript(consumed.transcript);
      if (questionForm) {
        await store.setQuestionForm(sessionId, questionForm);
        await store.transition(sessionId, 'needs_input');
        return;
      }

      await persistGeneratedArtifacts(sessionId, runId);
      await store.transition(sessionId, 'hardened');
    } catch (error) {
      const session = await store.getSession(sessionId);
      if (session.status === 'cancelled') return;
      await failSession(
        sessionId,
        error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'HARDENING_FAILED',
        error instanceof Error ? error.message : 'Codegen hardening failed.',
      );
    }
  }

  async function persistGeneratedArtifacts(sessionId: string, runId: string): Promise<void> {
    const session = await store.getSession(sessionId);
    const artifacts = await persistRequiredGenerationArtifacts({
      daemonClient,
      storageRoot: options.storageRoot,
      flowId: session.flowId,
      runId,
      tempSuffix: session.sessionId,
    });
    await store.setArtifacts(
      sessionId,
      artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        fileName: artifact.fileName,
        relativePath: artifact.relativePath,
        size: artifact.size,
      })),
    );
  }

  async function failSession(sessionId: string, code: string, message: string): Promise<void> {
    const session = await store.getSession(sessionId);
    if (session.status === 'cancelled') return;
    await store.setError(sessionId, { code, message });
    if (session.status !== 'failed') {
      await store.transition(sessionId, 'failed');
    }
  }

  return { startHardening, submitQuestionAnswers, cancel };
}

async function uploadRecordedScript(input: {
  daemonClient: CodegenHardeningDaemonClient;
  workspaceId: string;
  scriptPath: string;
}): Promise<void> {
  const source = await readFile(input.scriptPath);
  const file = new Blob([source], { type: 'text/x-python' });
  await input.daemonClient.uploadWorkspaceFile({
    workspaceId: input.workspaceId,
    file,
    fileName: 'flow.py',
    targetPath: 'input/flow.py',
  });
}
