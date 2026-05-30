import { z } from 'zod';
import {
  eventVisibilityLevels,
  runKinds,
  runStatuses,
  type CreateRunRequest,
  type CreateWorkspaceRequest,
  type EventReplayQuery,
  type ListRunsQuery,
  type PrepareWorkspaceRequest,
} from '../core/run-types.js';

const metadataSchema = z.record(z.string(), z.unknown());

const safePathSegmentSchema = z
  .string()
  .min(1)
  .refine((value) => value !== '.' && value !== '..', 'Path segment cannot be . or ..')
  .refine((value) => !value.includes('/'), 'Path segment cannot contain /')
  .refine((value) => !value.includes('\\'), 'Path segment cannot contain \\')
  .refine((value) => !value.includes('\0'), 'Path segment cannot contain null byte');

const workspaceRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'Path cannot contain null byte')
  .refine((value) => !value.startsWith('/'), 'Path must be relative')
  .refine((value) => !/^[A-Za-z]:[\\/]/.test(value), 'Path must be relative')
  .refine((value) => !value.startsWith('\\'), 'Path must be relative')
  .refine((value) => {
    const segments = value.split(/[\\/]+/);
    return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  }, 'Path must not contain empty, . or .. segments')
  .refine((value) => {
    const [firstSegment] = value.split(/[\\/]+/);
    return firstSegment !== '.claude-runner-skills';
  }, 'Path cannot target protected skill staging directory');

export const createWorkspaceRequestSchema: z.ZodType<CreateWorkspaceRequest> = z
  .object({
    profileId: z.string().min(1),
    workspace: z
      .object({
        originId: safePathSegmentSchema,
        userId: safePathSegmentSchema,
        projectId: safePathSegmentSchema,
      })
      .strict(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const prepareWorkspaceRequestSchema: z.ZodType<PrepareWorkspaceRequest> = z
  .object({
    files: z
      .array(
        z
          .object({
            sourcePath: z.string().min(1),
            targetPath: workspaceRelativePathSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const createRunRequestSchema: z.ZodType<CreateRunRequest> = z
  .object({
    profileId: z.string().min(1),
    workspaceId: z.string().min(1),
    kind: z.enum(runKinds),
    prompt: z.string().min(1),
    skillId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    artifactRuleIds: z.array(z.string().min(1)).optional(),
    eventVisibility: z.enum(eventVisibilityLevels).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'generate' && !value.skillId) {
      context.addIssue({
        code: 'custom',
        message: 'kind=generate requires skillId',
        path: ['skillId'],
      });
    }

    if (value.kind === 'revise' && value.skillId) {
      context.addIssue({
        code: 'custom',
        message: 'kind=revise forbids skillId',
        path: ['skillId'],
      });
    }
  });

export const listRunsQuerySchema: z.ZodType<ListRunsQuery> = z
  .object({
    originId: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    workspaceKey: z.string().min(1).optional(),
    workspacePrefix: z.string().min(1).optional(),
    status: z.enum(runStatuses).optional(),
  })
  .strict();

export const eventReplayQuerySchema: z.ZodType<EventReplayQuery> = z
  .object({
    after: z.string().min(1).optional(),
  })
  .strict();
