import {
  isDaemonArtifactFinalizedEvent,
  isDaemonEndEvent,
  isDaemonErrorEvent,
  isDaemonTextDeltaEvent,
  type DaemonRunStatus,
} from '../../shared/daemon-event-types.js';

export interface DaemonRunConsumerClient {
  subscribeRunEvents(runId: string, after?: string): AsyncGenerator<{ id: string; event: unknown }>;
}

export interface ConsumeDaemonRunInput {
  daemonClient: DaemonRunConsumerClient;
  runId: string;
  appendLog?: (message: string) => Promise<void>;
}

export interface ConsumedDaemonRun {
  transcript: string;
  terminalStatus?: DaemonRunStatus;
}

export async function consumeDaemonRun(input: ConsumeDaemonRunInput): Promise<ConsumedDaemonRun> {
  let transcript = '';
  let terminalStatus: DaemonRunStatus | undefined;

  for await (const record of input.daemonClient.subscribeRunEvents(input.runId)) {
    const { event } = record;
    if (isDaemonTextDeltaEvent(event)) {
      transcript += event.delta;
    } else if (isDaemonArtifactFinalizedEvent(event)) {
      await input.appendLog?.(`Artifact created: ${event.artifact.relativePath}`);
    } else if (isDaemonErrorEvent(event)) {
      await input.appendLog?.(`${event.code ?? 'ERROR'}: ${event.message}`);
    } else if (isDaemonEndEvent(event)) {
      terminalStatus = event.status;
    }
  }

  return { transcript, terminalStatus };
}
