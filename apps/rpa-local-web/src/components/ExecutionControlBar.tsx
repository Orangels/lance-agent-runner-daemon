import { Ban, Play } from 'lucide-react';
import type { RpaExecutionMode } from '../shared/rpa-api-types.js';

export interface ExecutionControlBarStartInput {
  flowId: string;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
  params: Record<string, string | number | boolean | null>;
}

export interface ExecutionControlBarProps {
  flowId: string;
  mode: RpaExecutionMode;
  dryRun: boolean;
  headless: boolean;
  paramsText: string;
  activeExecutionId?: string;
  busy?: boolean;
  onFlowIdChange: (flowId: string) => void;
  onModeChange: (mode: RpaExecutionMode) => void;
  onDryRunChange: (dryRun: boolean) => void;
  onHeadlessChange: (headless: boolean) => void;
  onParamsTextChange: (paramsText: string) => void;
  onStart: (input: ExecutionControlBarStartInput) => void;
  onCancel: () => void;
}

export function ExecutionControlBar({
  flowId,
  mode,
  dryRun,
  headless,
  paramsText,
  activeExecutionId,
  busy = false,
  onFlowIdChange,
  onModeChange,
  onDryRunChange,
  onHeadlessChange,
  onParamsTextChange,
  onStart,
  onCancel,
}: ExecutionControlBarProps) {
  const parsedParams = parseParams(paramsText);
  const flowIdIsValid = flowId.trim().length > 0;
  const startDisabled = busy || !flowIdIsValid || !parsedParams.ok;

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
        <span>Flow ID</span>
        <input
          aria-label="Flow ID"
          value={flowId}
          onChange={(event) => onFlowIdChange(event.target.value)}
          placeholder="case_query"
        />
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

      <label className="field field--params">
        <span>Params JSON</span>
        <textarea
          aria-label="Params JSON"
          rows={3}
          value={paramsText}
          onChange={(event) => onParamsTextChange(event.target.value)}
        />
      </label>

      {!parsedParams.ok && <p className="field-error">{parsedParams.error}</p>}

      <div className="execution-control-bar__actions">
        <button type="button" className="command-button" disabled={startDisabled} onClick={() => {
          if (!parsedParams.ok) return;
          onStart({
            flowId: flowId.trim(),
            mode,
            dryRun,
            headless,
            params: parsedParams.value,
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

type ParsedParams =
  | { ok: true; value: Record<string, string | number | boolean | null> }
  | { ok: false; error: string };

function parseParams(value: string): ParsedParams {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isParamRecord(parsed)) {
      return { ok: false, error: 'Params must be a JSON object.' };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: 'Params must be a JSON object.' };
  }
}

function isParamRecord(value: unknown): value is Record<string, string | number | boolean | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) =>
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean',
  );
}
