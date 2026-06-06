import { describe, expect, it, vi } from 'vitest';
import { RpaApiClient } from '../../src/api/rpa-api-client.js';
import type { RpaExecutionEvent } from '../../src/shared/rpa-api-types.js';

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

  it('loads flow details from the RPA BFF', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ flowId: 'case_query', title: '案件查询', source: 'codegen', dsl: {}, warnings: [] }),
    );
    const client = new RpaApiClient({ fetchImpl });

    await expect(client.getFlow('case_query')).resolves.toMatchObject({ flowId: 'case_query' });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/rpa/flows/case_query',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('starts and cancels executions through JSON endpoints', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ executionId: 'exec_1', flowId: 'case_query', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new RpaApiClient({ fetchImpl });

    await expect(
      client.startExecution({
        flowId: 'case_query',
        mode: 'verify',
        dryRun: true,
        headless: false,
        params: { case_no: 'A123' },
      }),
    ).resolves.toMatchObject({ executionId: 'exec_1' });
    await expect(client.cancelExecution('exec_1')).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      '/api/rpa/executions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          flowId: 'case_query',
          mode: 'verify',
          dryRun: true,
          headless: false,
          params: { case_no: 'A123' },
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      '/api/rpa/executions/exec_1/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('starts, reads, cancels, and answers codegen sessions through JSON endpoints', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'cg_1', flowId: 'case_query', status: 'recording' }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'cg_1', flowId: 'case_query', status: 'needs_input', logs: [] }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'cg_1', status: 'cancelled' }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'cg_1', status: 'hardening' }));
    const client = new RpaApiClient({ fetchImpl });

    await client.startCodegenSession({
      targetUrl: 'https://example.com',
      flowId: 'case_query',
      flowName: 'Case query',
    });
    await client.getCodegenSession('cg_1');
    await client.cancelCodegenSession('cg_1');
    await client.submitCodegenQuestionAnswers('cg_1', {
      formId: 'qf_1',
      answers: { date: '2026-06-06' },
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      '/api/rpa/codegen/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      '/api/rpa/codegen/sessions/cg_1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      '/api/rpa/codegen/sessions/cg_1/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      '/api/rpa/codegen/sessions/cg_1/question-form/answers',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ formId: 'qf_1', answers: { date: '2026-06-06' } }),
      }),
    );
  });

  it('starts, reads, cancels, answers, and repairs natural-language sessions through JSON endpoints', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'nl_1', flowId: 'case_query', status: 'starting' }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'nl_1', flowId: 'case_query', status: 'needs_input', logs: [] }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'nl_1', status: 'generating' }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'nl_1', status: 'repairing' }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'nl_1', status: 'cancelled' }));
    const client = new RpaApiClient({ fetchImpl });

    await client.startNaturalLanguageSession({
      targetUrl: 'https://example.com/cases',
      flowId: 'case_query',
      flowName: 'Case query',
      requirement: 'Search cases.',
      businessConstraints: 'No writes.',
      safetyNotes: 'Ask before submit.',
    });
    await client.getNaturalLanguageSession('nl_1');
    await client.submitNaturalLanguageQuestionAnswers('nl_1', {
      formId: 'qf_1',
      answers: { date: '2026-06-06' },
    });
    await client.repairNaturalLanguageSession('nl_1', {
      executionId: 'exec_1',
      instruction: 'Fix selector.',
    });
    await client.cancelNaturalLanguageSession('nl_1');

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      '/api/rpa/nl/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      '/api/rpa/nl/sessions/nl_1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      '/api/rpa/nl/sessions/nl_1/question-form/answers',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ formId: 'qf_1', answers: { date: '2026-06-06' } }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      '/api/rpa/nl/sessions/nl_1/repair',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ executionId: 'exec_1', instruction: 'Fix selector.' }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      5,
      '/api/rpa/nl/sessions/nl_1/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reads execution status, logs, and artifacts from expected endpoints', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ executionId: 'exec_1', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ executionId: 'exec_1', stdout: 'out', stderr: 'err' }))
      .mockResolvedValueOnce(jsonResponse({ executionId: 'exec_1', artifacts: [] }));
    const client = new RpaApiClient({ fetchImpl });

    await client.getExecutionStatus('exec_1');
    await client.getExecutionLogs('exec_1');
    await client.getExecutionArtifacts('exec_1');

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      '/api/rpa/executions/exec_1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      '/api/rpa/executions/exec_1/logs',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      '/api/rpa/executions/exec_1/artifacts',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('builds a browser-safe current screenshot URL with a cache key', () => {
    const client = new RpaApiClient({ fetchImpl: vi.fn() });

    expect(client.getCurrentScreenshotUrl('exec_1', '2026-06-06T00:00:00+08:00')).toBe(
      '/api/rpa/executions/exec_1/screenshots/current?cacheKey=2026-06-06T00%3A00%3A00%2B08%3A00',
    );
  });

  it('subscribes to execution SSE events, dedupes by sequence, and closes on completion', () => {
    const source = new FakeEventSource();
    const client = new RpaApiClient({
      fetchImpl: vi.fn(),
      eventSourceFactory: (url) => {
        expect(url).toBe('/api/rpa/executions/exec_1/events');
        return source;
      },
    });
    const onEvent = vi.fn();
    const onError = vi.fn();

    const unsubscribe = client.subscribeExecutionEvents('exec_1', { onEvent, onError });
    const started = event({ type: 'run.started', executionId: 'exec_1', status: 'running', sequence: 1 });
    source.emit('run.started', started);
    source.emit('run.started', started);
    source.emit('log', event({ type: 'log', executionId: 'exec_1', message: 'first unsequenced' }));
    source.emit('log', event({ type: 'log', executionId: 'exec_1', message: 'second unsequenced' }));
    source.emit('log', '{not json');
    source.emit('run.completed', event({ type: 'run.completed', executionId: 'exec_1', status: 'succeeded', sequence: 2 }));

    expect(onEvent).toHaveBeenCalledTimes(4);
    expect(onEvent.mock.calls.map(([item]) => item.message ?? item.type)).toEqual([
      'run.started',
      'first unsequenced',
      'second unsequenced',
      'run.completed',
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);

    unsubscribe();
    expect(source.closeCount).toBe(2);
  });
});

class FakeEventSource {
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  closed = false;
  closeCount = 0;

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.closeCount += 1;
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

function event(event: Partial<RpaExecutionEvent> & Pick<RpaExecutionEvent, 'type' | 'executionId'>): string {
  return JSON.stringify({
    timestamp: '2026-06-06T00:00:00.000Z',
    ...event,
  });
}
