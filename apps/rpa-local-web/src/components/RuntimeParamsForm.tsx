import type { RpaRuntimeParamField, RuntimeParamValue } from '../shared/runtime-params.js';

export interface RuntimeParamsFormProps {
  fields: RpaRuntimeParamField[];
  values: Record<string, RuntimeParamValue | undefined>;
  errors: Record<string, string | undefined>;
  onChange: (paramId: string, value: RuntimeParamValue) => void;
}

export function RuntimeParamsForm({ fields, values, errors, onChange }: RuntimeParamsFormProps) {
  if (fields.length === 0) {
    return (
      <section className="runtime-params-form runtime-params-form--empty" aria-label="Runtime params">
        <p>No runtime params configured.</p>
      </section>
    );
  }

  return (
    <section className="runtime-params-form" aria-label="Runtime params">
      <div className="runtime-params-form__header">
        <h3>Runtime params</h3>
      </div>
      <div className="runtime-params-form__grid">
        {fields.map((field) => (
          <RuntimeParamControl
            key={field.id}
            error={errors[field.id]}
            field={field}
            value={values[field.id]}
            onChange={onChange}
          />
        ))}
      </div>
    </section>
  );
}

function RuntimeParamControl({
  field,
  value,
  error,
  onChange,
}: {
  field: RpaRuntimeParamField;
  value: RuntimeParamValue | undefined;
  error?: string;
  onChange: (paramId: string, value: RuntimeParamValue) => void;
}) {
  const controlId = `runtime-param-${field.id}`;
  const errorId = `${controlId}-error`;
  const descriptionId = `${controlId}-description`;
  const describedBy = [field.description ? descriptionId : undefined, error ? errorId : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <label className="field runtime-param-field" htmlFor={controlId}>
      <span>
        {field.label}
        {field.required ? <b aria-hidden="true">*</b> : null}
      </span>
      {renderControl({
        controlId,
        describedBy,
        error,
        field,
        value,
        onChange,
      })}
      {field.description ? (
        <small className="runtime-param-field__description" id={descriptionId}>
          {field.description}
        </small>
      ) : null}
      {error ? (
        <small className="field-error runtime-param-field__error" id={errorId}>
          {error}
        </small>
      ) : null}
    </label>
  );
}

function renderControl({
  field,
  value,
  error,
  controlId,
  describedBy,
  onChange,
}: {
  field: RpaRuntimeParamField;
  value: RuntimeParamValue | undefined;
  error?: string;
  controlId: string;
  describedBy: string;
  onChange: (paramId: string, value: RuntimeParamValue) => void;
}) {
  const commonProps = {
    id: controlId,
    'aria-label': field.label,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': error ? true : undefined,
    required: field.required,
  };

  if (field.type === 'checkbox') {
    return (
      <input
        {...commonProps}
        checked={value === true}
        type="checkbox"
        onChange={(event) => onChange(field.id, event.target.checked)}
      />
    );
  }

  if (field.type === 'select') {
    return (
      <select
        {...commonProps}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(field.id, event.target.value)}
      >
        <option value="">Select...</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  const inputType =
    field.type === 'password' || field.type === 'number' || field.type === 'date' ? field.type : 'text';

  return (
    <input
      {...commonProps}
      type={inputType}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(event) => onChange(field.id, event.target.value)}
    />
  );
}
