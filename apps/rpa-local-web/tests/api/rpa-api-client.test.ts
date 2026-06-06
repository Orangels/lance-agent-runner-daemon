import { describe, expect, it, vi } from 'vitest';
import { RpaApiClient } from '../../src/api/rpa-api-client.js';

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RPA browser API client', () => {
  it('reads local config from the RPA BFF', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ defaultProfileId: 'rpa-local', daemonConfigured: true }),
    );
    const client = new RpaApiClient({ fetchImpl });

    await expect(client.getConfig()).resolves.toEqual({
      defaultProfileId: 'rpa-local',
      daemonConfigured: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/rpa/config',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns daemon health diagnostic payloads even when the BFF responds 502', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          daemonReachable: false,
          error: 'daemon unavailable',
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new RpaApiClient({ fetchImpl });

    await expect(client.getDaemonHealth()).resolves.toEqual({
      ok: false,
      daemonReachable: false,
      error: 'daemon unavailable',
    });
  });
});
