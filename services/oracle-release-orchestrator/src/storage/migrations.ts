export interface LedgerMigration {
  readonly version: number;
  readonly sql: string;
}

export const LEDGER_MIGRATIONS: readonly LedgerMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE workflow_blueprints (
        blueprint_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        definition_json TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (blueprint_id, version)
      );

      CREATE TABLE release_runs (
        run_id TEXT PRIMARY KEY,
        blueprint_id TEXT NOT NULL,
        blueprint_version INTEGER NOT NULL,
        blueprint_sha256 TEXT NOT NULL CHECK (length(blueprint_sha256) = 64),
        target_release TEXT NOT NULL,
        source_commit_sha TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('planned', 'running', 'paused_outcome_unknown', 'failed', 'succeeded')
        ),
        create_idempotency_key TEXT NOT NULL UNIQUE,
        create_request_sha256 TEXT NOT NULL CHECK (length(create_request_sha256) = 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (blueprint_id, blueprint_version)
          REFERENCES workflow_blueprints (blueprint_id, version)
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE release_runs
        ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0);

      CREATE TABLE run_steps (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        stage TEXT NOT NULL,
        action TEXT NOT NULL,
        execution_class TEXT NOT NULL CHECK (execution_class IN ('read_only', 'external_effect')),
        definition_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'in_progress', 'outcome_unknown', 'failed', 'succeeded')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        operation_id TEXT,
        idempotency_key TEXT,
        PRIMARY KEY (run_id, step_id),
        UNIQUE (run_id, ordinal),
        UNIQUE (run_id, idempotency_key),
        FOREIGN KEY (run_id) REFERENCES release_runs (run_id) ON DELETE CASCADE
      );

      CREATE TABLE run_health_gates (
        run_id TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'passed', 'failed', 'outcome_unknown')
        ),
        required_evidence_kinds_json TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (run_id, gate_id),
        FOREIGN KEY (run_id) REFERENCES release_runs (run_id) ON DELETE CASCADE
      );

      CREATE TABLE step_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        operation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('intent_recorded', 'outcome_unknown', 'resolved_not_applied', 'failed', 'succeeded')
        ),
        intent_recorded_at TEXT NOT NULL,
        completed_at TEXT,
        outcome_code TEXT,
        result_request_sha256 TEXT,
        UNIQUE (run_id, step_id, attempt_number),
        FOREIGN KEY (run_id, step_id)
          REFERENCES run_steps (run_id, step_id) ON DELETE CASCADE
      );

      CREATE INDEX step_attempts_operation
        ON step_attempts (operation_id, attempt_number DESC);
      CREATE INDEX step_attempts_recovery
        ON step_attempts (status, run_id);

      CREATE TABLE evidence_records (
        evidence_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        observed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES release_runs (run_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, step_id)
          REFERENCES run_steps (run_id, step_id) ON DELETE CASCADE
      );

      CREATE INDEX evidence_by_run ON evidence_records (run_id, recorded_at);

      CREATE TABLE run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES release_runs (run_id) ON DELETE CASCADE
      );

      CREATE TABLE audit_log (
        audit_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE (run_id, event_seq),
        FOREIGN KEY (run_id, event_seq)
          REFERENCES run_events (run_id, seq) ON DELETE CASCADE
      );

      CREATE TABLE health_gate_decisions (
        decision_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
        outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
        created_at TEXT NOT NULL,
        UNIQUE (run_id, gate_id),
        UNIQUE (run_id, idempotency_key),
        FOREIGN KEY (run_id, gate_id)
          REFERENCES run_health_gates (run_id, gate_id) ON DELETE CASCADE
      );

      CREATE TABLE operation_reconciliations (
        reconciliation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
        outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'not_applied', 'still_unknown')),
        created_at TEXT NOT NULL,
        UNIQUE (run_id, idempotency_key),
        FOREIGN KEY (run_id, step_id)
          REFERENCES run_steps (run_id, step_id) ON DELETE CASCADE
      );

      CREATE TRIGGER workflow_blueprints_no_update
        BEFORE UPDATE ON workflow_blueprints
        BEGIN SELECT RAISE(ABORT, 'workflow_blueprints_are_immutable'); END;
      CREATE TRIGGER workflow_blueprints_no_delete
        BEFORE DELETE ON workflow_blueprints
        BEGIN SELECT RAISE(ABORT, 'workflow_blueprints_are_immutable'); END;
      CREATE TRIGGER run_events_no_update
        BEFORE UPDATE ON run_events
        BEGIN SELECT RAISE(ABORT, 'run_events_are_append_only'); END;
      CREATE TRIGGER run_events_no_delete
        BEFORE DELETE ON run_events
        BEGIN SELECT RAISE(ABORT, 'run_events_are_append_only'); END;
      CREATE TRIGGER audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log_is_append_only'); END;
      CREATE TRIGGER audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log_is_append_only'); END;
      CREATE TRIGGER evidence_records_no_update
        BEFORE UPDATE ON evidence_records
        BEGIN SELECT RAISE(ABORT, 'evidence_records_are_immutable'); END;
      CREATE TRIGGER evidence_records_no_delete
        BEFORE DELETE ON evidence_records
        BEGIN SELECT RAISE(ABORT, 'evidence_records_are_immutable'); END;
      CREATE TRIGGER health_gate_decisions_no_update
        BEFORE UPDATE ON health_gate_decisions
        BEGIN SELECT RAISE(ABORT, 'health_gate_decisions_are_immutable'); END;
      CREATE TRIGGER health_gate_decisions_no_delete
        BEFORE DELETE ON health_gate_decisions
        BEGIN SELECT RAISE(ABORT, 'health_gate_decisions_are_immutable'); END;
      CREATE TRIGGER operation_reconciliations_no_update
        BEFORE UPDATE ON operation_reconciliations
        BEGIN SELECT RAISE(ABORT, 'operation_reconciliations_are_immutable'); END;
      CREATE TRIGGER operation_reconciliations_no_delete
        BEFORE DELETE ON operation_reconciliations
        BEGIN SELECT RAISE(ABORT, 'operation_reconciliations_are_immutable'); END;
    `,
  },
];
