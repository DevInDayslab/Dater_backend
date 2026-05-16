-- Optional client font slug for story text (text-only / overlay); persisted for reel JSON and analytics.
-- Primary display remains the uploaded JPEG; clients may use this for future dynamic render or QA.

ALTER TABLE stories
    ADD COLUMN IF NOT EXISTS text_font_id VARCHAR(64);

COMMENT ON COLUMN stories.text_font_id IS 'Stable font slug from the posting client (e.g. font_poppins_medium).';
