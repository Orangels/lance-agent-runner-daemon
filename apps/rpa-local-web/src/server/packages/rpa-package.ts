import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
  requiredGenerationArtifactNames,
  type RequiredGenerationArtifactName,
  type RpaFlowLocalMetadata,
  type RpaPackageManifest,
} from '../../shared/artifacts.js';
import type { RpaDslDocument } from '../../shared/dsl-schema.js';
import {
  buildRpaPackageManifest,
  readFlowLocalMetadata,
  resolveFlowArtifactPath,
  resolveFlowDir,
  resolveFlowsRoot,
  safeFlowId,
  writeFlowLocalMetadata,
} from '../flow-store.js';
import { validateRpaDsl } from '../validators/dsl-validator.js';
import { createUncompressedZip, readUncompressedZipEntries, type ReviewZipEntry } from '../zip/uncompressed-zip.js';
import { parseRpaPackageManifest } from './manifest-schema.js';

export interface ExportRpaPackageInput {
  storageRoot: string;
  flowId: string;
}

export interface ExportRpaPackageResult {
  fileName: string;
  content: Buffer;
  mimeType: 'application/zip';
}

export interface ImportRpaPackageInput {
  storageRoot: string;
  packageFileName: string;
  content: Buffer;
}

export interface ImportRpaPackageResult {
  flowId: string;
  title: string;
  source: 'imported';
  requiresVerifyBeforeRun: true;
  importedAt: string;
  packageSha256: `sha256:${string}`;
  ignoredEntries: string[];
}

export class RpaPackageError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'RpaPackageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function exportRpaPackage(input: ExportRpaPackageInput): Promise<ExportRpaPackageResult> {
  const storageRoot = path.resolve(input.storageRoot);
  const flowId = safeFlowId(input.flowId);
  const flowsRoot = resolveFlowsRoot(storageRoot);
  const flowDir = resolveFlowDir(storageRoot, flowId);
  const dsl = await readDslArtifact(path.join(flowDir, 'flow.dsl.json'));
  if (dsl.flow_id !== flowId) {
    throw new RpaPackageError('FLOW_ID_MISMATCH', 'DSL flow_id does not match requested flow id.');
  }

  const metadata = await readFlowLocalMetadata(flowDir, flowId);
  const manifest = await buildRpaPackageManifest({
    flowDir,
    dsl,
    generator: metadata.generator ?? fallbackGenerator(metadata),
  });
  const entries: ReviewZipEntry[] = [
    { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  for (const artifactName of requiredGenerationArtifactNames) {
    entries.push({
      path: artifactName,
      content: await readFile(resolveFlowArtifactPath(flowsRoot, flowId, artifactName)),
    });
  }

  return {
    fileName: `${flowId}.rpa.zip`,
    content: createUncompressedZip(entries),
    mimeType: 'application/zip',
  };
}

export async function importRpaPackage(input: ImportRpaPackageInput): Promise<ImportRpaPackageResult> {
  const storageRoot = path.resolve(input.storageRoot);
  const packageSha256 = `sha256:${sha256Buffer(input.content)}` as const;
  const entries = readUncompressedZipEntries(input.content);
  const entryMap = new Map(entries.map((entry) => [entry.path, entry]));
  const ignoredEntries = entries
    .map((entry) => entry.path)
    .filter((entryPath) => entryPath !== 'manifest.json' && !isRequiredArtifactName(entryPath));

  for (const entry of entries) {
    if (isSensitiveEntryPath(entry.path)) {
      throw new RpaPackageError('PACKAGE_SENSITIVE_ENTRY', `Package contains sensitive entry: ${entry.path}.`);
    }
  }

  const manifestEntry = entryMap.get('manifest.json');
  if (!manifestEntry) {
    throw new RpaPackageError('PACKAGE_MANIFEST_MISSING', 'Package is missing manifest.json.');
  }
  const manifest = await parseManifestEntry(manifestEntry.content);
  const flowId = safeFlowId(manifest.flowId);

  for (const artifactName of requiredGenerationArtifactNames) {
    const artifact = entryMap.get(artifactName);
    if (!artifact) {
      throw new RpaPackageError('PACKAGE_ARTIFACT_MISSING', `Package is missing required artifact: ${artifactName}.`);
    }
    const actualChecksum = `sha256:${sha256Buffer(artifact.content)}`;
    if (actualChecksum !== manifest.checksums[artifactName]) {
      throw new RpaPackageError('PACKAGE_CHECKSUM_MISMATCH', `Checksum mismatch for ${artifactName}.`);
    }
  }

  const dsl = parseDslEntry(entryMap.get('flow.dsl.json')!.content);
  const dslValidation = validateRpaDsl(dsl);
  if (!dslValidation.ok) {
    throw new RpaPackageError(
      'PACKAGE_DSL_INVALID',
      `Package DSL failed validation: ${dslValidation.errors.map((issue) => issue.code).join(', ')}.`,
    );
  }
  if (dsl.flow_id !== flowId) {
    throw new RpaPackageError('PACKAGE_FLOW_ID_MISMATCH', 'Manifest flowId does not match DSL flow_id.');
  }

  const flowDir = resolveFlowDir(storageRoot, flowId);
  if (await pathExists(flowDir)) {
    throw new RpaPackageError('FLOW_ALREADY_EXISTS', `Flow already exists: ${flowId}.`, 409);
  }

  const tempFlowDir = `${flowDir}.tmp-import-${Date.now()}`;
  await rm(tempFlowDir, { recursive: true, force: true });
  await mkdir(tempFlowDir, { recursive: true });
  let promoted = false;
  try {
    for (const artifactName of requiredGenerationArtifactNames) {
      await writeFile(path.join(tempFlowDir, artifactName), entryMap.get(artifactName)!.content);
    }
    const importedAt = new Date().toISOString();
    const metadata: RpaFlowLocalMetadata = {
      schemaVersion: RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
      flowId,
      source: 'imported',
      createdAt: importedAt,
      generator: { mode: 'imported' },
      requiresVerifyBeforeRun: true,
      imported: {
        originalFlowId: manifest.flowId,
        packageCreatedAt: manifest.createdAt,
        packageSha256,
        packageFileName: sanitizePackageFileName(input.packageFileName),
      },
    };
    await writeFlowLocalMetadata(tempFlowDir, metadata);
    await mkdir(path.dirname(flowDir), { recursive: true });
    await rename(tempFlowDir, flowDir);
    promoted = true;
    return {
      flowId,
      title: dsl.meta.title,
      source: 'imported',
      requiresVerifyBeforeRun: true,
      importedAt,
      packageSha256,
      ignoredEntries,
    };
  } finally {
    if (!promoted) {
      await rm(tempFlowDir, { recursive: true, force: true });
    }
  }
}

function fallbackGenerator(metadata: RpaFlowLocalMetadata): RpaPackageManifest['generator'] {
  return metadata.source === 'imported' ? { mode: 'imported' } : { mode: 'codegen' };
}

async function readDslArtifact(filePath: string): Promise<RpaDslDocument> {
  const dsl = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  const validation = validateRpaDsl(dsl);
  if (!validation.ok) {
    throw new RpaPackageError(
      'DSL_INVALID',
      `Flow DSL failed validation: ${validation.errors.map((issue) => issue.code).join(', ')}.`,
    );
  }
  return dsl as RpaDslDocument;
}

async function parseManifestEntry(content: Buffer): Promise<RpaPackageManifest> {
  try {
    return await parseRpaPackageManifest(JSON.parse(content.toString('utf8')));
  } catch (error) {
    if (error instanceof Error && error.name === 'RpaPackageManifestError') {
      throw new RpaPackageError(readManifestErrorCode(error), error.message);
    }
    throw new RpaPackageError('PACKAGE_MANIFEST_INVALID', 'Package manifest is not valid JSON.');
  }
}

function readManifestErrorCode(error: Error): string {
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : 'PACKAGE_MANIFEST_INVALID';
}

function parseDslEntry(content: Buffer): RpaDslDocument {
  try {
    return JSON.parse(content.toString('utf8')) as RpaDslDocument;
  } catch {
    throw new RpaPackageError('PACKAGE_DSL_INVALID', 'Package DSL is not valid JSON.');
  }
}

function isRequiredArtifactName(entryPath: string): entryPath is RequiredGenerationArtifactName {
  return requiredGenerationArtifactNames.includes(entryPath as RequiredGenerationArtifactName);
}

function isSensitiveEntryPath(entryPath: string): boolean {
  const normalized = entryPath.toLowerCase();
  if (/\.(env|pem|key|pfx|p12|crt|cer)$/i.test(normalized)) return true;
  return normalized
    .split('/')
    .some((part) =>
      /(^|[._-])(storage_state|trace|video|downloads?|cookies?|tokens?|secrets?|passwords?|ca_|usbkey)([._-]|$)/.test(part),
    );
}

function sanitizePackageFileName(fileName: string): string {
  return path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function sha256Buffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
