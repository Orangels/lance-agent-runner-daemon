import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionForm } from '../../src/components/QuestionForm.js';

afterEach(() => cleanup());

describe('QuestionForm', () => {
  it('enforces checkbox maxSelections before submitting answers', async () => {
    const onSubmit = vi.fn();

    render(
      <QuestionForm
        form={{
          formId: 'rpa-parameterization',
          title: '确认参数',
          questions: [
            {
              id: 'fields',
              type: 'checkbox',
              label: '返回字段',
              maxSelections: 2,
              options: [
                { label: '日期', value: 'date' },
                { label: '天气', value: 'weather' },
                { label: '温度', value: 'temperature' },
              ],
            },
          ],
        }}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByLabelText('日期'));
    await userEvent.click(screen.getByLabelText('天气'));

    expect(screen.getByLabelText('温度')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(onSubmit).toHaveBeenCalledWith({ fields: ['date', 'weather'] });
  });
});
