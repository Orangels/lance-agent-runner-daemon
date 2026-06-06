import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ExecutionControlBar, type ExecutionControlBarStartInput } from '../../src/components/ExecutionControlBar.js';
import type { RpaExecutionMode, RpaFlowSummary } from '../../src/shared/rpa-api-types.js';

afterEach(() => cleanup());

function Harness({
  activeExecutionId,
  flowOptions = defaultFlowOptions,
  onStart = vi.fn(),
  onCancel = vi.fn(),
}: {
  activeExecutionId?: string;
  flowOptions?: RpaFlowSummary[];
  onStart?: (input: ExecutionControlBarStartInput) => void;
  onCancel?: () => void;
}) {
  const [flowId, setFlowId] = useState('case_query');
  const [mode, setMode] = useState<RpaExecutionMode>('verify');
  const [dryRun, setDryRun] = useState(true);
  const [headless, setHeadless] = useState(false);

  return (
    <ExecutionControlBar
      activeExecutionId={activeExecutionId}
      dryRun={dryRun}
      flowId={flowId}
      flowOptions={flowOptions}
      headless={headless}
      mode={mode}
      onCancel={onCancel}
      onDryRunChange={setDryRun}
      onFlowIdChange={setFlowId}
      onHeadlessChange={setHeadless}
      onModeChange={setMode}
      onStart={onStart}
    />
  );
}

describe('ExecutionControlBar', () => {
  it('defaults to case_query title with verify dry-run headed settings', () => {
    render(<Harness />);

    expect(screen.getByRole('combobox', { name: 'Flow' })).toHaveDisplayValue('案件查询');
    expect(screen.getByRole('radio', { name: 'Verify' })).toBeChecked();
    expect(screen.getByLabelText('Dry run')).toBeChecked();
    expect(screen.getByLabelText('Headless')).not.toBeChecked();
  });

  it('selects a flow by name while submitting the flow id', async () => {
    const onStart = vi.fn();
    render(<Harness onStart={onStart} />);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Flow' }), 'report_download');
    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(screen.getByRole('combobox', { name: 'Flow' })).toHaveDisplayValue('报表下载');
    expect(onStart).toHaveBeenCalledWith({
      flowId: 'report_download',
      mode: 'verify',
      dryRun: true,
      headless: false,
    });
  });

  it('switches run mode to non-dry-run headless defaults', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByRole('radio', { name: 'Run' }));

    expect(screen.getByRole('radio', { name: 'Run' })).toBeChecked();
    expect(screen.getByLabelText('Dry run')).not.toBeChecked();
    expect(screen.getByLabelText('Headless')).toBeChecked();
  });

  it('does not render a free-form params JSON textarea', () => {
    render(<Harness />);

    expect(screen.queryByLabelText('Params JSON')).not.toBeInTheDocument();
  });

  it('passes execution settings when starting', async () => {
    const onStart = vi.fn();
    render(<Harness onStart={onStart} />);

    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(onStart).toHaveBeenCalledWith({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
    });
  });

  it('keeps cancel disabled until an execution is active', () => {
    const { rerender } = render(<Harness />);

    expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled();

    rerender(<Harness activeExecutionId="exec_1" />);

    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
  });

  it('disables start when no flows are available', () => {
    render(<Harness flowOptions={[]} />);

    expect(screen.getByRole('combobox', { name: 'Flow' })).toHaveDisplayValue('No flows available');
    expect(screen.getByRole('button', { name: /Start/ })).toBeDisabled();
  });
});

const defaultFlowOptions: RpaFlowSummary[] = [
  { flowId: 'case_query', title: '案件查询', source: 'codegen', requiresVerifyBeforeRun: false },
  { flowId: 'report_download', title: '报表下载', source: 'nl', requiresVerifyBeforeRun: false },
];
