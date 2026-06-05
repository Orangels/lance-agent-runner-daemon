import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredGenerationArtifactNames } from '../shared/artifacts.js';
import { createMinimalRpaDsl } from '../shared/dsl-schema.js';
import {
  buildRpaPackageManifest,
  resolveFlowArtifactPath,
  safeFlowId,
  writeJsonFile,
} from './flow-store.js';

describe('RPA flow store helpers', () => {
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
});
