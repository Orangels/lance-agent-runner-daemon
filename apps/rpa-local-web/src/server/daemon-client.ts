import type {
  ArtifactsResponse,
  CancelRunResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateWorkspaceRequest,
  DaemonRunEventRecord,
  ErrorResponse,
  HealthResponse,
  PublicWorkspace,
  UploadWorkspaceFileResponse,
} from '../shared/daemon-types.js';

type FetchLike = typeof fetch;

export interface DaemonClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}

interface JsonRequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

export class DaemonClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DaemonClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: DaemonClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  getHealth(): Promise<HealthResponse> {
    return this.requestJson('/api/health', { auth: false });
  }

  createWorkspace(request: CreateWorkspaceRequest): Promise<PublicWorkspace> {
    return this.requestJson('/api/workspaces', { method: 'POST', body: request });
  }

  createRun(request: CreateRunRequest): Promise<CreateRunResponse> {
    return this.requestJson('/api/runs', { method: 'POST', body: request });
  }

  cancelRun(runId: string): Promise<CancelRunResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  }

  listRunArtifacts(runId: string): Promise<ArtifactsResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  }

  async uploadWorkspaceFile(input: {
    workspaceId: string;
    file: File | Blob;
    targetPath: string;
    fileName?: string;
  }): Promise<UploadWorkspaceFileResponse> {
    const formData = new FormData();
    formData.append('targetPath', input.targetPath);
    if (input.fileName) {
      formData.append('file', input.file, input.fileName);
    } else {
      formData.append('file', input.file);
    }

    const response = await this.fetchImpl(
      this.toUrl(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/files`),
      {
        body: formData,
        headers: authHeaders(this.apiKey),
        method: 'POST',
      },
    );

    return parseJsonResponse<UploadWorkspaceFileResponse>(response);
  }

  async downloadArtifact(input: { runId: string; artifactId: string }): Promise<Response> {
    const response = await this.fetchImpl(
      this.toUrl(
        `/api/runs/${encodeURIComponent(input.runId)}/artifacts/${encodeURIComponent(
          input.artifactId,
        )}/download`,
      ),
      {
        headers: authHeaders(this.apiKey),
        method: 'GET',
      },
    );
    if (!response.ok) {
      throw await toDaemonClientError(response);
    }
    return response;
  }

  async *subscribeRunEvents(runId: string, after?: string): AsyncGenerator<DaemonRunEventRecord> {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    const response = await this.fetchImpl(
      this.toUrl(`/api/runs/${encodeURIComponent(runId)}/events${query}`),
      {
        headers: authHeaders(this.apiKey),
        method: 'GET',
      },
    );
    if (!response.ok) {
      throw await toDaemonClientError(response);
    }
    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const parsed = parseSseRecord(chunk);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode();
    const parsed = parseSseRecord(buffer);
    if (parsed) yield parsed;
  }

  private requestJson<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> =
      options.auth === false ? {} : authHeaders(this.apiKey);
    const init: RequestInit = {
      headers,
      method: options.method ?? 'GET',
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    return this.fetchImpl(this.toUrl(path), init).then((response) =>
      parseJsonResponse<T>(response),
    );
  }

  private toUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await readJson(response);
  if (!response.ok) {
    throw toApiError(response, payload);
  }
  return payload as T;
}

async function toDaemonClientError(response: Response): Promise<DaemonClientError> {
  return toApiError(response, await readJson(response));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toApiError(response: Response, payload: unknown): DaemonClientError {
  const structured = parseErrorResponse(payload);
  if (structured) {
    return new DaemonClientError(
      response.status,
      structured.error.code,
      structured.error.message,
      structured.error.details,
    );
  }
  return new DaemonClientError(
    response.status,
    'HTTP_ERROR',
    response.statusText || `HTTP ${response.status}`,
  );
}

function parseErrorResponse(payload: unknown): ErrorResponse | null {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return null;
  const error = (payload as { error: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const { code, message, details } = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { error: { code, message, details } };
}

function parseSseRecord(chunk: string): DaemonRunEventRecord | null {
  const lines = chunk.split('\n');
  let id = '';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const parsed = JSON.parse(dataLines.join('\n')) as unknown;
  return { id, event: parsed };
}
