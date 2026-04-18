-- Track which moderation warnings the user has acknowledged in-app (full-screen overlay).
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS moderation_warnings_acknowledged SMALLINT NOT NULL DEFAULT 0
        CHECK (moderation_warnings_acknowledged >= 0);

COMMENT ON COLUMN users.moderation_warnings_acknowledged IS
    'Increments alongside moderation_warning_count are shown until POST /users/me/moderation-warning-ack sets this equal to moderation_warning_count.';
