import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.resolve(__dirname, '../../skills');

const hardenedTemplatePaths = [
  path.join(skillsRoot, 'playwright-rpa-harden/templates/flow.hardened.py.tmpl'),
  path.join(skillsRoot, 'rpa-script-generate/templates/flow.hardened.py.tmpl'),
];

describe('RPA script template executor contract', () => {
  it.each(hardenedTemplatePaths)('accepts the local executor CLI flags in %s', async (templatePath) => {
    const source = await readFile(templatePath, 'utf8');

    expect(source).toContain('parser.add_argument("--mode"');
    expect(source).toContain('parser.add_argument("--params"');
    expect(source).toContain('parser.add_argument("--execution-dir"');
    expect(source).toContain('parser.add_argument("--dry-run"');
    expect(source).toContain('add_argument("--headless"');
    expect(source).toContain('add_argument("--headed"');
    expect(source).toContain('Path(__file__).with_name("config.example.json")');
    expect(source).toContain('dry_run = args.dry_run or is_dry_run(args.mode)');
  });

  it('keeps the natural-language draft template compatible with executor flags', async () => {
    const source = await readFile(
      path.join(skillsRoot, 'rpa-script-generate/templates/flow.py.tmpl'),
      'utf8',
    );

    expect(source).toContain('parser.add_argument("--execution-dir"');
    expect(source).toContain('parser.add_argument("--dry-run"');
    expect(source).toContain('add_argument("--headless"');
    expect(source).toContain('add_argument("--headed"');
    expect(source).toContain('Path(__file__).with_name("config.example.json")');
  });
});
