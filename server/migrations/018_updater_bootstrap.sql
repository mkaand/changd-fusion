-- A marker written only by the explicit one-time bootstrap procedure. Merely
-- applying migration 017/018 does not prove that legacy API/Worker admission
-- was fenced during the first v0.3.2 -> v0.3.3 transition.
CREATE TABLE IF NOT EXISTS fusion_updater_bootstrap (
  id integer PRIMARY KEY CHECK (id=1),
  project text NOT NULL CHECK (project ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  source_sha char(40) NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
