import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { RuntimeParamsForm } from '../../src/components/RuntimeParamsForm.js';
import type { RpaRuntimeParamField, RuntimeParamValue } from '../../src/shared/runtime-params.js';

afterEach(() => cleanup());

const fields: RpaRuntimeParamField[] = [
  {
    id: 'case_no',
    label: 'Case No',
    description: 'Internal case identifier',
    type: 'text',
    required: true,
    mask: false,
  },
  {
    id: 'amount',
    label: 'Amount',
    type: 'number',
    required: false,
    mask: false,
  },
  {
    id: 'report_date',
    label: 'Report date',
    type: 'date',
    required: true,
    mask: false,
  },
  {
    id: 'include_closed',
    label: 'Include closed',
    type: 'checkbox',
    required: false,
    mask: false,
  },
  {
    id: 'unit',
    label: 'Unit',
    type: 'select',
    required: true,
    mask: false,
    options: [
      { label: 'City', value: 'city' },
      { label: 'District', value: 'district' },
    ],
  },
  {
    id: 'password',
    label: 'Password',
    type: 'password',
    required: true,
    mask: true,
  },
];

function Harness({
  initialValues = {},
  errors = {},
  onChange = vi.fn(),
}: {
  initialValues?: Record<string, RuntimeParamValue>;
  errors?: Record<string, string>;
  onChange?: (paramId: string, value: RuntimeParamValue) => void;
}) {
  const [values, setValues] = useState<Record<string, RuntimeParamValue>>(initialValues);

  return (
    <RuntimeParamsForm
      errors={errors}
      fields={fields}
      values={values}
      onChange={(paramId, value) => {
        setValues((current) => ({ ...current, [paramId]: value }));
        onChange(paramId, value);
      }}
    />
  );
}

describe('RuntimeParamsForm', () => {
  it('renders typed controls from runtime parameter fields', () => {
    render(<Harness initialValues={{ include_closed: true, unit: 'district' }} />);

    expect(screen.getByLabelText('Case No')).toHaveAttribute('type', 'text');
    expect(screen.getByText('Internal case identifier')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText('Report date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Include closed')).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('district');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('emits text, number, date, checkbox, select, and password values', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('Case No'), 'A123');
    await userEvent.type(screen.getByLabelText('Amount'), '12.5');
    await userEvent.type(screen.getByLabelText('Report date'), '2026-06-06');
    await userEvent.click(screen.getByLabelText('Include closed'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'city');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-value');

    expect(onChange).toHaveBeenCalledWith('case_no', 'A123');
    expect(onChange).toHaveBeenCalledWith('amount', '12.5');
    expect(onChange).toHaveBeenCalledWith('report_date', '2026-06-06');
    expect(onChange).toHaveBeenCalledWith('include_closed', true);
    expect(onChange).toHaveBeenCalledWith('unit', 'city');
    expect(onChange).toHaveBeenCalledWith('password', 'secret-value');
  });

  it('shows per-field validation errors', () => {
    render(
      <Harness
        errors={{
          case_no: 'Case No is required.',
          unit: 'Unit must be one of the configured options.',
        }}
      />,
    );

    expect(screen.getByText('Case No is required.')).toBeInTheDocument();
    expect(screen.getByText('Unit must be one of the configured options.')).toBeInTheDocument();
    expect(screen.getByLabelText('Case No')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('renders a compact empty state when no runtime params are configured', () => {
    render(<RuntimeParamsForm errors={{}} fields={[]} values={{}} onChange={vi.fn()} />);

    expect(screen.getByText('No runtime params configured.')).toBeInTheDocument();
  });
});
