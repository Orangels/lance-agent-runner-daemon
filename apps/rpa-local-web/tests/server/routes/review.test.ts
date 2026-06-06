import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { createRpaLocalServer } from '../../../src/server/server.js';
import { createUncompressedZip, readUncompressedZipEntries } from '../../../src/server/observability/review-zip.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('RPA review routes', () => {
  it('downloads a combined RPA review bundle and forwards sanitized RPA feedback', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-review-route-'));
    const flowDir = path.join(storageRoot, 'flows', 'case_query');
    await mkdir(flowDir, { recursive: true });
    await mkdir(path.join(storageRoot, 'executions', 'exec_1'), { recursive: true });
    for (const artifactName of requiredGenerationArtifactNames) {
      await writeFile(
        path.join(flowDir, artifactName),
        artifactName === 'flow.dsl.json' ? JSON.stringify(createMinimalRpaDsl()) : `${artifactName}\n`,
      );
    }
    await writeFile(
      path.join(storageRoot, 'executions', 'exec_1', 'run.params.json'),
      JSON.stringify({ case_no: 'A123' }),
    );

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathText = String(url);
      if (pathText.endsWith('/api/runs/run_1/review-bundle/download')) {
        return new Response(
          toArrayBuffer(createUncompressedZip([
            { path: 'manifest.json', content: JSON.stringify({ collectionMode: 'diagnostic' }) },
            { path: 'review-summary.md', content: 'daemon\n' },
          ])),
          {
            status: 200,
            headers: { 'Content-Type': 'application/zip' },
          },
        );
      }
      if (pathText.endsWith('/api/runs/run_1/feedback') && init?.method !== 'POST') {
        return new Response(JSON.stringify({ feedback: [] }), { status: 200 });
      }
      if (pathText.endsWith('/api/runs/run_1/feedback')) {
        return new Response(JSON.stringify({ feedback: { id: 'feedback_1' } }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const app = await createRpaLocalServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        daemonBaseUrl: 'http://daemon.local',
        daemonApiKey: 'secret',
        defaultProfileId: 'rpa-local',
        storageRoot,
        codegenCommand: 'playwright',
        codegenArgs: ['codegen'],
        mode: 'test',
      },
      daemonFetch: fetchImpl as typeof fetch,
    });
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const bundleResponse = await fetch(`${baseUrl}/api/rpa/flows/case_query/review-bundle/download?daemonRunId=run_1`);
    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.headers.get('content-type')).toContain('application/zip');
    expect(bundleResponse.headers.get('content-disposition')).toContain('rpa_case_query_run_1_review_bundle.zip');
    const bundleEntries = Object.fromEntries(
      readUncompressedZipEntries(Buffer.from(await bundleResponse.arrayBuffer())).map((entry) => [
        entry.path,
        entry.content.toString('utf8'),
      ]),
    );
    expect(bundleEntries['review-summary.md']).toBe('daemon\n');
    expect(bundleEntries['extensions/rpa/rpa-summary.md']).toContain('case_query');

    const feedbackResponse = await fetch(`${baseUrl}/api/rpa/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        daemonRunId: 'run_1',
        flowId: 'case_query',
        executionId: 'exec_1',
        category: 'selector',
        severity: 'major',
        message: `wrong selector ${storageRoot} 13800138000 A123`,
      }),
    });
    expect(feedbackResponse.status).toBe(201);
    const feedbackCall = fetchImpl.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/runs/run_1/feedback') && init?.method === 'POST',
    );
    expect(JSON.stringify(feedbackCall?.[1]?.body)).not.toContain(storageRoot);
    expect(JSON.stringify(feedbackCall?.[1]?.body)).not.toContain('13800138000');
    expect(JSON.stringify(feedbackCall?.[1]?.body)).not.toContain('A123');
    expect(JSON.stringify(feedbackCall?.[1]?.body)).toContain('[masked-param:case_no]');
  });

  it('rejects unsafe feedback execution ids before forwarding feedback', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-review-route-'));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ feedback: { id: 'feedback_1' } }), { status: 201 }));
    const app = await createRpaLocalServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        daemonBaseUrl: 'http://daemon.local',
        daemonApiKey: 'secret',
        defaultProfileId: 'rpa-local',
        storageRoot,
        codegenCommand: 'playwright',
        codegenArgs: ['codegen'],
        mode: 'test',
      },
      daemonFetch: fetchImpl as typeof fetch,
    });
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const feedbackResponse = await fetch(`http://127.0.0.1:${port}/api/rpa/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        daemonRunId: 'run_1',
        executionId: '../outside',
        category: 'executor',
        severity: 'major',
        message: 'unsafe execution id',
      }),
    });

    expect(feedbackResponse.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
