import { daemonError, unauthorized } from '../core/errors.js';
import type { ClientConfig, ProfileConfig } from './profiles.js';

export type AuthHeaders = Record<string, string | string[] | undefined>;

export function getApiKeyFromHeaders(headers: AuthHeaders): string | undefined {
  const authorization = firstHeaderValue(headers.authorization ?? headers.Authorization);
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) {
      return match[1];
    }
  }

  return firstHeaderValue(
    headers['x-api-key'] ?? headers['X-API-Key'] ?? headers['X-Api-Key'] ?? headers['x-api-Key'],
  );
}

export function authenticateClient(headers: AuthHeaders, clients: readonly ClientConfig[]): ClientConfig {
  const apiKey = getApiKeyFromHeaders(headers);
  if (!apiKey) {
    throw unauthorized('Missing API key');
  }

  const client = clients.find((candidate) => candidate.apiKey === apiKey);
  if (!client) {
    throw unauthorized('Invalid API key');
  }

  return client;
}

export function requireProfileAccess(client: ClientConfig, profileId: string): void {
  if (client.isAdmin || client.allowedProfileIds.includes(profileId)) {
    return;
  }

  throw daemonError('PROFILE_NOT_ALLOWED', 'Client is not allowed to use this profile', 403, {
    clientId: client.id,
    profileId,
  });
}

export function filterProfilesForClient<T extends Pick<ProfileConfig, 'id'>>(
  client: ClientConfig,
  profiles: readonly T[],
): T[] {
  if (client.isAdmin) {
    return [...profiles];
  }

  const allowedProfileIds = new Set(client.allowedProfileIds);
  return profiles.filter((profile) => allowedProfileIds.has(profile.id));
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
