import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getConfigPathFromArgs, loadDaemonConfig } from './config/config.js';
import type { DaemonConfig } from './config/profiles.js';
import { createArtifactService, type ArtifactService } from './core/artifact-service.js';
import { createRunLogService, type RunLogService } from './core/run-log-service.js';
import { createRunService, type RunService } from './core/run-service.js';
import { createUploadTempService, type UploadTempService } from './core/upload-temp-service.js';
import { createWorkspaceService, type WorkspaceService } from './core/workspace-service.js';
import { openRunnerDatabase, type RunnerDatabase } from './db/connection.js';
import { markInterruptedRunsOnStartup } from './db/repositories.js';
import { applySchema } from './db/schema.js';
import { createApp } from './http/app.js';

export interface ServerContext {
  config: DaemonConfig;
  db: RunnerDatabase;
  workspaceService: WorkspaceService;
  artifactService: ArtifactService;
  runLogService: RunLogService;
  runService: RunService;
  uploadTempService: UploadTempService;
  app: ReturnType<typeof createApp>;
  interruptedRuns: number;
}

interface CreateServerContextOptions {
  clock?: () => number;
}

interface SignalTarget {
  exitCode?: string | number;
  once(signal: NodeJS.Signals, listener: () => void | Promise<void>): unknown;
  off(signal: NodeJS.Signals, listener: () => void | Promise<void>): unknown;
}

export function createServerContext(
  config: DaemonConfig,
  options: CreateServerContextOptions = {},
): ServerContext {
  const db = openRunnerDatabase(config.server.dataDir);
  applySchema(db);
  const now = options.clock ?? Date.now;
  const startupNow = now();
  const interruptedRuns = markInterruptedRunsOnStartup(db, startupNow);
  const workspaceService = createWorkspaceService({ db });
  const artifactService = createArtifactService({ config, db, clock: options.clock });
  const runLogService = createRunLogService({ config, db });
  const runService = createRunService({ config, db, artifactService, runLogService, clock: options.clock });
  const uploadTempService = createUploadTempService({ config });
  uploadTempService.pruneExpiredUploads({ now: startupNow });
  const app = createApp({
    config,
    db,
    workspaceService,
    runService,
    runLogService,
    artifactService,
    uploadTempService,
  });

  return {
    config,
    db,
    workspaceService,
    artifactService,
    runLogService,
    runService,
    uploadTempService,
    app,
    interruptedRuns,
  };
}

export function startServer(context: ServerContext): Server {
  const server = context.app.listen(context.config.server.port, context.config.server.host, () => {
    console.log(
      `claude runner daemon listening on ${context.config.server.host}:${context.config.server.port}`,
    );
  });
  installShutdownHandlers(context, server);
  return server;
}

export function installShutdownHandlers(
  context: Pick<ServerContext, 'config' | 'db' | 'runService'>,
  server: Pick<Server, 'close'>,
  signalTarget: SignalTarget = process,
): void {
  let shuttingDown = false;
  const handleSignal = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    signalTarget.off('SIGINT', handleSignal);
    signalTarget.off('SIGTERM', handleSignal);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await context.runService.shutdownActive({ graceMs: getMaxCancelGraceMs(context.config) });
    context.db.close();
    signalTarget.exitCode = 0;
  };

  signalTarget.once('SIGINT', handleSignal);
  signalTarget.once('SIGTERM', handleSignal);
}

function getMaxCancelGraceMs(config: DaemonConfig): number {
  return Math.max(0, ...config.profiles.map((profile) => profile.cancelGraceMs));
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Server | undefined {
  const configPath = getConfigPathFromArgs(argv, env);
  if (!configPath) {
    throw new Error('Missing --config <path> or CLAUDE_RUNNER_CONFIG');
  }

  const config = loadDaemonConfig(configPath, env);
  return startServer(createServerContext(config));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
