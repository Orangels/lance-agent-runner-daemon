import type { RunRecord } from '../db/types.js';
import type { ArtifactRole } from './run-types.js';

export const webhookRunStatusEventType = 'run.status_changed';
export const webhookRunPayloadSchemaVersion = 'daemon.webhook.run.v1';

export interface WebhookRunStatusPayload {
  schemaVersion: typeof webhookRunPayloadSchemaVersion;
  eventId: string;
  eventType: typeof webhookRunStatusEventType;
  createdAt: number;
  deliveryAttempt: number;
  run: {
    id: string;
    workspaceId: string;
    profileId: string;
    clientId: string;
    kind: RunRecord['kind'];
    skillId: string | null;
    status: RunRecord['status'];
    queuedAt: number | null;
    startedAt: number | null;
    finishedAt: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    idempotencyKey: string | null;
  };
  artifacts: Array<{
    id: string;
    ruleId: string;
    role: ArtifactRole;
    relativePath: string;
    fileName: string;
    mimeType: string | null;
    size: number | null;
    sha256: string | null;
  }>;
  metadata: unknown;
}

export function buildWebhookRunStatusPayload(input: {
  eventId: string;
  createdAt: number;
  deliveryAttempt: number;
  run: RunRecord;
  artifacts?: WebhookRunStatusPayload['artifacts'];
  metadata?: unknown;
}): WebhookRunStatusPayload {
  return {
    schemaVersion: webhookRunPayloadSchemaVersion,
    eventId: input.eventId,
    eventType: webhookRunStatusEventType,
    createdAt: input.createdAt,
    deliveryAttempt: input.deliveryAttempt,
    run: {
      id: input.run.id,
      workspaceId: input.run.workspaceId,
      profileId: input.run.profileId,
      clientId: input.run.clientId,
      kind: input.run.kind,
      skillId: input.run.skillId,
      status: input.run.status,
      queuedAt: input.run.queuedAt,
      startedAt: input.run.startedAt,
      finishedAt: input.run.finishedAt,
      errorCode: input.run.errorCode,
      errorMessage: input.run.errorMessage,
      idempotencyKey: input.run.idempotencyKey,
    },
    artifacts: (input.artifacts ?? []).map((artifact) => ({
      id: artifact.id,
      ruleId: artifact.ruleId,
      role: artifact.role,
      relativePath: artifact.relativePath,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
    metadata: input.metadata ?? null,
  };
}
