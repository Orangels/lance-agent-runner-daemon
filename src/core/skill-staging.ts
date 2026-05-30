import { cp, lstat, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { daemonError } from './errors.js';
import { assertSafePathSegment } from './path-safety.js';

export const STAGED_SKILLS_DIR = '.claude-runner-skills';

export type SkillStagingLogger = (message: string) => void;

export interface SkillForStaging {
  dir: string;
  folderName: string;
}

export interface StageSkillIntoWorkspaceInput {
  workspaceCwd: string;
  skill: SkillForStaging;
  logger?: SkillStagingLogger;
}

export interface StagedSkill {
  relativeRoot: string;
  absoluteRoot: string;
  folderName: string;
}

export async function stageSkillIntoWorkspace({
  workspaceCwd,
  skill,
  logger = () => {},
}: StageSkillIntoWorkspaceInput): Promise<StagedSkill> {
  const folderName = assertSafePathSegment(skill.folderName, 'skill folder name');
  const sourceStat = await stat(skill.dir).catch(() => {
    throw daemonError('BAD_REQUEST', 'Skill source is not available', 400);
  });

  if (!sourceStat.isDirectory()) {
    throw daemonError('BAD_REQUEST', 'Skill source is not a directory', 400);
  }

  const aliasRoot = path.join(workspaceCwd, STAGED_SKILLS_DIR);
  const absoluteRoot = path.join(aliasRoot, folderName);

  try {
    const aliasStat = await lstat(aliasRoot);
    if (aliasStat.isSymbolicLink()) {
      logger(`skill-stage: replacing stale symlink at ${aliasRoot}`);
      await rm(aliasRoot, { recursive: true, force: true });
    } else if (!aliasStat.isDirectory()) {
      throw daemonError('BAD_REQUEST', 'Skill staging root is not a directory', 400);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'DaemonError') {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await rm(absoluteRoot, { recursive: true, force: true });
  await cp(skill.dir, absoluteRoot, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
  });

  return {
    relativeRoot: `${STAGED_SKILLS_DIR}/${folderName}`,
    absoluteRoot,
    folderName,
  };
}
