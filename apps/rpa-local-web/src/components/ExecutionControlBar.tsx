import { Ban, Play } from 'lucide-react';
import type { RpaExecutionMode, RpaFlowSummary } from '../shared/rpa-api-types.js';

export interface ExecutionControlBarStartInput {
  flowId: string;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
}

export interface ExecutionControlBarProps {
  flowId: string;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
  activeExecutionId?: string;
  busy?: boolean;
  flowOptions?: RpaFlowSummary[];
  flowsLoading?: boolean;
  onFlowIdChange: (flowId: string) => void;
  onModeChange: (mode: RpaExecutionMode) => void;
  onDryRunChange: (dryRun: boolean) => void;
  onHeadlessChange: (headless: boolean) => void;
  onStart: (input: ExecutionControlBarStartInput) => void;
  onCancel: () => void;
}

export function ExecutionControlBar({
  flowId,
  mode,
  dryRun,
  headless,
  activeExecutionId,
  busy = false,
  flowOptions = [],
  flowsLoading = false,
  onFlowIdChange,
  onModeChange,
  onDryRunChange,
  onHeadlessChange,
  onStart,
  onCancel,
}: ExecutionControlBarProps) {
  const flowIdIsValid = flowId.trim().length > 0;
  const startDisabled = busy || !flowIdIsValid || flowOptions.length === 0;

  const setModeDefaults = (nextMode: RpaExecutionMode) => {
    onModeChange(nextMode);
    if (nextMode === 'verify') {
      onDryRunChange(true);
      onHeadlessChange(false);
    } else {
      onDryRunChange(false);
      onHeadlessChange(true);
    }
  };

  return (
    <section className="execution-control-bar" aria-label="Execution controls">
      <label className="field">
        <span>Flow</span>
        <select
          aria-label="Flow"
          disabled={busy || flowsLoading || flowOptions.length === 0}
          value={flowId}
          onChange={(event) => onFlowIdChange(event.target.value)}
        >
          {flowsLoading ? <option value="">Loading flows...</option> : null}
          {!flowsLoading && flowOptions.length === 0 ? <option value="">No flows available</option> : null}
          {flowOptions.map((flow) => (
            <option key={flow.flowId} value={flow.flowId}>
              {flow.title}
              {flow.requiresVerifyBeforeRun ? ' (verify required)' : ''}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="segmented-field" aria-label="Execution mode">
        <legend>Mode</legend>
        <label>
          <input
            checked={mode === 'verify'}
            name="execution-mode"
            type="radio"
            onChange={() => setModeDefaults('verify')}
          />
          <span>Verify</span>
        </label>
        <label>
          <input
            checked={mode === 'run'}
            name="execution-mode"
            type="radio"
            onChange={() => setModeDefaults('run')}
          />
          <span>Run</span>
        </label>
      </fieldset>

      <label className="checkbox-field">
        <input checked={dryRun} type="checkbox" onChange={(event) => onDryRunChange(event.target.checked)} />
        <span>Dry run</span>
      </label>

      <label className="checkbox-field">
        <input checked={headless} type="checkbox" onChange={(event) => onHeadlessChange(event.target.checked)} />
        <span>Headless</span>
      </label>

      <div className="execution-control-bar__actions">
        <button type="button" className="command-button" disabled={startDisabled} onClick={() => {
          onStart({
            flowId: flowId.trim(),
            mode,
            dryRun,
            headless,
          });
        }}>
          <Play aria-hidden="true" />
          <span>Start</span>
        </button>
        <button
          type="button"
          className="command-button command-button--secondary"
          disabled={busy || !activeExecutionId}
          onClick={onCancel}
        >
          <Ban aria-hidden="true" />
          <span>Cancel</span>
        </button>
      </div>
    </section>
  );
}
