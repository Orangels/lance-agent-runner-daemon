import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { requiredGenerationArtifactNames } from '../../shared/artifacts.js';
import type {
  CodegenArtifactSummary,
  CodegenQuestionForm,
  CodegenSessionStatus,
  CodegenSessionStatusResponse,
} from '../../shared/codegen-types.js';
import { resolveFlowsRoot, safeFlowId } from '../flow-store.js';

export interface CodegenSessionError {
  code: string;
  message: string;
}

export interface CreateCodegenSessionInput {
  flowId: string;
  flowName?: string;
  targetUrl: string;
}

export interface CodegenDaemonRunMetadata {
  workspaceId: string;
  daemonRunId: string;
  conversationId?: string;
}

export interface CodegenSessionRecord {
  sessionId: string;
  flowId: string;
  flowName?: string;
  targetUrl: string;
  status: CodegenSessionStatus;
  createdAt: string;
  updatedAt: string;
  recording: {
    inputPath: 'input/flow.py';
    absoluteInputPath: string;
  };
  finalFlowDir: string;
  workspaceId?: string;
  daemonRunId?: string;
  conversationId?: string;
  questionForm: CodegenQuestionForm | null;
  artifacts: CodegenArtifactSummary[];
  logs: string[];
  error: CodegenSessionError | null;
}

export interface PublicCodegenSession extends CodegenSessionStatusResponse {
  flowName?: string;
  recording: {
    inputPath: 'input/flow.py';
  };
}

export interface CodegenSessionStoreOptions {
  storageRoot: string;
  idFactory?: () => string;
  maxLogs?: number;
}

export interface CodegenSessionStore {
  createSession(input: CreateCodegenSessionInput): Promise<CodegenSessionRecord>;
  getSession(sessionId: string): Promise<CodegenSessionRecord>;
  getPublicSession(sessionId: string): Promise<PublicCodegenSession>;
  setRecording(sessionId: string): Promise<CodegenSessionRecord>;
  transition(sessionId: string, nextStatus: CodegenSessionStatus): Promise<CodegenSessionRecord>;
  setDaemonRun(sessionId: string, metadata: CodegenDaemonRunMetadata): Promise<CodegenSessionRecord>;
  setQuestionForm(sessionId: string, questionForm: CodegenQuestionForm | null): Promise<CodegenSessionRecord>;
  setArtifacts(sessionId: string, artifacts: CodegenArtifactSummary[]): Promise<CodegenSessionRecord>;
  appendLog(sessionId: string, message: string): Promise<CodegenSessionRecord>;
  setError(sessionId: string, error: CodegenSessionError | null): Promise<CodegenSessionRecord>;
}

const inputPath = 'input/flow.py' as const;

const allowedTransitions: Record<CodegenSessionStatus, ReadonlySet<CodegenSessionStatus>> = {
  starting: new Set(['recording']),
  recording: new Set(['completed', 'failed', 'cancelled']),
  completed: new Set(['hardening']),
  hardening: new Set(['needs_input', 'hardened', 'failed', 'cancelled']),
  needs_input: new Set(['hardening', 'cancelled']),
  hardened: new Set(['hardened']),
  failed: new Set([]),
  cancelled: new Set([]),
};

export function safeCodegenSessionId(sessionId: string): string {
  if (!/^cg_[a-zA-Z0-9_]{3,64}$/.test(sessionId)) {
    throw new Error(`Invalid codegen session id: ${sessionId}`);
  }
  return sessionId;
}

export function resolveCodegenSessionInputDir(storageRoot: string, sessionId: string): string {
  const safeId = safeCodegenSessionId(sessionId);
  const sessionsRoot = path.resolve(storageRoot, 'codegen-sessions');
  const resolved = path.resolve(sessionsRoot, safeId, 'input');
  if (!resolved.startsWith(`${sessionsRoot}${path.sep}`)) {
    throw new Error(`Unsafe codegen session path: ${sessionId}`);
  }
  return resolved;
}

export function resolveCodegenInputScriptPath(storageRoot: string, sessionId: string): string {
  return path.join(resolveCodegenSessionInputDir(storageRoot, sessionId), 'flow.py');
}

export function resolveFinalFlowDir(storageRoot: string, flowId: string): string {
  const flowsRoot = resolveFlowsRoot(storageRoot);
  const safeId = safeFlowId(flowId);
  const resolved = path.resolve(flowsRoot, safeId);
  if (!resolved.startsWith(`${flowsRoot}${path.sep}`)) {
    throw new Error(`Unsafe final flow path: ${flowId}`);
  }
  return resolved;
}

export function createCodegenSessionStore(options: CodegenSessionStoreOptions): CodegenSessionStore {
  const storageRoot = path.resolve(options.storageRoot);
  const idFactory = options.idFactory ?? (() => `cg_${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  const maxLogs = options.maxLogs ?? 100;
  const sessions = new Map<string, CodegenSessionRecord>();

  function requireSession(sessionId: string): CodegenSessionRecord {
    const safeId = safeCodegenSessionId(sessionId);
    const session = sessions.get(safeId);
    if (!session) {
      throw new Error(`Unknown codegen session: ${safeId}`);
    }
    return session;
  }

  function updateSession(session: CodegenSessionRecord, patch: Partial<CodegenSessionRecord>): CodegenSessionRecord {
    const updated: CodegenSessionRecord = {
      ...session,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    sessions.set(updated.sessionId, updated);
    return updated;
  }

  function toPublicSession(session: CodegenSessionRecord): PublicCodegenSession {
    return {
      sessionId: session.sessionId,
      flowId: session.flowId,
      flowName: session.flowName,
      targetUrl: session.targetUrl,
      status: session.status,
      recording: { inputPath },
      workspaceId: session.workspaceId,
      daemonRunId: session.daemonRunId,
      conversationId: session.conversationId,
      questionForm: session.questionForm,
      artifacts: session.artifacts.map((artifact) => sanitizePublicValue(artifact, storageRoot) as CodegenArtifactSummary),
      logs: session.logs.map((line) => sanitizeForStorageRoot(line, storageRoot)),
      error: session.error
        ? {
            code: session.error.code,
            message: sanitizeForStorageRoot(session.error.message, storageRoot),
          }
        : null,
    };
  }

  return {
    async createSession(input) {
      const sessionId = safeCodegenSessionId(idFactory());
      const flowId = safeFlowId(input.flowId);
      await assertNoExistingFinalFlow(storageRoot, flowId);
      if (sessions.has(sessionId)) {
        throw new Error(`Codegen session already exists: ${sessionId}`);
      }

      const sessionInputDir = resolveCodegenSessionInputDir(storageRoot, sessionId);
      await mkdir(sessionInputDir, { recursive: true });
      const now = new Date().toISOString();
      const record: CodegenSessionRecord = {
        sessionId,
        flowId,
        flowName: input.flowName,
        targetUrl: input.targetUrl,
        status: 'starting',
        createdAt: now,
        updatedAt: now,
        recording: {
          inputPath,
          absoluteInputPath: resolveCodegenInputScriptPath(storageRoot, sessionId),
        },
        finalFlowDir: resolveFinalFlowDir(storageRoot, flowId),
        questionForm: null,
        artifacts: [],
        logs: [],
        error: null,
      };
      sessions.set(sessionId, record);
      return record;
    },

    async getSession(sessionId) {
      return requireSession(sessionId);
    },

    async getPublicSession(sessionId) {
      return toPublicSession(requireSession(sessionId));
    },

    async setRecording(sessionId) {
      return this.transition(sessionId, 'recording');
    },

    async transition(sessionId, nextStatus) {
      const session = requireSession(sessionId);
      const allowed = allowedTransitions[session.status];
      if (!allowed.has(nextStatus)) {
        throw new Error(`Illegal codegen session status transition: ${session.status} -> ${nextStatus}`);
      }
      return updateSession(session, { status: nextStatus });
    },

    async setDaemonRun(sessionId, metadata) {
      const session = requireSession(sessionId);
      return updateSession(session, {
        workspaceId: metadata.workspaceId,
        daemonRunId: metadata.daemonRunId,
        conversationId: metadata.conversationId,
      });
    },

    async setQuestionForm(sessionId, questionForm) {
      const session = requireSession(sessionId);
      return updateSession(session, { questionForm });
    },

    async setArtifacts(sessionId, artifacts) {
      const session = requireSession(sessionId);
      return updateSession(session, {
        artifacts: artifacts.map((artifact) => sanitizePublicValue(artifact, storageRoot) as CodegenArtifactSummary),
      });
    },

    async appendLog(sessionId, message) {
      const session = requireSession(sessionId);
      const logs = [...session.logs, sanitizeForStorageRoot(message, storageRoot)].slice(-maxLogs);
      return updateSession(session, { logs });
    },

    async setError(sessionId, error) {
      const session = requireSession(sessionId);
      return updateSession(session, {
        error: error
          ? {
              code: error.code,
              message: sanitizeForStorageRoot(error.message, storageRoot),
            }
          : null,
      });
    },
  };
}

async function assertNoExistingFinalFlow(storageRoot: string, flowId: string): Promise<void> {
  const finalDir = resolveFinalFlowDir(storageRoot, flowId);
  let entries: string[];
  try {
    entries = await readdir(finalDir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }

  const required = new Set<string>(requiredGenerationArtifactNames);
  const hasFinalArtifact = entries.some((entry) => required.has(entry) || entry.endsWith('.rpa.zip'));
  if (hasFinalArtifact || entries.length > 0) {
    throw new Error(`Final flow already exists for flow id: ${flowId}`);
  }
}

function sanitizeForStorageRoot(message: string, storageRoot: string): string {
  return message.split(path.resolve(storageRoot)).join('[rpa-storage]');
}

function sanitizePublicValue(value: unknown, storageRoot: string): unknown {
  if (typeof value === 'string') return sanitizeForStorageRoot(value, storageRoot);
  if (Array.isArray(value)) return value.map((entry) => sanitizePublicValue(entry, storageRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizePublicValue(entry, storageRoot)]),
    );
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
