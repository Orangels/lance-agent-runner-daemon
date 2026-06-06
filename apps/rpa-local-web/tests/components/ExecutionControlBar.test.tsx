import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  const [paramsText, setParamsText] = useState('{}');

  return (
    <ExecutionControlBar
      activeExecutionId={activeExecutionId}
      dryRun={dryRun}
      flowId={flowId}
      headless={headless}
      mode={mode}
      paramsText={paramsText}
      onCancel={onCancel}
      onDryRunChange={setDryRun}
      onFlowIdChange={setFlowId}
      onHeadlessChange={setHeadless}
      onModeChange={setMode}
      onParamsTextChange={setParamsText}
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

  it('disables start and shows an inline error for invalid params JSON', async () => {
    const onStart = vi.fn();
    render(<Harness onStart={onStart} />);

    fireEvent.change(screen.getByLabelText('Params JSON'), { target: { value: '{bad json' } });

    expect(screen.getByRole('button', { name: /Start/ })).toBeDisabled();
    expect(screen.getByText('Params must be a JSON object.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Start/ }));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('passes parsed params when starting', async () => {
    const onStart = vi.fn();
    render(<Harness onStart={onStart} />);

    fireEvent.change(screen.getByLabelText('Params JSON'), { target: { value: '{"case_no":"A123"}' } });
    await userEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(onStart).toHaveBeenCalledWith({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      params: { case_no: 'A123' },
    });
  });

  it('keeps cancel disabled until an execution is active', () => {
    const { rerender } = render(<Harness />);

    expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled();

    rerender(<Harness activeExecutionId="exec_1" />);

    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
  });
});
