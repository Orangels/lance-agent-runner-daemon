import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArtifactRuleConfig } from '../../src/config/profiles.js';
import { DaemonError } from '../../src/core/errors.js';
import { scanArtifacts } from '../../src/core/artifact-scanner.js';

const fixedMtime = new Date('2026-01-02T03:04:05.000Z');

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'artifact-scanner-test-'));
}

function writeWorkspaceFile(workspaceCwd: string, relativePath: string, content: string): void {
  const filePath = path.join(workspaceCwd, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  utimesSync(filePath, fixedMtime, fixedMtime);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('scanArtifacts', () => {
  it('returns sorted workspace-relative artifact metadata for multiple selected rules', async () => {
    const workspaceCwd = makeWorkspace();
    const files = [
      ['output/blob.bin', 'bin'],
      ['output/data.json', '{"ok":true}'],
      ['output/items.csv', 'a,b\n1,2\n'],
      ['output/notes.md', '# Notes\n'],
      ['output/page.html', '<!doctype html>'],
      ['output/readme.txt', 'hello'],
      ['output/report.docx', 'docx'],
      ['output/report.pdf', '%PDF-1.7'],
      ['output/table.xlsx', 'xlsx'],
      ['work/summary.md', '# Summary\n'],
    ] as const;
    for (const [relativePath, content] of files) {
      writeWorkspaceFile(workspaceCwd, relativePath, content);
    }

    const artifacts = await scanArtifacts({
      workspaceCwd,
      now: 1770000000000,
      rules: [
        { id: 'outputs', pattern: 'output/**/*', role: 'primary', required: true },
        { id: 'work-markdown', pattern: 'work/**/*.md', role: 'supporting', required: false },
      ],
    });

    expect(artifacts.map((artifact) => artifact.relativePath)).toEqual(
      files.map(([relativePath]) => relativePath).sort(),
    );
    expect(artifacts.find((artifact) => artifact.relativePath === 'output/report.docx')).toEqual({
      fileName: 'report.docx',
      relativePath: 'output/report.docx',
      ruleId: 'outputs',
      role: 'primary',
      size: 4,
      mtime: fixedMtime.getTime(),
      sha256: sha256('docx'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(
      Object.fromEntries(
        artifacts
          .filter((artifact) => artifact.relativePath.startsWith('output/'))
          .map((artifact) => [artifact.relativePath, artifact.mimeType]),
      ),
    ).toEqual({
      'output/blob.bin': 'application/octet-stream',
      'output/data.json': 'application/json',
      'output/items.csv': 'text/csv',
      'output/notes.md': 'text/markdown',
      'output/page.html': 'text/html',
      'output/readme.txt': 'text/plain',
      'output/report.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'output/report.pdf': 'application/pdf',
      'output/table.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  });

  it('dedupes the same rule and path while keeping separate rules for the same file', async () => {
    const workspaceCwd = makeWorkspace();
    writeWorkspaceFile(workspaceCwd, 'output/report.pdf', '%PDF-1.7');

    const rules: ArtifactRuleConfig[] = [
      { id: 'primary', pattern: 'output/*.pdf', role: 'primary', required: true },
      { id: 'primary', pattern: 'output/**/*.pdf', role: 'primary', required: true },
      { id: 'debug', pattern: 'output/report.pdf', role: 'debug', required: false },
    ];

    const artifacts = await scanArtifacts({ workspaceCwd, rules, now: 1770000000000 });

    expect(artifacts.map((artifact) => `${artifact.relativePath}:${artifact.ruleId}`)).toEqual([
      'output/report.pdf:debug',
      'output/report.pdf:primary',
    ]);
  });

  it.each(['/tmp/*.pdf', 'C:\\tmp\\*.pdf', 'output/\0*.pdf'])(
    'rejects unsafe artifact pattern %s',
    async (pattern) => {
      const workspaceCwd = makeWorkspace();

      await expect(
        scanArtifacts({
          workspaceCwd,
          now: 1770000000000,
          rules: [{ id: 'unsafe', pattern, role: 'primary', required: false }],
        }),
      ).rejects.toMatchObject({
        name: 'DaemonError',
        code: 'PATH_NOT_ALLOWED',
        status: 400,
        details: { ruleId: 'unsafe', pattern },
      });
    },
  );

  it('never returns artifacts from the staged skill directory', async () => {
    const workspaceCwd = makeWorkspace();
    writeWorkspaceFile(workspaceCwd, 'output/report.pdf', '%PDF-1.7');
    writeWorkspaceFile(workspaceCwd, '.claude-runner-skills/report-writer/hidden.pdf', '%PDF-1.7');

    const artifacts = await scanArtifacts({
      workspaceCwd,
      now: 1770000000000,
      rules: [{ id: 'all-pdfs', pattern: '**/*.pdf', role: 'primary', required: false }],
    });

    expect(artifacts.map((artifact) => artifact.relativePath)).toEqual(['output/report.pdf']);
  });

  it('rejects matched files whose real path escapes the workspace root', async () => {
    const workspaceCwd = makeWorkspace();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), 'artifact-scanner-outside-'));
    mkdirSync(path.join(workspaceCwd, 'output'), { recursive: true });
    writeFileSync(path.join(outsideRoot, 'secret.pdf'), '%PDF-1.7');
    symlinkSync(path.join(outsideRoot, 'secret.pdf'), path.join(workspaceCwd, 'output/secret.pdf'));

    await expect(
      scanArtifacts({
        workspaceCwd,
        now: 1770000000000,
        rules: [{ id: 'pdfs', pattern: 'output/**/*.pdf', role: 'primary', required: false }],
      }),
    ).rejects.toBeInstanceOf(DaemonError);
    await expect(
      scanArtifacts({
        workspaceCwd,
        now: 1770000000000,
        rules: [{ id: 'pdfs', pattern: 'output/**/*.pdf', role: 'primary', required: false }],
      }),
    ).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
      status: 400,
      details: { relativePath: 'output/secret.pdf' },
    });
  });
});
