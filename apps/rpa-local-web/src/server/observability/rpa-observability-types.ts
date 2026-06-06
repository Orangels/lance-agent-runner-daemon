export {
  isRpaFeedbackCategory,
  isRpaFeedbackSeverity,
  rpaFeedbackCategories,
  rpaFeedbackSeverities,
  type RpaFeedbackCategory,
  type RpaFeedbackSeverity,
} from '../../shared/rpa-api-types.js';

export interface RpaReviewBundleRequest {
  flowId: string;
  daemonRunId: string;
  executionIds: string[];
  includeSensitiveFiles: boolean;
  collectionMode: 'lite' | 'diagnostic' | 'review';
}

export interface RpaLargeFileReference {
  path: string;
  kind: 'screenshot' | 'trace' | 'video' | 'download' | 'log' | 'other';
  sizeBytes: number;
  sha256: string;
  reason: string;
  included: boolean;
}

export interface RpaRedactionOptions {
  storageRoot: string;
  maskedParamIds: string[];
  params: Record<string, string | number | boolean | null>;
}
