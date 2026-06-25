import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { requiredGenerationArtifactNames } from '../../shared/artifacts.js';
import type {
  NaturalLanguageArtifactSummary,
  NaturalLanguageSessionStatus,
  NaturalLanguageSessionStatusResponse,
  StartNaturalLanguageSessionRequest,
} from '../../shared/natural-language-types.js';
import type { RpaQuestionForm } from '../../shared/question-form-types.js';
import { resolveFlowDir, safeFlowId } from '../flow-store.js';

export interface NaturalLanguageSessionError {
  code: string;
  message: string;
}

export interface NaturalLanguageDaemonRunMetadata {
  workspaceId: string;
  daemonRunId: string;
  conversationId?: string;
}

export interface NaturalLanguageSessionRecord {
  sessionId: string;
  flowId: string;
  flowName?: string;
  targetUrl: string;
  requirement: string;
  businessConstraints?: string;
  safetyNotes?: string;
  status: NaturalLanguageSessionStatus;
  createdAt: string;
  updatedAt: string;
  finalFlowDir: string;
  workspaceId?: string;
  daemonRunId?: string;
  conversationId?: string;
  questionForm: RpaQuestionForm | null;
  artifacts: NaturalLanguageArtifactSummary[];
  logs: string[];
  error: NaturalLanguageSessionError | null;
}

export interface NaturalLanguageSessionStoreOptions {
  storageRoot: string;
  idFactory?: () => string;
  maxLogs?: number;
}

export interface NaturalLanguageSessionStore {
  createSession(input: StartNaturalLanguageSessionRequest): Promise<NaturalLanguageSessionRecord>;
  getSession(sessionId: string): Promise<NaturalLanguageSessionRecord>;
  getPublicSession(sessionId: string): Promise<NaturalLanguageSessionStatusResponse>;
  transition(
    sessionId: string,
    nextStatus: NaturalLanguageSessionStatus,
  ): Promise<NaturalLanguageSessionRecord>;
  setDaemonRun(
    sessionId: string,
    metadata: NaturalLanguageDaemonRunMetadata,
  ): Promise<NaturalLanguageSessionRecord>;
  setQuestionForm(sessionId: string, questionForm: RpaQuestionForm | null): Promise<NaturalLanguageSessionRecord>;
  setArtifacts(
    sessionId: string,
    artifacts: NaturalLanguageArtifactSummary[],
  ): Promise<NaturalLanguageSessionRecord>;
  appendLog(sessionId: string, message: string): Promise<NaturalLanguageSessionRecord>;
  setError(sessionId: string, error: NaturalLanguageSessionError | null): Promise<NaturalLanguageSessionRecord>;
}

const allowedTransitions: Record<NaturalLanguageSessionStatus, ReadonlySet<NaturalLanguageSessionStatus>> = {
  starting: new Set(['generating', 'cancelled', 'failed']),
  generating: new Set(['needs_input', 'generated', 'failed', 'cancelled']),
  needs_input: new Set(['generating', 'failed', 'cancelled']),
  generated: new Set(['repairing', 'generated', 'failed']),
  repairing: new Set(['needs_input', 'generated', 'failed', 'cancelled']),
  failed: new Set([]),
  cancelled: new Set([]),
};

export function safeNaturalLanguageSessionId(sessionId: string): string {
  if (!/^nl_[a-zA-Z0-9_]{3,64}$/.test(sessionId)) {
    throw new Error(`Invalid natural-language session id: ${sessionId}`);
  }
  return sessionId;
}

export function resolveNaturalLanguageSessionDir(storageRoot: string, sessionId: string): string {
  const safeId = safeNaturalLanguageSessionId(sessionId);
  const sessionsRoot = path.resolve(storageRoot, 'nl-sessions');
  const resolved = path.resolve(sessionsRoot, safeId);
  if (!resolved.startsWith(`${sessionsRoot}${path.sep}`)) {
    throw new Error(`Unsafe natural-language session path: ${sessionId}`);
  }
  return resolved;
}

export function createNaturalLanguageSessionStore(
  options: NaturalLanguageSessionStoreOptions,
): NaturalLanguageSessionStore {
  const storageRoot = path.resolve(options.storageRoot);
  const idFactory = options.idFactory ?? (() => `nl_${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  const maxLogs = options.maxLogs ?? 100;
  const sessions = new Map<string, NaturalLanguageSessionRecord>();

  function requireSession(sessionId: string): NaturalLanguageSessionRecord {
    const safeId = safeNaturalLanguageSessionId(sessionId);
    const session = sessions.get(safeId);
    if (!session) {
      throw new Error(`Unknown natural-language session: ${safeId}`);
    }
    return session;
  }

  function updateSession(
    session: NaturalLanguageSessionRecord,
    patch: Partial<NaturalLanguageSessionRecord>,
  ): NaturalLanguageSessionRecord {
    const updated: NaturalLanguageSessionRecord = {
      ...session,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    sessions.set(updated.sessionId, updated);
    return updated;
  }

  function toPublicSession(session: NaturalLanguageSessionRecord): NaturalLanguageSessionStatusResponse {
    return {
      sessionId: session.sessionId,
      flowId: session.flowId,
      flowName: sanitizeOptionalString(session.flowName, storageRoot),
      status: session.status,
      targetUrl: sanitizeForStorageRoot(session.targetUrl, storageRoot),
      requirement: sanitizeForStorageRoot(session.requirement, storageRoot),
      workspaceId: session.workspaceId,
      daemonRunId: session.daemonRunId,
      conversationId: session.conversationId,
      logs: session.logs.map((line) => sanitizeForStorageRoot(line, storageRoot)),
      questionForm: session.questionForm
        ? (sanitizePublicValue(session.questionForm, storageRoot) as RpaQuestionForm)
        : null,
      artifacts: session.artifacts.map(
        (artifact) => sanitizePublicValue(artifact, storageRoot) as NaturalLanguageArtifactSummary,
      ),
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
      const sessionId = safeNaturalLanguageSessionId(idFactory());
      const flowId = safeFlowId(input.flowId);
      await assertNoExistingFinalFlow(storageRoot, flowId);
      if (sessions.has(sessionId)) {
        throw new Error(`Natural-language session already exists: ${sessionId}`);
      }

      await mkdir(resolveNaturalLanguageSessionDir(storageRoot, sessionId), { recursive: true });
      const now = new Date().toISOString();
      const record: NaturalLanguageSessionRecord = {
        sessionId,
        flowId,
        flowName: input.flowName,
        targetUrl: input.targetUrl,
        requirement: input.requirement,
        businessConstraints: input.businessConstraints,
        safetyNotes: input.safetyNotes,
        status: 'starting',
        createdAt: now,
        updatedAt: now,
        finalFlowDir: resolveFlowDir(storageRoot, flowId),
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

    async transition(sessionId, nextStatus) {
      const session = requireSession(sessionId);
      const allowed = allowedTransitions[session.status];
      if (!allowed.has(nextStatus)) {
        throw new Error(`Illegal natural-language session status transition: ${session.status} -> ${nextStatus}`);
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
        artifacts: artifacts.map((artifact) => sanitizePublicValue(artifact, storageRoot) as NaturalLanguageArtifactSummary),
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
  const finalDir = resolveFlowDir(storageRoot, flowId);
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

function sanitizeOptionalString(value: string | undefined, storageRoot: string): string | undefined {
  return value === undefined ? undefined : sanitizeForStorageRoot(value, storageRoot);
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
