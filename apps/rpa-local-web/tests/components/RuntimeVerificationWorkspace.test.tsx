import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeVerificationWorkspace } from '../../src/components/RuntimeVerificationWorkspace.js';
import { createMinimalRpaDsl } from '../../src/shared/dsl-schema.js';
import type {
  RpaExecutionArtifactsResponse,
  RpaExecutionEvent,
  RpaExecutionLogResponse,
  RpaExecutionStatusResponse,
  RpaFlowDetailResponse,
  StartRpaExecutionRequest,
  StartRpaExecutionResponse,
} from '../../src/shared/rpa-api-types.js';

afterEach(() => cleanup());

describe('RuntimeVerificationWorkspace', () => {
  it('loads the default flow and renders DSL steps', async () => {
    const client = new FakeRuntimeClient();

    render(<RuntimeVerificationWorkspace client={client} />);

    expect(await screen.findByText('案件查询')).toBeInTheDocument();
    expect(screen.getByText('打开查询页')).toBeInTheDocument();
    expect(client.getFlow).toHaveBeenCalledWith('case_query');
  });

  it('starts verify runs, streams events, and refreshes runtime panels', async () => {
    const client = new FakeRuntimeClient();

    render(<RuntimeVerificationWorkspace client={client} />);
    await screen.findByText('案件查询');

    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(client.startExecution).toHaveBeenCalledWith({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      params: {},
    });
    expect(client.subscribeExecutionEvents).toHaveBeenCalledWith('exec_1', expect.any(Object));

    await act(async () => {
      client.emit({ type: 'run.started', executionId: 'exec_1', status: 'running', sequence: 1 });
      client.emit({ type: 'step.started', executionId: 'exec_1', stepId: 's1', sequence: 2 });
      client.emit({ type: 'log', executionId: 'exec_1', message: 'opening page', stream: 'stdout' });
      client.emit({ type: 'log', executionId: 'exec_1', message: 'deduped event', stream: 'stdout', sequence: 3 });
      client.emit({ type: 'log', executionId: 'exec_1', message: 'deduped event', stream: 'stdout', sequence: 3 });
      client.emit({
        type: 'artifact.created',
        executionId: 'exec_1',
        artifactId: 'art_1',
        role: 'screenshot',
        relativePath: 'screenshots/current.png',
        sequence: 4,
      });
      client.emit({ type: 'run.completed', executionId: 'exec_1', status: 'succeeded', exitCode: 0, sequence: 5 });
    });

    expect(await screen.findByText('opening page')).toBeInTheDocument();
    expect(screen.getAllByText('deduped event')).toHaveLength(1);
    expect(screen.getByLabelText('stdout')).toHaveValue('stdout line');
    expect(screen.getByRole('link', { name: 'current.png' })).toHaveAttribute(
      'href',
      '/api/rpa/executions/exec_1/artifacts/art_1/download',
    );
    expect(screen.getByRole('img', { name: 'Current execution screenshot' })).toHaveAttribute(
      'src',
      '/api/rpa/executions/exec_1/screenshots/current?cacheKey=refreshed',
    );
    expect(within(screen.getByTestId('rpa-step-s1')).getByText('running')).toBeInTheDocument();
    expect(screen.getByText('succeeded')).toBeInTheDocument();
  });

  it('cancels the active execution', async () => {
    const client = new FakeRuntimeClient();

    render(<RuntimeVerificationWorkspace client={client} />);
    await screen.findByText('案件查询');
    await userEvent.click(screen.getByRole('button', { name: /Start/ }));
    await userEvent.click(screen.getByRole('button', { name: /Cancel/ }));

    expect(client.cancelExecution).toHaveBeenCalledWith('exec_1');
  });

  it('supports controlled flowId updates for later workflow reuse', async () => {
    const client = new FakeRuntimeClient();
    const onFlowIdChange = vi.fn();
    const { rerender } = render(
      <RuntimeVerificationWorkspace client={client} flowId="case_query" onFlowIdChange={onFlowIdChange} />,
    );

    expect(await screen.findByDisplayValue('case_query')).toBeInTheDocument();

    rerender(<RuntimeVerificationWorkspace client={client} flowId="report_download" onFlowIdChange={onFlowIdChange} />);

    await waitFor(() => expect(client.getFlow).toHaveBeenLastCalledWith('report_download'));
    expect(screen.getByDisplayValue('report_download')).toBeInTheDocument();
    expect(await screen.findByText('报表下载')).toBeInTheDocument();
  });

  it('auto-starts once per autoStartRequest request id', async () => {
    const client = new FakeRuntimeClient();
    const firstRequest = {
      requestId: 'req_1',
      flowId: 'case_query',
      mode: 'verify' as const,
      params: { case_no: 'A123' },
    };
    const { rerender } = render(<RuntimeVerificationWorkspace client={client} autoStartRequest={firstRequest} />);

    await waitFor(() => expect(client.startExecution).toHaveBeenCalledTimes(1));
    expect(client.startExecution).toHaveBeenLastCalledWith({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      params: { case_no: 'A123' },
    });

    rerender(<RuntimeVerificationWorkspace client={client} autoStartRequest={{ ...firstRequest }} />);
    await waitFor(() => expect(client.startExecution).toHaveBeenCalledTimes(1));

    rerender(
      <RuntimeVerificationWorkspace
        client={client}
        autoStartRequest={{ requestId: 'req_2', flowId: 'report_download', mode: 'run' }}
      />,
    );

    await waitFor(() => expect(client.startExecution).toHaveBeenCalledTimes(2));
    expect(client.startExecution).toHaveBeenLastCalledWith({
      flowId: 'report_download',
      mode: 'run',
      dryRun: false,
      headless: true,
      params: {},
    });
  });
});

class FakeRuntimeClient {
  private handler?: (event: RpaExecutionEvent) => void;

  readonly getFlow = vi.fn(async (flowId: string): Promise<RpaFlowDetailResponse> => {
    const dsl = createMinimalRpaDsl();
    const title = flowId === 'report_download' ? '报表下载' : dsl.meta.title;
    return {
      flowId,
      title,
      source: dsl.meta.source,
      dsl: {
        ...dsl,
        flow_id: flowId,
        meta: {
          ...dsl.meta,
          title,
        },
      },
      warnings: [],
    };
  });

  readonly startExecution = vi.fn(
    async (input: StartRpaExecutionRequest): Promise<StartRpaExecutionResponse> => ({
      executionId: 'exec_1',
      flowId: input.flowId,
      status: 'queued',
    }),
  );

  readonly cancelExecution = vi.fn(async () => ({ ok: true as const }));

  readonly getExecutionStatus = vi.fn(
    async (): Promise<RpaExecutionStatusResponse> => ({
      executionId: 'exec_1',
      flowId: 'case_query',
      status: 'succeeded',
      mode: 'verify',
      dryRun: true,
      headless: false,
    }),
  );

  readonly getExecutionLogs = vi.fn(
    async (): Promise<RpaExecutionLogResponse> => ({
      executionId: 'exec_1',
      stdout: 'stdout line',
      stderr: '',
    }),
  );

  readonly getExecutionArtifacts = vi.fn(
    async (): Promise<RpaExecutionArtifactsResponse> => ({
      executionId: 'exec_1',
      artifacts: [
        {
          artifactId: 'art_1',
          role: 'screenshot',
          fileName: 'current.png',
          relativePath: 'screenshots/current.png',
          size: 1200,
          sha256: 'sha256-current',
        },
      ],
    }),
  );

  readonly getCurrentScreenshotUrl = vi.fn(
    (executionId: string) => `/api/rpa/executions/${executionId}/screenshots/current?cacheKey=refreshed`,
  );

  readonly subscribeExecutionEvents = vi.fn(
    (_executionId: string, handlers: { onEvent: (event: RpaExecutionEvent) => void }) => {
      this.handler = handlers.onEvent;
      return vi.fn();
    },
  );

  emit(event: Omit<RpaExecutionEvent, 'timestamp'>): void {
    this.handler?.({
      timestamp: '2026-06-06T00:00:00.000Z',
      ...event,
    });
  }
}
