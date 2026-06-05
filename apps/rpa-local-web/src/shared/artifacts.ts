import { RPA_DSL_VERSION } from './dsl-schema.js';

export const RPA_PACKAGE_SCHEMA_VERSION = 'rpa-package.v0.1' as const;

export const requiredGenerationArtifactNames = [
  'flow.dsl.json',
  'flow.hardened.py',
  'config.example.json',
  'parameterization-report.md',
  'hardening-report.md',
] as const;

export type RequiredGenerationArtifactName = (typeof requiredGenerationArtifactNames)[number];

export const optionalGenerationArtifactNames = ['flow.py'] as const;
export type OptionalGenerationArtifactName = (typeof optionalGenerationArtifactNames)[number];

export const allowedGenerationArtifactNames = [
  ...requiredGenerationArtifactNames,
  ...optionalGenerationArtifactNames,
] as const;

export type AllowedGenerationArtifactName = (typeof allowedGenerationArtifactNames)[number];

export type GenerationArtifactRole =
  | 'dsl'
  | 'script'
  | 'configTemplate'
  | 'parameterizationReport'
  | 'hardeningReport';

export interface RpaGenerationArtifact {
  artifactId: string;
  relativePath: string;
  fileName: string;
  mimeType?: string;
  size: number;
  sha256?: string;
}

export interface RpaPackageManifest {
  schemaVersion: typeof RPA_PACKAGE_SCHEMA_VERSION;
  flowId: string;
  name: string;
  description?: string;
  createdAt: string;
  generator: {
    mode: 'codegen' | 'nl' | 'imported';
    skillId?: 'playwright-rpa-harden' | 'rpa-script-generate';
    daemonRunId?: string;
  };
  dsl: {
    version: typeof RPA_DSL_VERSION;
    path: 'flow.dsl.json';
  };
  artifacts: Record<GenerationArtifactRole, RequiredGenerationArtifactName>;
  params: {
    schemaPath: 'flow.dsl.json#/params';
    requiresUserInput: boolean;
    maskedParamIds: string[];
  };
  requirements: {
    runtime: 'python-playwright';
    executorMinVersion: '0.1.0';
    browser: 'playwright-chromium' | 'system-chrome';
    browserChannel: string | null;
    manualIntervention: string[];
  };
  checksums: Record<RequiredGenerationArtifactName, `sha256:${string}`>;
}

export const requiredArtifactRoleByName: Record<RequiredGenerationArtifactName, GenerationArtifactRole> = {
  'flow.dsl.json': 'dsl',
  'flow.hardened.py': 'script',
  'config.example.json': 'configTemplate',
  'parameterization-report.md': 'parameterizationReport',
  'hardening-report.md': 'hardeningReport',
};
