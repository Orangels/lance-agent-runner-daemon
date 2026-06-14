import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { requireProfileAccess } from '../config/auth.js';
import type { ArtifactRuleConfig, ClientConfig, DaemonConfig, ProfileConfig } from '../config/profiles.js';
import { getProfile } from '../config/profiles.js';
import type { RunnerDatabase } from '../db/connection.js';
import { createSqliteRunnerPersistence } from '../db/sqlite-persistence.js';
import type { ArtifactRecord, RunnerPersistence, RunWithWorkspaceRecord, WorkspaceRecord } from '../db/types.js';
import { scanArtifacts, type ScannedArtifact } from './artifact-scanner.js';
import { badRequest, daemonError, notFound } from './errors.js';
import { createId } from './ids.js';
import { isPathInsideRoot, resolveUnderRoot } from './path-safety.js';
import type { ArtifactRole, PublicArtifact } from './run-types.js';
import { getWorkspaceCwd } from './workspace-service.js';

const artifactRolePriority: Record<ArtifactRole, number> = {
  debug: 0,
  supporting: 1,
  primary: 2,
};

export interface ArtifactService {
  resolveSelectedArtifactRules(input: {
    profile: ProfileConfig;
    artifactRuleIds?: string[];
  }): ArtifactRuleConfig[];
  finalizeRunArtifacts(input: {
    profile: ProfileConfig;
    workspace: WorkspaceRecord;
    runId: string;
    artifactRuleIds: string[];
  }): Promise<ArtifactFinalizationResult>;
  listRunArtifacts(input: { client: ClientConfig; runId: string }): Promise<PublicArtifact[]>;
  getRunArtifactDownload(input: {
    client: ClientConfig;
    runId: string;
    artifactId: string;
  }): Promise<ArtifactDownload>;
}

export interface ArtifactFinalizationResult {
  artifacts: PublicArtifact[];
  missingRequiredRuleIds: string[];
}

export interface ArtifactDownload {
  artifact: PublicArtifact;
  filePath: string;
  mimeType: string | null;
  fileName: string;
  size: number | null;
}

export interface CreateArtifactServiceInput {
  config: DaemonConfig;
  persistence?: RunnerPersistence;
  db?: RunnerDatabase;
  scanner?: (input: {
    workspaceCwd: string;
    rules: ArtifactRuleConfig[];
    now: number;
  }) => Promise<ScannedArtifact[]>;
  clock?: () => number;
  ids?: {
    artifactId?: () => string;
  };
}

export function createArtifactService(input: CreateArtifactServiceInput): ArtifactService {
  const now = input.clock ?? Date.now;
  const nextArtifactId = input.ids?.artifactId ?? (() => createId('artifact'));
  const scanner = input.scanner ?? scanArtifacts;
  const persistence =
    input.persistence ?? (input.db ? createSqliteRunnerPersistence(input.db) : null);
  if (!persistence) {
    throw new Error('ArtifactService requires persistence');
  }

  function resolveSelectedArtifactRules({
    profile,
    artifactRuleIds,
  }: {
    profile: ProfileConfig;
    artifactRuleIds?: string[];
  }): ArtifactRuleConfig[] {
    const selectedIds = artifactRuleIds ?? profile.defaultArtifactRuleIds;
    const seen = new Set<string>();
    const selectedRules: ArtifactRuleConfig[] = [];

    for (const ruleId of selectedIds) {
      if (seen.has(ruleId)) {
        continue;
      }
      seen.add(ruleId);

      const rule = profile.artifactRules.find((candidate) => candidate.id === ruleId);
      if (!rule) {
        throw badRequest('Unknown artifact rule', { ruleId, profileId: profile.id });
      }
      selectedRules.push(rule);
    }

    return selectedRules;
  }

  return {
    resolveSelectedArtifactRules,

    async finalizeRunArtifacts(finalizeInput): Promise<ArtifactFinalizationResult> {
      const rules = resolveSelectedArtifactRules({
        profile: finalizeInput.profile,
        artifactRuleIds: finalizeInput.artifactRuleIds,
      });
      const workspaceCwd = getWorkspaceCwd(finalizeInput.profile, finalizeInput.workspace);
      const timestamp = now();

      try {
        if (rules.length === 0) {
          return {
            artifacts: (
              await persistence.replaceArtifactsForRun({
              runId: finalizeInput.runId,
              workspaceId: finalizeInput.workspace.id,
              artifacts: [],
              now: timestamp,
              })
            ).map(toPublicArtifact),
            missingRequiredRuleIds: [],
          };
        }

        const scanned = await scanner({ workspaceCwd, rules, now: timestamp });
        const selectedArtifacts = selectHighestPriorityArtifacts(scanned);
        const artifacts = await persistence.replaceArtifactsForRun({
          runId: finalizeInput.runId,
          workspaceId: finalizeInput.workspace.id,
          artifacts: selectedArtifacts.map((artifact) => ({
            id: nextArtifactId(),
            ruleId: artifact.ruleId,
            role: artifact.role,
            relativePath: artifact.relativePath,
            fileName: artifact.fileName,
            mimeType: artifact.mimeType,
            size: artifact.size,
            mtime: artifact.mtime,
            sha256: artifact.sha256,
          })),
          now: timestamp,
        });

        const matchedRuleIds = new Set(scanned.map((artifact) => artifact.ruleId));
        const missingRequiredRuleIds = rules
          .filter((rule) => rule.required && !matchedRuleIds.has(rule.id))
          .map((rule) => rule.id);

        return {
          artifacts: artifacts.map(toPublicArtifact),
          missingRequiredRuleIds,
        };
      } catch {
        throw daemonError('ARTIFACT_SCAN_FAILED', 'Artifact scan failed', 500);
      }
    },

    async listRunArtifacts({ client, runId }): Promise<PublicArtifact[]> {
      const runWithWorkspace = await getReadableRunWithWorkspace(persistence, input.config, client, runId);
      return (
        await persistence.listArtifactsForRun({
        runId: runWithWorkspace.run.id,
        clientId: client.id,
        isAdmin: client.isAdmin,
        })
      ).map(toPublicArtifact);
    },

    async getRunArtifactDownload({ client, runId, artifactId }): Promise<ArtifactDownload> {
      const runWithWorkspace = await getReadableRunWithWorkspace(persistence, input.config, client, runId);
      const artifact = await persistence.getArtifactForRunForClient({
        runId: runWithWorkspace.run.id,
        artifactId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });
      if (!artifact) {
        throw notFound('Artifact not found');
      }

      const profile = getProfile(input.config, runWithWorkspace.run.profileId);
      const workspaceCwd = getWorkspaceCwd(profile, runWithWorkspace.workspace);
      const filePath = resolveUnderRoot(workspaceCwd, artifact.relativePath);
      const safeStat = await stat(filePath).catch(() => null);
      if (!safeStat?.isFile()) {
        throw notFound('Artifact not found');
      }

      const [realWorkspaceRoot, realArtifactPath] = await Promise.all([
        realpath(workspaceCwd),
        realpath(filePath),
      ]).catch(() => {
        throw notFound('Artifact not found');
      });
      if (!isPathInsideRoot(realWorkspaceRoot, realArtifactPath)) {
        throw notFound('Artifact not found');
      }

      return {
        artifact: toPublicArtifact(artifact),
        filePath,
        mimeType: artifact.mimeType,
        fileName: path.posix.basename(artifact.relativePath),
        size: safeStat.size,
      };
    },
  };
}

function selectHighestPriorityArtifacts(artifacts: ScannedArtifact[]): ScannedArtifact[] {
  const selectedByPath = new Map<string, ScannedArtifact>();

  for (const artifact of artifacts) {
    const existing = selectedByPath.get(artifact.relativePath);
    if (!existing || artifactRolePriority[artifact.role] > artifactRolePriority[existing.role]) {
      selectedByPath.set(artifact.relativePath, artifact);
    }
  }

  return [...selectedByPath.values()];
}

export function toPublicArtifact(artifact: ArtifactRecord): PublicArtifact {
  return {
    id: artifact.id,
    runId: artifact.runId,
    workspaceId: artifact.workspaceId,
    ruleId: artifact.ruleId,
    role: artifact.role,
    relativePath: artifact.relativePath,
    fileName: artifact.fileName,
    mimeType: artifact.mimeType,
    size: artifact.size,
    mtime: artifact.mtime,
    sha256: artifact.sha256,
  };
}

async function getReadableRunWithWorkspace(
  persistence: RunnerPersistence,
  config: DaemonConfig,
  client: ClientConfig,
  runId: string,
): Promise<RunWithWorkspaceRecord> {
  const runWithWorkspace = await persistence.getRunWithWorkspaceForClient({
    runId,
    clientId: client.id,
    isAdmin: client.isAdmin,
  });
  if (!runWithWorkspace) {
    throw notFound('Run not found');
  }
  requireProfileAccess(client, runWithWorkspace.run.profileId);
  getProfile(config, runWithWorkspace.run.profileId);
  return runWithWorkspace;
}
