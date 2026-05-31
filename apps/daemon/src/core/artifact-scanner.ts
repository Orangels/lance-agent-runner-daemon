import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { ArtifactRuleConfig } from '../config/profiles.js';
import { daemonError } from './errors.js';
import { assertWorkspaceRelativePath, isPathInsideRoot, resolveUnderRoot } from './path-safety.js';

const STAGED_SKILLS_DIR = '.claude-runner-skills';

const mimeTypesByExtension = new Map<string, string>([
  ['.csv', 'text/csv'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

export interface ScannedArtifact {
  fileName: string;
  relativePath: string;
  ruleId: string;
  role: string;
  size: number;
  mtime: number;
  sha256: string;
  mimeType: string;
}

export interface ScanArtifactsOptions {
  workspaceCwd: string;
  rules: ArtifactRuleConfig[];
  now: number;
}

export async function scanArtifacts(options: ScanArtifactsOptions): Promise<ScannedArtifact[]> {
  const workspaceRoot = path.resolve(options.workspaceCwd);
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const artifacts: ScannedArtifact[] = [];
  const seenRulePaths = new Set<string>();

  for (const rule of options.rules) {
    validateRulePattern(rule);
    const matches = await fg(rule.pattern, {
      absolute: false,
      cwd: workspaceRoot,
      dot: true,
      followSymbolicLinks: true,
      ignore: [`${STAGED_SKILLS_DIR}/**`],
      markDirectories: false,
      objectMode: false,
      onlyFiles: true,
      unique: true,
    });

    for (const match of matches) {
      const relativePath = normalizeRelativePath(match);
      if (isStagedSkillPath(relativePath)) {
        continue;
      }

      const safeRelativePath = assertSafeArtifactRelativePath(rule, relativePath);
      const dedupeKey = `${rule.id}\0${safeRelativePath}`;
      if (seenRulePaths.has(dedupeKey)) {
        continue;
      }
      seenRulePaths.add(dedupeKey);

      const absolutePath = resolveUnderRoot(workspaceRoot, safeRelativePath);
      const realArtifactPath = await realpath(absolutePath);
      if (!isPathInsideRoot(realWorkspaceRoot, realArtifactPath)) {
        throw daemonError('PATH_NOT_ALLOWED', 'Matched artifact path escapes workspace', 400, {
          ruleId: rule.id,
          relativePath: safeRelativePath,
        });
      }

      const fileStat = await stat(absolutePath);
      artifacts.push({
        fileName: path.posix.basename(safeRelativePath),
        relativePath: safeRelativePath,
        ruleId: rule.id,
        role: rule.role,
        size: fileStat.size,
        mtime: Math.round(fileStat.mtimeMs),
        sha256: await hashFile(absolutePath),
        mimeType: mimeTypeForPath(safeRelativePath),
      });
    }
  }

  return artifacts.sort(compareArtifacts);
}

function validateRulePattern(rule: ArtifactRuleConfig): void {
  const pattern = rule.pattern;
  if (
    pattern.includes('\0') ||
    path.isAbsolute(pattern) ||
    path.win32.isAbsolute(pattern) ||
    hasParentSegment(pattern)
  ) {
    throw daemonError('PATH_NOT_ALLOWED', 'Artifact pattern is not allowed', 400, {
      ruleId: rule.id,
      pattern,
    });
  }
}

function hasParentSegment(pattern: string): boolean {
  return pattern.replaceAll('\\', '/').split('/').includes('..');
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

function isStagedSkillPath(relativePath: string): boolean {
  return relativePath === STAGED_SKILLS_DIR || relativePath.startsWith(`${STAGED_SKILLS_DIR}/`);
}

function assertSafeArtifactRelativePath(rule: ArtifactRuleConfig, relativePath: string): string {
  try {
    return assertWorkspaceRelativePath(relativePath);
  } catch {
    throw daemonError('PATH_NOT_ALLOWED', 'Matched artifact path is not allowed', 400, {
      ruleId: rule.id,
      relativePath,
    });
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function mimeTypeForPath(relativePath: string): string {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return mimeTypesByExtension.get(extension) ?? 'application/octet-stream';
}

function compareArtifacts(left: ScannedArtifact, right: ScannedArtifact): number {
  return (
    left.relativePath.localeCompare(right.relativePath) ||
    left.ruleId.localeCompare(right.ruleId) ||
    left.role.localeCompare(right.role)
  );
}
