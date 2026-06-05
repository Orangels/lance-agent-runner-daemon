import type {
  RpaConfigResponse,
  RpaDaemonHealthResponse,
  RpaHealthResponse,
} from '../shared/rpa-api-types.js';

type FetchLike = typeof fetch;

export interface RpaApiClientOptions {
  fetchImpl?: FetchLike;
}

export class RpaApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(options: RpaApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
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

  private async requestJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(path, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`RPA API request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}
