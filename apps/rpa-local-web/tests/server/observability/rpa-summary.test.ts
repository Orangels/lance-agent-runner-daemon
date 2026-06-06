import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { buildRpaSummaryMarkdown } from '../../../src/server/observability/rpa-summary.js';

describe('RPA review summary', () => {
  it('summarizes the RPA goal, source, artifacts, params, diagnostics, and executions without large raw content', () => {
    const summary = buildRpaSummaryMarkdown({
      flowId: 'case_query',
      daemonRunId: 'run_1',
      dsl: createMinimalRpaDsl(),
      diagnostics: {
        missingArtifacts: ['hardening-report.md'],
        fragileSelectors: [{ stepId: 's1', selectorType: 'xpath', path: 'steps[0].target' }],
        executionFailures: [
          { executionId: 'exec_1', stepId: 's1', category: 'selector', message: 'target not found' },
        ],
      },
      executionRecords: [{ executionId: 'exec_1', status: 'failed', failedStepId: 's1' }],
    });

    expect(summary).toContain('# RPA Review Summary');
    expect(summary).toContain('case_query');
    expect(summary).toContain('hardening-report.md');
    expect(summary).toContain('exec_1');
    expect(summary).not.toContain('trace.zip content');
  });
});
