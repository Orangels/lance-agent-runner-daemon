import { authHeaders, normalizeBaseUrl, readApiError } from './daemon-client.js';

type FetchLike = typeof fetch;

export interface FetchArtifactDownloadInput {
  baseUrl: string;
  apiKey: string;
  runId: string;
  artifactId: string;
  fetchImpl?: FetchLike;
}

export interface ArtifactDownload {
  blob: Blob;
  fileName: string;
  mimeType: string | null;
}

export async function fetchArtifactDownload(input: FetchArtifactDownloadInput): Promise<ArtifactDownload> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const artifactId = encodeURIComponent(input.artifactId);
  const runId = encodeURIComponent(input.runId);
  const response = await fetchImpl(`${baseUrl}/api/runs/${runId}/artifacts/${artifactId}/download`, {
    headers: authHeaders(input.apiKey),
    method: 'GET',
  });

  if (!response.ok) {
    throw await readApiError(response);
  }

  return {
    blob: await response.blob(),
    fileName: getDownloadFileName(response.headers.get('Content-Disposition'), input.artifactId),
    mimeType: response.headers.get('Content-Type'),
  };
}

export function triggerBrowserDownload(download: ArtifactDownload): void {
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function getDownloadFileName(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) {
    return fallback;
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8Match?.[1]) {
    return safeDecodeURIComponent(utf8Match[1]) || fallback;
  }

  const quotedMatch = /filename="([^"]+)"/i.exec(contentDisposition);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const plainMatch = /filename=([^;]+)/i.exec(contentDisposition);
  return plainMatch?.[1]?.trim() || fallback;
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
