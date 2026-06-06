import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';

describe('App', () => {
  it('renders the daemon test console shell', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Daemon Test Console' })).toBeInTheDocument();
  });
});
