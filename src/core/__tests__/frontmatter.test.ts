import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../frontmatter.js';

describe('parseFrontmatter', () => {
  it('returns empty data and the original body when SKILL.md has no frontmatter', () => {
    const body = '# Report Writer\n\nWrite a concise report.\n';

    expect(parseFrontmatter(body)).toEqual({ data: {}, body });
  });

  it('parses scalars, booleans, numbers, flat arrays, and block literals', () => {
    const parsed = parseFrontmatter(`---
title: Report Writer
enabled: true
draft: false
priority: 3
ratio: 1.5
tags:
  - report
  - docx
summary: |
  Use this skill for reports.
  Keep outputs concise.
---
# Instructions
Create the report.
`);

    expect(parsed.data).toEqual({
      title: 'Report Writer',
      enabled: true,
      draft: false,
      priority: 3,
      ratio: 1.5,
      tags: ['report', 'docx'],
      summary: 'Use this skill for reports.\nKeep outputs concise.',
    });
    expect(parsed.body).toBe('# Instructions\nCreate the report.\n');
  });

  it('ignores a UTF-8 BOM before the opening frontmatter fence', () => {
    const parsed = parseFrontmatter('\uFEFF---\nname: BOM Skill\n---\nBody\n');

    expect(parsed).toEqual({
      data: { name: 'BOM Skill' },
      body: 'Body\n',
    });
  });

  it('skips malformed non-key lines during discovery', () => {
    const parsed = parseFrontmatter(`---
name: Good Skill
this line has no colon
- orphan item
description: Still parsed
---
Body
`);

    expect(parsed.data).toEqual({
      name: 'Good Skill',
      description: 'Still parsed',
    });
    expect(parsed.body).toBe('Body\n');
  });
});
