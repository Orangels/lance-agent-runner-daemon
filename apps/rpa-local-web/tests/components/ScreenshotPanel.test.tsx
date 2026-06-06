import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ScreenshotPanel } from '../../src/components/ScreenshotPanel.js';

afterEach(() => cleanup());

describe('ScreenshotPanel', () => {
  it('renders idle, loading, and explicit error states', () => {
    const { rerender } = render(<ScreenshotPanel status="idle" />);
    expect(screen.getByText('No screenshot yet.')).toBeInTheDocument();

    rerender(<ScreenshotPanel status="loading" />);
    expect(screen.getByText('Loading screenshot...')).toBeInTheDocument();

    rerender(<ScreenshotPanel status="error" errorMessage="Screenshot is unavailable." />);
    expect(screen.getByText('Screenshot is unavailable.')).toBeInTheDocument();
  });

  it('renders a ready image and turns image load failures into an error state', () => {
    render(<ScreenshotPanel status="ready" imageUrl="/api/rpa/executions/exec_1/screenshots/current?t=123" />);

    const image = screen.getByRole('img', { name: 'Current execution screenshot' });
    expect(image).toHaveAttribute('src', '/api/rpa/executions/exec_1/screenshots/current?t=123');

    fireEvent.error(image);

    expect(screen.getByText('Screenshot failed to load.')).toBeInTheDocument();
  });
});
