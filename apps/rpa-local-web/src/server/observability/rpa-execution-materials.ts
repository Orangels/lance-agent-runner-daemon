import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RpaExecutionRecord } from '../executor/execution-types.js';
import { listExecutionArtifacts } from '../executor/artifact-collector.js';
import type { ReviewZipEntry } from '../zip/uncompressed-zip.js';
import type {
  RpaLargeFileReference,
  RpaRedactionOptions,
  RpaReviewBundleRequest,
} from './rpa-observability-types.js';
import { redactRpaText, redactRpaValue } from './rpa-redaction.js';

export interface CollectRpaExecutionMaterialsInput {
  storageRoot: string;
  executionIds: string[];
  collectionMode: RpaReviewBundleRequest['collectionMode'];
  redaction: RpaRedactionOptions;
  includeSensitiveFiles: boolean;
}

export interface RpaExecutionMaterials {
  executionRecords: RpaExecutionRecord[];
  entries: ReviewZipEntry[];
  largeFiles: RpaLargeFileReference[];
}

const DIAGNOSTIC_LOG_TAIL_BYTES = 16 * 1024;

export function resolveExecutionDirForReview(storageRoot: string, executionId: string): string {
  if (!/^exec_[a-zA-Z0-9_]+$/.test(executionId)) {
    throw new Error('Execution not found.');
  }
  const root = path.resolve(storageRoot, 'executions');
  const resolved = path.resolve(root, executionId);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Execution path is unsafe.');
  }
  return resolved;
}

export async function collectRpaExecutionMaterials(
  input: CollectRpaExecutionMaterialsInput,
): Promise<RpaExecutionMaterials> {
  const executionRecords: RpaExecutionRecord[] = [];
  const entries: ReviewZipEntry[] = [];
  const largeFiles: RpaLargeFileReference[] = [];

  for (const executionId of input.executionIds) {
    const executionDir = resolveExecutionDirForReview(input.storageRoot, executionId);
    const execution = await readExecutionRecord(executionDir, input.redaction);
    executionRecords.push(execution);
    entries.push({
      path: `executions/${executionId}/execution.json`,
      content: `${JSON.stringify(execution, null, 2)}\n`,
    });

    await collectLogs({
      collectionMode: input.collectionMode,
      entries,
      executionDir,
      executionId,
      largeFiles,
      redaction: input.redaction,
    });
    await collectArtifacts({
      entries,
      executionDir,
      executionId,
      includeSensitiveFiles: input.includeSensitiveFiles,
      largeFiles,
    });
  }

  return { executionRecords, entries, largeFiles };
}

async function readExecutionRecord(
  executionDir: string,
  redaction: RpaRedactionOptions,
): Promise<RpaExecutionRecord> {
  const record = JSON.parse(await readFile(path.join(executionDir, 'execution.json'), 'utf8')) as unknown;
  return redactRpaValue(record, redaction) as RpaExecutionRecord;
}

async function collectLogs(input: {
  collectionMode: RpaReviewBundleRequest['collectionMode'];
  entries: ReviewZipEntry[];
  executionDir: string;
  executionId: string;
  largeFiles: RpaLargeFileReference[];
  redaction: RpaRedactionOptions;
}): Promise<void> {
  const logFiles = [
    { sourcePath: path.join(input.executionDir, 'logs', 'stdout.log'), stream: 'stdout' },
    { sourcePath: path.join(input.executionDir, 'logs', 'stderr.log'), stream: 'stderr' },
    { sourcePath: path.join(input.executionDir, 'events.jsonl'), stream: 'events' },
  ] as const;
  const existing = (
    await Promise.all(
      logFiles.map(async (file) => {
        const content = await readOptionalFile(file.sourcePath);
        return content ? { ...file, content } : null;
      }),
    )
  ).filter((file): file is NonNullable<typeof file> => file !== null);

  if (input.collectionMode === 'lite') {
    for (const file of existing) {
      input.largeFiles.push({
        path: `extensions/rpa/executions/${input.executionId}/logs/${file.stream}.log`,
        kind: 'log',
        sizeBytes: file.content.byteLength,
        sha256: sha256(file.content),
        reason: 'collectionMode lite omits execution log content',
        included: false,
      });
    }
    return;
  }

  const lines: string[] = [];
  for (const file of existing) {
    const text =
      input.collectionMode === 'diagnostic'
        ? tailBuffer(file.content, DIAGNOSTIC_LOG_TAIL_BYTES).toString('utf8')
        : file.content.toString('utf8');
    const redacted = redactRpaText(text, input.redaction);
    for (const line of redacted.split('\n').filter((entry) => entry.length > 0)) {
      lines.push(JSON.stringify({ source: file.stream, message: line }));
    }
  }

  if (lines.length > 0) {
    input.entries.push({
      path: `executions/${input.executionId}/execution-log.jsonl`,
      content: `${lines.join('\n')}\n`,
    });
  }
}

async function collectArtifacts(input: {
  entries: ReviewZipEntry[];
  executionDir: string;
  executionId: string;
  includeSensitiveFiles: boolean;
  largeFiles: RpaLargeFileReference[];
}): Promise<void> {
  const artifacts = await listExecutionArtifacts(input.executionDir);
  for (const artifact of artifacts) {
    const bundlePath = `extensions/rpa/executions/${input.executionId}/${artifact.relativePath}`;
    const shouldReference = ['screenshot', 'trace', 'video', 'download'].includes(artifact.role);
    if (shouldReference || !input.includeSensitiveFiles) {
      input.largeFiles.push({
        path: bundlePath,
        kind: artifact.role,
        sizeBytes: artifact.size,
        sha256: artifact.sha256,
        reason: input.includeSensitiveFiles ? 'sensitive file included by request' : 'sensitive file referenced by default',
        included: input.includeSensitiveFiles,
      });
    }
    if (input.includeSensitiveFiles) {
      input.entries.push({
        path: `executions/${input.executionId}/${artifact.relativePath}`,
        content: await readFile(path.join(input.executionDir, artifact.relativePath)),
      });
    }
  }
}

async function readOptionalFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function tailBuffer(buffer: Buffer, maxBytes: number): Buffer {
  return buffer.byteLength <= maxBytes ? buffer : buffer.subarray(buffer.byteLength - maxBytes);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
