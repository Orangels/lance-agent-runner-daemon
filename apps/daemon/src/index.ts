import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getConfigPathFromArgs, loadDaemonConfig } from './config/config.js';
import type { DaemonConfig } from './config/profiles.js';
import { createArtifactService, type ArtifactService } from './core/artifact-service.js';
import { createDaemonLogger, type DaemonLogger } from './core/daemon-logger.js';
import {
  createReviewBundleService,
  type ReviewBundleService,
} from './core/review-bundle-service.js';
import { createRunFeedbackService, type RunFeedbackService } from './core/run-feedback-service.js';
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
  reviewBundleService: ReviewBundleService;
  feedbackService: RunFeedbackService;
  runService: RunService;
  uploadTempService: UploadTempService;
  daemonLogger: DaemonLogger;
  app: ReturnType<typeof createApp>;
  interruptedRuns: number;
}

interface CreateServerContextOptions {
  clock?: () => number;
  daemonLogger?: DaemonLogger;
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
  const daemonLogger = options.daemonLogger ?? createDaemonLogger({ dataDir: config.server.dataDir });
  const db = openRunnerDatabase(config.server.dataDir);
  applySchema(db);
  const now = options.clock ?? Date.now;
  const startupNow = now();
  const interruptedRuns = markInterruptedRunsOnStartup(db, startupNow);
  const workspaceService = createWorkspaceService({ db });
  const artifactService = createArtifactService({ config, db, clock: options.clock });
  const runLogService = createRunLogService({ config, db });
  const reviewBundleService = createReviewBundleService({ config, db, runLogService });
  const feedbackService = createRunFeedbackService({ db, clock: options.clock });
  const runService = createRunService({ config, db, artifactService, runLogService, clock: options.clock });
  const uploadTempService = createUploadTempService({ config });
  uploadTempService.pruneExpiredUploads({ now: startupNow });
  const app = createApp({
    config,
    db,
    workspaceService,
    runService,
    runLogService,
    reviewBundleService,
    feedbackService,
    artifactService,
    uploadTempService,
    daemonLogger,
  });
  daemonLogger.info('daemon_context_ready', {
    clientCount: config.clients.length,
    interruptedRuns,
    profileCount: config.profiles.length,
  });

  return {
    config,
    db,
    workspaceService,
    artifactService,
    runLogService,
    reviewBundleService,
    feedbackService,
    runService,
    uploadTempService,
    daemonLogger,
    app,
    interruptedRuns,
  };
}

export function startServer(context: ServerContext): Server {
  context.daemonLogger.info('daemon_starting', {
    host: context.config.server.host,
    port: context.config.server.port,
  });
  const server = context.app.listen(context.config.server.port, context.config.server.host, () => {
    console.log(
      `claude runner daemon listening on ${context.config.server.host}:${context.config.server.port}`,
    );
    context.daemonLogger.info('daemon_started', {
      host: context.config.server.host,
      port: context.config.server.port,
    });
  });
  server.on('error', (error) => {
    context.daemonLogger.error('daemon_server_error', { error });
  });
  installShutdownHandlers(context, server);
  return server;
}

export function installShutdownHandlers(
  context: Pick<ServerContext, 'config' | 'db' | 'runService'> & { daemonLogger?: DaemonLogger },
  server: Pick<Server, 'close'>,
  signalTarget: SignalTarget = process,
): void {
  let shuttingDown = false;
  const handleSignal = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    context.daemonLogger?.info('daemon_shutdown_started');
    signalTarget.off('SIGINT', handleSignal);
    signalTarget.off('SIGTERM', handleSignal);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await context.runService.shutdownActive({ graceMs: getMaxCancelGraceMs(context.config) });
    context.db.close();
    context.daemonLogger?.info('daemon_shutdown_complete');
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
