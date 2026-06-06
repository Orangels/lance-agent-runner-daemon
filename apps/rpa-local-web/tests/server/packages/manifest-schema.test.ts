import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { buildRpaPackageManifest } from '../../../src/server/flow-store.js';
import { parseRpaPackageManifest } from '../../../src/server/packages/manifest-schema.js';

async function validManifest() {
  const flowDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-manifest-schema-'));
  for (const name of requiredGenerationArtifactNames) {
    await writeFile(path.join(flowDir, name), `${name}\n`);
  }
  return buildRpaPackageManifest({
    flowDir,
    dsl: createMinimalRpaDsl(),
    generator: { mode: 'codegen', skillId: 'playwright-rpa-harden', daemonRunId: 'run_1' },
  });
}

describe('RPA package manifest schema', () => {
  it('accepts the MVP manifest shape', async () => {
    await expect(parseRpaPackageManifest(await validManifest())).resolves.toMatchObject({
      schemaVersion: 'rpa-package.v0.1',
      flowId: 'case_query',
      artifacts: { dsl: 'flow.dsl.json', script: 'flow.hardened.py' },
    });
  });

  it('rejects unsupported schema versions and unsafe artifact names', async () => {
    const manifest = await validManifest();
    await expect(parseRpaPackageManifest({ ...manifest, schemaVersion: 'bad' })).rejects.toThrow(
      /PACKAGE_SCHEMA_UNSUPPORTED/,
    );
    await expect(
      parseRpaPackageManifest({
        ...manifest,
        artifacts: { ...manifest.artifacts, script: '../flow.hardened.py' },
      }),
    ).rejects.toThrow(/PACKAGE_MANIFEST_INVALID/);
  });
});
