import { describe, expect, it } from 'vitest';
import {
  createRunRequestSchema,
  createWorkspaceRequestSchema,
  eventReplayQuerySchema,
  listRunsQuerySchema,
  prepareWorkspaceRequestSchema,
  workspaceUploadFieldsSchema,
  zodErrorToDaemonError,
} from '../validation.js';
import type { UploadWorkspaceFileResponse } from '../../core/run-types.js';

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

describe('workspace file upload field validation', () => {
  it('accepts a workspace-relative upload target path', () => {
    expect(workspaceUploadFieldsSchema.parse({ targetPath: 'input/source.docx' })).toEqual({
      targetPath: 'input/source.docx',
    });
  });

  it('rejects unsafe upload target paths', () => {
    for (const targetPath of [
      '/tmp/source.docx',
      '../source.docx',
      '.claude-runner-skills/source.docx',
    ]) {
      expect(() => workspaceUploadFieldsSchema.parse({ targetPath })).toThrow();
    }
  });

  it('maps upload target path errors to PATH_NOT_ALLOWED', () => {
    const result = workspaceUploadFieldsSchema.safeParse({
      targetPath: '.claude-runner-skills/source.docx',
    });
    if (result.success) {
      throw new Error('expected upload field validation to fail');
    }

    expect(zodErrorToDaemonError(result.error).code).toBe('PATH_NOT_ALLOWED');
  });

  it('uses the public upload response shape without absolute paths', () => {
    const response: UploadWorkspaceFileResponse = {
      workspaceId: 'ws_123',
      workspaceKey: 'lqbot/user_1/project_123',
      file: {
        targetPath: 'input/source.docx',
        size: 1024,
        originalName: 'source.docx',
        mimeType: 'text/plain',
      },
    };

    expect(JSON.stringify(response)).not.toContain('/tmp/');
    expect(response.file.targetPath).toBe('input/source.docx');
  });
});

describe('run create request validation', () => {
  const long128 = 'x'.repeat(128);
  const long129 = 'x'.repeat(129);

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
    expect(parsed.promptMode).toBeUndefined();
  });

  it('accepts a revise run with only workspaceId and prompt fields', () => {
    const parsed = createRunRequestSchema.parse({
      profileId: 'report-docx',
      workspaceId: 'ws_123',
      kind: 'revise',
      prompt: 'Revise the report.',
      model: 'sonnet',
      eventVisibility: 'normal',
      metadata: {
        businessMessageId: 'msg_001',
      },
    });

    expect(parsed).toEqual({
      profileId: 'report-docx',
      workspaceId: 'ws_123',
      kind: 'revise',
      prompt: 'Revise the report.',
      model: 'sonnet',
      eventVisibility: 'normal',
      metadata: {
        businessMessageId: 'msg_001',
      },
    });
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

  it('rejects run create fields that exceed length limits', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: long129,
        workspaceId: 'ws_123',
        kind: 'revise',
        prompt: 'Revise the report.',
      }),
    ).toThrow();

    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: long129,
        kind: 'revise',
        prompt: 'Revise the report.',
      }),
    ).toThrow();

    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'generate',
        skillId: long129,
        prompt: 'Generate the report.',
      }),
    ).toThrow();

    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'revise',
        prompt: 'Revise the report.',
        model: long129,
      }),
    ).toThrow();

    expect(
      createRunRequestSchema.parse({
        profileId: long128,
        workspaceId: long128,
        kind: 'revise',
        prompt: 'Revise the report.',
        model: long128,
      }),
    ).toMatchObject({
      profileId: long128,
      workspaceId: long128,
      model: long128,
    });
  });

  it('rejects prompts and artifact rule lists beyond Phase 1 limits', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'revise',
        prompt: 'x'.repeat(200_001),
      }),
    ).toThrow();

    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'revise',
        prompt: 'Revise the report.',
        artifactRuleIds: Array.from({ length: 33 }, (_, index) => `rule-${index}`),
      }),
    ).toThrow();

    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'revise',
        prompt: 'Revise the report.',
        artifactRuleIds: [long129],
      }),
    ).toThrow();

    expect(
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'revise',
        prompt: 'x'.repeat(200_000),
        artifactRuleIds: Array.from({ length: 32 }, (_, index) => `rule-${index}`),
      }),
    ).toMatchObject({
      artifactRuleIds: Array.from({ length: 32 }, (_, index) => `rule-${index}`),
    });
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

  it('accepts a business-context generate run with opaque business context', () => {
    const parsed = createRunRequestSchema.parse({
      profileId: 'report-docx',
      workspaceId: 'ws_123',
      conversationId: 'conv_123',
      kind: 'generate',
      promptMode: 'business-context',
      collectionMode: 'diagnostic',
      skillId: 'report-writer',
      currentPrompt: '请根据上传的业务材料生成报告',
      businessContext: {
        stage: 'initial-draft',
        inputFiles: ['input/source.docx'],
      },
      metadata: { business: 'reporting' },
    });

    expect(parsed.promptMode).toBe('business-context');
    expect(parsed.currentPrompt).toContain('报告');
    expect(parsed.businessContext).toEqual({
      stage: 'initial-draft',
      inputFiles: ['input/source.docx'],
    });
  });

  it('rejects invalid business-context request shapes', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'generate',
        promptMode: 'business-context',
        skillId: 'report-writer',
        prompt: 'raw prompt is forbidden here',
        currentPrompt: 'current prompt',
      }),
    ).toThrow();

    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'generate',
        promptMode: 'business-context',
        skillId: 'report-writer',
      }),
    ).toThrow();

    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'report-docx',
        workspaceId: 'ws_123',
        kind: 'revise',
        promptMode: 'business-context',
        currentPrompt: '用户已回答参数问题',
      }),
    ).toThrow();
  });

  it('rejects daemon-composed as a deferred prompt mode', () => {
    expect(() =>
      createRunRequestSchema.parse({
        profileId: 'general-agent',
        workspaceId: 'ws_123',
        conversationId: 'conv_123',
        kind: 'revise',
        promptMode: 'daemon-composed',
        currentPrompt: '继续刚才的修改',
      }),
    ).toThrow(/deferred|not supported/i);
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
