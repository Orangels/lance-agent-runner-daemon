import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DaemonError } from '../../src/core/errors.js';
import { STAGED_SKILLS_DIR, stageSkillIntoWorkspace } from '../../src/core/skill-staging.js';

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'runner-skill-staging-test-'));
}

function makeSkill(dir: string, folderName = path.basename(dir)) {
  return {
    id: 'report-writer',
    name: 'Report Writer',
    description: 'Writes reports',
    body: 'Use the templates.',
    dir,
    folderName,
  };
}

describe('skill staging', () => {
  it('copies only the active skill directory under the workspace staging root', async () => {
    const root = makeTempRoot();
    const workspaceCwd = path.join(root, 'workspace');
    const skillsRoot = path.join(root, 'skills');
    const activeSkill = path.join(skillsRoot, 'report-writer');
    const inactiveSkill = path.join(skillsRoot, 'spreadsheet-maker');
    mkdirSync(path.join(activeSkill, 'assets'), { recursive: true });
    mkdirSync(inactiveSkill, { recursive: true });
    writeFileSync(path.join(activeSkill, 'SKILL.md'), '# Report Writer');
    writeFileSync(path.join(activeSkill, 'assets', 'template.md'), 'template');
    writeFileSync(path.join(inactiveSkill, 'SKILL.md'), '# Spreadsheet Maker');

    const staged = await stageSkillIntoWorkspace({
      workspaceCwd,
      skill: makeSkill(activeSkill, 'report-writer'),
    });

    expect(staged).toEqual({
      relativeRoot: `${STAGED_SKILLS_DIR}/report-writer`,
      absoluteRoot: path.join(workspaceCwd, STAGED_SKILLS_DIR, 'report-writer'),
      folderName: 'report-writer',
      sideFilesManifest: [
        expect.objectContaining({
          relativePath: 'assets/template.md',
          size: 8,
        }),
      ],
    });
    expect(staged.sideFilesManifest[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(path.join(staged.absoluteRoot, 'assets', 'template.md'), 'utf8')).toBe(
      'template',
    );
    expect(existsSync(path.join(workspaceCwd, STAGED_SKILLS_DIR, 'spreadsheet-maker'))).toBe(
      false,
    );
  });

  it('creates a real copy, dereferences source symlinks, and isolates edits from the source', async () => {
    const root = makeTempRoot();
    const workspaceCwd = path.join(root, 'workspace');
    const sourceSkill = path.join(root, 'skills', 'report-writer');
    mkdirSync(path.join(sourceSkill, 'assets'), { recursive: true });
    writeFileSync(path.join(sourceSkill, 'SKILL.md'), '# Report Writer');
    writeFileSync(path.join(sourceSkill, 'assets', 'source-template.md'), 'source template');
    symlinkSync(
      path.join(sourceSkill, 'assets', 'source-template.md'),
      path.join(sourceSkill, 'assets', 'linked-template.md'),
    );

    const staged = await stageSkillIntoWorkspace({
      workspaceCwd,
      skill: makeSkill(sourceSkill, 'report-writer'),
    });
    const stagedLinkedFile = path.join(staged.absoluteRoot, 'assets', 'linked-template.md');

    expect(lstatSync(staged.absoluteRoot).isSymbolicLink()).toBe(false);
    expect(lstatSync(stagedLinkedFile).isSymbolicLink()).toBe(false);
    expect(readFileSync(stagedLinkedFile, 'utf8')).toBe('source template');

    writeFileSync(path.join(staged.absoluteRoot, 'assets', 'source-template.md'), 'changed copy');

    expect(readFileSync(path.join(sourceSkill, 'assets', 'source-template.md'), 'utf8')).toBe(
      'source template',
    );
  });

  it('records a deterministic side files manifest without SKILL.md or absolute paths', async () => {
    const root = makeTempRoot();
    const workspaceCwd = path.join(root, 'workspace');
    const sourceSkill = path.join(root, 'skills', 'report-writer');
    mkdirSync(path.join(sourceSkill, 'references'), { recursive: true });
    mkdirSync(path.join(sourceSkill, 'templates'), { recursive: true });
    writeFileSync(path.join(sourceSkill, 'SKILL.md'), '# Report Writer');
    writeFileSync(path.join(sourceSkill, 'references', 'style.md'), 'style rules');
    writeFileSync(path.join(sourceSkill, 'templates', 'base.py'), 'print("base")');

    const staged = await stageSkillIntoWorkspace({
      workspaceCwd,
      skill: makeSkill(sourceSkill, 'report-writer'),
    });

    expect(staged.sideFilesManifest).toEqual([
      {
        relativePath: 'references/style.md',
        size: 11,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        relativePath: 'templates/base.py',
        size: 13,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(JSON.stringify(staged.sideFilesManifest)).not.toContain(sourceSkill);
    expect(staged.sideFilesManifest.map((entry) => entry.relativePath)).not.toContain('SKILL.md');
  });

  it('replaces the stale per-skill staged copy before copying', async () => {
    const root = makeTempRoot();
    const workspaceCwd = path.join(root, 'workspace');
    const sourceSkill = path.join(root, 'skills', 'report-writer');
    const staleStaged = path.join(workspaceCwd, STAGED_SKILLS_DIR, 'report-writer');
    mkdirSync(staleStaged, { recursive: true });
    mkdirSync(sourceSkill, { recursive: true });
    writeFileSync(path.join(staleStaged, 'removed.txt'), 'stale');
    writeFileSync(path.join(staleStaged, 'SKILL.md'), 'old');
    writeFileSync(path.join(sourceSkill, 'SKILL.md'), 'fresh');

    const staged = await stageSkillIntoWorkspace({
      workspaceCwd,
      skill: makeSkill(sourceSkill, 'report-writer'),
    });

    expect(readFileSync(path.join(staged.absoluteRoot, 'SKILL.md'), 'utf8')).toBe('fresh');
    expect(existsSync(path.join(staged.absoluteRoot, 'removed.txt'))).toBe(false);
  });

  it.each(['', '.', '..', 'nested/name', 'nested\\name', `bad\0name`, '/absolute'])(
    'rejects unsafe skill folder name %s',
    async (folderName) => {
      const root = makeTempRoot();
      const workspaceCwd = path.join(root, 'workspace');
      const sourceSkill = path.join(root, 'skills', 'report-writer');
      mkdirSync(sourceSkill, { recursive: true });
      writeFileSync(path.join(sourceSkill, 'SKILL.md'), '# Report Writer');

      await expect(
        stageSkillIntoWorkspace({
          workspaceCwd,
          skill: makeSkill(sourceSkill, folderName),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PATH_SEGMENT' });
    },
  );

  it('fails for a non-directory source without deleting unrelated workspace files', async () => {
    const root = makeTempRoot();
    const workspaceCwd = path.join(root, 'workspace');
    const sourceSkill = path.join(root, 'skills', 'report-writer');
    const unrelated = path.join(workspaceCwd, STAGED_SKILLS_DIR, 'unrelated', 'keep.txt');
    mkdirSync(path.dirname(sourceSkill), { recursive: true });
    mkdirSync(path.dirname(unrelated), { recursive: true });
    writeFileSync(sourceSkill, 'not a directory');
    writeFileSync(unrelated, 'keep me');

    await expect(
      stageSkillIntoWorkspace({
        workspaceCwd,
        skill: makeSkill(sourceSkill, 'report-writer'),
      }),
    ).rejects.toBeInstanceOf(DaemonError);

    expect(readFileSync(unrelated, 'utf8')).toBe('keep me');
    expect(statSync(path.dirname(unrelated)).isDirectory()).toBe(true);
  });
});
