import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig } from '../../src/config/profiles.js';
import { createReviewBundleService, type ReviewBundleClient } from '../../src/core/review-bundle-service.js';
import { createRunLogService } from '../../src/core/run-log-service.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  insertRunFeedback,
  replaceArtifactsForRun,
  updateRunMessage,
  upsertRunContextSnapshot,
  upsertRunPromptSnapshot,
  upsertRunSkillSnapshot,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(input: { canReadDebugEvents?: boolean; maxReviewBundleBytes?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'review-bundle-test-'));
  tempDirs.push(root);
  const config = parseDaemonConfig(
    {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir: path.join(root, 'data'),
        globalConcurrency: 4,
        maxQueueSize: 100,
        maxReviewBundleBytes: input.maxReviewBundleBytes ?? 1024 * 1024,
      },
      clients: [{ id: 'lqbot', apiKey: 'secret', allowedProfileIds: ['report-docx'], canReadLogs: true }],
      profiles: [
        {
          id: 'report-docx',
          sandboxRoot: path.join(root, 'sandboxes'),
          claudeConfigDir: path.join(root, 'profiles/report-docx/claude'),
          skillRoots: [path.join(root, 'skills')],
          allowedInputRoots: [path.join(root, 'uploads')],
          allowedSkillIds: ['report-writer'],
          artifactRules: [{ id: 'report-docx', pattern: 'output/**/*.docx', role: 'primary', required: true }],
          defaultArtifactRuleIds: ['report-docx'],
          permissionMode: 'bypassPermissions',
          defaultModel: 'sonnet',
          allowedModels: ['sonnet'],
          eventVisibility: 'quiet',
          maxCollectionMode: 'review',
          profileConcurrency: 1,
          runTimeoutMs: 1000,
          inactivityTimeoutMs: 1000,
          cancelGraceMs: 100,
          env: {},
        },
      ],
    },
    { env: {} },
  );
  const db = openInMemoryDatabase();
  applySchema(db);
  const workspace = upsertWorkspace(db, {
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_1',
    now: 1000,
  });
  createRunQueuedWithMessagesAndSnapshot(db, {
    runId: 'run_1',
    conversationId: 'conv_1',
    userMessageId: 'msg_user',
    assistantMessageId: 'msg_assistant',
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    clientId: workspace.clientId,
    kind: 'generate',
    prompt: 'Build a report.',
    profileSnapshot: { profileId: workspace.profileId, sandboxRoot: config.profiles[0]!.sandboxRoot },
    collectionMode: 'diagnostic',
    now: 2000,
  });
  updateRunMessage(db, {
    messageId: 'msg_assistant',
    content: 'Done',
    thinkingContent: 'private chain of thought',
    events: [{ type: 'tool_result', content: 'authorization: Bearer secret-token' }],
    now: 2100,
  });
  upsertRunPromptSnapshot(db, {
    runId: 'run_1',
    promptSnapshot: null,
    promptSnapshotHash: 'sha256:prompt',
    charCount: 123,
    byteCount: 456,
    persisted: false,
    now: 2200,
  });
  upsertRunSkillSnapshot(db, {
    runId: 'run_1',
    skillId: 'report-writer',
    skillName: 'Report Writer',
    skillDescription: 'Writes reports',
    skillBodyHash: 'sha256:skill',
    skillBody: null,
    sideFilesManifest: [{ path: 'references/rules.md', sha256: 'sha256:side' }],
    persisted: false,
    now: 2300,
  });
  upsertRunContextSnapshot(db, {
    runId: 'run_1',
    businessContext: { localPath: config.profiles[0]!.sandboxRoot, artifactPath: 'output/report.docx' },
    businessContextHash: 'sha256:context',
    persisted: true,
    now: 2400,
  });
  replaceArtifactsForRun(db, {
    runId: 'run_1',
    workspaceId: workspace.id,
    artifacts: [
      {
        id: 'artifact_1',
        ruleId: 'report-docx',
        role: 'primary',
        relativePath: 'output/report.docx',
        fileName: 'report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 1024,
        mtime: 2500,
        sha256: 'sha256:artifact',
      },
    ],
    now: 2500,
  });
  insertRunFeedback(db, {
    id: 'feedback_1',
    runId: 'run_1',
    clientId: 'lqbot',
    category: 'prompt',
    message: 'secret=hidden',
    metadata: { token: 'abc', artifactPath: 'output/report.docx' },
    now: 2600,
  });
  const runLogService = createRunLogService({ config, db });
  const logs = runLogService.openRunLogs({ runId: 'run_1' });
  logs.stdout(`stdout ${config.profiles[0]!.sandboxRoot} output/report.docx`);
  logs.stderr('stderr');
  logs.debugEvent({ type: 'tool_result', content: 'token=my-token' } as never);
  logs.close();
  const service = createReviewBundleService({ config, db, runLogService });
  return {
    config,
    service,
    client: {
      id: 'lqbot',
      canReadLogs: true,
      canReadDebugEvents: input.canReadDebugEvents ?? false,
    } satisfies ReviewBundleClient,
  };
}

describe('review bundle service', () => {
  it('exports a sanitized generic bundle for authorized clients', async () => {
    const { service, client, config } = setup();

    const bundle = await service.createRunReviewBundle({ runId: 'run_1', client });
    const entries = readStoredEntries(bundle.buffer);

    expect(bundle.fileName).toBe('run_run_1_review_bundle.zip');
    expect(entries['manifest.json']).toContain('"schemaVersion"');
    expect(entries['prompt-snapshot.md']).toContain('sha256:prompt');
    expect(entries['prompt-snapshot.md']).not.toContain('Build a report.');
    expect(entries['skill/side-files-manifest.json']).toContain('references/rules.md');
    expect(entries['skill/SKILL.md']).toBeUndefined();
    expect(entries['logs/stdout.log']).toContain('output/report.docx');
    expect(entries['logs/stdout.log']).not.toContain(config.profiles[0]!.sandboxRoot);
    expect(entries['messages.filtered.json']).not.toContain('private chain of thought');
    expect(entries['messages.filtered.json']).not.toContain('tool_result');
    expect(entries['messages.debug.json']).toBeUndefined();
    expect(entries['logs/debug-events.ndjson']).toBeUndefined();
    expect(entries['feedback.jsonl']).not.toContain('hidden');
    expect(entries['artifacts/manifest.json']).toContain('output/report.docx');
    expect(JSON.parse(entries['diagnostics.json'] ?? '{}')).toEqual(
      expect.objectContaining({
        size: expect.objectContaining({ byteCount: expect.any(Number) }),
      }),
    );
    expect(JSON.parse(entries['diagnostics.json'] ?? '{}').size.byteCount).toBeGreaterThan(0);
  });

  it('includes debug-only files for clients with debug event permission', async () => {
    const { service, client } = setup({ canReadDebugEvents: true });

    const entries = readStoredEntries((await service.createRunReviewBundle({ runId: 'run_1', client })).buffer);

    expect(entries['messages.debug.json']).toContain('tool_result');
    expect(entries['messages.debug.json']).not.toContain('secret-token');
    expect(entries['logs/debug-events.ndjson']).toContain('[redacted]');
  });

  it('enforces permissions and bundle size limits', async () => {
    const { service, client } = setup({ maxReviewBundleBytes: 10 });

    await expect(
      service.createRunReviewBundle({
        runId: 'run_1',
        client: { ...client, canReadLogs: false },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      service.createRunReviewBundle({
        runId: 'run_1',
        client: { id: 'other', canReadLogs: true, canReadDebugEvents: true },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(service.createRunReviewBundle({ runId: 'run_1', client })).rejects.toMatchObject({
      code: 'REVIEW_BUNDLE_TOO_LARGE',
      status: 413,
    });
  });
});

function readStoredEntries(buffer: Buffer): Record<string, string> {
  const entries: Record<string, string> = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    const contentStart = nameStart + fileNameLength + extraLength;
    entries[name] = buffer.subarray(contentStart, contentStart + compressedSize).toString('utf8');
    offset = contentStart + compressedSize;
  }
  return entries;
}
