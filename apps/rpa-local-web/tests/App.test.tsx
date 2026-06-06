import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RPA local web app shell', () => {
  it('renders dense workflow navigation and switches sections', async () => {
    mockRpaStatusFetches();
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
    expect(screen.getByRole('combobox', { name: 'Flow' })).toHaveDisplayValue('案件查询');
  });

  it('loads daemon status and renders the real settings view', async () => {
    mockRpaStatusFetches({
      config: {
        defaultProfileId: 'rpa-local',
        daemonConfigured: true,
        daemonBaseUrl: 'http://127.0.0.1:17890',
        storageRoot: '/mnt/8t/ls_data/rpa-local-data',
        codegenCommand: '/home/orangels/miniforge3/bin/python',
        codegenArgs: ['-m', 'playwright', 'codegen'],
        mode: 'development',
      },
      daemonHealth: { ok: true, daemonReachable: true, status: 200 },
    });

    render(<App />);

    expect(await screen.findByText('Daemon connected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(screen.getByText('http://127.0.0.1:17890')).toBeInTheDocument();
    expect(screen.getByText('rpa-local')).toBeInTheDocument();
    expect(screen.getByText('/mnt/8t/ls_data/rpa-local-data')).toBeInTheDocument();
    expect(screen.getByText('/home/orangels/miniforge3/bin/python -m playwright codegen')).toBeInTheDocument();
    expect(screen.getByText('development')).toBeInTheDocument();
  });

  it('shows a degraded daemon state in the topbar and settings page', async () => {
    mockRpaStatusFetches({
      daemonHealth: {
        ok: false,
        daemonReachable: false,
        error: 'daemon unavailable',
      },
    });

    render(<App />);

    expect(await screen.findByText('Daemon unavailable')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(screen.getByText('daemon unavailable')).toBeInTheDocument();
  });
});

function mockRpaStatusFetches(input: {
  config?: Record<string, unknown>;
  daemonHealth?: Record<string, unknown>;
} = {}) {
  const config =
    input.config ??
    {
      defaultProfileId: 'rpa-local',
      daemonConfigured: true,
      daemonBaseUrl: 'http://127.0.0.1:17890',
      storageRoot: '.rpa-local',
      codegenCommand: 'playwright',
      codegenArgs: ['codegen'],
      mode: 'test',
    };
  const daemonHealth =
    input.daemonHealth ??
    {
      ok: true,
      daemonReachable: true,
      status: 200,
    };

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource) => {
    const url = String(resource);
    if (url === '/api/rpa/config') {
      return jsonResponse(config);
    }
    if (url === '/api/rpa/daemon/health') {
      return jsonResponse(daemonHealth, daemonHealth.ok === false ? 502 : 200);
    }
    if (url === '/api/rpa/flows') {
      return jsonResponse({
        flows: [
          { flowId: 'case_query', title: '案件查询', source: 'codegen', requiresVerifyBeforeRun: false },
        ],
      });
    }
    if (url === '/api/rpa/flows/case_query') {
      return jsonResponse({
        flowId: 'case_query',
        title: '案件查询',
        source: 'codegen',
        warnings: [],
        runtimeParams: { fields: [], requiresUserInput: false, maskedParamIds: [] },
        provenance: { source: 'generated', requiresVerifyBeforeRun: false },
        dsl: {
          dsl_version: '0.1',
          flow_id: 'case_query',
          name: '案件查询',
          meta: { source: 'codegen' },
          params: {},
          context: {},
          steps: [],
        },
      });
    }

    return jsonResponse({ ok: true });
  });
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
