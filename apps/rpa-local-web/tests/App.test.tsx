import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';

describe('RPA local web app shell', () => {
  it('renders dense workflow navigation and switches sections', async () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'RPA Local Web' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Codegen 加固' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Playwright codegen 录制后加固')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '自然语言生成' }));

    expect(screen.getByRole('tab', { name: '自然语言生成' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('用业务描述生成 RPA 流程')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Executions' }));

    expect(screen.getByRole('tab', { name: 'Executions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Execution controls' })).toBeInTheDocument();
    expect(screen.getByLabelText('Flow ID')).toHaveValue('case_query');
  });
});
