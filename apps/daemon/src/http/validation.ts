import { z } from 'zod';
import { badRequest, daemonError, type DaemonError } from '../core/errors.js';
import {
  collectionModes,
  eventVisibilityLevels,
  promptModes,
  runKinds,
  runStatuses,
  type CreateRunRequest,
  type CreateWorkspaceRequest,
  type EventReplayQuery,
  type ListRunsQuery,
  type PrepareWorkspaceRequest,
} from '../core/run-types.js';

const metadataSchema = z.record(z.string(), z.unknown());

const runShortStringSchema = z.string().min(1).max(128);
const runPromptSchema = z.string().min(1).max(200_000);
const businessContextSchema = z.record(z.string(), z.unknown());
const contextPolicySchema = z
  .object({
    recentMessages: z.number().int().min(0).max(100).optional(),
    maxMessageChars: z.number().int().min(100).max(50_000).optional(),
    maxTotalChars: z.number().int().min(100).max(200_000).optional(),
    includeRunWarnings: z.boolean().optional(),
  })
  .strict();

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

export const workspaceUploadFieldsSchema = z
  .object({
    targetPath: workspaceRelativePathSchema,
  })
  .strict();

export const createRunRequestSchema: z.ZodType<CreateRunRequest> = z
  .object({
    profileId: runShortStringSchema,
    workspaceId: runShortStringSchema,
    kind: z.enum(runKinds),
    prompt: runPromptSchema.optional(),
    currentPrompt: runPromptSchema.optional(),
    conversationId: runShortStringSchema.optional(),
    promptMode: z.enum(promptModes).optional(),
    collectionMode: z.enum(collectionModes).optional(),
    businessContext: businessContextSchema.optional(),
    contextPolicy: contextPolicySchema.optional(),
    skillId: runShortStringSchema.optional(),
    model: runShortStringSchema.optional(),
    artifactRuleIds: z.array(runShortStringSchema).max(32).optional(),
    eventVisibility: z.enum(eventVisibilityLevels).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const promptMode = value.promptMode ?? 'legacy';

    if (promptMode === 'legacy') {
      if (!value.prompt) {
        addIssue(context, 'prompt', 'legacy promptMode requires prompt');
      }
      if (value.currentPrompt) {
        addIssue(context, 'currentPrompt', 'legacy promptMode forbids currentPrompt');
      }
      if (value.businessContext !== undefined) {
        addIssue(context, 'businessContext', 'legacy promptMode forbids businessContext');
      }
      if (value.contextPolicy !== undefined) {
        addIssue(context, 'contextPolicy', 'legacy promptMode forbids contextPolicy');
      }
      if (value.kind === 'generate' && !value.skillId) {
        addIssue(context, 'skillId', 'legacy generate requires skillId');
      }
      if (value.kind === 'revise' && value.skillId) {
        addIssue(context, 'skillId', 'legacy revise forbids skillId');
      }
      return;
    }

    if (promptMode === 'business-context') {
      if (value.prompt) {
        addIssue(context, 'prompt', 'business-context forbids prompt');
      }
      if (!value.currentPrompt) {
        addIssue(context, 'currentPrompt', 'business-context requires currentPrompt');
      }
      if (!value.skillId) {
        addIssue(context, 'skillId', 'business-context requires skillId for MVP');
      }
      if (value.contextPolicy !== undefined) {
        addIssue(context, 'contextPolicy', 'business-context forbids contextPolicy');
      }
      return;
    }

    if (promptMode === 'daemon-composed') {
      if (value.prompt) {
        addIssue(context, 'prompt', 'daemon-composed forbids prompt');
      }
      if (!value.currentPrompt) {
        addIssue(context, 'currentPrompt', 'daemon-composed requires currentPrompt');
      }
      if (value.businessContext !== undefined) {
        addIssue(context, 'businessContext', 'daemon-composed forbids businessContext');
      }
      if (value.kind === 'generate' && !value.skillId) {
        addIssue(context, 'skillId', 'daemon-composed generate requires skillId');
      }
    }
  });

function addIssue(context: z.RefinementCtx, path: string, message: string): void {
  context.addIssue({ code: 'custom', path: [path], message });
}

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

export const createRunFeedbackRequestSchema = z
  .object({
    category: z.string().min(1).max(80),
    message: z.string().min(1).max(20_000),
    metadata: z.unknown().optional(),
  })
  .strict();

export function zodErrorToDaemonError(error: z.ZodError): DaemonError {
  if (
    error.issues.some((issue) =>
      issue.path.some((segment) =>
        ['originId', 'userId', 'projectId'].includes(String(segment)),
      ),
    )
  ) {
    return daemonError('INVALID_PATH_SEGMENT', 'Invalid workspace identity path segment', 400, {
      issues: error.issues,
    });
  }

  if (
    error.issues.some((issue) =>
      issue.path.some((segment) => ['targetPath', 'sourcePath'].includes(String(segment))),
    )
  ) {
    return daemonError('PATH_NOT_ALLOWED', 'Path is not allowed', 400, { issues: error.issues });
  }

  return badRequest('Invalid request', { issues: error.issues });
}
