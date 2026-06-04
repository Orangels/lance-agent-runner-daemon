import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileConfig } from '../../config/profiles.js';
import { DaemonError } from '../errors.js';
import {
  assertSkillAllowedForProfile,
  listProfileSkills,
  resolveSkillForProfile,
} from '../skill-registry.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-registry-test-'));
  tempRoots.push(root);
  return root;
}

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: 'default',
    sandboxRoot: '/tmp/runner/sandboxes',
    claudeConfigDir: '/tmp/runner/profiles/default/claude',
    claudeBin: 'claude',
    skillRoots: [],
    allowedInputRoots: [],
    allowedSkillIds: [],
    artifactRules: [],
    defaultArtifactRuleIds: [],
    permissionMode: 'bypassPermissions',
    defaultModel: 'sonnet',
    allowedModels: ['sonnet'],
    eventVisibility: 'quiet',
    profileConcurrency: 1,
    runTimeoutMs: 60_000,
    inactivityTimeoutMs: 10_000,
    cancelGraceMs: 1_000,
    env: {},
    ...overrides,
  };
}

function writeSkill(root: string, folderName: string, contents: string): string {
  const dir = path.join(root, folderName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), contents);
  return dir;
}

describe('listProfileSkills', () => {
  it('scans profile skill roots, skips missing or unreadable roots, strips frontmatter from body, and lets the first root win duplicate ids', async () => {
    const rootA = makeTempRoot();
    const rootB = makeTempRoot();
    const missingRoot = path.join(makeTempRoot(), 'missing');
    const unreadableRoot = path.join(makeTempRoot(), 'not-a-directory');
    writeFileSync(unreadableRoot, 'not a scannable skill root');
    const expectedDir = writeSkill(
      rootA,
      'report-writer-a',
      `---
name: report-writer
description: From first root
---
# First body
`,
    );
    writeSkill(
      rootB,
      'report-writer-b',
      `---
name: report-writer
description: From second root
---
# Second body
`,
    );
    writeSkill(rootB, 'summary-writer', '# Summary body\n');

    const skills = await listProfileSkills(
      makeProfile({ skillRoots: [missingRoot, unreadableRoot, rootA, rootB] }),
    );

    expect(skills.map((skill) => skill.id).sort()).toEqual(['report-writer', 'summary-writer']);
    const reportWriter = skills.find((skill) => skill.id === 'report-writer');
    expect(reportWriter).toMatchObject({
      id: 'report-writer',
      name: 'report-writer',
      description: 'From first root',
      body: '# First body\n',
      dir: expectedDir,
      folderName: 'report-writer-a',
    });
    expect(path.isAbsolute(reportWriter?.dir ?? '')).toBe(true);
    expect(reportWriter?.body).not.toContain('description: From first root');
  });

  it('uses frontmatter id as a new daemon extension, then falls back to name and folder id', async () => {
    const root = makeTempRoot();
    // Frontmatter id is new in this daemon; lanceDesign only derived ids from
    // name or folder, but generic skill packages should not be UI-name-coupled.
    writeSkill(
      root,
      'folder-id',
      `---
id: stable-id
name: Display Name
description: Uses explicit id
---
Body
`,
    );
    writeSkill(
      root,
      'named-folder',
      `---
name: name-id
description: Uses name fallback
---
Body
`,
    );
    writeSkill(root, 'folder-fallback', 'Body\n');

    const skills = await listProfileSkills(makeProfile({ skillRoots: [root] }));

    expect(skills.map((skill) => skill.id).sort()).toEqual([
      'folder-fallback',
      'name-id',
      'stable-id',
    ]);
    expect(skills.find((skill) => skill.id === 'stable-id')).toMatchObject({
      id: 'stable-id',
      name: 'Display Name',
      description: 'Uses explicit id',
    });
  });

  it('keeps generic metadata and excludes lanceDesign product metadata fields', async () => {
    const root = makeTempRoot();
    writeSkill(
      root,
      'metadata-skill',
      `---
id: metadata-skill
name: Metadata Skill
category: generic
version: 2
lancedesign:
  craft:
    requires:
      - brand
craft:
  requires:
    - product
preview: html
design_system: true
critique: required
---
Body
`,
    );

    const [skill] = await listProfileSkills(makeProfile({ skillRoots: [root] }));

    expect(skill?.metadata).toEqual({
      id: 'metadata-skill',
      name: 'Metadata Skill',
      category: 'generic',
      version: 2,
    });
    expect(JSON.stringify(skill?.metadata)).not.toContain('lancedesign');
    expect(JSON.stringify(skill?.metadata)).not.toContain('craft');
    expect(JSON.stringify(skill?.metadata)).not.toContain('preview');
    expect(JSON.stringify(skill?.metadata)).not.toContain('design_system');
    expect(JSON.stringify(skill?.metadata)).not.toContain('critique');
  });

  it('detects side files only when the skill directory has attachments beyond SKILL.md', async () => {
    const root = makeTempRoot();
    writeSkill(root, 'plain-skill', 'Plain body\n');
    const withAssetsDir = writeSkill(root, 'asset-skill', 'Asset body\n');
    mkdirSync(path.join(withAssetsDir, 'assets'));
    const withReferenceDir = writeSkill(root, 'reference-skill', 'Reference body\n');
    mkdirSync(path.join(withReferenceDir, 'references'));
    const withGuidesDir = writeSkill(root, 'guides-skill', 'Guides body\n');
    mkdirSync(path.join(withGuidesDir, 'guides'));
    const withScriptDir = writeSkill(root, 'script-skill', 'Script body\n');
    mkdirSync(path.join(withScriptDir, 'scripts'));
    const withTemplatesDir = writeSkill(root, 'templates-skill', 'Templates body\n');
    mkdirSync(path.join(withTemplatesDir, 'templates'));
    const withSibling = writeSkill(root, 'sibling-skill', 'Sibling body\n');
    writeFileSync(path.join(withSibling, 'notes.md'), 'notes');

    const skills = await listProfileSkills(makeProfile({ skillRoots: [root] }));

    expect(Object.fromEntries(skills.map((skill) => [skill.id, skill.hasSideFiles]))).toEqual({
      'plain-skill': false,
      'asset-skill': true,
      'reference-skill': true,
      'guides-skill': true,
      'script-skill': true,
      'templates-skill': true,
      'sibling-skill': true,
    });
  });
});

describe('resolveSkillForProfile', () => {
  it('resolves a filesystem-discovered skill only when the id is profile allowed', async () => {
    const root = makeTempRoot();
    writeSkill(root, 'report-writer', 'Body\n');
    const profile = makeProfile({ skillRoots: [root], allowedSkillIds: ['report-writer'] });

    await expect(resolveSkillForProfile(profile, 'report-writer')).resolves.toMatchObject({
      id: 'report-writer',
      body: 'Body\n',
    });
  });

  it('throws SKILL_NOT_ALLOWED for disallowed ids', async () => {
    const root = makeTempRoot();
    writeSkill(root, 'report-writer', 'Body\n');
    const profile = makeProfile({ skillRoots: [root], allowedSkillIds: [] });

    expect(() => assertSkillAllowedForProfile(profile, 'report-writer')).toThrow(
      expect.objectContaining({ code: 'SKILL_NOT_ALLOWED' }),
    );
    await expect(resolveSkillForProfile(profile, 'report-writer')).rejects.toMatchObject({
      code: 'SKILL_NOT_ALLOWED',
    });
  });

  it('throws SKILL_UNAVAILABLE for allowed but missing ids without leaking root absolute paths', async () => {
    const root = makeTempRoot();
    const profile = makeProfile({
      skillRoots: [root],
      allowedSkillIds: ['report-writer'],
    });

    expect(() => assertSkillAllowedForProfile(profile, 'report-writer')).not.toThrow();
    try {
      await resolveSkillForProfile(profile, 'report-writer');
      throw new Error('expected skill resolution to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      expect((error as DaemonError).code).toBe('SKILL_UNAVAILABLE');
      expect((error as DaemonError).message).not.toContain(root);
      expect(JSON.stringify((error as DaemonError).details)).not.toContain(root);
    }
  });
});
