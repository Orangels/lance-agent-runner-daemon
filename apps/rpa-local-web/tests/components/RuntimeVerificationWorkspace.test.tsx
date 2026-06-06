import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeVerificationWorkspace } from '../../src/components/RuntimeVerificationWorkspace.js';
import { createMinimalRpaDsl, type RpaDslDocument } from '../../src/shared/dsl-schema.js';
import { deriveRuntimeParamFields } from '../../src/shared/runtime-params.js';
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

    await userEvent.type(screen.getByLabelText('案件编号'), 'A123');
    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(client.startExecution).toHaveBeenCalledWith({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      params: { case_no: 'A123' },
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
    await userEvent.type(screen.getByLabelText('案件编号'), 'A123');
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
  });

  it('loads the target flow before validating auto-start params', async () => {
    const client = new FakeRuntimeClient();
    render(
      <RuntimeVerificationWorkspace
        client={client}
        autoStartRequest={{
          requestId: 'req_target',
          flowId: 'report_download',
          mode: 'run',
          params: { case_no: 'R100' },
        }}
      />,
    );

    await waitFor(() => expect(client.getFlow).toHaveBeenCalledWith('report_download'));
    await waitFor(() => expect(client.startExecution).toHaveBeenCalledTimes(1));
    expect(client.startExecution).toHaveBeenCalledWith({
      flowId: 'report_download',
      mode: 'run',
      dryRun: false,
      headless: true,
      params: { case_no: 'R100' },
    });
  });

  it('does not auto-start when required runtime params are missing', async () => {
    const client = new FakeRuntimeClient();

    render(
      <RuntimeVerificationWorkspace
        client={client}
        autoStartRequest={{ requestId: 'req_missing', flowId: 'case_query', mode: 'verify' }}
      />,
    );

    expect(await screen.findByText('Runtime params are required before execution can start.')).toBeInTheDocument();
    expect(client.startExecution).not.toHaveBeenCalled();
  });

  it('shows runtime param errors and does not start until required values are provided', async () => {
    const client = new FakeRuntimeClient();

    render(<RuntimeVerificationWorkspace client={client} />);
    await screen.findByText('案件查询');

    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(client.startExecution).not.toHaveBeenCalled();
    expect(screen.getByText('案件编号 is required.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('案件编号'), 'A123');
    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(client.startExecution).toHaveBeenCalledWith({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      params: { case_no: 'A123' },
    });
  });

  it('notifies when verify mode succeeds', async () => {
    const client = new FakeRuntimeClient();
    const onVerifySucceeded = vi.fn();

    render(<RuntimeVerificationWorkspace client={client} onVerifySucceeded={onVerifySucceeded} />);
    await screen.findByText('案件查询');
    await userEvent.type(screen.getByLabelText('案件编号'), 'A123');
    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    await act(async () => {
      client.emit({ type: 'run.completed', executionId: 'exec_1', status: 'succeeded', exitCode: 0, sequence: 1 });
    });

    expect(onVerifySucceeded).toHaveBeenCalledWith({ flowId: 'case_query', executionId: 'exec_1' });
  });

  it('offers a repair callback after a failed execution', async () => {
    const client = new FakeRuntimeClient();
    client.startExecution.mockResolvedValueOnce({
      executionId: 'exec_failed',
      flowId: 'case_query',
      status: 'queued',
    });
    client.getExecutionStatus.mockResolvedValue({
      executionId: 'exec_failed',
      flowId: 'case_query',
      status: 'failed',
      mode: 'verify',
      dryRun: true,
      headless: false,
      failedStepId: 'step_003',
    });
    const onRepairRequest = vi.fn();

    render(<RuntimeVerificationWorkspace client={client} onRepairRequest={onRepairRequest} />);
    await screen.findByText('案件查询');
    await userEvent.type(screen.getByLabelText('案件编号'), 'A123');
    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    await act(async () => {
      client.emit({ type: 'run.completed', executionId: 'exec_failed', status: 'failed', sequence: 1 });
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Repair with Claude Code' }));

    expect(onRepairRequest).toHaveBeenCalledWith({
      executionId: 'exec_failed',
      failedStepId: 'step_003',
    });
  });
});

class FakeRuntimeClient {
  private handler?: (event: RpaExecutionEvent) => void;

  readonly getFlow = vi.fn(async (flowId: string): Promise<RpaFlowDetailResponse> => {
    const dsl = createMinimalRpaDsl();
    const title = flowId === 'report_download' ? '报表下载' : dsl.meta.title;
    return flowDetail({
      flowId,
      title,
      dsl: {
        ...dsl,
        flow_id: flowId,
        meta: {
          ...dsl.meta,
          title,
        },
      },
    });
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

function flowDetail({
  flowId,
  title,
  dsl,
}: {
  flowId: string;
  title: string;
  dsl: RpaDslDocument;
}): RpaFlowDetailResponse {
  const fields = deriveRuntimeParamFields(dsl.params);

  return {
    flowId,
    title,
    source: dsl.meta.source,
    dsl,
    warnings: [],
    runtimeParams: {
      fields,
      requiresUserInput: fields.length > 0,
      maskedParamIds: fields.filter((field) => field.mask).map((field) => field.id),
    },
    provenance: {
      source: dsl.meta.source === 'imported' ? 'imported' : 'generated',
      requiresVerifyBeforeRun: false,
    },
  };
}
