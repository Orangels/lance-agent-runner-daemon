import type { RunKind } from './run-types.js';
import { badRequest } from './errors.js';
import type { StagedSkill } from './skill-staging.js';

export interface PromptSkill {
  id: string;
  name: string;
  description?: string;
  body: string;
}

export interface ComposeRunPromptInput {
  kind: RunKind;
  userPrompt: string;
  skill?: PromptSkill;
  stagedSkill?: StagedSkill;
}

export function composeRunPrompt({
  kind,
  userPrompt,
  skill,
  stagedSkill,
}: ComposeRunPromptInput): string {
  if (kind === 'revise') {
    return userPrompt;
  }

  if (!skill) {
    throw badRequest('kind=generate requires a resolved skill');
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
      `> Skill root (absolute workspace path): \`${stagedSkill.absoluteRoot}\``,
      '>',
      '> This skill ships side files alongside `SKILL.md`. Prefer the relative path above',
      '> when reading those files from the workspace. If that is not reachable, use the',
      '> absolute workspace path above.',
    );
  }

  sections.push('', '## Skill instructions', skill.body, '', '## User request', userPrompt);

  return sections.join('\n');
}
