import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

const profile = {
  id: 'report-docx',
  allowedSkillIds: ['report-gen'],
  artifactRules: [{ id: 'report-docx', role: 'primary', pattern: 'output/*.docx' }],
  defaultArtifactRuleIds: ['report-docx'],
  defaultModel: 'opus',
  allowedModels: ['opus'],
  eventVisibility: 'normal',
  maxCollectionMode: 'lite',
  permissionMode: 'bypassPermissions',
  profileConcurrency: 1,
  runTimeoutMs: null,
  inactivityTimeoutMs: null,
  cancelGraceMs: 5000,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    status: 200,
    ...init,
  });
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function runDetail(runId: string, status: 'succeeded' | 'running', content: string) {
  return {
    run: {
      id: runId,
      workspaceId: 'ws_1',
      profileId: 'report-docx',
      kind: 'generate',
      skillId: 'report-gen',
      status,
      lastRunEventId: '2',
      queuedAt: 1,
      startedAt: 2,
      finishedAt: status === 'succeeded' ? 3 : null,
      createdAt: 1,
      updatedAt: 3,
    },
    messages: [
      {
        id: `msg_${runId}_user`,
        role: 'user',
        content: 'Prompt',
        thinkingContent: '',
        events: null,
        runStatus: null,
        lastRunEventId: null,
        startedAt: null,
        endedAt: null,
        position: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: `msg_${runId}_assistant`,
        role: 'assistant',
        content,
        thinkingContent: '',
        events: [{ type: 'end', status }],
        runStatus: status,
        lastRunEventId: '2',
        startedAt: 2,
        endedAt: status === 'succeeded' ? 3 : null,
        position: 2,
        createdAt: 1,
        updatedAt: 3,
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App daemon flows', () => {
  it('runs generate with SSE and then reconciles durable detail', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/profiles')) return jsonResponse({ profiles: [profile] });
      if (url.endsWith('/api/workspaces')) return jsonResponse({ workspaceId: 'ws_1', workspaceKey: 'demo/user_001/project_001' });
      if (url.endsWith('/api/runs') && init?.method === 'POST') return jsonResponse({ runId: 'run_1', status: 'queued' }, { status: 202 });
      if (url.endsWith('/api/runs/run_1/events')) {
        return streamResponse([
          'id: 1\nevent: agent\ndata: {"type":"text_delta","delta":"Hello "}\n\n',
          'id: 2\nevent: agent\ndata: {"type":"end","status":"succeeded"}\n\n',
        ]);
      }
      if (url.endsWith('/api/runs/run_1')) return jsonResponse(runDetail('run_1', 'succeeded', 'Hello report'));
      if (url.endsWith('/api/runs/run_1/artifacts')) return jsonResponse({ artifacts: [] });
      return jsonResponse({ error: { code: 'NOT_FOUND', message: url } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    render(<App />);
    await userEvent.type(screen.getByLabelText('API Key'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Load profiles' }));
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('report-docx'));
    await userEvent.type(screen.getByLabelText('Prompt'), 'Generate a report');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Hello report')).toBeInTheDocument();
    const eventsCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('/events'));
    expect(eventsCall?.[0]).toBe('/api/runs/run_1/events');
    expect(eventsCall?.[1]).toMatchObject({ headers: { Authorization: 'Bearer secret' } });
  });

  it('runs generate without SSE by polling lightweight status and then artifacts', async () => {
    const artifact = {
      id: 'artifact_1',
      runId: 'run_2',
      workspaceId: 'ws_1',
      ruleId: 'report-docx',
      role: 'primary',
      relativePath: 'output/report.docx',
      fileName: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 4,
      mtime: 3,
      sha256: 'abc123',
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/profiles')) return jsonResponse({ profiles: [profile] });
      if (url.endsWith('/api/workspaces')) return jsonResponse({ workspaceId: 'ws_1', workspaceKey: 'demo/user_001/project_001' });
      if (url.endsWith('/api/runs') && init?.method === 'POST') return jsonResponse({ runId: 'run_2', status: 'queued' }, { status: 202 });
      if (url.endsWith('/api/runs/run_2/status')) {
        return jsonResponse({ run: runDetail('run_2', 'succeeded', 'Durable report').run, terminal: true });
      }
      if (url.endsWith('/api/runs/run_2/artifacts')) return jsonResponse({ artifacts: [artifact] });
      return jsonResponse({ error: { code: 'NOT_FOUND', message: url } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    render(<App />);
    await userEvent.type(screen.getByLabelText('API Key'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Load profiles' }));
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('report-docx'));
    await userEvent.click(screen.getByRole('radio', { name: 'Generate + Poll' }));
    await userEvent.type(screen.getByLabelText('Prompt'), 'Generate without streaming');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getAllByText('report.docx').length).toBeGreaterThan(0));
    expect(screen.queryByText('Durable report')).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/events'))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/api/runs/run_2'))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/api/runs/run_2/status'))).toBe(true);
  });

  it('runs revise against the existing workspace and omits skillId', async () => {
    const runBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/profiles')) return jsonResponse({ profiles: [profile] });
      if (url.endsWith('/api/workspaces')) return jsonResponse({ workspaceId: 'ws_1', workspaceKey: 'demo/user_001/project_001' });
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        runBodies.push(JSON.parse(String(init.body)));
        const runId = runBodies.length === 1 ? 'run_3' : 'run_4';
        return jsonResponse({ runId, status: 'queued' }, { status: 202 });
      }
      if (url.endsWith('/api/runs/run_3/events')) return streamResponse(['event: agent\ndata: {"type":"end","status":"succeeded"}\n\n']);
      if (url.endsWith('/api/runs/run_4/events')) return streamResponse(['event: agent\ndata: {"type":"end","status":"succeeded"}\n\n']);
      if (url.endsWith('/api/runs/run_3')) return jsonResponse(runDetail('run_3', 'succeeded', 'Generated'));
      if (url.endsWith('/api/runs/run_4')) return jsonResponse(runDetail('run_4', 'succeeded', 'Revised'));
      if (url.includes('/artifacts')) return jsonResponse({ artifacts: [] });
      return jsonResponse({ error: { code: 'NOT_FOUND', message: url } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    render(<App />);
    await userEvent.type(screen.getByLabelText('API Key'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Load profiles' }));
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('report-docx'));
    await userEvent.type(screen.getByLabelText('Prompt'), 'Generate first');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Generated');

    await userEvent.click(screen.getByRole('radio', { name: 'Revise' }));
    await userEvent.type(screen.getByLabelText('Prompt'), 'Revise the report');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Revised')).toBeInTheDocument();
    await waitFor(() => expect(runBodies).toHaveLength(2));
    expect(runBodies[1]).toMatchObject({ kind: 'revise', workspaceId: 'ws_1' });
    expect(runBodies[1]).not.toHaveProperty('skillId');
  });

  it('clears uploaded files after a successful send so revise does not re-upload old files', async () => {
    const uploadUrls: string[] = [];
    let runCreateCount = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/profiles')) return jsonResponse({ profiles: [profile] });
      if (url.endsWith('/api/workspaces')) return jsonResponse({ workspaceId: 'ws_1', workspaceKey: 'demo/user_001/project_001' });
      if (url.endsWith('/files') && init?.method === 'POST') {
        uploadUrls.push(url);
        return jsonResponse({
          workspaceId: 'ws_1',
          workspaceKey: 'demo/user_001/project_001',
          file: { targetPath: 'input/source.docx', size: 4, originalName: 'source.docx', mimeType: null },
        });
      }
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        runCreateCount += 1;
        const runId = runCreateCount === 1 ? 'run_upload_1' : 'run_upload_2';
        return jsonResponse({ runId, status: 'queued' }, { status: 202 });
      }
      if (url.includes('/events')) return streamResponse(['event: agent\ndata: {"type":"end","status":"succeeded"}\n\n']);
      if (url.endsWith('/api/runs/run_upload_1')) return jsonResponse(runDetail('run_upload_1', 'succeeded', 'Generated'));
      if (url.endsWith('/api/runs/run_upload_2')) return jsonResponse(runDetail('run_upload_2', 'succeeded', 'Revised'));
      if (url.includes('/artifacts')) return jsonResponse({ artifacts: [] });
      return jsonResponse({ error: { code: 'NOT_FOUND', message: url } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    render(<App />);
    await userEvent.type(screen.getByLabelText('API Key'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Load profiles' }));
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('report-docx'));
    await userEvent.upload(screen.getByLabelText('Input files'), new File(['docx'], 'source.docx'));
    await userEvent.type(screen.getByLabelText('Prompt'), 'Generate with file');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Generated');

    await userEvent.click(screen.getByRole('radio', { name: 'Revise' }));
    await userEvent.type(screen.getByLabelText('Prompt'), 'Revise without new upload');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Revised');

    expect(uploadUrls).toHaveLength(1);
  });
});
