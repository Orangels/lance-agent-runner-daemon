import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { createRpaLocalServer } from '../../../src/server/server.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('RPA package routes', () => {
  it('downloads and imports a .rpa.zip package without storage root leaks', async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-package-route-source-'));
    await createFlow(sourceRoot);
    let zip: Buffer | undefined;

    await withServer(sourceRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rpa/flows/case_query/package/download`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/zip');
      expect(response.headers.get('content-disposition')).toContain('case_query.rpa.zip');
      zip = Buffer.from(await response.arrayBuffer());
      expect(zip.toString('utf8')).not.toContain(sourceRoot);
    });

    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-package-route-target-'));
    await withServer(targetRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rpa/flows/import-package`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          'X-RPA-Package-File-Name': 'case_query.rpa.zip',
        },
        body: new Uint8Array(zip!),
      });
      expect(response.status).toBe(201);
      const payload = await response.json();
      expect(payload).toMatchObject({
        flowId: 'case_query',
        source: 'imported',
        requiresVerifyBeforeRun: true,
      });
      expect(JSON.stringify(payload)).not.toContain(targetRoot);
    });
  });
});

async function createFlow(storageRoot: string) {
  const flowDir = path.join(storageRoot, 'flows', 'case_query');
  await mkdir(flowDir, { recursive: true });
  for (const name of requiredGenerationArtifactNames) {
    if (name === 'flow.dsl.json') {
      await writeFile(path.join(flowDir, name), `${JSON.stringify(createMinimalRpaDsl(), null, 2)}\n`);
    } else {
      await writeFile(path.join(flowDir, name), `${name}\n`);
    }
  }
}

async function withServer(storageRoot: string, callback: (baseUrl: string) => Promise<void>) {
  const app = await createRpaLocalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      daemonBaseUrl: 'http://daemon.local',
      daemonApiKey: 'secret',
      defaultProfileId: 'rpa-local',
      storageRoot,
      codegenCommand: 'playwright',
      codegenArgs: ['codegen'],
      mode: 'test',
    },
    daemonFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback(`http://127.0.0.1:${port}`);
}
