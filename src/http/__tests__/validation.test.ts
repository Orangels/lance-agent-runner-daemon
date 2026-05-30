import { describe, expect, it } from 'vitest';
import {
  createRunRequestSchema,
  createWorkspaceRequestSchema,
  eventReplayQuerySchema,
  listRunsQuerySchema,
  prepareWorkspaceRequestSchema,
} from '../validation.js';

describe('workspace create request validation', () => {
  it('accepts the two-step workspace creation contract', () => {
    const parsed = createWorkspaceRequestSchema.parse({
      profileId: 'report-docx',
      workspace: {
        originId: 'lqbot',
        userId: 'user_1',
        projectId: 'project_123',
      },
      metadata: {
        label: 'quarterly report',
      },
    });

    expect(parsed.workspace).toEqual({
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
    });
  });

  it('rejects unsafe workspace identity path segments', () => {
    expect(() =>
      createWorkspaceRequestSchema.parse({
        profileId: 'report-docx',
        workspace: {
          originId: 'lqbot',
          userId: '../user',
          projectId: 'project_123',
        },
      }),
    ).toThrow();
  });
});

describe('workspace prepare request validation', () => {
  it('accepts source to workspace-relative target mappings', () => {
    const parsed = prepareWorkspaceRequestSchema.parse({
      files: [
        {
          sourcePath: '/mnt/lqbot/uploads/user_1/source.docx',
          targetPath: 'input/source.docx',
        },
      ],
    });

    expect(parsed.files[0]?.targetPath).toBe('input/source.docx');
  });

  it('rejects absolute target paths', () => {
    expect(() =>
      prepareWorkspaceRequestSchema.parse({
        files: [{ sourcePath: '/mnt/source.docx', targetPath: '/tmp/source.docx' }],
      }),
    ).toThrow();
  });

  it('rejects parent-directory target paths', () => {
    expect(() =>
      prepareWorkspaceRequestSchema.parse({
        files: [{ sourcePath: '/mnt/source.docx', targetPath: '../source.docx' }],
      }),
    ).toThrow();
  });

  it('rejects protected skill staging targets', () => {
    expect(() =>
      prepareWorkspaceRequestSchema.parse({
        files: [
          {
            sourcePath: '/mnt/source.md',
            targetPath: '.claude-runner-skills/report-writer/SKILL.md',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('run create request validation', () => {
  it('accepts a generate run that references workspaceId and skillId', () => {
    const parsed = createRunRequestSchema.parse({
      profileId: 'report-docx',
      workspaceId: 'ws_123',
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      model: 'sonnet',
      artifactRuleIds: ['report-docx'],
      eventVisibility: 'quiet',
      metadata: {
        businessMessageId: 'msg_001',
      },
    });

    expect(parsed.workspaceId).toBe('ws_123');
    expect(parsed.kind).toBe('generate');
  });

  it('rejects run create bodies that inline workspace identity', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        originId: 'lqbot',
        userId: 'user_1',
        projectId: 'project_123',
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
      }),
    ).toThrow();
  });

  it('rejects run create bodies that pass a workspace object', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        workspace: {
          originId: 'lqbot',
          userId: 'user_1',
          projectId: 'project_123',
        },
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate the report.',
      }),
    ).toThrow();
  });

  it('rejects generate runs without skillId', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'generate',
        prompt: 'Generate the report.',
      }),
    ).toThrow();
  });

  it('rejects revise runs with skillId', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'revise',
        skillId: 'report-writer',
        prompt: 'Revise the report.',
      }),
    ).toThrow();
  });

  it('rejects unknown event visibility values', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'revise',
        prompt: 'Revise the report.',
        eventVisibility: 'trace',
      }),
    ).toThrow();
  });
});

describe('run query validation', () => {
  it('rejects unknown status filters', () => {
    expect(() => listRunsQuerySchema.parse({ status: 'done' })).toThrow();
  });

  it('accepts supported run filters', () => {
    expect(
      listRunsQuerySchema.parse({
        originId: 'lqbot',
        userId: 'user_1',
        projectId: 'project_123',
        workspaceKey: 'lqbot/user_1/project_123',
        workspacePrefix: 'lqbot/user_1',
        status: 'running',
      }),
    ).toEqual({
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
      workspaceKey: 'lqbot/user_1/project_123',
      workspacePrefix: 'lqbot/user_1',
      status: 'running',
    });
  });
});

describe('event replay query validation', () => {
  it('accepts Last-Event-ID replay aliases', () => {
    expect(eventReplayQuerySchema.parse({ after: 'evt_123' })).toEqual({ after: 'evt_123' });
  });
});
