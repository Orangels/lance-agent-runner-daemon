import type { RunnerDatabase } from './connection.js';
import * as repositories from './repositories.js';
import type {
  CreateRunQueuedWithMessagesAndSnapshotInput,
  GetArtifactForRunForClientInput,
  GetConversationForWorkspaceInput,
  GetOrCreateDefaultConversationInput,
  GetRunByIdempotencyKeyInput,
  GetRunLogForRunForClientInput,
  GetWorkspaceForClientInput,
  GetNextWebhookDeliveryDueAtInput,
  ClaimWebhookDeliveriesInput,
  CreateWebhookDeliveryForRunStatusInput,
  InsertAssistantRunMessageInput,
  InsertRunFeedbackInput,
  InsertRunMessagesForRunCreateInput,
  InsertRunQueuedInput,
  InsertRunWebhookInput,
  InsertWebhookDeliveryAttemptInput,
  ListArtifactsForRunInput,
  ListConversationMessagesForPromptInput,
  ListRunFeedbackForClientInput,
  ListRunLogsFinishedBeforeInput,
  ListRunsForClientInput,
  MarkWebhookDeliveryAbandonedInput,
  MarkWebhookDeliveryRetryingInput,
  MarkWebhookDeliverySucceededInput,
  ReplaceArtifactsForRunInput,
  RunForClientInput,
  RunnerPersistence,
  UpdateAssistantMessageStartedInput,
  UpdateAssistantMessageTerminalInput,
  UpdateAssistantMessagesTerminalForRunInput,
  UpdateRunMessageInput,
  UpdateRunPromptSnapshotFieldsInput,
  UpdateRunStartedInput,
  UpdateRunTerminalInput,
  UpsertRunContextSnapshotInput,
  UpsertRunLogPathsInput,
  UpsertRunPromptSnapshotInput,
  UpsertRunSkillSnapshotInput,
  UpsertWorkspaceInput,
} from './types.js';

// Temporary bridge while services are moved to the async persistence facade.
// Task 6 replaces daemon startup with PostgreSQL-only persistence.
export function createSqliteRunnerPersistence(db: RunnerDatabase): RunnerPersistence {
  const persistence: RunnerPersistence = {
    async close(): Promise<void> {
      db.close();
    },
    isUniqueConstraintError(error: unknown): boolean {
      return repositories.isSqliteUniqueConstraintError(error);
    },
    async transaction<T>(fn: (persistence: RunnerPersistence) => Promise<T>): Promise<T> {
      return fn(persistence);
    },
    async upsertWorkspace(input: UpsertWorkspaceInput) {
      return repositories.upsertWorkspace(db, input);
    },
    async getWorkspaceForClient(input: GetWorkspaceForClientInput) {
      return repositories.getWorkspaceForClient(db, input);
    },
    async getOrCreateDefaultConversation(input: GetOrCreateDefaultConversationInput) {
      return repositories.getOrCreateDefaultConversation(db, input);
    },
    async getConversationForWorkspace(input: GetConversationForWorkspaceInput) {
      return repositories.getConversationForWorkspace(db, input);
    },
    async listConversationMessagesForPrompt(input: ListConversationMessagesForPromptInput) {
      return repositories.listConversationMessagesForPrompt(db, input);
    },
    async insertRunQueued(input: InsertRunQueuedInput) {
      return repositories.insertRunQueued(db, input);
    },
    async createRunQueuedWithMessagesAndSnapshot(input: CreateRunQueuedWithMessagesAndSnapshotInput) {
      return repositories.createRunQueuedWithMessagesAndSnapshot(db, input);
    },
    async getProfileSnapshotForRun(runId: string) {
      return repositories.getProfileSnapshotForRun(db, runId);
    },
    async upsertRunPromptSnapshot(input: UpsertRunPromptSnapshotInput) {
      return repositories.upsertRunPromptSnapshot(db, input);
    },
    async updateRunPromptSnapshotFields(input: UpdateRunPromptSnapshotFieldsInput) {
      return repositories.updateRunPromptSnapshotFields(db, input);
    },
    async upsertRunSkillSnapshot(input: UpsertRunSkillSnapshotInput) {
      return repositories.upsertRunSkillSnapshot(db, input);
    },
    async upsertRunContextSnapshot(input: UpsertRunContextSnapshotInput) {
      return repositories.upsertRunContextSnapshot(db, input);
    },
    async getRunPromptSnapshot(runId: string) {
      return repositories.getRunPromptSnapshot(db, runId);
    },
    async getRunSkillSnapshot(runId: string) {
      return repositories.getRunSkillSnapshot(db, runId);
    },
    async getRunContextSnapshot(runId: string) {
      return repositories.getRunContextSnapshot(db, runId);
    },
    async markInterruptedRunsOnStartup(now: number) {
      return repositories.markInterruptedRunsOnStartup(db, now);
    },
    async insertRunMessagesForRunCreate(input: InsertRunMessagesForRunCreateInput) {
      return repositories.insertRunMessagesForRunCreate(db, input);
    },
    async insertAssistantRunMessage(input: InsertAssistantRunMessageInput) {
      return repositories.insertAssistantRunMessage(db, input);
    },
    async updateAssistantMessagesTerminalForRun(input: UpdateAssistantMessagesTerminalForRunInput) {
      return repositories.updateAssistantMessagesTerminalForRun(db, input);
    },
    async updateRunStarted(input: UpdateRunStartedInput) {
      return repositories.updateRunStarted(db, input);
    },
    async updateRunTerminal(input: UpdateRunTerminalInput) {
      return repositories.updateRunTerminal(db, input);
    },
    async insertRunWebhook(_input: InsertRunWebhookInput) {
      throw webhooksRequirePostgresPersistence();
    },
    async createWebhookDeliveryForRunStatus(_input: CreateWebhookDeliveryForRunStatusInput) {
      throw webhooksRequirePostgresPersistence();
    },
    async claimDueWebhookDeliveries(_input: ClaimWebhookDeliveriesInput) {
      throw webhooksRequirePostgresPersistence();
    },
    async getNextWebhookDeliveryDueAt(_input: GetNextWebhookDeliveryDueAtInput) {
      throw webhooksRequirePostgresPersistence();
    },
    async markWebhookDeliverySucceeded(_input: MarkWebhookDeliverySucceededInput) {
      throw webhooksRequirePostgresPersistence();
    },
    async markWebhookDeliveryRetrying(_input: MarkWebhookDeliveryRetryingInput) {
      throw webhooksRequirePostgresPersistence();
    },
    async markWebhookDeliveryAbandoned(_input: MarkWebhookDeliveryAbandonedInput) {
      throw webhooksRequirePostgresPersistence();
    },
    async insertWebhookDeliveryAttempt(_input: InsertWebhookDeliveryAttemptInput) {
      throw webhooksRequirePostgresPersistence();
    },
    async updateAssistantMessageStarted(input: UpdateAssistantMessageStartedInput) {
      return repositories.updateAssistantMessageStarted(db, input);
    },
    async updateAssistantMessageTerminal(input: UpdateAssistantMessageTerminalInput) {
      return repositories.updateAssistantMessageTerminal(db, input);
    },
    async updateRunMessage(input: UpdateRunMessageInput) {
      return repositories.updateRunMessage(db, input);
    },
    async replaceArtifactsForRun(input: ReplaceArtifactsForRunInput) {
      return repositories.replaceArtifactsForRun(db, input);
    },
    async listArtifactsForRun(input: ListArtifactsForRunInput) {
      return repositories.listArtifactsForRun(db, input);
    },
    async getArtifactForRunForClient(input: GetArtifactForRunForClientInput) {
      return repositories.getArtifactForRunForClient(db, input);
    },
    async upsertRunLogPaths(input: UpsertRunLogPathsInput) {
      return repositories.upsertRunLogPaths(db, input);
    },
    async getRunLogForRunForClient(input: GetRunLogForRunForClientInput) {
      return repositories.getRunLogForRunForClient(db, input);
    },
    async listRunLogsFinishedBefore(input: ListRunLogsFinishedBeforeInput) {
      return repositories.listRunLogsFinishedBefore(db, input);
    },
    async deleteRunLogRows(runIds: readonly string[]) {
      return repositories.deleteRunLogRows(db, runIds);
    },
    async insertRunFeedback(input: InsertRunFeedbackInput) {
      return repositories.insertRunFeedback(db, input);
    },
    async listRunFeedbackForClient(input: ListRunFeedbackForClientInput) {
      return repositories.listRunFeedbackForClient(db, input);
    },
    async getRunDetail(input: RunForClientInput) {
      return repositories.getRunDetail(db, input);
    },
    async getRunForClient(input: RunForClientInput) {
      return repositories.getRunForClient(db, input);
    },
    async getRunWithWorkspaceForClient(input: RunForClientInput) {
      return repositories.getRunWithWorkspaceForClient(db, input);
    },
    async listRunsForClient(input: ListRunsForClientInput) {
      return repositories.listRunsForClient(db, input);
    },
    async getRunByIdempotencyKey(input: GetRunByIdempotencyKeyInput) {
      return repositories.getRunByIdempotencyKey(db, input);
    },
  };
  return persistence;
}

function webhooksRequirePostgresPersistence(): Error {
  return new Error('webhooks require postgres persistence');
}
