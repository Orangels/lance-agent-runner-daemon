import type { RunnerPersistence, RunFeedbackRecord } from '../db/types.js';
import { createId } from './ids.js';
import { sanitizeLogText, sanitizeReviewValue } from './log-sanitizer.js';
import { notFound } from './errors.js';

export interface RunFeedbackClient {
  id: string;
  isAdmin?: boolean;
}

export interface RunFeedbackService {
  createRunFeedback(input: {
    runId: string;
    client: RunFeedbackClient;
    category: string;
    message: string;
    metadata?: unknown;
  }): Promise<RunFeedbackRecord>;
  listRunFeedback(input: { runId: string; client: RunFeedbackClient }): Promise<RunFeedbackRecord[]>;
}

export interface CreateRunFeedbackServiceInput {
  persistence?: RunnerPersistence;
  clock?: () => number;
  ids?: {
    feedbackId?: () => string;
  };
}

export function createRunFeedbackService(input: CreateRunFeedbackServiceInput): RunFeedbackService {
  const now = input.clock ?? Date.now;
  const nextFeedbackId = input.ids?.feedbackId ?? (() => createId('feedback'));
  const persistence = input.persistence;
  if (!persistence) {
    throw new Error('RunFeedbackService requires persistence');
  }

  return {
    createRunFeedback: async ({ runId, client, category, message, metadata }) => {
      const run = await persistence.getRunForClient({
        runId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });
      if (!run) {
        throw notFound('Run not found');
      }

      return persistence.insertRunFeedback({
        id: nextFeedbackId(),
        runId,
        clientId: client.id,
        category,
        message: sanitizeLogText(message),
        metadata: sanitizeReviewValue(metadata ?? null),
        now: now(),
      });
    },
    listRunFeedback: async ({ runId, client }) => {
      const feedback = await persistence.listRunFeedbackForClient({
        runId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });
      if (!feedback) {
        throw notFound('Run not found');
      }
      return feedback;
    },
  };
}
