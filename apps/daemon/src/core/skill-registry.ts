import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProfileConfig } from '../config/profiles.js';
import { daemonError } from './errors.js';
import {
  parseFrontmatter,
  type FrontmatterObject,
  type FrontmatterValue,
} from './frontmatter.js';

export type SkillSource = 'profile';

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  dir: string;
  folderName: string;
  source: SkillSource;
  metadata: FrontmatterObject;
  hasSideFiles: boolean;
}

const productMetadataKeys = new Set([
  'lancedesign',
  'craft',
  'preview',
  'design_system',
  'critique',
]);

const sideFileDirectoryNames = new Set(['assets', 'guides', 'references', 'scripts']);
const sideFileExtensions = new Set([
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export async function listProfileSkills(profile: ProfileConfig): Promise<SkillRecord[]> {
  const skills: SkillRecord[] = [];
  const seenIds = new Set<string>();

  for (const root of profile.skillRoots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skill = await readSkill(path.resolve(root, entry.name), entry.name);
      if (!skill || seenIds.has(skill.id)) {
        continue;
      }

      seenIds.add(skill.id);
      skills.push(skill);
    }
  }

  return skills;
}

export async function resolveSkillForProfile(
  profile: ProfileConfig,
  skillId: string,
): Promise<SkillRecord> {
  assertSkillAllowedForProfile(profile, skillId);

  const skills = await listProfileSkills(profile);
  const skill = skills.find((candidate) => candidate.id === skillId);
  if (!skill) {
    throw daemonError('SKILL_UNAVAILABLE', 'Skill is not available for this profile', 500, {
      profileId: profile.id,
      skillId,
    });
  }

  return skill;
}

export function assertSkillAllowedForProfile(profile: ProfileConfig, skillId: string): void {
  if (!profile.allowedSkillIds.includes(skillId)) {
    throwSkillNotAllowed(profile.id, skillId);
  }
}

async function readSkill(dir: string, folderName: string): Promise<SkillRecord | null> {
  const skillPath = path.join(dir, 'SKILL.md');
  try {
    const stats = await stat(skillPath);
    if (!stats.isFile()) {
      return null;
    }

    const raw = await readFile(skillPath, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const id = stringValue(data.id) ?? stringValue(data.name) ?? folderName;
    const name = stringValue(data.name) ?? id;
    const description = stringValue(data.description) ?? '';

    return {
      id,
      name,
      description,
      body,
      dir,
      folderName,
      source: 'profile',
      metadata: sanitizeMetadata(data),
      hasSideFiles: await dirHasSideFiles(dir),
    };
  } catch {
    return null;
  }
}

function sanitizeMetadata(data: FrontmatterObject): FrontmatterObject {
  const sanitized: FrontmatterObject = {};

  for (const [key, value] of Object.entries(data)) {
    if (productMetadataKeys.has(key.toLowerCase())) {
      continue;
    }

    sanitized[key] = sanitizeMetadataValue(value);
  }

  return sanitized;
}

function sanitizeMetadataValue(value: FrontmatterValue): FrontmatterValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item));
  }

  if (isFrontmatterObject(value)) {
    return sanitizeMetadata(value);
  }

  return value;
}

async function dirHasSideFiles(dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  return entries.some((entry) => {
    if (entry.name === 'SKILL.md') {
      return false;
    }

    if (entry.isDirectory()) {
      return sideFileDirectoryNames.has(entry.name);
    }

    if (!entry.isFile()) {
      return false;
    }

    return sideFileExtensions.has(path.extname(entry.name).toLowerCase());
  });
}

function stringValue(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isFrontmatterObject(value: FrontmatterValue): value is FrontmatterObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function throwSkillNotAllowed(profileId: string, skillId: string): never {
  throw daemonError('SKILL_NOT_ALLOWED', 'Skill is not allowed for this profile', 400, {
    profileId,
    skillId,
  });
}
