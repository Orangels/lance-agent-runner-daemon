import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpaLocalServer } from './server.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function withServer(callback: (baseUrl: string) => Promise<void>) {
  const app = await createRpaLocalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      daemonBaseUrl: 'http://daemon.local',
      daemonApiKey: 'secret',
      defaultProfileId: 'rpa-local',
      mode: 'test',
    },
    daemonFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback(`http://127.0.0.1:${port}`);
}

describe('RPA local server', () => {
  it('serves local RPA health and config without exposing daemon API key', async () => {
    await withServer(async (baseUrl) => {
      await expect(fetch(`${baseUrl}/api/rpa/health`).then((res) => res.json())).resolves.toEqual({
        ok: true,
        app: 'rpa-local-web',
      });

      const config = await fetch(`${baseUrl}/api/rpa/config`).then((res) => res.json());
      expect(config).toEqual({
        defaultProfileId: 'rpa-local',
        daemonConfigured: true,
      });
      expect(JSON.stringify(config)).not.toContain('secret');
      expect(JSON.stringify(config)).not.toContain('daemon.local');
    });
  });

  it('checks daemon health through the server-side daemon client', async () => {
    await withServer(async (baseUrl) => {
      await expect(fetch(`${baseUrl}/api/rpa/daemon/health`).then((res) => res.json())).resolves.toEqual({
        ok: true,
        daemonReachable: true,
        status: 200,
      });
    });
  });
});
