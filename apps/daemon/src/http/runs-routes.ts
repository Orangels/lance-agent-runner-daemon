import { Router } from 'express';
import { getProfile, type DaemonConfig } from '../config/profiles.js';
import { filterRunEvent, filterRunEvents, resolveEventVisibility } from '../core/event-visibility.js';
import type { RunService } from '../core/run-service.js';
import type { RunEvent } from '../core/run-events.js';
import type { RunDetailRecord, RunMessageRecord, RunRecord } from '../db/repositories.js';
import { createSseResponse } from './sse.js';
import {
  createRunRequestSchema,
  eventReplayQuerySchema,
  listRunsQuerySchema,
} from './validation.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';

interface CreateRunsRouterDependencies {
  config: DaemonConfig;
  runService: RunService;
}

export function createRunsRouter(dependencies: CreateRunsRouterDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.config);

  router.post('/', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const body = createRunRequestSchema.parse(request.body);
      response.status(202).json(dependencies.runService.createRun({ client, request: body }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const query = listRunsQuerySchema.parse(request.query);
      response.json({
        runs: dependencies.runService.listRuns({ client, query }).map(toPublicRunListItem),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:runId', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const runId = String(request.params.runId);
      const detail = dependencies.runService.getRunDetail({ client, runId });
      const profile = getProfile(dependencies.config, detail.run.profileId);
      const visibility = resolveEventVisibility({
        client,
        profile,
        request: { eventVisibility: dependencies.runService.getRequestedEventVisibility(runId) },
      });
      response.json(toPublicRunDetail(detail, visibility));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:runId/events', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const runId = String(request.params.runId);
      const query = eventReplayQuerySchema.parse(request.query);
      const after = query.after ?? getLastEventId(request.headers['last-event-id']);
      const run = dependencies.runService.getRunDetail({ client, runId }).run;
      const profile = getProfile(dependencies.config, run.profileId);
      const visibility = resolveEventVisibility({
        client,
        profile,
        request: { eventVisibility: dependencies.runService.getRequestedEventVisibility(runId) },
      });
      let sse: ReturnType<typeof createSseResponse>;
      const subscription = dependencies.runService.subscribeRunEvents({ client, runId, after }, (record) => {
        const event = filterRunEvent(record.event, visibility);
        if (event) {
          sse.send('agent', event, record.id);
        }
        if (record.event.type === 'end') {
          subscription.unsubscribe();
          sse.end();
        }
      });

      sse = createSseResponse(response);
      for (const record of subscription.replay) {
        const event = filterRunEvent(record.event, visibility);
        if (event) {
          sse.send('agent', event, record.id);
        }
      }

      if (subscription.terminal) {
        sse.end();
      }
    } catch (error) {
      next(error);
    }
  });

  router.post('/:runId/cancel', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      response.json(dependencies.runService.cancelRun({ client, runId: String(request.params.runId) }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function toPublicRunListItem(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    profileId: run.profileId,
    kind: run.kind,
    skillId: run.skillId,
    status: run.status,
    lastRunEventId: run.lastRunEventId,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toPublicRunDetail(detail: RunDetailRecord, visibility: Parameters<typeof filterRunEvents>[1]) {
  return {
    run: {
      ...toPublicRunListItem(detail.run),
      exitCode: detail.run.exitCode,
      signal: detail.run.signal,
      errorCode: detail.run.errorCode,
      errorMessage: detail.run.errorMessage,
      usage: detail.run.usage,
      metadata: detail.run.metadata,
    },
    messages: detail.messages.map((message) => toPublicRunMessage(message, visibility)),
  };
}

function toPublicRunMessage(
  message: RunMessageRecord,
  visibility: Parameters<typeof filterRunEvents>[1],
): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    thinkingContent: visibility === 'quiet' ? '' : message.thinkingContent,
    events: filterMessageEvents(message.events, visibility),
    runStatus: message.runStatus,
    lastRunEventId: message.lastRunEventId,
    startedAt: message.startedAt,
    endedAt: message.endedAt,
    position: message.position,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function filterMessageEvents(events: unknown, visibility: Parameters<typeof filterRunEvents>[1]): RunEvent[] | null {
  return Array.isArray(events) ? filterRunEvents(events as RunEvent[], visibility) : null;
}

function getLastEventId(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
