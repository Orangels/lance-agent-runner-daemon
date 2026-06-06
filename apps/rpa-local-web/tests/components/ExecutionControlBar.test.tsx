import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ExecutionControlBar, type ExecutionControlBarStartInput } from '../../src/components/ExecutionControlBar.js';
import type { RpaExecutionMode } from '../../src/shared/rpa-api-types.js';

afterEach(() => cleanup());

function Harness({
  activeExecutionId,
  onStart = vi.fn(),
  onCancel = vi.fn(),
}: {
  activeExecutionId?: string;
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
  it('defaults to case_query with verify dry-run headed settings', () => {
    render(<Harness />);

    expect(screen.getByLabelText('Flow ID')).toHaveValue('case_query');
    expect(screen.getByRole('radio', { name: 'Verify' })).toBeChecked();
    expect(screen.getByLabelText('Dry run')).toBeChecked();
    expect(screen.getByLabelText('Headless')).not.toBeChecked();
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
});
