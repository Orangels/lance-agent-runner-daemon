import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonError } from '../../src/core/errors.js';
import { createUploadTempService } from '../../src/core/upload-temp-service.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-upload-temp-test-'));
  tempDirs.push(dir);
  return dir;
}

function setup(input: { uploadTempRetentionMs?: number } = {}) {
  const dataDir = makeDataDir();
  const service = createUploadTempService({
    config: {
      server: {
        dataDir,
        uploadTempRetentionMs: input.uploadTempRetentionMs ?? 60_000,
      },
    },
  });
  return { dataDir, service };
}

describe('upload temp service', () => {
  it('creates temp root and one unique upload directory', () => {
    const { dataDir, service } = setup();

    const uploadDir = service.createUploadDirectory();

    expect(service.getTempRoot()).toBe(path.join(dataDir, 'uploads', 'tmp'));
    expect(statSync(service.getTempRoot()).isDirectory()).toBe(true);
    expect(statSync(uploadDir).isDirectory()).toBe(true);
    expect(path.dirname(uploadDir)).toBe(service.getTempRoot());
    expect(readdirSync(service.getTempRoot())).toEqual([path.basename(uploadDir)]);
  });

  it('assertTempPath accepts a file under the upload directory', () => {
    const { service } = setup();
    const uploadDir = service.createUploadDirectory();
    const filePath = path.join(uploadDir, 'source.docx');
    writeFileSync(filePath, 'content');

    expect(service.assertTempPath(filePath)).toBe(filePath);
  });

  it('assertTempPath rejects sibling-prefix escapes', () => {
    const { service } = setup();
    const escapePath = `${service.getTempRoot()}-evil/source.docx`;

    expect(() => service.assertTempPath(escapePath)).toThrow(DaemonError);
    try {
      service.assertTempPath(escapePath);
      throw new Error('expected upload temp validation failure');
    } catch (error) {
      expect((error as DaemonError).code).toBe('PATH_NOT_ALLOWED');
    }
  });

  it('removeUploadPath deletes the file and empty per-upload directory', () => {
    const { service } = setup();
    const uploadDir = service.createUploadDirectory();
    const filePath = path.join(uploadDir, 'source.docx');
    writeFileSync(filePath, 'content');

    service.removeUploadPath(filePath);

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
    expect(existsSync(service.getTempRoot())).toBe(true);
  });

  it('pruneExpiredUploads removes old temp child directories', () => {
    const { service } = setup({ uploadTempRetentionMs: 1_000 });
    const uploadDir = service.createUploadDirectory();
    writeFileSync(path.join(uploadDir, 'source.docx'), 'content');
    utimesSync(uploadDir, new Date(1_000), new Date(1_000));

    const result = service.pruneExpiredUploads({ now: 3_000 });

    expect(result).toEqual({ removed: 1 });
    expect(existsSync(uploadDir)).toBe(false);
  });

  it('pruneExpiredUploads leaves fresh child directories intact', () => {
    const { service } = setup({ uploadTempRetentionMs: 1_000 });
    const uploadDir = service.createUploadDirectory();
    writeFileSync(path.join(uploadDir, 'source.docx'), 'content');
    utimesSync(uploadDir, new Date(2_500), new Date(2_500));

    const result = service.pruneExpiredUploads({ now: 3_000 });

    expect(result).toEqual({ removed: 0 });
    expect(existsSync(uploadDir)).toBe(true);
  });

  it('pruneExpiredUploads does not remove the temp root itself', () => {
    const { service } = setup({ uploadTempRetentionMs: 0 });
    mkdirSync(service.getTempRoot(), { recursive: true });
    utimesSync(service.getTempRoot(), new Date(1_000), new Date(1_000));

    const result = service.pruneExpiredUploads({ now: 3_000 });

    expect(result).toEqual({ removed: 0 });
    expect(existsSync(service.getTempRoot())).toBe(true);
  });
});
