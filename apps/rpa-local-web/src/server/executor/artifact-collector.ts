import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RpaExecutionArtifactSummary } from '../../shared/rpa-api-types.js';

type CollectedArtifact = RpaExecutionArtifactSummary & {
  filePath: string;
  mtimeMs: number;
};

const artifactIdPattern = /^art_[a-f0-9]{16}$/;

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function artifactIdFor(relativePath: string): string {
  return `art_${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`;
}

function roleFor(relativePath: string): RpaExecutionArtifactSummary['role'] {
  const [, topLevel] = relativePath.split('/');
  switch (topLevel) {
    case 'screenshots':
      return 'screenshot';
    case 'downloads':
      return 'download';
    case 'trace':
      return 'trace';
    case 'video':
      return 'video';
    default:
      return 'other';
  }
}

function assertUnderArtifacts(artifactsDir: string, filePath: string): void {
  const relative = path.relative(artifactsDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Unsafe artifact path');
  }
}

async function collectArtifactFiles(artifactsDir: string, currentDir = artifactsDir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectArtifactFiles(artifactsDir, entryPath)));
    } else if (entry.isFile()) {
      assertUnderArtifacts(artifactsDir, entryPath);
      files.push(entryPath);
    }
  }
  return files;
}

async function collectExecutionArtifacts(executionDir: string): Promise<CollectedArtifact[]> {
  const artifactsDir = path.resolve(executionDir, 'artifacts');
  const filePaths = await collectArtifactFiles(artifactsDir);
  const artifacts = await Promise.all(
    filePaths.map(async (filePath) => {
      const fileStat = await stat(filePath);
      const contents = await readFile(filePath);
      const relativePath = normalizeRelativePath(path.relative(executionDir, filePath));

      return {
        artifactId: artifactIdFor(relativePath),
        role: roleFor(relativePath),
        fileName: path.basename(filePath),
        relativePath,
        size: fileStat.size,
        sha256: createHash('sha256').update(contents).digest('hex'),
        filePath,
        mtimeMs: fileStat.mtimeMs,
      };
    }),
  );

  return artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function listExecutionArtifacts(executionDir: string): Promise<RpaExecutionArtifactSummary[]> {
  return (await collectExecutionArtifacts(executionDir)).map(({ filePath: _filePath, mtimeMs: _mtimeMs, ...artifact }) => artifact);
}

export async function resolveExecutionArtifactDownload(
  executionDir: string,
  artifactId: string,
): Promise<{ filePath: string; artifact: RpaExecutionArtifactSummary }> {
  if (!artifactIdPattern.test(artifactId)) {
    throw new Error('Unknown artifact id');
  }

  const artifact = (await collectExecutionArtifacts(executionDir)).find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) {
    throw new Error('Unknown artifact id');
  }

  const { filePath, mtimeMs: _mtimeMs, ...summary } = artifact;
  return { filePath, artifact: summary };
}

export async function findCurrentScreenshot(executionDir: string): Promise<RpaExecutionArtifactSummary | null> {
  const screenshots = (await collectExecutionArtifacts(executionDir)).filter((artifact) => artifact.role === 'screenshot');
  const latest = screenshots.sort((left, right) => right.mtimeMs - left.mtimeMs || right.relativePath.localeCompare(left.relativePath))[0];
  if (!latest) {
    return null;
  }

  const { filePath: _filePath, mtimeMs: _mtimeMs, ...summary } = latest;
  return summary;
}
