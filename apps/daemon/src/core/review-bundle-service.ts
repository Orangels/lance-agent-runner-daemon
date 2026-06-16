import { readFile } from 'node:fs/promises';
import type { DaemonConfig } from '../config/profiles.js';
import type { RunnerPersistence, RunMessageRecord, RunPromptSnapshotRecord } from '../db/types.js';
import { daemonError, forbidden, notFound, type DaemonError } from './errors.js';
import { sanitizeLogText, sanitizeReviewValue } from './log-sanitizer.js';
import type { RunLogDownloadKind, RunLogService } from './run-log-service.js';
import { createZipBuffer, type ZipEntry } from './zip-writer.js';

export interface ReviewBundleClient {
  id: string;
  isAdmin?: boolean;
  canReadLogs: boolean;
  canReadDebugEvents: boolean;
}

export interface ReviewBundleDownload {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ReviewBundleExtensionEntry {
  path: string;
  content: string | Buffer;
}

export interface ReviewBundleExtensionInput {
  runId: string;
  client: ReviewBundleClient;
}

export interface ReviewBundleExtensionProvider {
  id: string;
  collect(input: ReviewBundleExtensionInput): Promise<ReviewBundleExtensionEntry[]>;
}

export interface ReviewBundleService {
  createRunReviewBundle(input: {
    runId: string;
    client: ReviewBundleClient;
  }): Promise<ReviewBundleDownload>;
}

export interface CreateReviewBundleServiceInput {
  config: DaemonConfig;
  persistence?: RunnerPersistence;
  runLogService: RunLogService;
  extensionProviders?: ReviewBundleExtensionProvider[];
}

export function createReviewBundleService(input: CreateReviewBundleServiceInput): ReviewBundleService {
  const providers = input.extensionProviders ?? [];
  const persistence = input.persistence;
  if (!persistence) {
    throw new Error('ReviewBundleService requires persistence');
  }

  return {
    createRunReviewBundle: async ({ runId, client }) => {
      if (!client.canReadLogs) {
        throw forbidden('Client is not allowed to export review bundles');
      }

      const detail = await persistence.getRunDetail({ runId, clientId: client.id, isAdmin: client.isAdmin });
      if (!detail) {
        throw notFound('Run not found');
      }

      const missingFiles: string[] = [];
      const omittedFiles: Array<{ path: string; reason: string }> = [];
      const logEntries = await collectLogEntries({
        client,
        missingFiles,
        runId,
        runLogService: input.runLogService,
      });
      const [
        profileSnapshot,
        promptSnapshot,
        skillSnapshot,
        contextSnapshot,
        artifacts,
        feedback,
      ] = await Promise.all([
        persistence.getProfileSnapshotForRun(runId),
        persistence.getRunPromptSnapshot(runId),
        persistence.getRunSkillSnapshot(runId),
        persistence.getRunContextSnapshot(runId),
        persistence.listArtifactsForRun({
          runId,
          clientId: client.id,
          isAdmin: client.isAdmin,
        }),
        persistence.listRunFeedbackForClient({
          runId,
          clientId: client.id,
          isAdmin: client.isAdmin,
        }),
      ]);
      const extensions = (
        await Promise.all(providers.map((provider) => provider.collect({ runId, client })))
      ).flat();

      const diagnostics = {
        schemaVersion: 'business-skill-diagnostics.v0.1',
        runId,
        collectionMode: detail.run.collectionMode,
        missingFiles,
        omittedFiles,
        redactionApplied: true,
        size: {
          byteCount: 0,
          maxReviewBundleBytes: input.config.server.maxReviewBundleBytes,
        },
      };
      const entries: ZipEntry[] = [
        jsonEntry(
          'manifest.json',
          {
            schemaVersion: 'business-skill-review-bundle.v0.1',
            runId,
            conversationId: detail.messages[0]?.conversationId ?? null,
            workspaceId: detail.run.workspaceId,
            profileId: detail.run.profileId,
            kind: detail.run.kind,
            skillId: detail.run.skillId,
            status: detail.run.status,
            collectionMode: detail.run.collectionMode,
            redaction: { applied: true, version: 'generic-v0.1' },
            snapshots: {
              prompt: {
                persisted: promptSnapshot?.persisted ?? false,
                hash: promptSnapshot?.promptSnapshotHash ?? detail.run.promptSnapshotHash,
                byteCount: promptSnapshot?.byteCount ?? detail.run.promptSnapshotByteCount,
              },
              skill: {
                persisted: skillSnapshot?.persisted ?? false,
                skillId: skillSnapshot?.skillId ?? detail.run.skillId,
                bodyHash: skillSnapshot?.skillBodyHash ?? null,
              },
              businessContext: {
                persisted: contextSnapshot?.persisted ?? false,
                hash: contextSnapshot?.businessContextHash ?? detail.run.businessContextHash,
              },
            },
            files: [],
            extensions: providers.map((provider) => provider.id),
          },
        ),
        jsonEntry('request.json', {
          run: detail.run,
          businessContext: contextSnapshot?.businessContext ?? null,
        }),
        {
          path: 'prompt-snapshot.md',
          content: buildPromptSnapshotMarkdown(promptSnapshot),
        },
        jsonEntry('profile-snapshot.json', profileSnapshot?.profile ?? null),
        jsonEntry('messages.filtered.json', detail.messages.map(toFilteredMessage)),
        jsonEntry('artifacts/manifest.json', artifacts),
        jsonEntry('large-files-manifest.json', [
          ...artifacts.map((artifact) => ({
            path: artifact.relativePath,
            kind: 'artifact',
            size: artifact.size,
            sha256: artifact.sha256,
            reason: 'artifact body is not inlined in the generic review bundle',
          })),
        ]),
        jsonEntry('diagnostics.json', diagnostics),
        {
          path: 'review-summary.md',
          content: buildReviewSummary({
            runId,
            status: detail.run.status,
            skillId: detail.run.skillId,
            promptHash: promptSnapshot?.promptSnapshotHash ?? detail.run.promptSnapshotHash,
            artifactCount: artifacts.length,
            missingFiles,
          }),
        },
        {
          path: 'feedback.jsonl',
          content: (feedback ?? []).map((record) => JSON.stringify(sanitizeReviewValue(record))).join('\n'),
        },
        ...logEntries,
        ...extensions.map((entry) => ({ path: `extensions/${entry.path}`, content: entry.content })),
      ];

      if (skillSnapshot) {
        entries.push(jsonEntry('skill/side-files-manifest.json', skillSnapshot.sideFilesManifest ?? []));
        if (skillSnapshot.skillBody !== null) {
          entries.push({ path: 'skill/SKILL.md', content: sanitizeLogText(skillSnapshot.skillBody) });
        }
      }

      if (client.canReadDebugEvents) {
        entries.push(jsonEntry('messages.debug.json', detail.messages.map(toDebugMessage)));
      }

      finalizeDiagnosticsEntry(entries, diagnostics);
      assertBundleSize(entries, input.config.server.maxReviewBundleBytes);
      const buffer = createZipBuffer(entries);
      return {
        buffer,
        fileName: `run_${runId}_review_bundle.zip`,
        mimeType: 'application/zip',
        size: buffer.byteLength,
      };
    },
  };
}

async function collectLogEntries(input: {
  runId: string;
  client: ReviewBundleClient;
  runLogService: RunLogService;
  missingFiles: string[];
}): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const kind of ['stdout', 'stderr'] satisfies RunLogDownloadKind[]) {
    const entry = await readLogEntry(input.runLogService, {
      kind,
      runId: input.runId,
      client: input.client,
      path: `logs/${kind}.log`,
    });
    if (entry) {
      entries.push(entry);
    } else {
      input.missingFiles.push(`logs/${kind}.log`);
    }
  }
  if (input.client.canReadDebugEvents) {
    const entry = await readLogEntry(input.runLogService, {
      kind: 'debug-events',
      runId: input.runId,
      client: input.client,
      path: 'logs/debug-events.ndjson',
    });
    if (entry) {
      entries.push(entry);
    } else {
      input.missingFiles.push('logs/debug-events.ndjson');
    }
  }
  return entries;
}

async function readLogEntry(
  runLogService: RunLogService,
  input: { runId: string; kind: RunLogDownloadKind; client: ReviewBundleClient; path: string },
): Promise<ZipEntry | null> {
  try {
    const download = await runLogService.getRunLogDownload(input);
    return {
      path: input.path,
      content: sanitizeLogText(await readFile(download.filePath, 'utf8')),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): error is DaemonError {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'NOT_FOUND';
}

function jsonEntry(path: string, value: unknown): ZipEntry {
  return { path, content: `${JSON.stringify(sanitizeReviewValue(value), null, 2)}\n` };
}

function toFilteredMessage(message: RunMessageRecord): Record<string, unknown> {
  return sanitizeReviewValue({
    id: message.id,
    role: message.role,
    content: message.content,
    runStatus: message.runStatus,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }) as Record<string, unknown>;
}

function toDebugMessage(message: RunMessageRecord): Record<string, unknown> {
  return sanitizeReviewValue({
    id: message.id,
    role: message.role,
    content: message.content,
    thinkingContent: message.thinkingContent,
    events: message.events,
    runStatus: message.runStatus,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }) as Record<string, unknown>;
}

function buildPromptSnapshotMarkdown(snapshot: RunPromptSnapshotRecord | null): string {
  if (!snapshot) {
    return '# Prompt Snapshot\n\nNo prompt snapshot was recorded.\n';
  }
  const lines = [
    '# Prompt Snapshot',
    '',
    `Persisted: ${snapshot.persisted ? 'true' : 'false'}`,
    `Hash: ${snapshot.promptSnapshotHash ?? ''}`,
    `Characters: ${snapshot.charCount ?? 0}`,
    `Bytes: ${snapshot.byteCount ?? 0}`,
    '',
  ];
  if (snapshot.promptSnapshot !== null) {
    lines.push('```text', sanitizeLogText(snapshot.promptSnapshot), '```', '');
  } else {
    lines.push('Prompt body was not persisted for this collection mode.', '');
  }
  return lines.join('\n');
}

function buildReviewSummary(input: {
  runId: string;
  status: string;
  skillId: string | null;
  promptHash: string | null;
  artifactCount: number;
  missingFiles: string[];
}): string {
  return [
    '# Run Review Summary',
    '',
    '## Task',
    `Run ${input.runId} finished with status ${input.status}.`,
    '',
    '## Skill And Snapshots',
    `Skill: ${input.skillId ?? 'none'}`,
    `Prompt hash: ${input.promptHash ?? 'none'}`,
    '',
    '## Prompt And Context',
    'See prompt-snapshot.md and request.json.',
    '',
    '## Artifacts',
    `${input.artifactCount} artifact(s) recorded. See artifacts/manifest.json.`,
    '',
    '## Logs And Diagnostics',
    input.missingFiles.length > 0
      ? `Missing files: ${input.missingFiles.join(', ')}`
      : 'No missing generic files recorded.',
    '',
    '## Suggested Next Checks',
    'Review prompt snapshot, skill snapshot, logs, messages, artifacts, and extension directories as needed.',
    '',
  ].join('\n');
}

function finalizeDiagnosticsEntry(
  entries: ZipEntry[],
  diagnostics: { size: { byteCount: number } },
): void {
  const diagnosticsIndex = entries.findIndex((entry) => entry.path === 'diagnostics.json');
  if (diagnosticsIndex === -1) {
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const byteCount = calculateEntryContentByteCount(entries);
    if (byteCount === diagnostics.size.byteCount) {
      return;
    }
    diagnostics.size.byteCount = byteCount;
    entries[diagnosticsIndex] = jsonEntry('diagnostics.json', diagnostics);
  }
}

function assertBundleSize(entries: ZipEntry[], maxReviewBundleBytes: number): void {
  const plannedByteCount = calculateEntryContentByteCount(entries);
  if (plannedByteCount > maxReviewBundleBytes) {
    throw daemonError('REVIEW_BUNDLE_TOO_LARGE', 'Review bundle is too large', 413, {
      maxReviewBundleBytes,
      plannedByteCount,
    });
  }
}

function calculateEntryContentByteCount(entries: ZipEntry[]): number {
  return entries.reduce((sum, entry) => {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    return sum + content.byteLength;
  }, 0);
}
