-- factory_telemetry schema — KI-E385
-- PostgreSQL + pgvector (pgvector/pgvector:0.8.3-pg16, already enabled).
-- Accessed from orchestrate.mjs via: kubectl -n <your-namespace> exec postgres-0 -- psql -U postgres -d factory_telemetry
--
-- To run:  kubectl -n <your-namespace> exec -i postgres-0 -- psql -U postgres -d factory_telemetry < factory-pg-schema.sql
--          or: scripts/factory-pg-setup.sh

-- ── Per-batch run metrics ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS factory_runs (
  id              BIGSERIAL PRIMARY KEY,
  run_id          TEXT UNIQUE NOT NULL,     -- orchestrator run UUID
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Batch identity
  cycle           INTEGER,
  max_lanes       INTEGER,
  backend         TEXT,                     -- 'claude-headless' | 'opencode' | …

  -- Item outcome counts
  dispatched      INTEGER NOT NULL DEFAULT 0,
  closed          INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  escalated       INTEGER NOT NULL DEFAULT 0,
  partial         INTEGER NOT NULL DEFAULT 0,  -- folded but incomplete

  -- Token metrics (from runs.jsonl / KI-E379)
  tokens_total    BIGINT,
  tokens_input    BIGINT,
  tokens_output   BIGINT,
  tokens_cache    BIGINT,

  -- Throughput ratios (computed, stored for fast query)
  close_rate      NUMERIC(6,4),             -- closed / dispatched
  failure_rate    NUMERIC(6,4),             -- (failed+escalated) / dispatched
  tokens_per_close NUMERIC(14,2),           -- tokens_total / closed  (NULL if closed=0)

  -- Post-batch failure analysis results
  direct_fixes    INTEGER NOT NULL DEFAULT 0,
  proposals_gen   INTEGER NOT NULL DEFAULT 0,
  proposals_skip  INTEGER NOT NULL DEFAULT 0,

  -- Failure pattern breakdown { patternKey: count }
  failure_patterns JSONB,

  -- Gate verdicts aggregated { gate: {pass, fail} }
  gate_verdicts   JSONB,

  -- Full factory config snapshot at time of run (for hill climbing correlation)
  factory_config  JSONB,

  -- Run summary text for embedding (built by orchestrate.mjs)
  summary_text    TEXT,
  -- 384-dim embedding of summary_text via BAAI/bge-small-en-v1.5
  summary_vec     vector(384)
);

CREATE INDEX IF NOT EXISTS factory_runs_cycle_idx ON factory_runs (cycle DESC);
CREATE INDEX IF NOT EXISTS factory_runs_recorded_at_idx ON factory_runs (recorded_at DESC);
-- Approximate nearest-neighbour index for similarity queries (IVFFlat, nlist tuned for small tables)
CREATE INDEX IF NOT EXISTS factory_runs_vec_idx ON factory_runs
  USING ivfflat (summary_vec vector_cosine_ops)
  WITH (lists = 20);

-- ── Per-item per-run detail ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS factory_item_runs (
  id              BIGSERIAL PRIMARY KEY,
  run_id          TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- State transition
  from_state      TEXT,
  to_state        TEXT NOT NULL,
  attempt_number  INTEGER,

  -- Outcome details
  decisive_gate   TEXT,
  override_reason TEXT,
  failure_class   TEXT,    -- classified by classifyFixableError (phantom-manifest, build-error …)

  -- Tokens (from runs.jsonl tokensUsed)
  tokens_used     BIGINT,

  -- All gate verdicts { gate: verdict }
  gate_verdicts   JSONB,

  -- Free-form note from fold result
  note_text       TEXT,
  -- 384-dim embedding of note_text + failure_text concatenated
  note_vec        vector(384),

  FOREIGN KEY (run_id) REFERENCES factory_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS factory_item_runs_run_idx   ON factory_item_runs (run_id);
CREATE INDEX IF NOT EXISTS factory_item_runs_item_idx  ON factory_item_runs (item_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS factory_item_runs_state_idx ON factory_item_runs (to_state, recorded_at DESC);
CREATE INDEX IF NOT EXISTS factory_item_runs_vec_idx   ON factory_item_runs
  USING ivfflat (note_vec vector_cosine_ops)
  WITH (lists = 20);

-- ── Hill climbing state ───────────────────────────────────────────────────────────────────────────
-- Tracks which factory parameter values were in effect over time and the measured outcomes.
-- The hill climber reads this table to recommend the next parameter nudge.
CREATE TABLE IF NOT EXISTS factory_hill_state (
  id              BIGSERIAL PRIMARY KEY,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Run window this row summarises
  from_run_id     TEXT,
  to_run_id       TEXT,
  window_runs     INTEGER,          -- number of runs in the window

  -- Parameter being tracked
  param_name      TEXT NOT NULL,    -- 'max_lanes' | 'backend' | 'model_tier' | …
  param_value     JSONB NOT NULL,   -- the actual value during the window

  -- Measured outcomes over the window
  avg_close_rate  NUMERIC(6,4),
  avg_failure_rate NUMERIC(6,4),
  avg_tpc         NUMERIC(14,2),    -- average tokens per close
  total_closed    INTEGER,
  total_tokens    BIGINT,

  -- Composite fitness score (higher = better)
  -- fitness = close_rate * (baseline_tpc / avg_tpc) normalised 0–1
  fitness         NUMERIC(8,6),

  -- Suggested next step
  suggestion      TEXT,
  suggestion_dir  SMALLINT          -- +1 increase / -1 decrease / 0 neutral
);

CREATE INDEX IF NOT EXISTS factory_hill_state_param_idx ON factory_hill_state (param_name, recorded_at DESC);

-- ── Improvement outcome tracking ─────────────────────────────────────────────────────────────────
-- Links postBatchFailureAnalysis proposals to their outcomes, measuring effectiveness.
CREATE TABLE IF NOT EXISTS factory_improvement_outcomes (
  id              BIGSERIAL PRIMARY KEY,
  ki_id           TEXT NOT NULL,          -- KI-E* improvement item id
  pattern_key     TEXT NOT NULL,
  failure_class   TEXT,
  proposed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,

  -- Failure counts from runs before/after
  failures_before INTEGER,
  failures_after  INTEGER,
  window_runs     INTEGER,

  -- Effectiveness: 1.0 = fully eliminated, 0.0 = no change, negative = got worse
  effectiveness   NUMERIC(5,3)
);

CREATE INDEX IF NOT EXISTS factory_improvement_outcomes_ki_idx ON factory_improvement_outcomes (ki_id);
CREATE INDEX IF NOT EXISTS factory_improvement_outcomes_pattern_idx ON factory_improvement_outcomes (pattern_key, proposed_at DESC);
