import { describe, expect, it } from 'vitest';
import { requiredGenerationArtifactNames, type RpaGenerationArtifact } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl, type RpaDslDocument } from '../../../src/shared/dsl-schema.js';
import { buildRpaDiagnostics } from '../../../src/server/observability/rpa-diagnostics.js';

describe('RPA diagnostics', () => {
  it('summarizes DSL warnings, missing artifacts, fragile selectors, waits, manuals, and writes', () => {
    const dsl: RpaDslDocument = {
      ...createMinimalRpaDsl(),
      steps: [
        {
          id: 'search',
          name: '查询',
          action: 'click',
          target: { by: 'xpath', xpath: '//button[1]' },
          write: true,
          manual: null,
        },
        {
          id: 'captcha',
          name: '验证码',
          action: 'manual',
          write: false,
          manual: { type: 'captcha', instruction: '请处理验证码', riskLevel: 'medium' },
        },
      ],
    };

    const artifacts: RpaGenerationArtifact[] = requiredGenerationArtifactNames
      .filter((fileName) => fileName !== 'hardening-report.md')
      .map((fileName) => ({
        artifactId: `artifact_${fileName}`,
        fileName,
        relativePath: `output/${fileName}`,
        size: 10,
        sha256: 'a'.repeat(64),
      }));

    const diagnostics = buildRpaDiagnostics({
      dsl,
      artifacts,
      executions: [],
      maxItemsPerList: 20,
    });

    expect(diagnostics.missingArtifacts).toContain('hardening-report.md');
    expect(diagnostics.fragileSelectors[0]).toMatchObject({ stepId: 'search', selectorType: 'xpath' });
    expect(diagnostics.missingWaits).toContain('search');
    expect(diagnostics.unconfirmedWriteSteps).toContain('search');
    expect(diagnostics.manualSteps[0]).toMatchObject({ stepId: 'captcha', type: 'captcha' });
  });

  it('bounds large lists and reports omitted counts', () => {
    const dsl: RpaDslDocument = {
      ...createMinimalRpaDsl(),
      steps: Array.from({ length: 25 }, (_, index) => ({
        id: `s${index}`,
        name: `Step ${index}`,
        action: 'click',
        target: { by: 'css', css: `.button-${index}` },
        write: false,
        manual: null,
      })),
    };

    const diagnostics = buildRpaDiagnostics({ dsl, artifacts: [], executions: [], maxItemsPerList: 5 });

    expect(diagnostics.fragileSelectors).toHaveLength(5);
    expect(diagnostics.limits.omitted.fragileSelectors).toBeGreaterThan(0);
  });
});
