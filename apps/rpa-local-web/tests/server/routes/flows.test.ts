import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createMinimalRpaDsl, type RpaDslDocument } from '../../../src/shared/dsl-schema.js';
import { writeFlowLocalMetadata } from '../../../src/server/flow-store.js';
import { registerFlowRoutes } from '../../../src/server/routes/flows.js';

async function writeFlowDsl(storageRoot: string, dsl: RpaDslDocument) {
  const flowDir = path.join(storageRoot, 'flows', dsl.flow_id);
  await mkdir(flowDir, { recursive: true });
  await writeFile(path.join(flowDir, 'flow.dsl.json'), `${JSON.stringify(dsl, null, 2)}\n`);
}

function dslWithWarningAndStorageState(storageRoot: string): RpaDslDocument {
  return {
    ...createMinimalRpaDsl(),
    context: {
      ...createMinimalRpaDsl().context,
      storage_state: path.join(storageRoot, 'private', 'auth-state.json'),
    },
    steps: [
      ...createMinimalRpaDsl().steps,
      {
        id: 's2',
        name: '点击查询',
        action: 'click',
        target: { by: 'css', css: '#query' },
        write: false,
        manual: null,
      },
    ],
  };
}

describe('RPA flow detail routes', () => {
  it('returns a safe validated flow detail response with DSL steps and warnings', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-route-detail-'));
    await writeFlowDsl(storageRoot, dslWithWarningAndStorageState(storageRoot));

    const { status, payload } = await requestFlow(storageRoot, 'case_query');
    expect(status).toBe(200);

    expect(payload).toMatchObject({
      flowId: 'case_query',
      title: '案件查询',
      source: 'codegen',
      dsl: {
        flow_id: 'case_query',
        steps: [
          expect.objectContaining({ id: 's1', name: '打开查询页' }),
          expect.objectContaining({ id: 's2', name: '点击查询' }),
        ],
      },
    });
    expect(payload.warnings).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'MISSING_WAIT', path: 'steps[1].wait' }),
    ]);
    expect(payload.runtimeParams).toMatchObject({
      requiresUserInput: true,
      maskedParamIds: ['case_no'],
      fields: [expect.objectContaining({ id: 'case_no', type: 'text', required: true, mask: true })],
    });
    expect(payload.provenance).toMatchObject({
      source: 'generated',
      requiresVerifyBeforeRun: false,
    });
    expect(payload.dsl.context.storage_state).toBe('[configured]');
    expect(JSON.stringify(payload)).not.toContain(storageRoot);
  });

  it('returns imported flow provenance without leaking local paths', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-route-imported-'));
    const dsl = createMinimalRpaDsl();
    await writeFlowDsl(storageRoot, dsl);
    await writeFlowLocalMetadata(path.join(storageRoot, 'flows', dsl.flow_id), {
      schemaVersion: 'rpa-flow-local.v0.1',
      flowId: dsl.flow_id,
      source: 'imported',
      createdAt: '2026-06-06T00:00:00.000Z',
      requiresVerifyBeforeRun: true,
      imported: {
        originalFlowId: 'case_query',
        packageCreatedAt: '2026-06-05T00:00:00.000Z',
        packageSha256: 'sha256:abc',
        packageFileName: 'case_query.rpa.zip',
      },
    });

    const { status, payload } = await requestFlow(storageRoot, 'case_query');

    expect(status).toBe(200);
    expect(payload.provenance).toMatchObject({
      source: 'imported',
      requiresVerifyBeforeRun: true,
      importedAt: '2026-06-06T00:00:00.000Z',
      originalFlowId: 'case_query',
      packageCreatedAt: '2026-06-05T00:00:00.000Z',
      packageSha256: 'sha256:abc',
    });
    expect(JSON.stringify(payload)).not.toContain(storageRoot);
  });

  it('returns structured errors for missing flows and invalid flow ids without leaking storage root', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-route-errors-'));

    const missing = await requestFlow(storageRoot, 'case_query');
    expect(missing.status).toBe(404);
    expect(['FLOW_ARTIFACT_MISSING', 'FLOW_NOT_FOUND']).toContain(missing.payload.error.code);
    expect(JSON.stringify(missing.payload)).not.toContain(storageRoot);

    const invalid = await requestFlow(storageRoot, '../secret');
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(invalid.payload).toMatchObject({ error: { code: 'INVALID_FLOW_ID' } });
    expect(JSON.stringify(invalid.payload)).not.toContain(storageRoot);
  });

  it('returns DSL validation failures as structured browser-safe errors', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-flow-route-invalid-dsl-'));
    await writeFlowDsl(storageRoot, {
      ...createMinimalRpaDsl(),
      steps: [],
    });

    const { status, payload } = await requestFlow(storageRoot, 'case_query');
    expect(status).toBe(400);
    expect(payload).toMatchObject({ error: { code: 'DSL_INVALID' } });
    expect(JSON.stringify(payload)).not.toContain(storageRoot);
  });
});

async function requestFlow(storageRoot: string, flowId: string): Promise<{ status: number; payload: any }> {
  const routes = new Map<string, RouteHandler>();
  const app = {
    get: vi.fn((route: string, handler: RouteHandler) => {
      routes.set(route, handler);
      return app;
    }),
  } as unknown as Express;
  registerFlowRoutes(app, { storageRoot });

  const res = createMockResponse();
  await routes.get('/api/rpa/flows/:flowId')?.({ params: { flowId } }, res);
  return { status: res.statusCode, payload: res.payload };
}

type RouteHandler = (req: { params: { flowId: string } }, res: MockResponse) => Promise<void> | void;

interface MockResponse {
  statusCode: number;
  payload: any;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
}

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    payload: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
}
