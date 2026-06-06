import type {
  RpaConfigResponse,
  RpaDaemonHealthResponse,
  RpaExecutionArtifactsResponse,
  RpaExecutionEvent,
  RpaExecutionLogResponse,
  RpaExecutionStatusResponse,
  RpaFlowDetailResponse,
  RpaHealthResponse,
  StartRpaExecutionRequest,
  StartRpaExecutionResponse,
} from '../shared/rpa-api-types.js';
import { rpaExecutionEventTypes } from '../shared/rpa-api-types.js';

type FetchLike = typeof fetch;

export interface RpaEventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface RpaApiClientOptions {
  fetchImpl?: FetchLike;
  eventSourceFactory?: (url: string) => RpaEventSourceLike;
}

export interface RpaExecutionEventHandlers {
  onEvent: (event: RpaExecutionEvent) => void;
  onError?: (error: unknown) => void;
}

export class RpaApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly eventSourceFactory: (url: string) => RpaEventSourceLike;

  constructor(options: RpaApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.eventSourceFactory =
      options.eventSourceFactory ??
      ((url) => new globalThis.EventSource(url) as RpaEventSourceLike);
  }

  getHealth(): Promise<RpaHealthResponse> {
    return this.requestJson('/api/rpa/health');
  }

  getConfig(): Promise<RpaConfigResponse> {
    return this.requestJson('/api/rpa/config');
  }

  async getDaemonHealth(): Promise<RpaDaemonHealthResponse> {
    const response = await this.fetchImpl('/api/rpa/daemon/health', { method: 'GET' });
    const payload = (await response.json()) as RpaDaemonHealthResponse;
    if (!response.ok && typeof payload?.daemonReachable !== 'boolean') {
      throw new Error(`RPA API request failed: ${response.status}`);
    }
    return payload;
  }

  getFlow(flowId: string): Promise<RpaFlowDetailResponse> {
    return this.requestJson(`/api/rpa/flows/${encodeURIComponent(flowId)}`);
  }

  startExecution(request: StartRpaExecutionRequest): Promise<StartRpaExecutionResponse> {
    return this.requestJson('/api/rpa/executions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  cancelExecution(executionId: string): Promise<{ ok: true }> {
    return this.requestJson(`/api/rpa/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: 'POST',
    });
  }

  getExecutionStatus(executionId: string): Promise<RpaExecutionStatusResponse> {
    return this.requestJson(`/api/rpa/executions/${encodeURIComponent(executionId)}`);
  }

  getExecutionLogs(executionId: string): Promise<RpaExecutionLogResponse> {
    return this.requestJson(`/api/rpa/executions/${encodeURIComponent(executionId)}/logs`);
  }

  getExecutionArtifacts(executionId: string): Promise<RpaExecutionArtifactsResponse> {
    return this.requestJson(`/api/rpa/executions/${encodeURIComponent(executionId)}/artifacts`);
  }

  getCurrentScreenshotUrl(executionId: string, cacheKey?: string | number): string {
    const base = `/api/rpa/executions/${encodeURIComponent(executionId)}/screenshots/current`;
    if (cacheKey === undefined) return base;
    return `${base}?cacheKey=${encodeURIComponent(String(cacheKey))}`;
  }

  subscribeExecutionEvents(executionId: string, handlers: RpaExecutionEventHandlers): () => void {
    const source = this.eventSourceFactory(`/api/rpa/executions/${encodeURIComponent(executionId)}/events`);
    const seenSequences = new Set<number>();

    for (const type of rpaExecutionEventTypes) {
      source.addEventListener(type, (message) => {
        let event: RpaExecutionEvent;
        try {
          event = JSON.parse(message.data) as RpaExecutionEvent;
        } catch (error) {
          handlers.onError?.(error);
          return;
        }

        if (event.sequence !== undefined) {
          if (seenSequences.has(event.sequence)) return;
          seenSequences.add(event.sequence);
        }

        handlers.onEvent(event);
        if (event.type === 'run.completed') {
          source.close();
        }
      });
    }

    return () => source.close();
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const headers = init.body === undefined ? init.headers : { 'Content-Type': 'application/json', ...init.headers };
    const response = await this.fetchImpl(path, { ...init, method, headers });
    if (!response.ok) {
      throw new Error(`RPA API request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}
