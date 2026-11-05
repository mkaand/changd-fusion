-- A durable deployment barrier is deliberately separate from browser leases.
-- It remains closed across API/Worker restarts and updater interruption until
-- the exact owner proves a successful transition or an operator performs a
-- separately verified recovery.
CREATE TABLE IF NOT EXISTS fusion_maintenance (
  id integer PRIMARY KEY CHECK (id=1),
  project text NOT NULL CHECK (project ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  operation_id uuid NOT NULL UNIQUE,
  source_sha char(40) NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  owner_token_hash char(64) NOT NULL CHECK (owner_token_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('draining','drained','deploying','recovery_required')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  drained_at timestamptz,
  evidence_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  failure_code text,
  CHECK ((state IN ('draining','recovery_required')) OR (drained_at IS NOT NULL AND evidence_expires_at IS NOT NULL))
);

-- Active application work is explicit rather than inferred from process
-- health. A lost owner leaves a conservative record for manual recovery.
CREATE TABLE IF NOT EXISTS fusion_runtime_operations (
  id uuid PRIMARY KEY,
  owner_token_hash char(64) NOT NULL CHECK (owner_token_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('scheduled_capture','manual_check','preview')),
  started_at timestamptz NOT NULL DEFAULT now()
);
