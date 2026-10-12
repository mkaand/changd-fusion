-- Delivery direction never changes stored history or baseline progression.
ALTER TABLE fusion_monitors
  ADD COLUMN text_direction text NOT NULL DEFAULT 'both'
    CHECK (text_direction IN ('added','removed','both')),
  ADD COLUMN text_source text NOT NULL DEFAULT 'direct'
    CHECK (text_source IN ('direct','jina'));
