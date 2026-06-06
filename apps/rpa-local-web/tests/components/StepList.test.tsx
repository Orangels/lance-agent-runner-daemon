import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StepList } from '../../src/components/StepList.js';
import type { RpaDslStep } from '../../src/shared/dsl-schema.js';

afterEach(() => cleanup());

const steps: RpaDslStep[] = [
  {
    id: 's1',
    name: 'Open query page',
    action: 'navigate',
    value: '${base_url}',
    write: false,
    manual: null,
  },
  {
    id: 's2',
    name: 'Enter case number',
    action: 'input',
    value: '${case_no}',
    write: true,
    manual: null,
  },
  {
    id: 's3',
    name: 'Download report',
    action: 'click',
    write: true,
    manual: null,
  },
];

describe('StepList', () => {
  it('keeps every step pending when no step events are present', () => {
    render(<StepList steps={steps} events={[]} />);

    for (const step of steps) {
      const item = screen.getByTestId(`rpa-step-${step.id}`);
      expect(within(item).getByText(step.id)).toBeInTheDocument();
      expect(within(item).getByText(step.name)).toBeInTheDocument();
      expect(within(item).getByText('pending')).toBeInTheDocument();
    }
  });

  it('derives running, succeeded, and failed states from step events', () => {
    render(
      <StepList
        steps={steps}
        failedStepId="s3"
        events={[
          { type: 'step.started', executionId: 'exec_1', stepId: 's1', timestamp: '2026-06-06T01:00:00.000Z' },
          { type: 'step.completed', executionId: 'exec_1', stepId: 's1', timestamp: '2026-06-06T01:00:01.000Z' },
          { type: 'step.started', executionId: 'exec_1', stepId: 's2', timestamp: '2026-06-06T01:00:02.000Z' },
          {
            type: 'step.failed',
            executionId: 'exec_1',
            stepId: 's3',
            timestamp: '2026-06-06T01:00:03.000Z',
            message: 'Selector was not visible.',
          },
        ]}
      />,
    );

    expect(within(screen.getByTestId('rpa-step-s1')).getByText('succeeded')).toBeInTheDocument();
    expect(within(screen.getByTestId('rpa-step-s2')).getByText('running')).toBeInTheDocument();
    expect(within(screen.getByTestId('rpa-step-s3')).getByText('failed')).toBeInTheDocument();
    expect(within(screen.getByTestId('rpa-step-s3')).getByText('Selector was not visible.')).toBeInTheDocument();
  });
});
