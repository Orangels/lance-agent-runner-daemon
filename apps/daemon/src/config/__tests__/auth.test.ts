import { describe, expect, it } from 'vitest';
import { DaemonError } from '../../core/errors.js';
import type { ClientConfig, ProfileConfig } from '../profiles.js';
import {
  authenticateClient,
  filterProfilesForClient,
  getApiKeyFromHeaders,
  requireCollectionModeAccess,
  requireProfileAccess,
} from '../auth.js';

const clients: ClientConfig[] = [
  {
    id: 'lqbot',
    apiKey: 'lqbot-secret',
    allowedProfileIds: ['report-docx'],
    canReadDebugEvents: false,
    canReadLogs: true,
    isAdmin: false,
  },
  {
    id: 'admin',
    apiKey: 'admin-secret',
    allowedProfileIds: [],
    canReadDebugEvents: true,
    canReadLogs: true,
    isAdmin: true,
  },
];

const profiles = [
  { id: 'report-docx' },
  { id: 'slides-pptx' },
] as ProfileConfig[];

describe('api key extraction', () => {
  it('extracts bearer tokens', () => {
    expect(getApiKeyFromHeaders({ authorization: 'Bearer lqbot-secret' })).toBe('lqbot-secret');
  });

  it('extracts x-api-key tokens', () => {
    expect(getApiKeyFromHeaders({ 'x-api-key': 'lqbot-secret' })).toBe('lqbot-secret');
  });
});

describe('client authentication', () => {
  it('authenticates a bearer token', () => {
    const client = authenticateClient({ authorization: 'Bearer lqbot-secret' }, clients);

    expect(client.id).toBe('lqbot');
  });

  it('authenticates an X-API-Key token', () => {
    const client = authenticateClient({ 'x-api-key': 'lqbot-secret' }, clients);

    expect(client.id).toBe('lqbot');
  });

  it('rejects missing api keys with UNAUTHORIZED', () => {
    expect(() => authenticateClient({}, clients)).toThrow(DaemonError);
    expect(() => authenticateClient({}, clients)).toThrow(/Missing API key/);
  });

  it('rejects unknown api keys with UNAUTHORIZED', () => {
    try {
      authenticateClient({ authorization: 'Bearer wrong-secret' }, clients);
      throw new Error('expected authentication failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      expect((error as DaemonError).code).toBe('UNAUTHORIZED');
      expect((error as DaemonError).status).toBe(401);
    }
  });
});

describe('profile authorization', () => {
  it('allows clients to use explicitly allowed profiles', () => {
    expect(requireProfileAccess(clients[0]!, 'report-docx')).toBeUndefined();
  });

  it('rejects unauthorized profile access with PROFILE_NOT_ALLOWED', () => {
    try {
      requireProfileAccess(clients[0]!, 'slides-pptx');
      throw new Error('expected profile access failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      expect((error as DaemonError).code).toBe('PROFILE_NOT_ALLOWED');
      expect((error as DaemonError).status).toBe(403);
    }
  });

  it('filters profiles to allowed profiles for ordinary clients', () => {
    expect(filterProfilesForClient(clients[0]!, profiles).map((profile) => profile.id)).toEqual([
      'report-docx',
    ]);
  });

  it('returns all profiles for admin clients', () => {
    expect(filterProfilesForClient(clients[1]!, profiles).map((profile) => profile.id)).toEqual([
      'report-docx',
      'slides-pptx',
    ]);
  });
});

describe('collection mode authorization', () => {
  it('allows lite collection for any authenticated client', () => {
    expect(() =>
      requireCollectionModeAccess({
        client: clients[0]!,
        profile: { id: 'report-docx', maxCollectionMode: 'lite' } as ProfileConfig,
        collectionMode: 'lite',
      }),
    ).not.toThrow();
  });

  it('rejects collection modes above the profile cap', () => {
    try {
      requireCollectionModeAccess({
        client: clients[0]!,
        profile: { id: 'report-docx', maxCollectionMode: 'lite' } as ProfileConfig,
        collectionMode: 'diagnostic',
      });
      throw new Error('expected collection mode failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      expect((error as DaemonError).code).toBe('COLLECTION_MODE_NOT_ALLOWED');
      expect((error as DaemonError).status).toBe(403);
    }
  });

  it('requires log access for diagnostic collection', () => {
    const clientWithoutLogs: ClientConfig = {
      ...clients[0]!,
      canReadLogs: false,
      canReadDebugEvents: false,
    };

    expect(() =>
      requireCollectionModeAccess({
        client: clientWithoutLogs,
        profile: { id: 'report-docx', maxCollectionMode: 'diagnostic' } as ProfileConfig,
        collectionMode: 'diagnostic',
      }),
    ).toThrow(expect.objectContaining({ code: 'COLLECTION_MODE_NOT_ALLOWED', status: 403 }));

    expect(() =>
      requireCollectionModeAccess({
        client: clients[0]!,
        profile: { id: 'report-docx', maxCollectionMode: 'diagnostic' } as ProfileConfig,
        collectionMode: 'diagnostic',
      }),
    ).not.toThrow();
  });

  it('requires log and debug access for review collection', () => {
    expect(() =>
      requireCollectionModeAccess({
        client: clients[0]!,
        profile: { id: 'report-docx', maxCollectionMode: 'review' } as ProfileConfig,
        collectionMode: 'review',
      }),
    ).toThrow(expect.objectContaining({ code: 'COLLECTION_MODE_NOT_ALLOWED', status: 403 }));

    expect(() =>
      requireCollectionModeAccess({
        client: clients[1]!,
        profile: { id: 'report-docx', maxCollectionMode: 'review' } as ProfileConfig,
        collectionMode: 'review',
      }),
    ).not.toThrow();
  });
});
