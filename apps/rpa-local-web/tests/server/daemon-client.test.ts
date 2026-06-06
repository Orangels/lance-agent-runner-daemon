import { describe, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonClientError } from '../../src/server/daemon-client.js';

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('RPA daemon client', () => {
  it('creates runs with bearer auth and JSON body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        runId: 'run_1',
        status: 'queued',
        conversationId: 'conv_1',
        userMessageId: 'msg_user',
        assistantMessageId: 'msg_assistant',
      }),
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon.local/',
      apiKey: 'secret',
      fetchImpl,
    });

    await expect(
      client.createRun({
        profileId: 'rpa-local',
        workspaceId: 'ws_1',
        kind: 'generate',
        promptMode: 'business-context',
        currentPrompt: 'Harden the uploaded codegen script.',
        skillId: 'playwright-rpa-harden',
      }),
    ).resolves.toMatchObject({ runId: 'run_1' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://daemon.local/api/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"skillId":"playwright-rpa-harden"'),
      }),
    );
  });

  it('uploads workspace files using multipart form data', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        workspaceId: 'ws_1',
        workspaceKey: 'rpa/local/flow',
        file: {
          targetPath: 'input/flow.py',
          size: 12,
          originalName: 'flow.py',
          mimeType: 'text/x-python',
        },
      }),
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon.local',
      apiKey: 'secret',
      fetchImpl,
    });
    const file = new File(['print(1)'], 'flow.py', { type: 'text/x-python' });

    await client.uploadWorkspaceFile({ workspaceId: 'ws_1', file, targetPath: 'input/flow.py' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://daemon.local/api/workspaces/ws_1/files',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: expect.any(FormData),
      }),
    );
  });

  it('cancels runs and lists artifacts', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ artifacts: [] }));
    const client = new DaemonClient({
      baseUrl: 'http://daemon.local',
      apiKey: 'secret',
      fetchImpl,
    });

    await expect(client.cancelRun('run_1')).resolves.toEqual({ ok: true });
    await expect(client.listRunArtifacts('run_1')).resolves.toEqual({ artifacts: [] });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://daemon.local/api/runs/run_1/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://daemon.local/api/runs/run_1/artifacts',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('parses SSE event records from daemon event streams', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`id: 1
event: message
data: {"type":"status","label":"running"}

`),
        );
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const client = new DaemonClient({
      baseUrl: 'http://daemon.local',
      apiKey: 'secret',
      fetchImpl,
    });

    const records = [];
    for await (const record of client.subscribeRunEvents('run_1')) {
      records.push(record);
    }

    expect(records).toEqual([
      {
        id: '1',
        event: { type: 'status', label: 'running' },
      },
    ]);
  });

  it('throws structured daemon errors', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'BAD_REQUEST', message: 'Invalid request' } },
        { status: 400 },
      ),
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon.local',
      apiKey: 'secret',
      fetchImpl,
    });

    await expect(
      client.createWorkspace({
        profileId: 'rpa-local',
        workspace: { originId: 'rpa', userId: 'local', projectId: 'flow' },
      }),
    ).rejects.toMatchObject({
      name: 'DaemonClientError',
      status: 400,
      code: 'BAD_REQUEST',
    });
  });
});
