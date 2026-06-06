import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RpaExecutionArtifactSummary } from '../../shared/rpa-api-types.js';

type CollectedArtifact = RpaExecutionArtifactSummary & {
  filePath: string;
  mtimeMs: number;
};

const artifactIdPattern = /^art_[a-f0-9]{16}$/;
const runtimeAllowedExtensionPattern = /\.(csv|docx?|json|jsonl|log|pdf|png|jpe?g|txt|webm|xlsx?|zip)$/i;
const sensitiveRuntimePathPattern =
  /(^|[/\\])(?:storage_state|cookie|cookies|token|secret|secrets|credential|credentials|ca_|usbkey)|\.(?:env|key|pem|pfx|p12|crt|cer)$/i;

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function artifactIdFor(relativePath: string): string {
  return `art_${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`;
}

function roleFor(relativePath: string): RpaExecutionArtifactSummary['role'] {
  const segments = relativePath.split('/');
  const category = segments[1] ?? segments[0] ?? '';
  if (relativePath.endsWith('/audit.jsonl') || relativePath.endsWith('/audit.log')) {
    return 'log';
  }
  switch (category) {
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

function assertUnderRoot(rootDir: string, filePath: string): void {
  const relative = path.relative(rootDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Unsafe execution artifact path');
  }
}

function shouldCollectFile(rootName: 'artifacts' | 'runtime', relativeToRoot: string): boolean {
  const normalized = normalizeRelativePath(relativeToRoot);
  if (rootName === 'artifacts') return true;
  if (sensitiveRuntimePathPattern.test(normalized)) return false;
  return runtimeAllowedExtensionPattern.test(normalized);
}

async function collectArtifactFiles(
  executionDir: string,
  rootName: 'artifacts' | 'runtime',
  currentDir = path.resolve(executionDir, rootName),
): Promise<string[]> {
  const rootDir = path.resolve(executionDir, rootName);
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
      files.push(...(await collectArtifactFiles(executionDir, rootName, entryPath)));
    } else if (entry.isFile() && shouldCollectFile(rootName, path.relative(rootDir, entryPath))) {
      assertUnderRoot(rootDir, entryPath);
      files.push(entryPath);
    }
  }
  return files;
}

async function collectExecutionArtifacts(executionDir: string): Promise<CollectedArtifact[]> {
  const filePaths = [
    ...(await collectArtifactFiles(executionDir, 'artifacts')),
    ...(await collectArtifactFiles(executionDir, 'runtime')),
  ];
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
  const artifacts = await collectExecutionArtifacts(executionDir);
  const audited = await findLatestAuditScreenshot(executionDir, artifacts);
  if (audited) return stripInternalFields(audited);

  const screenshots = artifacts.filter((artifact) => artifact.role === 'screenshot');
  const latest = screenshots.sort((left, right) => right.mtimeMs - left.mtimeMs || right.relativePath.localeCompare(left.relativePath))[0];
  if (!latest) {
    return null;
  }

  return stripInternalFields(latest);
}

async function findLatestAuditScreenshot(
  executionDir: string,
  artifacts: CollectedArtifact[],
): Promise<CollectedArtifact | undefined> {
  let content: string;
  try {
    content = await readFile(path.join(executionDir, 'runtime', 'audit.jsonl'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  const artifactsByRelativePath = new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));
  for (const line of content.split('\n').reverse()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.screenshot !== 'string') continue;
    const relativePath = normalizeExecutionRelativePath(executionDir, path.resolve(parsed.screenshot));
    if (!relativePath) continue;
    const artifact = artifactsByRelativePath.get(relativePath);
    if (artifact?.role === 'screenshot') return artifact;
  }
  return undefined;
}

function stripInternalFields(artifact: CollectedArtifact): RpaExecutionArtifactSummary {
  const { filePath: _filePath, mtimeMs: _mtimeMs, ...summary } = artifact;
  return summary;
}

function normalizeExecutionRelativePath(executionDir: string, filePath: string): string | undefined {
  const relative = path.relative(executionDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return normalizeRelativePath(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
