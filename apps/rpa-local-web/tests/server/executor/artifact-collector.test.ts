import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findCurrentScreenshot,
  listExecutionArtifacts,
  resolveExecutionArtifactDownload,
} from '../../../src/server/executor/artifact-collector.js';

function artifactIdFor(relativePath: string): string {
  return `art_${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`;
}

async function writeArtifact(executionDir: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.join(executionDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

describe('RPA execution artifact collector', () => {
  it('collects artifact files with stable ids, roles, sizes, and hashes', async () => {
    const executionDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-artifacts-'));
    await writeArtifact(executionDir, 'artifacts/screenshots/open.png', 'screenshot');
    await writeArtifact(executionDir, 'artifacts/downloads/report.csv', 'download');
    await writeArtifact(executionDir, 'artifacts/trace/trace.zip', 'trace');
    await writeArtifact(executionDir, 'artifacts/video/session.webm', 'video');
    await writeArtifact(executionDir, 'artifacts/notes.txt', 'other');
    await writeArtifact(executionDir, 'outside.txt', 'ignore me');

    const artifacts = await listExecutionArtifacts(executionDir);

    expect(artifacts.map((artifact) => artifact.relativePath)).toEqual([
      'artifacts/downloads/report.csv',
      'artifacts/notes.txt',
      'artifacts/screenshots/open.png',
      'artifacts/trace/trace.zip',
      'artifacts/video/session.webm',
    ]);
    expect(artifacts.map((artifact) => [artifact.fileName, artifact.role])).toEqual([
      ['report.csv', 'download'],
      ['notes.txt', 'other'],
      ['open.png', 'screenshot'],
      ['trace.zip', 'trace'],
      ['session.webm', 'video'],
    ]);
    expect(artifacts[0]).toMatchObject({
      artifactId: artifactIdFor('artifacts/downloads/report.csv'),
      size: 'download'.length,
      sha256: createHash('sha256').update('download').digest('hex'),
    });
  });

  it('collects generic runtime outputs without relying on business-specific file names', async () => {
    const executionDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-runtime-artifacts-'));
    await writeArtifact(executionDir, 'runtime/audit.jsonl', '{}\n');
    await writeArtifact(executionDir, 'runtime/result-data.json', '{"ok":true}');
    await writeArtifact(executionDir, 'runtime/screenshots/last-step.png', 'screenshot');
    await writeArtifact(executionDir, 'runtime/downloads/export.csv', 'download');
    await writeArtifact(executionDir, 'runtime/storage_state.json', 'sensitive');
    await writeArtifact(executionDir, 'runtime/session.cookie', 'sensitive');

    const artifacts = await listExecutionArtifacts(executionDir);

    expect(artifacts.map((artifact) => artifact.relativePath)).toEqual([
      'runtime/audit.jsonl',
      'runtime/downloads/export.csv',
      'runtime/result-data.json',
      'runtime/screenshots/last-step.png',
    ]);
    expect(artifacts.map((artifact) => [artifact.relativePath, artifact.role])).toEqual([
      ['runtime/audit.jsonl', 'log'],
      ['runtime/downloads/export.csv', 'download'],
      ['runtime/result-data.json', 'other'],
      ['runtime/screenshots/last-step.png', 'screenshot'],
    ]);
  });

  it('resolves downloads by artifact id without exposing absolute paths in summaries', async () => {
    const executionDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-artifact-download-'));
    const filePath = await writeArtifact(executionDir, 'artifacts/downloads/report.csv', 'download');

    const result = await resolveExecutionArtifactDownload(
      executionDir,
      artifactIdFor('artifacts/downloads/report.csv'),
    );

    expect(result.filePath).toBe(filePath);
    expect(result.artifact).toMatchObject({
      artifactId: artifactIdFor('artifacts/downloads/report.csv'),
      relativePath: 'artifacts/downloads/report.csv',
    });
    expect(JSON.stringify(result.artifact)).not.toContain(executionDir);
  });

  it('rejects traversal-shaped and unknown artifact ids', async () => {
    const executionDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-artifact-reject-'));
    await writeArtifact(executionDir, 'artifacts/downloads/report.csv', 'download');

    await expect(resolveExecutionArtifactDownload(executionDir, '../report.csv')).rejects.toThrow(
      /Unknown artifact id/,
    );
    await expect(resolveExecutionArtifactDownload(executionDir, 'art_missing')).rejects.toThrow(
      /Unknown artifact id/,
    );
  });

  it('returns the latest screenshot by modified time or null when none exist', async () => {
    const executionDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-current-screenshot-'));
    await writeArtifact(executionDir, 'artifacts/downloads/report.csv', 'download');
    const older = await writeArtifact(executionDir, 'artifacts/screenshots/older.png', 'older');
    const newer = await writeArtifact(executionDir, 'artifacts/screenshots/newer.png', 'newer');
    const now = Date.now();
    await import('node:fs/promises').then(({ utimes }) =>
      Promise.all([
        utimes(older, new Date(now - 10_000), new Date(now - 10_000)),
        utimes(newer, new Date(now), new Date(now)),
      ]),
    );

    await expect(stat(newer)).resolves.toMatchObject({ size: 'newer'.length });
    await expect(findCurrentScreenshot(executionDir)).resolves.toMatchObject({
      artifactId: artifactIdFor('artifacts/screenshots/newer.png'),
      relativePath: 'artifacts/screenshots/newer.png',
      role: 'screenshot',
    });

    const emptyExecutionDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-no-screenshot-'));
    await expect(findCurrentScreenshot(emptyExecutionDir)).resolves.toBeNull();
  });
});
