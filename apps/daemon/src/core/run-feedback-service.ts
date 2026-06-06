import type { RunnerDatabase } from '../db/connection.js';
import {
  getRunForClient,
  insertRunFeedback,
  listRunFeedbackForClient,
  type RunFeedbackRecord,
} from '../db/repositories.js';
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
  }): RunFeedbackRecord;
  listRunFeedback(input: { runId: string; client: RunFeedbackClient }): RunFeedbackRecord[];
}

export interface CreateRunFeedbackServiceInput {
  db: RunnerDatabase;
  clock?: () => number;
  ids?: {
    feedbackId?: () => string;
  };
}

export function createRunFeedbackService(input: CreateRunFeedbackServiceInput): RunFeedbackService {
  const now = input.clock ?? Date.now;
  const nextFeedbackId = input.ids?.feedbackId ?? (() => createId('feedback'));

  return {
    createRunFeedback: ({ runId, client, category, message, metadata }) => {
      const run = getRunForClient(input.db, {
        runId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });
      if (!run) {
        throw notFound('Run not found');
      }

      return insertRunFeedback(input.db, {
        id: nextFeedbackId(),
        runId,
        clientId: client.id,
        category,
        message: sanitizeLogText(message),
        metadata: sanitizeReviewValue(metadata ?? null),
        now: now(),
      });
    },
    listRunFeedback: ({ runId, client }) => {
      const feedback = listRunFeedbackForClient(input.db, {
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
