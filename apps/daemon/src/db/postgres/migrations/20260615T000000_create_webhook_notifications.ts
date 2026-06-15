import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE run_webhooks (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      client_id text NOT NULL,
      url text NOT NULL,
      secret text,
      statuses_json text NOT NULL,
      metadata_json text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE (run_id)
    );

    CREATE INDEX idx_run_webhooks_client_run
      ON run_webhooks (client_id, run_id);

    CREATE TABLE webhook_deliveries (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      webhook_id text NOT NULL REFERENCES run_webhooks(id) ON DELETE CASCADE,
      client_id text NOT NULL,
      event_type text NOT NULL,
      run_status text NOT NULL,
      delivery_status text NOT NULL,
      payload_json text NOT NULL,
      payload_sha256 text NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at bigint NOT NULL,
      locked_at bigint,
      locked_by text,
      last_attempt_at bigint,
      delivered_at bigint,
      response_status integer,
      response_body_preview text,
      error_message text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE (webhook_id, run_status)
    );

    CREATE INDEX idx_webhook_deliveries_due
      ON webhook_deliveries (delivery_status, next_attempt_at, created_at);

    CREATE INDEX idx_webhook_deliveries_run
      ON webhook_deliveries (run_id, created_at);

    CREATE TABLE webhook_delivery_attempts (
      id text PRIMARY KEY,
      delivery_id text NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
      attempt integer NOT NULL,
      attempted_at bigint NOT NULL,
      duration_ms integer NOT NULL,
      success integer NOT NULL,
      response_status integer,
      response_body_preview text,
      error_message text,
      created_at bigint NOT NULL
    );

    CREATE INDEX idx_webhook_delivery_attempts_delivery
      ON webhook_delivery_attempts (delivery_id, attempt);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP TABLE IF EXISTS webhook_delivery_attempts;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS run_webhooks;
  `);
}
