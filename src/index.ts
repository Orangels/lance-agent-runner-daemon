import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getConfigPathFromArgs, loadDaemonConfig } from './config/config.js';
import type { DaemonConfig } from './config/profiles.js';
import { createRunService, type RunService } from './core/run-service.js';
import { createWorkspaceService, type WorkspaceService } from './core/workspace-service.js';
import { openRunnerDatabase, type RunnerDatabase } from './db/connection.js';
import { markInterruptedRunsOnStartup } from './db/repositories.js';
import { applySchema } from './db/schema.js';
import { createApp } from './http/app.js';

export interface ServerContext {
  config: DaemonConfig;
  db: RunnerDatabase;
  workspaceService: WorkspaceService;
  runService: RunService;
  app: ReturnType<typeof createApp>;
  interruptedRuns: number;
}

interface CreateServerContextOptions {
  clock?: () => number;
}

export function createServerContext(
  config: DaemonConfig,
  options: CreateServerContextOptions = {},
): ServerContext {
  const db = openRunnerDatabase(config.server.dataDir);
  applySchema(db);
  const interruptedRuns = markInterruptedRunsOnStartup(db, (options.clock ?? Date.now)());
  const workspaceService = createWorkspaceService({ db });
  const runService = createRunService({ config, db, clock: options.clock });
  const app = createApp({ config, db, workspaceService, runService });

  return {
    config,
    db,
    workspaceService,
    runService,
    app,
    interruptedRuns,
  };
}

export function startServer(context: ServerContext): Server {
  return context.app.listen(context.config.server.port, context.config.server.host, () => {
    console.log(
      `claude runner daemon listening on ${context.config.server.host}:${context.config.server.port}`,
    );
  });
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
