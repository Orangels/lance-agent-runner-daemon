import { describe, expect, it, vi } from 'vitest';
import { DaemonApiError, DaemonClient } from '../daemon-client.js';
import { fetchArtifactDownload, getDownloadFileName } from '../download.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    status: 200,
    ...init,
  });
}

describe('DaemonClient', () => {
  it('calls health without auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new DaemonClient({ baseUrl: 'http://daemon.test/', apiKey: 'secret', fetchImpl });

    await expect(client.getHealth()).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledWith('http://daemon.test/api/health', {
      headers: {},
      method: 'GET',
    });
  });

  it('supports same-origin API paths for the local Vite proxy', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new DaemonClient({ baseUrl: '', apiKey: 'secret', fetchImpl });

    await client.getHealth();

    expect(fetchImpl).toHaveBeenCalledWith('/api/health', {
      headers: {},
      method: 'GET',
    });
  });

  it('adds bearer auth to protected JSON requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ profiles: [] }));
    const client = new DaemonClient({ baseUrl: 'http://daemon.test', apiKey: 'secret', fetchImpl });

    await client.getProfiles();

    expect(fetchImpl).toHaveBeenCalledWith('http://daemon.test/api/profiles', {
      headers: { Authorization: 'Bearer secret' },
      method: 'GET',
    });
  });

  it('fetches lightweight run status without messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        run: {
          id: 'run_1',
          workspaceId: 'ws_1',
          profileId: 'report-docx',
          kind: 'generate',
          skillId: 'report-gen',
          status: 'succeeded',
          lastRunEventId: '4',
          queuedAt: 1,
          startedAt: 2,
          finishedAt: 3,
          createdAt: 1,
          updatedAt: 3,
          errorCode: null,
          errorMessage: null,
        },
        terminal: true,
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon.test', apiKey: 'secret', fetchImpl });

    await expect(client.getRunStatus('run_1')).resolves.toMatchObject({
      run: { id: 'run_1', status: 'succeeded' },
      terminal: true,
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://daemon.test/api/runs/run_1/status', {
      headers: { Authorization: 'Bearer secret' },
      method: 'GET',
    });
  });

  it('serializes JSON bodies and decodes structured API errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'RUN_QUEUE_FULL',
            message: 'Queue is full',
            details: { limit: 2 },
          },
        },
        { status: 409 },
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon.test', apiKey: 'secret', fetchImpl });

    await expect(
      client.createRun({
        profileId: 'report-docx',
        workspaceId: 'ws_1',
        kind: 'generate',
        skillId: 'report-gen',
        prompt: 'Generate the report',
      }),
    ).rejects.toMatchObject({
      code: 'RUN_QUEUE_FULL',
      message: 'Queue is full',
      status: 409,
      details: { limit: 2 },
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://daemon.test/api/runs', {
      body: JSON.stringify({
        profileId: 'report-docx',
        workspaceId: 'ws_1',
        kind: 'generate',
        skillId: 'report-gen',
        prompt: 'Generate the report',
      }),
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
  });

  it('uploads exactly one file without setting multipart content type manually', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        workspaceId: 'ws_1',
        workspaceKey: 'demo/user/project',
        file: {
          targetPath: 'input/report.docx',
          size: 12,
          originalName: 'report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon.test', apiKey: 'secret', fetchImpl });
    const file = new File(['hello'], 'report.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await client.uploadWorkspaceFile({ workspaceId: 'ws_1', file, targetPath: 'input/report.docx' });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(init.body).toBeInstanceOf(FormData);

    const form = init.body as FormData;
    expect(form.get('targetPath')).toBe('input/report.docx');
    expect(form.get('file')).toBe(file);
  });

  it('throws a generic error when the daemon response is not structured JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('proxy failure', { status: 502, statusText: 'Bad Gateway' }));
    const client = new DaemonClient({ baseUrl: 'http://daemon.test', apiKey: 'secret', fetchImpl });

    await expect(client.getProfiles()).rejects.toEqual(new DaemonApiError(502, 'HTTP_ERROR', 'Bad Gateway'));
  });
});

describe('artifact downloads', () => {
  it('uses content-disposition filename when present', () => {
    expect(getDownloadFileName('attachment; filename="final-report.docx"', 'artifact_1')).toBe('final-report.docx');
  });

  it('prefers UTF-8 content-disposition filenames', () => {
    expect(
      getDownloadFileName(
        "attachment; filename=\"output_2025_8.docx\"; filename*=UTF-8''output_2025%E5%B9%B48%E6%9C%88_%E4%B8%B4%E9%AB%98%E5%8E%BF%E5%85%AC%E5%AE%89%E5%B1%80%E6%8A%A5%E5%91%8A.docx",
        'artifact_1',
      ),
    ).toBe('output_2025年8月_临高县公安局报告.docx');
  });

  it('falls back to artifact id when no filename header is present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('docx', {
        headers: { 'Content-Type': 'application/octet-stream' },
        status: 200,
      }),
    );

    const download = await fetchArtifactDownload({
      baseUrl: 'http://daemon.test',
      apiKey: 'secret',
      runId: 'run_1',
      artifactId: 'artifact_1',
      fetchImpl,
    });

    expect(download.fileName).toBe('artifact_1');
    expect(download.blob.size).toBe(4);
    expect(fetchImpl).toHaveBeenCalledWith('http://daemon.test/api/runs/run_1/artifacts/artifact_1/download', {
      headers: { Authorization: 'Bearer secret' },
      method: 'GET',
    });
  });
});
