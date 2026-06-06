import type { RpaDslStep } from '../shared/dsl-schema.js';

export type RpaStepDisplayStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type RpaStepEventType = 'step.started' | 'step.screenshot' | 'step.completed' | 'step.failed';

export interface StepListEvent {
  type: string;
  executionId: string;
  timestamp: string;
  stepId?: string;
  message?: string;
}

export interface StepListProps {
  steps: RpaDslStep[];
  events: StepListEvent[];
  failedStepId?: string;
}

interface DerivedStepState {
  status: RpaStepDisplayStatus;
  message?: string;
}

function deriveStepStates(
  steps: RpaDslStep[],
  events: StepListEvent[],
  failedStepId?: string,
): Map<string, DerivedStepState> {
  const states = new Map<string, DerivedStepState>();
  const stepIds = new Set(steps.map((step) => step.id));

  for (const step of steps) {
    states.set(step.id, { status: 'pending' });
  }

  for (const event of events) {
    if (!event.stepId || !stepIds.has(event.stepId)) continue;

    if (event.type === 'step.started' || event.type === 'step.screenshot') {
      states.set(event.stepId, { status: 'running' });
    }

    if (event.type === 'step.completed') {
      states.set(event.stepId, { status: 'succeeded' });
    }

    if (event.type === 'step.failed') {
      states.set(event.stepId, { status: 'failed', message: event.message });
    }
  }

  if (failedStepId && stepIds.has(failedStepId)) {
    const current = states.get(failedStepId);
    states.set(failedStepId, {
      status: 'failed',
      message: current?.message,
    });
  }

  return states;
}

export function StepList({ steps, events, failedStepId }: StepListProps) {
  const stepStates = deriveStepStates(steps, events, failedStepId);

  return (
    <section className="rpa-step-list" aria-label="Execution steps">
      <div className="rpa-step-list__header">
        <h3>Steps</h3>
        <span className="rpa-step-list__count">{steps.length}</span>
      </div>

      {steps.length === 0 ? (
        <p className="rpa-step-list__empty">No steps loaded.</p>
      ) : (
        <ol className="rpa-step-list__items">
          {steps.map((step) => {
            const state = stepStates.get(step.id) ?? { status: 'pending' };

            return (
              <li
                key={step.id}
                data-testid={`rpa-step-${step.id}`}
                className={`rpa-step-list__item rpa-step-list__item--${state.status}`}
              >
                <div className="rpa-step-list__main">
                  <span className="rpa-step-list__id">{step.id}</span>
                  <span className="rpa-step-list__name">{step.name}</span>
                </div>
                <div className="rpa-step-list__meta">
                  <span className="rpa-step-list__action">{step.action}</span>
                  <span className={`rpa-step-list__status rpa-step-list__status--${state.status}`}>
                    {state.status}
                  </span>
                </div>
                {state.status === 'failed' && state.message ? (
                  <p className="rpa-step-list__message">{state.message}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
