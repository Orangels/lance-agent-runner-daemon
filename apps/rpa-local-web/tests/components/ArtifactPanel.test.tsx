import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactPanel } from '../../src/components/ArtifactPanel.js';
import type { RpaExecutionArtifactSummary } from '../../src/shared/rpa-api-types.js';

afterEach(() => cleanup());

const artifacts: RpaExecutionArtifactSummary[] = [
  {
    artifactId: 'art_screenshot',
    role: 'screenshot',
    fileName: 'current.png',
    relativePath: '/home/orangels/private/current.png',
    size: 1024,
    sha256: 'hash_screenshot',
  },
  {
    artifactId: 'art_download',
    role: 'download',
    fileName: 'report.csv',
    relativePath: 'artifacts/downloads/report.csv',
    size: 2048,
    sha256: 'hash_download',
  },
  {
    artifactId: 'art_trace',
    role: 'trace',
    fileName: 'trace.zip',
    relativePath: 'artifacts/trace/trace.zip',
    size: 4096,
    sha256: 'hash_trace',
  },
  {
    artifactId: 'art_video',
    role: 'video',
    fileName: 'session.webm',
    relativePath: 'artifacts/video/session.webm',
    size: 8192,
    sha256: 'hash_video',
  },
  {
    artifactId: 'art_log',
    role: 'log',
    fileName: 'stdout.log',
    relativePath: 'artifacts/logs/stdout.log',
    size: 512,
    sha256: 'hash_log',
  },
];

describe('ArtifactPanel', () => {
  it('renders artifacts by role with safe download links', () => {
    render(<ArtifactPanel executionId="exec_1" artifacts={artifacts} />);

    for (const artifact of artifacts) {
      expect(screen.getByText(artifact.role)).toBeInTheDocument();
      const link = screen.getByRole('link', { name: new RegExp(artifact.fileName) });
      expect(link).toHaveAttribute(
        'href',
        `/api/rpa/executions/exec_1/artifacts/${artifact.artifactId}/download`,
      );
    }

    expect(screen.getByText('current.png')).toBeInTheDocument();
    expect(screen.queryByText('/home/orangels/private/current.png')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/home/orangels/private');
  });
});
