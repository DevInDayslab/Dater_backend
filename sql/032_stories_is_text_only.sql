-- Solid-colour text status stories (no base photo); used by clients for full-bleed display.

ALTER TABLE stories
    ADD COLUMN IF NOT EXISTS is_text_only BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN stories.is_text_only IS 'True when the JPEG is a full-frame solid background + text (no photo base).';
