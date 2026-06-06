import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLOW_LOCAL_METADATA_FILE,
  writeFlowLocalMetadata,
} from '../../../src/server/flow-store.js';
import { exportRpaPackage, importRpaPackage } from '../../../src/server/packages/rpa-package.js';
import { createUncompressedZip, readUncompressedZipEntries } from '../../../src/server/zip/uncompressed-zip.js';
import {
  RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
  requiredGenerationArtifactNames,
  type RpaFlowLocalMetadata,
} from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl, type RpaDslDocument } from '../../../src/shared/dsl-schema.js';

describe('RPA package service', () => {
  it('exports only manifest and required generation artifacts', async () => {
    const storageRoot = await createStorageRoot();
    await writeFlow(storageRoot, dslFixture());
    await writeFile(path.join(storageRoot, 'flows', 'case_query', 'storage_state.json'), '{"cookies":[]}\n');
    await writeFile(path.join(storageRoot, 'flows', 'case_query', 'trace.zip'), 'trace\n');

    const exported = await exportRpaPackage({ storageRoot, flowId: 'case_query' });

    expect(exported).toMatchObject({
      fileName: 'case_query.rpa.zip',
      mimeType: 'application/zip',
    });
    const entries = readUncompressedZipEntries(exported.content);
    expect(entries.map((entry) => entry.path)).toEqual(['manifest.json', ...requiredGenerationArtifactNames]);
    expect(JSON.parse(entryText(entries, 'manifest.json'))).toMatchObject({
      flowId: 'case_query',
      artifacts: {
        dsl: 'flow.dsl.json',
        script: 'flow.hardened.py',
      },
    });
  });

  it('imports a package after validating manifest, checksums, DSL, and flow id', async () => {
    const sourceRoot = await createStorageRoot();
    await writeFlow(sourceRoot, dslFixture());
    const exported = await exportRpaPackage({ storageRoot: sourceRoot, flowId: 'case_query' });

    const targetRoot = await createStorageRoot();
    const imported = await importRpaPackage({
      storageRoot: targetRoot,
      packageFileName: exported.fileName,
      content: exported.content,
    });

    expect(imported).toMatchObject({
      flowId: 'case_query',
      title: 'Case Query',
      source: 'imported',
      requiresVerifyBeforeRun: true,
      ignoredEntries: [],
    });
    expect(imported.packageSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    const importedFiles = await readdir(path.join(targetRoot, 'flows', 'case_query'));
    expect(importedFiles.sort()).toEqual([...requiredGenerationArtifactNames, FLOW_LOCAL_METADATA_FILE].sort());
    const metadata = JSON.parse(
      await readFile(path.join(targetRoot, 'flows', 'case_query', FLOW_LOCAL_METADATA_FILE), 'utf8'),
    ) as RpaFlowLocalMetadata;
    expect(metadata).toMatchObject({
      schemaVersion: RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
      flowId: 'case_query',
      source: 'imported',
      requiresVerifyBeforeRun: true,
      imported: {
        originalFlowId: 'case_query',
        packageFileName: exported.fileName,
        packageSha256: imported.packageSha256,
      },
    });
  });

  it('rejects duplicate flow ids', async () => {
    const sourceRoot = await createStorageRoot();
    await writeFlow(sourceRoot, dslFixture());
    const exported = await exportRpaPackage({ storageRoot: sourceRoot, flowId: 'case_query' });

    const targetRoot = await createStorageRoot();
    await writeFlow(targetRoot, dslFixture());

    await expect(
      importRpaPackage({ storageRoot: targetRoot, packageFileName: exported.fileName, content: exported.content }),
    ).rejects.toMatchObject({ code: 'FLOW_ALREADY_EXISTS' });
  });

  it('rejects sensitive package entries', async () => {
    const sourceRoot = await createStorageRoot();
    await writeFlow(sourceRoot, dslFixture());
    const exported = await exportRpaPackage({ storageRoot: sourceRoot, flowId: 'case_query' });
    const sensitivePackage = createUncompressedZip([
      ...readUncompressedZipEntries(exported.content),
      { path: 'storage_state.json', content: '{"cookies":[]}\n' },
    ]);

    await expect(
      importRpaPackage({
        storageRoot: await createStorageRoot(),
        packageFileName: 'case_query.rpa.zip',
        content: sensitivePackage,
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_SENSITIVE_ENTRY' });
  });

  it('rejects checksum and DSL flow id mismatches', async () => {
    const sourceRoot = await createStorageRoot();
    await writeFlow(sourceRoot, dslFixture());
    const exported = await exportRpaPackage({ storageRoot: sourceRoot, flowId: 'case_query' });
    const entries = readUncompressedZipEntries(exported.content);

    const checksumMismatch = createUncompressedZip(
      entries.map((entry) =>
        entry.path === 'flow.hardened.py' ? { path: entry.path, content: '# tampered\n' } : entry,
      ),
    );
    await expect(
      importRpaPackage({
        storageRoot: await createStorageRoot(),
        packageFileName: exported.fileName,
        content: checksumMismatch,
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_CHECKSUM_MISMATCH' });

    const flowIdMismatch = createUncompressedZip(
      entries.map((entry) =>
        entry.path === 'flow.dsl.json'
          ? { path: entry.path, content: `${JSON.stringify({ ...dslFixture(), flow_id: 'other_flow' }, null, 2)}\n` }
          : entry,
      ),
    );
    await expect(
      importRpaPackage({
        storageRoot: await createStorageRoot(),
        packageFileName: exported.fileName,
        content: flowIdMismatch,
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_CHECKSUM_MISMATCH' });
  });
});

async function createStorageRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'rpa-package-'));
}

async function writeFlow(storageRoot: string, dsl: RpaDslDocument): Promise<void> {
  const flowDir = path.join(storageRoot, 'flows', dsl.flow_id);
  await mkdir(flowDir, { recursive: true });
  for (const artifactName of requiredGenerationArtifactNames) {
    await writeFile(path.join(flowDir, artifactName), artifactBody(artifactName, dsl), 'utf8');
  }
  await writeFlowLocalMetadata(flowDir, {
    schemaVersion: RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
    flowId: dsl.flow_id,
    source: 'generated',
    createdAt: '2026-06-06T00:00:00.000Z',
    generator: { mode: 'codegen', skillId: 'playwright-rpa-harden', daemonRunId: 'run_1' },
    requiresVerifyBeforeRun: false,
  });
}

function dslFixture(): RpaDslDocument {
  return {
    ...createMinimalRpaDsl(),
    flow_id: 'case_query',
    meta: {
      ...createMinimalRpaDsl().meta,
      title: 'Case Query',
    },
  };
}

function artifactBody(artifactName: string, dsl: RpaDslDocument): string {
  if (artifactName === 'flow.dsl.json') return `${JSON.stringify(dsl, null, 2)}\n`;
  return `${artifactName}\n`;
}

function entryText(entries: Array<{ path: string; content: Buffer }>, entryPath: string): string {
  const entry = entries.find((candidate) => candidate.path === entryPath);
  if (!entry) throw new Error(`Missing entry: ${entryPath}`);
  return entry.content.toString('utf8');
}
