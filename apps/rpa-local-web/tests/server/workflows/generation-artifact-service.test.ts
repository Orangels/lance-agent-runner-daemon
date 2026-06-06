import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  optionalGenerationArtifactNames,
  requiredGenerationArtifactNames,
} from '../../../src/shared/artifacts.js';
import type { ArtifactSummary, ArtifactsResponse } from '../../../src/shared/daemon-types.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { resolveFinalFlowDir } from '../../../src/server/codegen/codegen-session-store.js';
import { persistRequiredGenerationArtifacts } from '../../../src/server/workflows/generation-artifact-service.js';

describe('generation artifact service', () => {
  it('downloads required and optional output artifacts into the final flow directory', async () => {
    const storageRoot = await createStorageRoot();
    const daemonClient = createDaemonClient({
      artifacts: {
        artifacts: [...generationArtifacts(), nonOutputArtifact()],
      },
    });

    const persisted = await persistRequiredGenerationArtifacts({
      daemonClient,
      storageRoot,
      flowId: 'case_query',
      runId: 'run_1',
      tempSuffix: 'cg_abc123',
      generator: { mode: 'codegen', skillId: 'playwright-rpa-harden', daemonRunId: 'run_1' },
    });

    expect(persisted.map((artifact) => artifact.fileName)).toEqual([
      ...requiredGenerationArtifactNames,
      ...optionalGenerationArtifactNames,
    ]);
    for (const fileName of [...requiredGenerationArtifactNames, ...optionalGenerationArtifactNames]) {
      await expect(readFile(path.join(storageRoot, 'flows', 'case_query', fileName), 'utf8')).resolves.toContain(
        fileName === 'flow.dsl.json' ? '"flow_id": "case_query"' : fileName,
      );
    }
    expect(daemonClient.downloadArtifact.mock.calls.map(([input]) => input.artifactId)).toEqual(
      [...requiredGenerationArtifactNames, ...optionalGenerationArtifactNames].map((name) => `art_${name}`),
    );
    await expect(
      readFile(path.join(storageRoot, 'flows', 'case_query', 'flow.local.json'), 'utf8'),
    ).resolves.toContain('"source": "generated"');
    await expect(readdir(`${resolveFinalFlowDir(storageRoot, 'case_query')}.tmp-cg_abc123`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('ignores known Claude tool state files under hidden output directories', async () => {
    const storageRoot = await createStorageRoot();
    const daemonClient = createDaemonClient({
      artifacts: {
        artifacts: [
          ...generationArtifacts(),
          {
            ...artifact('620d46a7-session.json'),
            id: 'art_omc_session',
            ruleId: 'rpa-other-output',
            role: 'supporting',
            relativePath: 'output/.omc/sessions/620d46a7-session.json',
            fileName: '620d46a7-session.json',
          },
        ],
      },
    });

    const persisted = await persistRequiredGenerationArtifacts({
      daemonClient,
      storageRoot,
      flowId: 'weather_lookup',
      runId: 'run_omc',
      tempSuffix: 'nl_omc',
      generator: { mode: 'nl', skillId: 'rpa-script-generate', daemonRunId: 'run_omc' },
    });

    expect(persisted.map((artifact) => artifact.fileName)).toEqual([
      ...requiredGenerationArtifactNames,
      ...optionalGenerationArtifactNames,
    ]);
    expect(daemonClient.downloadArtifact).not.toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'art_omc_session' }),
    );
    await expect(
      readFile(path.join(storageRoot, 'flows', 'weather_lookup', '620d46a7-session.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores Python bytecode cache files created while generating artifacts', async () => {
    const storageRoot = await createStorageRoot();
    const daemonClient = createDaemonClient({
      artifacts: {
        artifacts: [
          ...generationArtifacts(),
          {
            ...artifact('flow.hardened.cpython-313.pyc'),
            id: 'art_python_cache',
            ruleId: 'rpa-other-output',
            role: 'supporting',
            relativePath: 'output/__pycache__/flow.hardened.cpython-313.pyc',
            fileName: 'flow.hardened.cpython-313.pyc',
          },
        ],
      },
    });

    const persisted = await persistRequiredGenerationArtifacts({
      daemonClient,
      storageRoot,
      flowId: 'weather_lookup',
      runId: 'run_pyc',
      tempSuffix: 'nl_pyc',
      generator: { mode: 'nl', skillId: 'rpa-script-generate', daemonRunId: 'run_pyc' },
    });

    expect(persisted.map((artifact) => artifact.fileName)).toEqual([
      ...requiredGenerationArtifactNames,
      ...optionalGenerationArtifactNames,
    ]);
    expect(daemonClient.downloadArtifact).not.toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'art_python_cache' }),
    );
    await expect(
      readFile(path.join(storageRoot, 'flows', 'weather_lookup', 'flow.hardened.cpython-313.pyc'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('downloads allowed supporting artifacts while preserving their relative paths', async () => {
    const storageRoot = await createStorageRoot();
    const daemonClient = createDaemonClient({
      artifacts: {
        artifacts: [
          ...generationArtifacts(),
          {
            ...artifact('weather_parser.py'),
            id: 'art_helper',
            ruleId: 'rpa-supporting-output',
            role: 'supporting',
            relativePath: 'output/helpers/weather_parser.py',
            fileName: 'weather_parser.py',
          },
          {
            ...artifact('weather.schema.json'),
            id: 'art_schema',
            ruleId: 'rpa-supporting-output',
            role: 'supporting',
            relativePath: 'output/schemas/weather.schema.json',
            fileName: 'weather.schema.json',
          },
          {
            ...artifact('selector-notes.md'),
            id: 'art_notes',
            ruleId: 'rpa-supporting-output',
            role: 'supporting',
            relativePath: 'output/notes/selector-notes.md',
            fileName: 'selector-notes.md',
          },
        ],
      },
    });

    const persisted = await persistRequiredGenerationArtifacts({
      daemonClient,
      storageRoot,
      flowId: 'weather_lookup',
      runId: 'run_support',
      tempSuffix: 'nl_support',
      generator: { mode: 'nl', skillId: 'rpa-script-generate', daemonRunId: 'run_support' },
    });

    expect(persisted.map((artifact) => artifact.relativePath)).toEqual([
      ...requiredGenerationArtifactNames.map((name) => `output/${name}`),
      ...optionalGenerationArtifactNames.map((name) => `output/${name}`),
      'output/helpers/weather_parser.py',
      'output/notes/selector-notes.md',
      'output/schemas/weather.schema.json',
    ]);
    await expect(
      readFile(path.join(storageRoot, 'flows', 'weather_lookup', 'helpers', 'weather_parser.py'), 'utf8'),
    ).resolves.toContain('helper');
    await expect(
      readFile(path.join(storageRoot, 'flows', 'weather_lookup', 'schemas', 'weather.schema.json'), 'utf8'),
    ).resolves.toContain('schema');
    await expect(
      readFile(path.join(storageRoot, 'flows', 'weather_lookup', 'notes', 'selector-notes.md'), 'utf8'),
    ).resolves.toContain('notes');
  });

  it('removes temp artifacts and does not leave a final flow when generated DSL is invalid', async () => {
    const storageRoot = await createStorageRoot();
    const finalFlowDir = resolveFinalFlowDir(storageRoot, 'case_query');
    const daemonClient = createDaemonClient({
      artifacts: { artifacts: generationArtifacts() },
      bodies: {
        'flow.dsl.json': JSON.stringify({ invalid: true }),
      },
    });

    await expect(
      persistRequiredGenerationArtifacts({
        daemonClient,
        storageRoot,
        flowId: 'case_query',
        runId: 'run_1',
        tempSuffix: 'bad_dsl',
        generator: { mode: 'codegen', skillId: 'playwright-rpa-harden', daemonRunId: 'run_1' },
      }),
    ).rejects.toMatchObject({ code: 'DSL_INVALID' });

    await expect(readdir(finalFlowDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(`${finalFlowDir}.tmp-bad_dsl`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails before downloading when a required artifact is missing', async () => {
    const storageRoot = await createStorageRoot();
    const daemonClient = createDaemonClient({
      artifacts: {
        artifacts: [
          ...requiredGenerationArtifactNames.slice(1).map((name) => artifact(name)),
          nonOutputArtifact(),
        ],
      },
    });

    await expect(
      persistRequiredGenerationArtifacts({
        daemonClient,
        storageRoot,
        flowId: 'case_query',
        runId: 'run_1',
        tempSuffix: 'missing_required',
        generator: { mode: 'codegen', skillId: 'playwright-rpa-harden', daemonRunId: 'run_1' },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_VALIDATION_FAILED' });

    expect(daemonClient.downloadArtifact).not.toHaveBeenCalled();
    await expect(readdir(resolveFinalFlowDir(storageRoot, 'case_query'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createStorageRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'rpa-generation-artifacts-'));
}

function createDaemonClient(input: {
  artifacts: ArtifactsResponse;
  bodies?: Record<string, string>;
}) {
  return {
    listRunArtifacts: vi.fn(async () => input.artifacts),
    downloadArtifact: vi.fn(async ({ artifactId }: { runId: string; artifactId: string }) => {
      const fileName = artifactId.replace(/^art_/, '');
      return new Response(input.bodies?.[fileName] ?? artifactBody(fileName));
    }),
  };
}

function artifactBody(fileName: string): string {
  if (fileName === 'flow.dsl.json') {
    return JSON.stringify({ ...createMinimalRpaDsl(), flow_id: 'case_query' }, null, 2);
  }
  return `${fileName}\n`;
}

function generationArtifacts(): ArtifactSummary[] {
  return [...requiredGenerationArtifactNames, ...optionalGenerationArtifactNames].map((name) => artifact(name));
}

function artifact(fileName: string): ArtifactSummary {
  return {
    id: `art_${fileName}`,
    runId: 'run_1',
    workspaceId: 'ws_1',
    ruleId: 'rpa-output',
    role: 'primary',
    relativePath: `output/${fileName}`,
    fileName,
    mimeType: fileName.endsWith('.json') ? 'application/json' : 'text/plain',
    size: 100,
    mtime: 1,
    sha256: 'a'.repeat(64),
  };
}

function nonOutputArtifact(): ArtifactSummary {
  return {
    ...artifact('notes.txt'),
    id: 'art_notes',
    relativePath: 'work/notes.txt',
    fileName: 'notes.txt',
  };
}
