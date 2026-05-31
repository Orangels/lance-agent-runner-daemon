import type {
  ArtifactsResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateWorkspaceRequest,
  ErrorResponse,
  HealthResponse,
  ProfilesResponse,
  PublicWorkspace,
  RunDetailResponse,
  UploadWorkspaceFileResponse,
} from './types.js';

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

export class DaemonApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DaemonApiError';
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

  getProfiles(): Promise<ProfilesResponse> {
    return this.requestJson('/api/profiles');
  }

  createWorkspace(request: CreateWorkspaceRequest): Promise<PublicWorkspace> {
    return this.requestJson('/api/workspaces', { body: request, method: 'POST' });
  }

  createRun(request: CreateRunRequest): Promise<CreateRunResponse> {
    return this.requestJson('/api/runs', { body: request, method: 'POST' });
  }

  getRunDetail(runId: string): Promise<RunDetailResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(runId: string): Promise<CreateRunResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  }

  listRunArtifacts(runId: string): Promise<ArtifactsResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  }

  async uploadWorkspaceFile(input: {
    workspaceId: string;
    file: File;
    targetPath: string;
  }): Promise<UploadWorkspaceFileResponse> {
    const formData = new FormData();
    formData.append('targetPath', input.targetPath);
    formData.append('file', input.file);

    const response = await this.fetchImpl(this.toUrl(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/files`), {
      body: formData,
      headers: authHeaders(this.apiKey),
      method: 'POST',
    });

    return parseJsonResponse<UploadWorkspaceFileResponse>(response);
  }

  private async requestJson<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = options.auth === false ? {} : authHeaders(this.apiKey);
    const init: RequestInit = {
      headers,
      method: options.method ?? 'GET',
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(this.toUrl(path), init);
    return parseJsonResponse<T>(response);
  }

  private toUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await readJson(response);
  if (!response.ok) {
    throw toApiError(response, payload);
  }
  return payload as T;
}

export async function readApiError(response: Response): Promise<DaemonApiError> {
  return toApiError(response, await readJson(response));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toApiError(response: Response, payload: unknown): DaemonApiError {
  const structured = parseErrorResponse(payload);
  if (structured) {
    return new DaemonApiError(
      response.status,
      structured.error.code,
      structured.error.message,
      structured.error.details,
    );
  }

  return new DaemonApiError(response.status, 'HTTP_ERROR', response.statusText || `HTTP ${response.status}`);
}

function parseErrorResponse(payload: unknown): ErrorResponse | null {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) {
    return null;
  }

  const error = (payload as { error: unknown }).error;
  if (!error || typeof error !== 'object') {
    return null;
  }

  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') {
    return null;
  }

  return { error: { code: code as ErrorResponse['error']['code'], message, details } };
}
