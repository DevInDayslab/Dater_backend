-- Story visibility for home reel / viewer (matches client StoryAudience).
ALTER TABLE stories
    ADD COLUMN IF NOT EXISTS audience VARCHAR(32) NOT NULL DEFAULT 'EVERYONE';

ALTER TABLE stories
    DROP CONSTRAINT IF EXISTS chk_stories_audience;

ALTER TABLE stories
    ADD CONSTRAINT chk_stories_audience CHECK (audience IN ('EVERYONE', 'FRIENDS_ONLY'));

COMMENT ON COLUMN stories.audience IS 'EVERYONE: discoverable non-friends; FRIENDS_ONLY: friends only.';
