import type { RunKind } from './run-types.js';
import type { ActivePromptMode } from './run-types.js';
import { badRequest } from './errors.js';
import type { StagedSkill } from './skill-staging.js';
import { stableJsonStringify } from './snapshot-service.js';

export interface PromptSkill {
  id: string;
  name: string;
  description?: string;
  body: string;
}

export interface ComposeRunPromptInput {
  kind: RunKind;
  promptMode: ActivePromptMode;
  currentPrompt: string;
  businessContext?: Record<string, unknown>;
  skill?: PromptSkill;
  stagedSkill?: StagedSkill;
}

export function composeRunPrompt({
  kind,
  promptMode,
  currentPrompt,
  businessContext,
  skill,
  stagedSkill,
}: ComposeRunPromptInput): string {
  if (promptMode === 'legacy' && kind === 'revise') {
    return currentPrompt;
  }

  if (!skill) {
    throw badRequest(`${promptMode} ${kind} requires a resolved skill`);
  }

  const sections = [
    '## Skill',
    `Name: ${skill.name}`,
    `ID: ${skill.id}`,
  ];

  if (skill.description && skill.description.trim().length > 0) {
    sections.push(`Description: ${skill.description}`);
  }

  if (stagedSkill) {
    sections.push(
      '',
      `> Skill root (relative to workspace): \`${stagedSkill.relativeRoot}/\``,
      '>',
      '> This skill ships side files alongside `SKILL.md`. Read them from the relative',
      '> path above inside the current workspace.',
    );

    if (stagedSkill.sideFilesManifest.length > 0) {
      sections.push(
        '',
        'Skill side files manifest:',
        '```json',
        stableJsonStringify(stagedSkill.sideFilesManifest, 2),
        '```',
      );
    }
  }

  sections.push('', '## Skill instructions', skill.body);

  if (businessContext) {
    sections.push(
      '',
      '## Business context',
      '```json',
      stableJsonStringify(businessContext, 2),
      '```',
    );
  }

  sections.push('', '## Current user request', currentPrompt);

  return sections.join('\n');
}
