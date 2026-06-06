import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactsResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateWorkspaceRequest,
  PublicWorkspace,
  UploadWorkspaceFileResponse,
} from '../../shared/daemon-types.js';
import {
  isDaemonArtifactFinalizedEvent,
  isDaemonEndEvent,
  isDaemonErrorEvent,
  isDaemonTextDeltaEvent,
} from '../../shared/daemon-event-types.js';
import type {
  CodegenQuestionAnswers,
  CodegenQuestionForm,
  SubmitCodegenQuestionAnswersRequest,
} from '../../shared/codegen-types.js';
import { requiredGenerationArtifactNames, type RpaGenerationArtifact } from '../../shared/artifacts.js';
import { validateRpaDsl } from '../validators/dsl-validator.js';
import { validateGenerationArtifacts } from '../validators/artifact-validator.js';
import type { CodegenSessionStore } from '../codegen/codegen-session-store.js';

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
    let transcript = '';
    let terminalStatus: string | undefined;

    try {
      for await (const record of daemonClient.subscribeRunEvents(runId)) {
        const { event } = record;
        if (isDaemonTextDeltaEvent(event)) {
          transcript += event.delta;
        } else if (isDaemonArtifactFinalizedEvent(event)) {
          await store.appendLog(sessionId, `Artifact created: ${event.artifact.relativePath}`);
        } else if (isDaemonErrorEvent(event)) {
          await store.appendLog(sessionId, `${event.code ?? 'ERROR'}: ${event.message}`);
        } else if (isDaemonEndEvent(event)) {
          terminalStatus = event.status;
        }
      }

      if (terminalStatus !== 'succeeded') {
        await failSession(sessionId, 'DAEMON_RUN_FAILED', `Daemon run ended with status: ${terminalStatus ?? 'unknown'}.`);
        return;
      }

      const questionForm = parseQuestionForm(transcript);
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
    const artifactsResponse = await daemonClient.listRunArtifacts(runId);
    const generationArtifacts = artifactsResponse.artifacts
      .filter((artifact) => artifact.relativePath.startsWith('output/'))
      .map((artifact): RpaGenerationArtifact => ({
        artifactId: artifact.id,
        relativePath: artifact.relativePath,
        fileName: artifact.fileName,
        mimeType: artifact.mimeType ?? undefined,
        size: artifact.size ?? 0,
        sha256: artifact.sha256 ?? undefined,
      }));
    const artifactValidation = validateGenerationArtifacts(generationArtifacts);
    if (!artifactValidation.ok) {
      throw new WorkflowError(
        'ARTIFACT_VALIDATION_FAILED',
        `Generated artifacts failed validation: ${artifactValidation.errors.map((issue) => issue.code).join(', ')}.`,
      );
    }

    const tempFlowDir = `${session.finalFlowDir}.tmp-${session.sessionId}`;
    await rm(tempFlowDir, { recursive: true, force: true });
    await mkdir(tempFlowDir, { recursive: true });
    const persisted: RpaGenerationArtifact[] = [];
    let promoted = false;
    try {
      for (const artifact of artifactValidation.artifacts) {
        const response = await daemonClient.downloadArtifact({ runId, artifactId: artifact.artifactId });
        if (!response.ok) {
          throw new WorkflowError(
            'ARTIFACT_DOWNLOAD_FAILED',
            `Failed to download generation artifact: ${artifact.fileName}.`,
          );
        }
        const body = await response.text();
        await writeFile(path.join(tempFlowDir, artifact.fileName), body, 'utf8');
        persisted.push(artifact);
      }

      const dsl = JSON.parse(await readFile(path.join(tempFlowDir, 'flow.dsl.json'), 'utf8')) as unknown;
      const dslValidation = validateRpaDsl(dsl);
      if (!dslValidation.ok) {
        throw new WorkflowError(
          'DSL_INVALID',
          `Generated DSL failed validation: ${dslValidation.errors.map((issue) => issue.code).join(', ')}.`,
        );
      }

      await rename(tempFlowDir, session.finalFlowDir);
      promoted = true;
      await store.setArtifacts(
        sessionId,
        persisted.map((artifact) => ({
          artifactId: artifact.artifactId,
          fileName: artifact.fileName,
          relativePath: artifact.relativePath,
          size: artifact.size,
        })),
      );
    } finally {
      if (!promoted) {
        await rm(tempFlowDir, { recursive: true, force: true });
      }
    }
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

function parseQuestionForm(transcript: string): CodegenQuestionForm | null {
  const match = transcript.match(/<question-form\b([^>]*)>([\s\S]*?)<\/question-form>/);
  if (!match) return null;

  const attrs = match[1] ?? '';
  const body = match[2] ?? '';
  const formId = attr(attrs, 'id') ?? 'rpa-question-form';
  const version = attr(attrs, 'version');
  const parsed = JSON.parse(body.trim()) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) {
    throw new WorkflowError('QUESTION_FORM_INVALID', 'Question form payload is invalid.');
  }

  return {
    formId,
    version: typeof parsed.version === 'string' ? parsed.version : version,
    title: typeof parsed.title === 'string' ? parsed.title : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    questions: parsed.questions as CodegenQuestionForm['questions'],
  };
}

function attr(value: string, name: string): string | undefined {
  const match = value.match(new RegExp(`${name}="([^"]+)"`));
  return match?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}
