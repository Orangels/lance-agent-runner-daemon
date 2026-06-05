import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeRunPrompt } from '../prompt-composer.js';

function makeSkill(overrides: Partial<Parameters<typeof composeRunPrompt>[0]['skill']> = {}) {
  return {
    id: 'report-writer',
    name: 'Report Writer',
    description: 'Writes concise reports.',
    body: 'Use references/style.md and produce a clean report.',
    dir: '/private/skills/report-writer',
    folderName: 'report-writer',
    ...overrides,
  };
}

describe('prompt composer', () => {
  it('returns revise prompts unchanged', () => {
    expect(
      composeRunPrompt({
        kind: 'revise',
        promptMode: 'legacy',
        currentPrompt: 'Please revise the attached document.',
      }),
    ).toBe('Please revise the attached document.');
  });

  it('composes generate prompts from skill metadata, staged paths, body, and user request', () => {
    const stagedAbsoluteRoot = path.join(
      '/tmp/workspace',
      '.claude-runner-skills',
      'report-writer',
    );

    const prompt = composeRunPrompt({
      kind: 'generate',
      promptMode: 'legacy',
      currentPrompt: 'Create the quarterly report.',
      skill: makeSkill(),
      stagedSkill: {
        relativeRoot: '.claude-runner-skills/report-writer',
        absoluteRoot: stagedAbsoluteRoot,
        folderName: 'report-writer',
        sideFilesManifest: [
          {
            relativePath: 'references/style.md',
            size: 12,
            sha256: 'a'.repeat(64),
          },
        ],
      },
    });

    expect(prompt).toContain('Report Writer');
    expect(prompt).toContain('report-writer');
    expect(prompt).toContain('Writes concise reports.');
    expect(prompt).toContain('Use references/style.md and produce a clean report.');
    expect(prompt).toContain('Skill root (relative to workspace): `.claude-runner-skills/report-writer/`');
    expect(prompt).toContain('"relativePath": "references/style.md"');
    expect(prompt).not.toContain(`Skill root (absolute workspace path): \`${stagedAbsoluteRoot}\``);
    expect(prompt).not.toContain(stagedAbsoluteRoot);
    expect(prompt).not.toContain('/private/skills/report-writer');
    expect(prompt).toContain('## Current user request');
    expect(prompt).toContain('Create the quarterly report.');
  });

  it('omits staged path guidance when no staged skill copy is provided', () => {
    const prompt = composeRunPrompt({
      kind: 'generate',
      promptMode: 'legacy',
      currentPrompt: 'Create the report.',
      skill: makeSkill({ body: 'Write from the supplied brief.' }),
    });

    expect(prompt).toContain('Write from the supplied brief.');
    expect(prompt).toContain('## Current user request');
    expect(prompt).toContain('Create the report.');
    expect(prompt).not.toContain('.claude-runner-skills/report-writer');
    expect(prompt).not.toContain('Skill root');
  });

  it('injects skill instructions and opaque business context for business-context revise runs', () => {
    const prompt = composeRunPrompt({
      kind: 'revise',
      promptMode: 'business-context',
      currentPrompt: 'Update the RPA flow with these answers.',
      businessContext: {
        stage: 'question-form-answers',
        formAnswers: {
          unit: '公安局',
          dateRange: ['2026-06-01', '2026-06-05'],
        },
      },
      skill: makeSkill({
        id: 'report-writer',
        name: 'Report Writer',
        body: 'Update the report draft from the supplied answers.',
      }),
    });

    expect(prompt).toContain('Report Writer');
    expect(prompt).toContain('Update the report draft from the supplied answers.');
    expect(prompt).toContain('## Business context');
    expect(prompt).toContain('"stage": "question-form-answers"');
    expect(prompt).toContain('"unit": "公安局"');
    expect(prompt).toContain('## Current user request');
    expect(prompt).toContain('Update the RPA flow with these answers.');
  });

  it('does not inject product-specific language unless authored in the skill body', () => {
    const prompt = composeRunPrompt({
      kind: 'generate',
      promptMode: 'legacy',
      currentPrompt: 'Create a neutral report.',
      skill: makeSkill({
        name: 'Neutral Writer',
        description: '',
        body: 'Write a neutral report from the request.',
      }),
    });

    expect(prompt).not.toMatch(/lanceDesign|design system|critique|craft/);

    const authoredPrompt = composeRunPrompt({
      kind: 'generate',
      promptMode: 'legacy',
      currentPrompt: 'Create a report.',
      skill: makeSkill({
        body: 'Mention critique because this skill author explicitly requires it.',
      }),
    });
    expect(authoredPrompt).toContain('critique');
  });
});
