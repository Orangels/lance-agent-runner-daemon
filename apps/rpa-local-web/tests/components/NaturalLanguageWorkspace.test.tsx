import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NaturalLanguageWorkspace } from '../../src/components/NaturalLanguageWorkspace.js';
import type { RuntimeVerificationApiClient } from '../../src/components/RuntimeVerificationWorkspace.js';
import type {
  NaturalLanguageSessionStatus,
  NaturalLanguageSessionStatusResponse,
  RepairNaturalLanguageSessionRequest,
  StartNaturalLanguageSessionRequest,
  SubmitNaturalLanguageQuestionAnswersRequest,
} from '../../src/shared/natural-language-types.js';
import { createMinimalRpaDsl, type RpaDslDocument } from '../../src/shared/dsl-schema.js';
import { deriveRuntimeParamFields } from '../../src/shared/runtime-params.js';
import type {
  RpaExecutionArtifactsResponse,
  RpaExecutionEvent,
  RpaExecutionLogResponse,
  RpaExecutionStatusResponse,
  RpaFlowDetailResponse,
  StartRpaExecutionResponse,
} from '../../src/shared/rpa-api-types.js';

afterEach(() => cleanup());

describe('NaturalLanguageWorkspace', () => {
  it('starts a natural-language session and shows daemon progress', async () => {
    const client = new FakeNaturalLanguageClient({
      status: {
        ...baseSession(),
        status: 'generating',
        daemonRunId: 'run_1',
        logs: ['Artifact created: output/flow.dsl.json'],
      },
    });

    render(<NaturalLanguageWorkspace client={client} />);
    await userEvent.clear(screen.getByLabelText('Target URL'));
    await userEvent.type(screen.getByLabelText('Target URL'), 'https://example.com/cases');
    await userEvent.clear(screen.getByLabelText('Requirement'));
    await userEvent.type(screen.getByLabelText('Requirement'), 'Search cases by case number.');
    await userEvent.click(screen.getByRole('button', { name: 'Generate flow' }));

    expect(client.startNaturalLanguageSession).toHaveBeenCalledWith({
      targetUrl: 'https://example.com/cases',
      flowId: 'case_query',
      flowName: '',
      requirement: 'Search cases by case number.',
      businessConstraints: '',
      safetyNotes: '',
    });
    expect(await screen.findByText('generating')).toBeInTheDocument();
    expect(screen.getByText('Artifact created: output/flow.dsl.json')).toBeInTheDocument();
  });

  it('renders question-form and submits answers', async () => {
    const client = new FakeNaturalLanguageClient({
      status: {
        ...baseSession(),
        status: 'needs_input',
        questionForm: {
          formId: 'qf_1',
          title: '确认参数',
          questions: [{ id: 'date', type: 'text', label: '日期' }],
        },
      },
    });

    render(<NaturalLanguageWorkspace client={client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate flow' }));
    await userEvent.type(await screen.findByLabelText('日期'), '2026-06-06');
    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(client.submitNaturalLanguageQuestionAnswers).toHaveBeenCalledWith('nl_1', {
      formId: 'qf_1',
      answers: { date: '2026-06-06' },
    });
  });

  it('opens verification workspace for generated flows without auto-starting', async () => {
    const nlClient = new FakeNaturalLanguageClient({
      status: {
        ...baseSession(),
        status: 'generated',
        daemonRunId: 'run_1',
        artifacts: [{ artifactId: 'art_1', fileName: 'flow.dsl.json', relativePath: 'output/flow.dsl.json', size: 120 }],
      },
    });
    const runtimeClient = new FakeRuntimeClient();

    render(<NaturalLanguageWorkspace client={nlClient} runtimeClient={runtimeClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate flow' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Verify flow' }));

    expect(await screen.findByText('案件查询')).toBeInTheDocument();
    expect(runtimeClient.getFlow).toHaveBeenCalledWith('case_query');
    expect(runtimeClient.startExecution).not.toHaveBeenCalled();
  });

  it('repairs generated flow from runtime verification failure', async () => {
    const nlClient = new FakeNaturalLanguageClient({
      status: {
        ...baseSession(),
        status: 'generated',
        daemonRunId: 'run_1',
      },
    });
    const runtimeClient = new FakeRuntimeClient();
    runtimeClient.startExecution.mockResolvedValueOnce({
      executionId: 'exec_failed',
      flowId: 'case_query',
      status: 'queued',
    });
    runtimeClient.getExecutionStatus.mockResolvedValue({
      executionId: 'exec_failed',
      flowId: 'case_query',
      status: 'failed',
      mode: 'verify',
      dryRun: true,
      headless: false,
      failedStepId: 'step_003',
    });

    render(<NaturalLanguageWorkspace client={nlClient} runtimeClient={runtimeClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate flow' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Verify flow' }));
    await userEvent.type(screen.getByLabelText('案件编号'), 'A123');
    await userEvent.click(screen.getByRole('button', { name: /Start/ }));
    await act(async () => {
      runtimeClient.emit({ type: 'run.completed', executionId: 'exec_failed', status: 'failed', sequence: 1 });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Repair with Claude Code' }));

    expect(nlClient.repairNaturalLanguageSession).toHaveBeenCalledWith('nl_1', {
      executionId: 'exec_failed',
    });
  });
});

function baseSession(): NaturalLanguageSessionStatusResponse {
  return {
    sessionId: 'nl_1',
    flowId: 'case_query',
    flowName: 'Case query',
    targetUrl: 'https://example.com/cases',
    requirement: 'Search cases.',
    status: 'starting',
    logs: [],
    questionForm: null,
    artifacts: [],
    error: null,
  };
}

class FakeNaturalLanguageClient {
  readonly startNaturalLanguageSession = vi.fn(async (_request: StartNaturalLanguageSessionRequest) => ({
    sessionId: 'nl_1',
    flowId: 'case_query',
    status: 'starting' as NaturalLanguageSessionStatus,
    targetUrl: 'https://example.com/cases',
  }));
  readonly getNaturalLanguageSession = vi.fn(async () => this.response.status);
  readonly cancelNaturalLanguageSession = vi.fn(async () => ({ ...this.response.status, status: 'cancelled' as const }));
  readonly submitNaturalLanguageQuestionAnswers = vi.fn(
    async (_sessionId: string, _request: SubmitNaturalLanguageQuestionAnswersRequest) => ({
      sessionId: 'nl_1',
      status: 'generating' as const,
    }),
  );
  readonly repairNaturalLanguageSession = vi.fn(
    async (_sessionId: string, _request: RepairNaturalLanguageSessionRequest) => ({
      ...this.response.status,
      status: 'repairing' as const,
    }),
  );

  constructor(private readonly response: { status: NaturalLanguageSessionStatusResponse }) {}
}

class FakeRuntimeClient implements RuntimeVerificationApiClient {
  private handler?: (event: RpaExecutionEvent) => void;

  readonly getFlow = vi.fn(async (flowId: string): Promise<RpaFlowDetailResponse> => {
    const dsl = createMinimalRpaDsl();
    return flowDetail({
      flowId,
      title: '案件查询',
      dsl: { ...dsl, flow_id: flowId, meta: { ...dsl.meta, source: 'nl' } },
    });
  });
  readonly startExecution = vi.fn(async (): Promise<StartRpaExecutionResponse> => ({
    executionId: 'exec_1',
    flowId: 'case_query',
    status: 'queued',
  }));
  readonly cancelExecution = vi.fn(async () => ({ ok: true as const }));
  readonly getExecutionStatus = vi.fn(async (): Promise<RpaExecutionStatusResponse> => ({
    executionId: 'exec_1',
    flowId: 'case_query',
    status: 'succeeded',
    mode: 'verify',
    dryRun: true,
    headless: false,
  }));
  readonly getExecutionLogs = vi.fn(async (): Promise<RpaExecutionLogResponse> => ({
    executionId: 'exec_1',
    stdout: '',
    stderr: '',
  }));
  readonly getExecutionArtifacts = vi.fn(async (): Promise<RpaExecutionArtifactsResponse> => ({
    executionId: 'exec_1',
    artifacts: [],
  }));
  readonly getCurrentScreenshotUrl = vi.fn(() => '/api/rpa/executions/exec_1/screenshots/current');
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
