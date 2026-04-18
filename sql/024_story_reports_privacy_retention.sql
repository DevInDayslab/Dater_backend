-- Story reports (links to stories), privacy-mode ghost views, retention for S3, activity read cursor.

ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS story_id UUID REFERENCES stories(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reports_story_reporter
    ON reports (story_id, reporter_id)
    WHERE story_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_story_id_created
    ON reports (story_id, created_at DESC)
    WHERE story_id IS NOT NULL;

ALTER TABLE story_interactions
    ADD COLUMN IF NOT EXISTS show_in_activity_list BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN story_interactions.show_in_activity_list IS
    'When false (e.g. privacy-mode viewer VIEW), still counts toward view totals but is hidden from owner activity list.';

ALTER TABLE stories
    ADD COLUMN IF NOT EXISTS media_purge_after TIMESTAMPTZ;

COMMENT ON COLUMN stories.media_purge_after IS
    'After soft delete, S3 object may be hard-deleted once this time is reached (e.g. NOW()+6 months).';

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS story_activity_seen_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z';

COMMENT ON COLUMN users.story_activity_seen_at IS
    'Story interactions at or before this time do not count toward the notifications-tab story-activity badge.';
