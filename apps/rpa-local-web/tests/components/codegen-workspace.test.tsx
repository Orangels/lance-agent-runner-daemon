import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodegenWorkspace } from '../../src/components/CodegenWorkspace.js';
import { createMinimalRpaDsl, type RpaDslDocument } from '../../src/shared/dsl-schema.js';
import { deriveRuntimeParamFields } from '../../src/shared/runtime-params.js';
import type { RuntimeVerificationApiClient } from '../../src/components/RuntimeVerificationWorkspace.js';
import type {
  RpaExecutionArtifactsResponse,
  RpaExecutionLogResponse,
  RpaExecutionStatusResponse,
  RpaFlowDetailResponse,
  StartRpaExecutionResponse,
} from '../../src/shared/rpa-api-types.js';

afterEach(() => cleanup());

describe('CodegenWorkspace', () => {
  it('starts a codegen session and shows daemon progress', async () => {
    const client = new FakeCodegenClient({
      status: {
        sessionId: 'cg_1',
        flowId: 'case_query',
        status: 'hardening',
        targetUrl: 'https://example.com',
        daemonRunId: 'run_1',
        logs: ['Artifact created: output/flow.dsl.json'],
        questionForm: null,
        artifacts: [],
        error: null,
      },
    });

    render(<CodegenWorkspace client={client} />);
    await userEvent.clear(screen.getByLabelText('Target URL'));
    await userEvent.type(screen.getByLabelText('Target URL'), 'https://example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    expect(client.startCodegenSession).toHaveBeenCalledWith({
      targetUrl: 'https://example.com',
      flowId: 'case_query',
      flowName: '',
    });
    expect(await screen.findByText('hardening')).toBeInTheDocument();
    expect(screen.getByText('Artifact created: output/flow.dsl.json')).toBeInTheDocument();
  });

  it('renders question-form and submits answers', async () => {
    const client = new FakeCodegenClient({
      status: {
        sessionId: 'cg_1',
        flowId: 'case_query',
        status: 'needs_input',
        targetUrl: 'https://example.com',
        logs: [],
        questionForm: {
          formId: 'qf_1',
          title: '确认参数',
          questions: [{ id: 'date', type: 'text', label: '日期' }],
        },
        artifacts: [],
        error: null,
      },
    });

    render(<CodegenWorkspace client={client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await userEvent.type(await screen.findByLabelText('日期'), '2026-06-06');
    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(client.submitCodegenQuestionAnswers).toHaveBeenCalledWith('cg_1', {
      formId: 'qf_1',
      answers: { date: '2026-06-06' },
    });
  });

  it('opens hardened flows in the runtime verification workspace and blocks auto-start until params are filled', async () => {
    const codegenClient = new FakeCodegenClient({
      status: {
        sessionId: 'cg_1',
        flowId: 'case_query',
        status: 'hardened',
        targetUrl: 'https://example.com',
        daemonRunId: 'run_1',
        logs: [],
        questionForm: null,
        artifacts: [{ artifactId: 'art_1', fileName: 'flow.dsl.json', relativePath: 'output/flow.dsl.json', size: 120 }],
        error: null,
      },
    });
    const runtimeClient = new FakeRuntimeClient();

    render(<CodegenWorkspace client={codegenClient} runtimeClient={runtimeClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Verify flow' }));

    expect(await screen.findByText('Runtime params are required before execution can start.')).toBeInTheDocument();
    expect(runtimeClient.startExecution).not.toHaveBeenCalled();
  });
});

class FakeCodegenClient {
  readonly startCodegenSession = vi.fn(async () => ({
    sessionId: 'cg_1',
    flowId: 'case_query',
    status: 'recording' as const,
    targetUrl: 'https://example.com',
    recording: { inputPath: 'input/flow.py' as const },
  }));

  readonly getCodegenSession = vi.fn(async () => this.response.status);
  readonly cancelCodegenSession = vi.fn(async () => ({ sessionId: 'cg_1', status: 'cancelled' as const }));
  readonly submitCodegenQuestionAnswers = vi.fn(async () => ({ sessionId: 'cg_1', status: 'hardening' as const }));

  constructor(private readonly response: { status: Awaited<ReturnType<FakeCodegenClient['getCodegenSession']>> }) {}
}

class FakeRuntimeClient implements RuntimeVerificationApiClient {
  readonly getFlow = vi.fn(async (flowId: string): Promise<RpaFlowDetailResponse> => {
    const dsl = createMinimalRpaDsl();
    return flowDetail({
      flowId,
      title: '案件查询',
      dsl: { ...dsl, flow_id: flowId },
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
  readonly subscribeExecutionEvents = vi.fn(() => vi.fn());
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
