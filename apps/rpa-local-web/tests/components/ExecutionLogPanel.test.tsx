import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionLogPanel } from '../../src/components/ExecutionLogPanel.js';

afterEach(() => cleanup());

describe('ExecutionLogPanel', () => {
  it('renders stdout, stderr, and event timeline details', () => {
    render(
      <ExecutionLogPanel
        stdout={'stdout line 1\nstdout line 2'}
        stderr="stderr line"
        events={[
          {
            type: 'step.started',
            executionId: 'exec_1',
            stepId: 's1',
            timestamp: '2026-06-06T01:00:00.000Z',
            message: 'Opening page',
          },
        ]}
      />,
    );

    expect(screen.getByLabelText('stdout')).toHaveValue('stdout line 1\nstdout line 2');
    expect(screen.getByLabelText('stderr')).toHaveValue('stderr line');

    const event = screen.getByTestId('rpa-event-0');
    expect(within(event).getByText('step.started')).toBeInTheDocument();
    expect(within(event).getByText('s1')).toBeInTheDocument();
    expect(within(event).getByText('Opening page')).toBeInTheDocument();
  });

  it('shows only the newest 200 timeline events', () => {
    const events = Array.from({ length: 205 }, (_, index) => ({
      type: 'log' as const,
      executionId: 'exec_1',
      timestamp: `2026-06-06T01:00:${String(index % 60).padStart(2, '0')}.000Z`,
      message: `timeline-${String(index).padStart(3, '0')}`,
      sequence: index + 1,
    }));

    render(<ExecutionLogPanel stdout="" stderr="" events={events} />);

    expect(screen.queryByText('timeline-004')).not.toBeInTheDocument();
    expect(screen.getByText('timeline-005')).toBeInTheDocument();
    expect(screen.getByText('timeline-204')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^rpa-event-/)).toHaveLength(200);
  });
});
