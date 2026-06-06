import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowAssetsWorkspace } from '../../src/components/FlowAssetsWorkspace.js';
import { createMinimalRpaDsl } from '../../src/shared/dsl-schema.js';
import type { RpaFlowDetailResponse } from '../../src/shared/rpa-api-types.js';

afterEach(() => cleanup());

describe('FlowAssetsWorkspace', () => {
  it('loads flow provenance and exposes export/verify/run controls', async () => {
    const client = new FakeFlowAssetsClient();
    render(<FlowAssetsWorkspace client={client} />);

    await userEvent.clear(screen.getByLabelText('Flow ID'));
    await userEvent.type(screen.getByLabelText('Flow ID'), 'case_query');
    await userEvent.click(screen.getByRole('button', { name: 'Load flow' }));

    expect(await screen.findByText('案件查询')).toBeInTheDocument();
    expect(screen.getByText('imported')).toBeInTheDocument();
    expect(screen.getByText('Verify required before run')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export .rpa.zip' })).toHaveAttribute(
      'href',
      '/api/rpa/flows/case_query/package/download',
    );
    expect(screen.getByRole('button', { name: 'Run flow' })).toBeDisabled();
  });

  it('reloads provenance after verify succeeds so imported flows can run', async () => {
    const client = new FakeFlowAssetsClient();
    const runtimeClient = new FakeRuntimeClient();
    render(<FlowAssetsWorkspace client={client} runtimeClient={runtimeClient} />);

    await userEvent.clear(screen.getByLabelText('Flow ID'));
    await userEvent.type(screen.getByLabelText('Flow ID'), 'case_query');
    await userEvent.click(screen.getByRole('button', { name: 'Load flow' }));
    expect(await screen.findByRole('button', { name: 'Run flow' })).toBeDisabled();

    client.markVerified();
    await userEvent.click(screen.getByRole('button', { name: 'Verify flow' }));

    await waitFor(() => expect(runtimeClient.startExecution).toHaveBeenCalled());
    await act(async () => {
      runtimeClient.emit({
        type: 'run.completed',
        executionId: 'exec_verify',
        status: 'succeeded',
        sequence: 1,
      });
    });

    await waitFor(() => expect(client.getFlow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(runtimeClient.startExecution).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run flow' })).toBeEnabled());
  });

  it('imports a package and loads the imported flow', async () => {
    const client = new FakeFlowAssetsClient();
    render(<FlowAssetsWorkspace client={client} />);

    const file = new File([new Uint8Array([1, 2, 3])], 'imported_flow.rpa.zip', { type: 'application/zip' });
    await userEvent.upload(screen.getByLabelText('Import .rpa.zip'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));

    await waitFor(() => expect(client.importPackage).toHaveBeenCalledWith(file));
    await waitFor(() => expect(client.getFlow).toHaveBeenLastCalledWith('imported_flow'));
  });
});

class FakeFlowAssetsClient {
  private verified = false;

  readonly getFlow = vi.fn(async (flowId = 'case_query'): Promise<RpaFlowDetailResponse> => {
    const dsl = { ...createMinimalRpaDsl(), flow_id: flowId };
    return {
      flowId,
      title: flowId === 'imported_flow' ? 'Imported flow' : '案件查询',
      source: 'codegen',
      dsl,
      warnings: [],
      runtimeParams: {
        fields: [{ id: 'case_no', label: '案件编号', type: 'text', required: true, mask: true }],
        requiresUserInput: true,
        maskedParamIds: ['case_no'],
      },
      provenance: {
        source: 'imported',
        requiresVerifyBeforeRun: !this.verified,
        originalFlowId: 'case_query',
        packageSha256: 'sha256:abc',
      },
    };
  });

  readonly getPackageDownloadUrl = vi.fn((flowId: string) => `/api/rpa/flows/${flowId}/package/download`);

  readonly importPackage = vi.fn(async () => ({
    flowId: 'imported_flow',
    title: 'Imported flow',
    source: 'imported' as const,
    requiresVerifyBeforeRun: true as const,
    importedAt: '2026-06-06T00:00:00.000Z',
    packageSha256: 'sha256:def',
    ignoredEntries: [],
  }));

  markVerified() {
    this.verified = true;
  }
}

class FakeRuntimeClient {
  private handler?: (event: any) => void;

  readonly getFlow = vi.fn(async (): Promise<RpaFlowDetailResponse> => ({
    flowId: 'case_query',
    title: '案件查询',
    source: 'codegen',
    dsl: { ...createMinimalRpaDsl(), params: {} },
    warnings: [],
    runtimeParams: { fields: [], requiresUserInput: false, maskedParamIds: [] },
    provenance: { source: 'generated', requiresVerifyBeforeRun: false },
  }));

  readonly startExecution = vi.fn(async () => ({
    executionId: 'exec_verify',
    flowId: 'case_query',
    status: 'queued' as const,
  }));

  readonly cancelExecution = vi.fn(async () => ({ ok: true as const }));
  readonly getExecutionStatus = vi.fn(async () => ({
    executionId: 'exec_verify',
    flowId: 'case_query',
    status: 'succeeded' as const,
    mode: 'verify' as const,
    dryRun: true,
    headless: false,
  }));
  readonly getExecutionLogs = vi.fn(async () => ({ executionId: 'exec_verify', stdout: '', stderr: '' }));
  readonly getExecutionArtifacts = vi.fn(async () => ({ executionId: 'exec_verify', artifacts: [] }));
  readonly getCurrentScreenshotUrl = vi.fn(() => '/api/rpa/executions/exec_verify/screenshots/current');
  readonly subscribeExecutionEvents = vi.fn(
    (_executionId: string, handlers: { onEvent: (event: any) => void }) => {
      this.handler = handlers.onEvent;
      return vi.fn();
    },
  );

  emit(event: any) {
    this.handler?.({ timestamp: '2026-06-06T00:00:00.000Z', ...event });
  }
}
