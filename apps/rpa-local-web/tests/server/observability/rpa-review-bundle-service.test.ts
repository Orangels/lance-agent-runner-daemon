import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { createRpaReviewBundleService } from '../../../src/server/observability/rpa-review-bundle-service.js';
import { createUncompressedZip, readUncompressedZipEntries } from '../../../src/server/zip/uncompressed-zip.js';

describe('RPA review bundle service', () => {
  it('combines daemon generic bundle with RPA extension entries', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-review-bundle-'));
    const flowDir = path.join(storageRoot, 'flows', 'case_query');
    await mkdir(flowDir, { recursive: true });
    for (const artifactName of requiredGenerationArtifactNames) {
      await writeFile(
        path.join(flowDir, artifactName),
        artifactName === 'flow.dsl.json'
          ? JSON.stringify(createMinimalRpaDsl(), null, 2)
          : `${artifactName}\n`,
      );
    }

    const daemonClient = {
      downloadReviewBundle: vi.fn(async () =>
        new Response(
          toArrayBuffer(createUncompressedZip([
            { path: 'manifest.json', content: JSON.stringify({ collectionMode: 'diagnostic' }) },
            { path: 'review-summary.md', content: 'daemon\n' },
          ])),
        ),
      ),
      listRunFeedback: vi.fn(async () => ({ feedback: [] })),
    };

    const service = createRpaReviewBundleService({ storageRoot, daemonClient });
    const bundle = await service.createReviewBundle({
      flowId: 'case_query',
      daemonRunId: 'run_1',
      executionIds: [],
      includeSensitiveFiles: false,
      collectionMode: 'diagnostic',
    });
    const entries = Object.fromEntries(
      readUncompressedZipEntries(bundle.buffer).map((entry) => [entry.path, entry.content.toString('utf8')]),
    );

    expect(entries['review-summary.md']).toBe('daemon\n');
    expect(entries['extensions/rpa/rpa-summary.md']).toContain('case_query');
    expect(entries['extensions/rpa/rpa-diagnostics.json']).toContain('rpa-diagnostics.v0.1');
    expect(entries['extensions/rpa/dsl-validation.json']).toContain('ok');
    expect(entries['extensions/rpa/artifact-validation.json']).toContain('ok');
  });
});

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
