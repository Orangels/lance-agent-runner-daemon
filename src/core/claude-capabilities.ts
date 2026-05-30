import { execFile as nodeExecFile } from 'node:child_process';

export interface ClaudeCapabilities {
  partialMessages?: boolean;
  addDir?: boolean;
}

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

export type ClaudeCapabilityExecFile = (
  file: string,
  args: string[],
  callback: ExecFileCallback,
) => void;

interface ProbeClaudeCapabilitiesOptions {
  claudeBin: string;
  execFile?: ClaudeCapabilityExecFile;
}

export async function probeClaudeCapabilities(
  options: ProbeClaudeCapabilitiesOptions,
): Promise<ClaudeCapabilities> {
  const execFile = options.execFile ?? nodeExecFile;

  return new Promise((resolve) => {
    execFile(options.claudeBin, ['-p', '--help'], (error, stdout, stderr) => {
      if (error) {
        resolve({});
        return;
      }

      const helpOutput = `${stdout.toString()}\n${stderr.toString()}`;
      resolve({
        partialMessages: helpOutput.includes('--include-partial-messages'),
        addDir: helpOutput.includes('--add-dir'),
      });
    });
  });
}
