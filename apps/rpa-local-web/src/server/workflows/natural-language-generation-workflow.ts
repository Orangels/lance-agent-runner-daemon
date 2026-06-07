import path from 'node:path';
import type {
  ArtifactsResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateWorkspaceRequest,
  PublicWorkspace,
} from '../../shared/daemon-types.js';
import type {
  NaturalLanguageArtifactSummary,
  RepairNaturalLanguageSessionRequest,
  SubmitNaturalLanguageQuestionAnswersRequest,
} from '../../shared/natural-language-types.js';
import type { NaturalLanguageSessionRecord, NaturalLanguageSessionStore } from '../natural-language/nl-session-store.js';
import { consumeDaemonRun } from './daemon-run-consumer.js';
import { GenerationArtifactError, persistRequiredGenerationArtifacts } from './generation-artifact-service.js';
import { parseQuestionFormFromTranscript, QuestionFormParseError } from './question-form-parser.js';

export interface NaturalLanguageDaemonClient {
  createWorkspace(request: CreateWorkspaceRequest): Promise<PublicWorkspace>;
  createRun(request: CreateRunRequest): Promise<CreateRunResponse>;
  cancelRun(runId: string): Promise<{ ok: true }>;
  listRunArtifacts(runId: string): Promise<ArtifactsResponse>;
  downloadArtifact(input: { runId: string; artifactId: string }): Promise<Response>;
  subscribeRunEvents(runId: string, after?: string): AsyncGenerator<{ id: string; event: unknown }>;
}

export interface NaturalLanguageExecutionReader {
  getStatus(executionId: string): Promise<{
    status: string;
    failedStepId?: string;
    error?: { code: string; message: string };
  }>;
  getLogs(executionId: string): Promise<{ stdout: string; stderr: string }>;
  listArtifacts(executionId: string): Promise<{ artifacts: Array<{ role: string; relativePath: string }> }>;
}

export interface NaturalLanguageGenerationWorkflowOptions {
  daemonClient: NaturalLanguageDaemonClient;
  defaultProfileId: string;
  executionReader: NaturalLanguageExecutionReader;
  storageRoot: string;
  store: NaturalLanguageSessionStore;
}

export interface NaturalLanguageGenerationWorkflow {
  startGeneration(sessionId: string): Promise<void>;
  submitQuestionAnswers(sessionId: string, request: SubmitNaturalLanguageQuestionAnswersRequest): Promise<void>;
  repairFromExecutionFailure(sessionId: string, request: RepairNaturalLanguageSessionRequest): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

const expectedArtifacts = [
  'output/flow.dsl.json',
  'output/flow.hardened.py',
  'output/config.example.json',
  'output/parameterization-report.md',
  'output/hardening-report.md',
] as const;

const initialPrompt = 'Generate an RPA flow from the user natural-language requirement.';
const followUpPrompt = "Continue generating the RPA flow after the user's question-form answers.";
const repairPrompt = 'Repair the generated RPA flow using the execution failure evidence.';

export function createNaturalLanguageGenerationWorkflow(
  options: NaturalLanguageGenerationWorkflowOptions,
): NaturalLanguageGenerationWorkflow {
  const { daemonClient, defaultProfileId, executionReader, storageRoot, store } = options;

  async function startGeneration(sessionId: string): Promise<void> {
    try {
      const session = await store.getSession(sessionId);
      await store.transition(sessionId, 'generating');
      await store.appendLog(sessionId, 'Creating daemon workspace for natural-language RPA generation.');

      const workspace = await daemonClient.createWorkspace({
        profileId: defaultProfileId,
        workspace: {
          originId: 'rpa-local-web',
          userId: 'local-user',
          projectId: `nl_${session.flowId}_${session.sessionId}`,
        },
        metadata: {
          naturalLanguageSessionId: session.sessionId,
          flowId: session.flowId,
          source: 'natural-language',
        },
      });

      const run = await daemonClient.createRun({
        profileId: defaultProfileId,
        workspaceId: workspace.workspaceId,
        kind: 'generate',
        promptMode: 'business-context',
        currentPrompt: `${initialPrompt} Target URL: ${session.targetUrl}.`,
        skillId: 'rpa-script-generate',
        collectionMode: 'diagnostic',
        eventVisibility: 'normal',
        businessContext: {
          stage: 'nl-generation',
          naturalLanguageSessionId: session.sessionId,
          flowId: session.flowId,
          flowName: session.flowName,
          targetUrl: session.targetUrl,
          requirement: session.requirement,
          businessConstraints: session.businessConstraints,
          safetyNotes: session.safetyNotes,
          expectedArtifacts,
          exploration: {
            chromeDevtoolsMcp: 'profile-provided',
            notesPath: 'notes/',
          },
        },
        metadata: {
          app: 'rpa-local-web',
          workflow: 'nl-generation',
          naturalLanguageSessionId: session.sessionId,
          flowId: session.flowId,
        },
      });

      await store.setDaemonRun(sessionId, {
        workspaceId: workspace.workspaceId,
        daemonRunId: run.runId,
        conversationId: run.conversationId,
      });
      await consumeAndHandle(sessionId, run.runId);
    } catch (error) {
      await handleWorkflowError(sessionId, error, 'NL_GENERATION_FAILED');
    }
  }

  async function submitQuestionAnswers(
    sessionId: string,
    request: SubmitNaturalLanguageQuestionAnswersRequest,
  ): Promise<void> {
    try {
      const session = await store.getSession(sessionId);
      if (session.status !== 'needs_input' || !session.questionForm) {
        throw new WorkflowError('SESSION_NOT_WAITING_FOR_INPUT', 'Natural-language session is not waiting for question-form answers.');
      }
      if (session.questionForm.formId !== request.formId) {
        throw new WorkflowError('QUESTION_FORM_MISMATCH', 'Question form id does not match the current natural-language session.');
      }
      if (!session.workspaceId || !session.daemonRunId) {
        throw new WorkflowError('DAEMON_RUN_MISSING', 'Natural-language session is missing daemon run metadata.');
      }

      await store.transition(sessionId, 'generating');
      await store.setQuestionForm(sessionId, null);

      const run = await daemonClient.createRun({
        profileId: defaultProfileId,
        workspaceId: session.workspaceId,
        conversationId: session.conversationId,
        kind: 'revise',
        promptMode: 'business-context',
        currentPrompt: followUpPrompt,
        skillId: 'rpa-script-generate',
        collectionMode: 'diagnostic',
        eventVisibility: 'normal',
        businessContext: {
          stage: 'nl-generation-follow-up',
          naturalLanguageSessionId: session.sessionId,
          flowId: session.flowId,
          flowName: session.flowName,
          previousRunId: session.daemonRunId,
          artifactPaths: expectedArtifacts,
          formAnswers: request.answers,
        },
        metadata: {
          app: 'rpa-local-web',
          workflow: 'nl-generation-follow-up',
          naturalLanguageSessionId: session.sessionId,
          flowId: session.flowId,
        },
      });

      await store.setDaemonRun(sessionId, {
        workspaceId: session.workspaceId,
        daemonRunId: run.runId,
        conversationId: run.conversationId,
      });
      await consumeAndHandle(sessionId, run.runId);
    } catch (error) {
      await handleWorkflowError(sessionId, error, 'NL_GENERATION_FAILED');
    }
  }

  async function repairFromExecutionFailure(
    sessionId: string,
    request: RepairNaturalLanguageSessionRequest,
  ): Promise<void> {
    try {
      const session = await store.getSession(sessionId);
      if (session.status !== 'generated') {
        throw new WorkflowError('SESSION_NOT_GENERATED', 'Natural-language session has no generated flow to repair.');
      }
      if (!session.workspaceId || !session.daemonRunId) {
        throw new WorkflowError('DAEMON_RUN_MISSING', 'Natural-language session is missing daemon run metadata.');
      }

      await store.transition(sessionId, 'repairing');
      const executionFailure = await buildExecutionFailureContext(request);

      const run = await daemonClient.createRun({
        profileId: defaultProfileId,
        workspaceId: session.workspaceId,
        conversationId: session.conversationId,
        kind: 'revise',
        promptMode: 'business-context',
        currentPrompt: repairPrompt,
        skillId: 'rpa-script-generate',
        collectionMode: 'diagnostic',
        eventVisibility: 'normal',
        businessContext: {
          stage: 'nl-generation-repair',
          naturalLanguageSessionId: session.sessionId,
          flowId: session.flowId,
          flowName: session.flowName,
          previousRunId: session.daemonRunId,
          executionFailure,
          currentArtifacts: currentArtifactPaths(session),
        },
        metadata: {
          app: 'rpa-local-web',
          workflow: 'nl-generation-repair',
          naturalLanguageSessionId: session.sessionId,
          flowId: session.flowId,
          executionId: request.executionId,
        },
      });

      await store.setDaemonRun(sessionId, {
        workspaceId: session.workspaceId,
        daemonRunId: run.runId,
        conversationId: run.conversationId,
      });
      await consumeAndHandle(sessionId, run.runId);
    } catch (error) {
      await handleWorkflowError(sessionId, error, 'NL_REPAIR_FAILED');
    }
  }

  async function cancel(sessionId: string): Promise<void> {
    const session = await store.getSession(sessionId);
    const shouldCancelDaemonRun =
      session.daemonRunId !== undefined && (session.status === 'generating' || session.status === 'repairing');
    if (session.status === 'generating' || session.status === 'repairing' || session.status === 'needs_input') {
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

  async function consumeAndHandle(sessionId: string, runId: string): Promise<void> {
    const consumed = await consumeDaemonRun({
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

    const session = await store.getSession(sessionId);
    const artifacts = await persistRequiredGenerationArtifacts({
      daemonClient,
      storageRoot,
      flowId: session.flowId,
      flowName: session.flowName,
      runId,
      tempSuffix: session.sessionId,
      generator: {
        mode: 'nl',
        skillId: 'rpa-script-generate',
        daemonRunId: runId,
      },
    });
    await store.setArtifacts(sessionId, toArtifactSummaries(artifacts));
    await store.transition(sessionId, 'generated');
  }

  async function buildExecutionFailureContext(request: RepairNaturalLanguageSessionRequest): Promise<Record<string, unknown>> {
    const [status, logs, artifacts] = await Promise.all([
      executionReader.getStatus(request.executionId),
      executionReader.getLogs(request.executionId),
      executionReader.listArtifacts(request.executionId),
    ]);
    return {
      executionId: request.executionId,
      failedStepId: status.failedStepId,
      status: status.status,
      error: status.error
        ? {
            code: status.error.code,
            message: sanitizeStorageRoot(status.error.message, storageRoot),
          }
        : undefined,
      logTail: boundedLogTail(logs, storageRoot),
      artifactPaths: artifacts.artifacts.map((artifact) => artifact.relativePath),
      instruction: request.instruction,
    };
  }

  async function handleWorkflowError(sessionId: string, error: unknown, fallbackCode: string): Promise<void> {
    if (error instanceof GenerationArtifactError || error instanceof QuestionFormParseError || error instanceof WorkflowError) {
      await failSession(sessionId, error.code, error.message);
      return;
    }
    await failSession(sessionId, fallbackCode, error instanceof Error ? error.message : 'Natural-language generation failed.');
  }

  async function failSession(sessionId: string, code: string, message: string): Promise<void> {
    const session = await store.getSession(sessionId);
    if (session.status === 'cancelled') return;
    await store.setError(sessionId, { code, message });
    if (session.status !== 'failed') {
      await store.transition(sessionId, 'failed');
    }
  }

  return { startGeneration, submitQuestionAnswers, repairFromExecutionFailure, cancel };
}

function toArtifactSummaries(artifacts: Array<{ artifactId: string; fileName: string; relativePath: string; size: number }>): NaturalLanguageArtifactSummary[] {
  return artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    fileName: artifact.fileName,
    relativePath: artifact.relativePath,
    size: artifact.size,
  }));
}

function currentArtifactPaths(session: NaturalLanguageSessionRecord): string[] {
  return session.artifacts.length > 0
    ? session.artifacts.map((artifact) => artifact.relativePath)
    : [...expectedArtifacts];
}

function boundedLogTail(logs: { stdout: string; stderr: string }, storageRoot: string): string {
  return [
    logs.stdout ? `stdout:\n${sanitizeStorageRoot(tail(logs.stdout), storageRoot)}` : '',
    logs.stderr ? `stderr:\n${sanitizeStorageRoot(tail(logs.stderr), storageRoot)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function tail(value: string, maxChars = 4000): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function sanitizeStorageRoot(value: string, storageRoot: string): string {
  return value.split(path.resolve(storageRoot)).join('[rpa-storage]').split(storageRoot).join('[rpa-storage]');
}

class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}
