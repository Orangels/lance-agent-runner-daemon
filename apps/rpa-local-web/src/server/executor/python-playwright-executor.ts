import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  RpaExecutionArtifactsResponse,
  RpaExecutionArtifactSummary,
  RpaExecutionLogResponse,
  RpaExecutionStatusResponse,
  StartRpaExecutionResponse,
} from '../../shared/rpa-api-types.js';
import type { RpaDslDocument } from '../../shared/dsl-schema.js';
import { normalizeRuntimeParams } from '../../shared/runtime-params.js';
import { requiredGenerationArtifactNames } from '../../shared/artifacts.js';
import {
  markFlowVerified,
  readFlowLocalMetadata,
  resolveFlowArtifactPath,
  resolveFlowsRoot,
  safeFlowId,
} from '../flow-store.js';
import { validateRpaDsl } from '../validators/dsl-validator.js';
import {
  findCurrentScreenshot,
  listExecutionArtifacts,
  resolveExecutionArtifactDownload,
} from './artifact-collector.js';
import { createFileExecutionStore, type FileExecutionStore } from './execution-store.js';
import type {
  RpaExecutionEvent,
  RpaExecutionMode,
  RpaExecutionParamValue,
} from './execution-types.js';
import { startManagedProcess, type ManagedProcessHandle } from './process-manager.js';

export interface PythonPlaywrightExecutorOptions {
  storageRoot: string;
  pythonCommand?: string;
  pythonArgs?: string[];
  defaultTimeoutMs?: number;
}

export interface StartExecutionInput {
  flowId: string;
  daemonRunId?: string;
  mode: RpaExecutionMode;
  dryRun?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  params?: Record<string, RpaExecutionParamValue>;
}

export interface RpaLocalExecutor {
  start(input: StartExecutionInput): Promise<StartRpaExecutionResponse>;
  cancel(executionId: string): Promise<{ ok: true }>;
  getStatus(executionId: string): Promise<RpaExecutionStatusResponse>;
  getLogs(executionId: string): Promise<RpaExecutionLogResponse>;
  subscribe(executionId: string): AsyncIterable<RpaExecutionEvent>;
  listArtifacts(executionId: string): Promise<RpaExecutionArtifactsResponse>;
  resolveArtifactDownload(
    executionId: string,
    artifactId: string,
  ): Promise<{ filePath: string; artifact: RpaExecutionArtifactSummary }>;
  resolveCurrentScreenshot(
    executionId: string,
  ): Promise<{ filePath: string; artifact: RpaExecutionArtifactSummary } | null>;
}

export class RpaExecutorError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'RpaExecutorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createPythonPlaywrightExecutor(options: PythonPlaywrightExecutorOptions): RpaLocalExecutor {
  const storageRoot = path.resolve(options.storageRoot);
  const flowsRoot = resolveFlowsRoot(storageRoot);
  const store = createFileExecutionStore({ storageRoot });
  const activeProcesses = new Map<string, ManagedProcessHandle>();
  const pendingCancelRequests = new Set<string>();
  const pythonCommand = options.pythonCommand ?? 'python3';
  const pythonArgs = options.pythonArgs ?? [];
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  function executionDir(executionId: string): string {
    if (!/^exec_[a-zA-Z0-9_]+$/.test(executionId)) {
      throw new RpaExecutorError('EXECUTION_NOT_FOUND', 'Execution not found.', 404);
    }
    return path.join(storageRoot, 'executions', executionId);
  }

  return {
    async start(input) {
      const flow = await loadFlow(storageRoot, flowsRoot, input.flowId);
      const maskedParamIds = Object.entries(flow.dsl.params)
        .filter(([, param]) => param.mask === true || param.type === 'secret')
        .map(([id]) => id);
      const timeoutMs = normalizeTimeout(input.timeoutMs, defaultTimeoutMs);
      const dryRun = input.dryRun ?? input.mode === 'verify';
      const headless = input.headless ?? input.mode === 'run';
      const paramValidation = normalizeRuntimeParams(flow.dsl.params, input.params ?? {});
      if (!paramValidation.ok) {
        throw new RpaExecutorError(
          'PARAMS_INVALID',
          `Runtime params failed validation: ${paramValidation.errors
            .map((error) => `${error.paramId}:${error.code}`)
            .join(', ')}.`,
        );
      }
      const metadata = await readFlowLocalMetadata(flow.flowDir, flow.flowId);
      if (input.mode === 'run' && metadata.requiresVerifyBeforeRun) {
        throw new RpaExecutorError(
          'FLOW_VERIFY_REQUIRED',
          'Imported flow must complete a successful local verify before production run.',
        );
      }
      const normalizedParams = paramValidation.value;

      const record = await store.createExecution({
        flowId: flow.flowId,
        daemonRunId: input.daemonRunId,
        mode: input.mode,
        dryRun,
        headless,
        timeoutMs,
        params: normalizedParams,
        maskedParamIds,
      });

      void runExecution({
        store,
        activeProcesses,
        pendingCancelRequests,
        recordId: record.executionId,
        flowId: flow.flowId,
        mode: input.mode,
        dryRun,
        headless,
        timeoutMs,
        scriptPath: flow.scriptPath,
        pythonCommand,
        pythonArgs,
        storageRoot,
      });

      return {
        executionId: record.executionId,
        flowId: record.flowId,
        daemonRunId: record.daemonRunId,
        status: record.status,
      };
    },

    async cancel(executionId) {
      await getExecutionOrNotFound(store, executionId);
      pendingCancelRequests.add(executionId);
      activeProcesses.get(executionId)?.cancel();
      return { ok: true };
    },

    async getStatus(executionId) {
      const record = await getExecutionOrNotFound(store, executionId);
      return {
        executionId: record.executionId,
        flowId: record.flowId,
        daemonRunId: record.daemonRunId,
        status: record.status,
        mode: record.mode,
        dryRun: record.dryRun,
        headless: record.headless,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        failedStepId: record.failedStepId,
        error: record.error,
      };
    },

    async getLogs(executionId) {
      return getLogsOrNotFound(store, executionId);
    },

    async *subscribe(executionId) {
      await getExecutionOrNotFound(store, executionId);
      yield* store.subscribe(executionId);
    },

    async listArtifacts(executionId) {
      await getExecutionOrNotFound(store, executionId);
      return {
        executionId,
        artifacts: await listExecutionArtifacts(executionDir(executionId)),
      };
    },

    async resolveArtifactDownload(executionId, artifactId) {
      await getExecutionOrNotFound(store, executionId);
      try {
        return await resolveExecutionArtifactDownload(executionDir(executionId), artifactId);
      } catch {
        throw new RpaExecutorError('ARTIFACT_NOT_FOUND', 'Artifact not found.', 404);
      }
    },

    async resolveCurrentScreenshot(executionId) {
      await getExecutionOrNotFound(store, executionId);
      const artifact = await findCurrentScreenshot(executionDir(executionId));
      if (!artifact) return null;
      return this.resolveArtifactDownload(executionId, artifact.artifactId);
    },
  };
}

async function runExecution(input: {
  store: FileExecutionStore;
  activeProcesses: Map<string, ManagedProcessHandle>;
  pendingCancelRequests: Set<string>;
  recordId: string;
  flowId: string;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
  timeoutMs: number;
  scriptPath: string;
  pythonCommand: string;
  pythonArgs: string[];
  storageRoot: string;
}): Promise<void> {
  const executionDir = path.join(input.storageRoot, 'executions', input.recordId);

  try {
    await input.store.markRunning(input.recordId);
    await input.store.appendEvent({
      type: 'run.started',
      executionId: input.recordId,
      timestamp: new Date().toISOString(),
      status: 'running',
    });

    const args = [
      ...input.pythonArgs,
      input.scriptPath,
      '--mode',
      input.mode,
      '--params',
      path.join(executionDir, 'run.params.json'),
      '--execution-dir',
      executionDir,
    ];
    if (input.dryRun) args.push('--dry-run');
    args.push(input.headless ? '--headless' : '--headed');

    const pendingLogWrites: Array<Promise<unknown>> = [];
    const handle = startManagedProcess({
      command: input.pythonCommand,
      args,
      cwd: executionDir,
      timeoutMs: input.timeoutMs,
      onStdoutLine: (line) => pendingLogWrites.push(input.store.appendLog(input.recordId, 'stdout', line)),
      onStderrLine: (line) => pendingLogWrites.push(input.store.appendLog(input.recordId, 'stderr', line)),
    });
    input.activeProcesses.set(input.recordId, handle);
    if (input.pendingCancelRequests.has(input.recordId)) {
      handle.cancel();
    }

    const result = await handle.done;
    await waitForProcessOutputCallbacks();
    await Promise.allSettled(pendingLogWrites);
    const artifacts = await listExecutionArtifacts(executionDir);
    await appendScriptAuditEvents({
      store: input.store,
      executionId: input.recordId,
      executionDir,
      artifacts,
    });
    for (const artifact of artifacts) {
      await input.store.appendEvent({
        type: 'artifact.created',
        executionId: input.recordId,
        timestamp: new Date().toISOString(),
        artifactId: artifact.artifactId,
        role: artifact.role,
        relativePath: artifact.relativePath,
      });
    }

    if (result.timedOut) {
      await input.store.finishExecution(input.recordId, {
        status: 'timed_out',
        exitCode: result.exitCode,
        error: { code: 'PROCESS_TIMEOUT', message: `Execution timed out after ${input.timeoutMs}ms.` },
      });
    } else if (result.canceled) {
      await input.store.finishExecution(input.recordId, {
        status: 'canceled',
        exitCode: result.exitCode,
        error: { code: 'PROCESS_CANCELED', message: 'Execution was canceled.' },
      });
    } else if (result.exitCode === 0) {
      if (input.mode === 'verify') {
        await markFlowVerified({
          storageRoot: input.storageRoot,
          flowId: input.flowId,
          executionId: input.recordId,
        }).catch((error) => {
          return input.store.appendLog(
            input.recordId,
            'stderr',
            `FLOW_VERIFY_MARK_FAILED: ${sanitizeStorageRoot(
              error instanceof Error ? error.message : 'Failed to mark flow verified.',
              input.storageRoot,
            )}`,
          );
        });
      }
      await input.store.finishExecution(input.recordId, { status: 'succeeded', exitCode: result.exitCode });
    } else {
      await input.store.finishExecution(input.recordId, {
        status: 'failed',
        exitCode: result.exitCode,
        error: {
          code: 'PROCESS_EXIT_NON_ZERO',
          message: `Execution process exited with code ${result.exitCode ?? 'unknown'}.`,
        },
      });
    }
  } catch (error) {
    await input.store.finishExecution(input.recordId, {
      status: 'failed',
      error: {
        code: 'PROCESS_START_FAILED',
        message: sanitizeStorageRoot(error instanceof Error ? error.message : 'Execution failed.', input.storageRoot),
      },
    });
  } finally {
    input.activeProcesses.delete(input.recordId);
    input.pendingCancelRequests.delete(input.recordId);
  }
}

async function loadFlow(
  storageRoot: string,
  flowsRoot: string,
  flowIdInput: string,
): Promise<{ flowId: string; flowDir: string; dsl: RpaDslDocument; scriptPath: string }> {
  let flowId: string;
  try {
    flowId = safeFlowId(flowIdInput);
  } catch {
    throw new RpaExecutorError('INVALID_FLOW_ID', 'Invalid flow id.');
  }

  for (const artifactName of requiredGenerationArtifactNames) {
    const artifactPath = resolveRequiredArtifactPath(flowsRoot, flowId, artifactName);
    try {
      await readFile(artifactPath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new RpaExecutorError('FLOW_ARTIFACT_MISSING', `Flow artifact is missing: ${artifactName}.`);
      }
      throw new RpaExecutorError(
        'FLOW_ARTIFACT_READ_FAILED',
        sanitizeStorageRoot(`Failed to read flow artifact: ${artifactName}.`, storageRoot),
      );
    }
  }

  const dsl = await readDsl(resolveRequiredArtifactPath(flowsRoot, flowId, 'flow.dsl.json'), storageRoot);
  const validation = validateRpaDsl(dsl);
  if (!validation.ok) {
    throw new RpaExecutorError(
      'DSL_VALIDATION_FAILED',
      `DSL validation failed: ${validation.errors.map((issue) => issue.code).join(', ')}.`,
    );
  }

  return {
    flowId,
    flowDir: path.join(flowsRoot, flowId),
    dsl: dsl as RpaDslDocument,
    scriptPath: resolveRequiredArtifactPath(flowsRoot, flowId, 'flow.hardened.py'),
  };
}

async function readDsl(filePath: string, storageRoot: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RpaExecutorError('DSL_JSON_INVALID', 'DSL JSON is invalid.');
    }
    throw new RpaExecutorError(
      'DSL_READ_FAILED',
      sanitizeStorageRoot(error instanceof Error ? error.message : 'Failed to read DSL.', storageRoot),
    );
  }
}

function resolveRequiredArtifactPath(flowsRoot: string, flowId: string, artifactName: string): string {
  try {
    return resolveFlowArtifactPath(flowsRoot, flowId, artifactName);
  } catch {
    throw new RpaExecutorError('FLOW_ARTIFACT_INVALID', 'Invalid flow artifact path.');
  }
}

function normalizeTimeout(input: number | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  if (!Number.isFinite(input) || input <= 0) {
    throw new RpaExecutorError('INVALID_TIMEOUT', 'timeoutMs must be a positive number.');
  }
  return Math.floor(input);
}

function waitForProcessOutputCallbacks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function appendScriptAuditEvents(input: {
  store: FileExecutionStore;
  executionId: string;
  executionDir: string;
  artifacts: RpaExecutionArtifactSummary[];
}): Promise<void> {
  const auditRows = await readScriptAuditRows(path.join(input.executionDir, 'runtime', 'audit.jsonl'));
  if (auditRows.length === 0) return;

  const artifactsByRelativePath = new Map(input.artifacts.map((artifact) => [artifact.relativePath, artifact]));
  const seenScreenshots = new Set<string>();
  for (const row of auditRows) {
    const stepId = stringField(row, 'step_id') ?? stringField(row, 'stepId');
    if (!stepId) continue;
    const timestamp = stringField(row, 'ts') ?? stringField(row, 'timestamp') ?? new Date().toISOString();
    const status = (stringField(row, 'status') ?? '').toLowerCase();
    if (status === 'start' || status === 'started' || status === 'running') {
      await input.store.appendEvent({
        type: 'step.started',
        executionId: input.executionId,
        timestamp,
        stepId,
      });
      continue;
    }

    const screenshotArtifact = artifactFromAuditPath(
      input.executionDir,
      artifactsByRelativePath,
      stringField(row, 'screenshot') ?? stringField(row, 'screenshot_path'),
    );
    if (screenshotArtifact && !seenScreenshots.has(`${stepId}:${screenshotArtifact.relativePath}`)) {
      seenScreenshots.add(`${stepId}:${screenshotArtifact.relativePath}`);
      await input.store.appendEvent({
        type: 'step.screenshot',
        executionId: input.executionId,
        timestamp,
        stepId,
        artifactId: screenshotArtifact.artifactId,
        role: screenshotArtifact.role,
        relativePath: screenshotArtifact.relativePath,
      });
    }

    if (status === 'ok' || status === 'success' || status === 'succeeded' || status === 'done') {
      await input.store.appendEvent({
        type: 'step.completed',
        executionId: input.executionId,
        timestamp,
        stepId,
      });
    } else if (status === 'failed' || status === 'fail' || status === 'error') {
      await input.store.appendEvent({
        type: 'step.failed',
        executionId: input.executionId,
        timestamp,
        stepId,
        message: stringField(row, 'message') ?? stringField(row, 'error'),
      });
    }
  }
}

async function readScriptAuditRows(auditPath: string): Promise<Record<string, unknown>[]> {
  let content: string;
  try {
    content = await readFile(auditPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }

  const rows: Record<string, unknown>[] = [];
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      // Ignore malformed audit rows. The script process status remains authoritative.
    }
  }
  return rows;
}

function artifactFromAuditPath(
  executionDir: string,
  artifactsByRelativePath: Map<string, RpaExecutionArtifactSummary>,
  auditPath: string | undefined,
): RpaExecutionArtifactSummary | undefined {
  if (!auditPath) return undefined;
  const resolved = path.resolve(auditPath);
  const relative = normalizeExecutionRelativePath(executionDir, resolved);
  if (!relative) return undefined;
  return artifactsByRelativePath.get(relative);
}

function normalizeExecutionRelativePath(executionDir: string, filePath: string): string | undefined {
  const relative = path.relative(executionDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

function stringField(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function getExecutionOrNotFound(
  store: FileExecutionStore,
  executionId: string,
): Promise<Awaited<ReturnType<FileExecutionStore['getExecution']>>> {
  try {
    return await store.getExecution(executionId);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new RpaExecutorError('EXECUTION_NOT_FOUND', 'Execution not found.', 404);
    }
    if (error instanceof RpaExecutorError) throw error;
    throw error;
  }
}

async function getLogsOrNotFound(store: FileExecutionStore, executionId: string): Promise<RpaExecutionLogResponse> {
  try {
    return await store.getLogs(executionId);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new RpaExecutorError('EXECUTION_NOT_FOUND', 'Execution not found.', 404);
    }
    throw error;
  }
}

function sanitizeStorageRoot(value: string, storageRoot: string): string {
  return value.split(storageRoot).join('[rpa-storage]');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
