import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredGenerationArtifactNames } from '../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../src/shared/dsl-schema.js';
import {
  FLOW_LOCAL_METADATA_FILE,
  buildRpaPackageManifest,
  readFlowLocalMetadata,
  resolveFlowArtifactPath,
  resolveFlowsRoot,
  safeFlowId,
  writeFlowLocalMetadata,
  writeJsonFile,
} from '../../src/server/flow-store.js';

describe('RPA flow store helpers', () => {
  it('resolves the shared flows root under storage root', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-root-'));

    expect(resolveFlowsRoot(storageRoot)).toBe(path.join(path.resolve(storageRoot), 'flows'));
  });

  it('resolves flow artifacts under a precomputed flows root without double joining flows', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-artifact-root-'));
    const flowsRoot = resolveFlowsRoot(storageRoot);

    const resolved = resolveFlowArtifactPath(flowsRoot, 'case_query', 'flow.dsl.json');

    expect(resolved).toBe(path.join(flowsRoot, 'case_query', 'flow.dsl.json'));
    expect(resolved).toContain(path.join(storageRoot, 'flows', 'case_query'));
    expect(resolved).not.toContain(path.join('flows', 'flows'));
  });

  it('validates flow ids and confines artifact paths to the flow directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-store-'));

    expect(safeFlowId('case_query')).toBe('case_query');
    expect(() => safeFlowId('../case')).toThrow(/Invalid flow id/);

    const resolved = resolveFlowArtifactPath(root, 'case_query', 'flow.dsl.json');
    expect(resolved.startsWith(path.join(root, 'case_query'))).toBe(true);
    expect(resolveFlowArtifactPath(root, 'case_query', 'flow.py')).toContain('flow.py');
    expect(() => resolveFlowArtifactPath(root, 'case_query', '../secret.json')).toThrow(/Unsafe artifact path/);
    expect(() => resolveFlowArtifactPath(root, 'case_query', 'notes.md')).toThrow(/Unsupported flow artifact/);
  });

  it('writes JSON files with stable formatting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-json-'));
    const filePath = path.join(root, 'flow.dsl.json');

    await writeJsonFile(filePath, createMinimalRpaDsl());

    expect(await readFile(filePath, 'utf8')).toContain('"dsl_version": "rpa-dsl.v0.1"');
  });

  it('builds a manifest with required artifact checksums and masked params', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-manifest-'));
    for (const name of requiredGenerationArtifactNames) {
      await writeFile(path.join(root, name), `${name}\n`);
    }

    const manifest = await buildRpaPackageManifest({
      flowDir: root,
      dsl: createMinimalRpaDsl(),
      generator: {
        mode: 'codegen',
        skillId: 'playwright-rpa-harden',
        daemonRunId: 'run_1',
      },
    });

    expect(manifest.schemaVersion).toBe('rpa-package.v0.1');
    expect(manifest.dsl.version).toBe('rpa-dsl.v0.1');
    expect(manifest.params.maskedParamIds).toEqual(['case_no']);
    expect(Object.keys(manifest.checksums)).toEqual([...requiredGenerationArtifactNames]);
    expect(manifest.checksums['flow.dsl.json']).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('writes and reads browser-safe local flow metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-local-metadata-'));
    const flowDir = path.join(root, 'case_query');

    await writeFlowLocalMetadata(flowDir, {
      schemaVersion: 'rpa-flow-local.v0.1',
      flowId: 'case_query',
      source: 'imported',
      createdAt: '2026-06-06T00:00:00.000Z',
      requiresVerifyBeforeRun: true,
      imported: {
        originalFlowId: 'case_query',
        packageCreatedAt: '2026-06-05T00:00:00.000Z',
        packageSha256: 'sha256:abc',
        packageFileName: 'case_query.rpa.zip',
      },
    });

    expect(await readFlowLocalMetadata(flowDir, 'case_query')).toMatchObject({
      flowId: 'case_query',
      source: 'imported',
      requiresVerifyBeforeRun: true,
      imported: { packageFileName: 'case_query.rpa.zip' },
    });
    expect(await readFile(path.join(flowDir, FLOW_LOCAL_METADATA_FILE), 'utf8')).toContain('rpa-flow-local.v0.1');
  });

  it('returns generated fallback metadata for old generated flows', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-local-metadata-fallback-'));
    const flowDir = path.join(root, 'case_query');

    await writeJsonFile(path.join(flowDir, 'placeholder.json'), { ok: true });

    expect(await readFlowLocalMetadata(flowDir, 'case_query')).toMatchObject({
      schemaVersion: 'rpa-flow-local.v0.1',
      flowId: 'case_query',
      source: 'generated',
      requiresVerifyBeforeRun: false,
    });
  });
});
