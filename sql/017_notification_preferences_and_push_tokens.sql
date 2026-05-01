-- 017_notification_preferences_and_push_tokens.sql
-- Stores per-user notification toggles + device push tokens (FCM).

BEGIN;

CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_friend_request_received BOOLEAN NOT NULL DEFAULT TRUE,
    push_friend_request_accepted BOOLEAN NOT NULL DEFAULT TRUE,
    push_chat_dm BOOLEAN NOT NULL DEFAULT TRUE,
    push_comment BOOLEAN NOT NULL DEFAULT TRUE,
    inapp_friend_request_received BOOLEAN NOT NULL DEFAULT TRUE,
    inapp_friend_request_accepted BOOLEAN NOT NULL DEFAULT TRUE,
    inapp_comment BOOLEAN NOT NULL DEFAULT TRUE,
    inapp_chat_dm BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One user can have multiple devices; tokens rotate, so keep history and allow revocation.
CREATE TABLE IF NOT EXISTS user_push_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'ANDROID',
    device_id TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_push_tokens_user_token
    ON user_push_tokens (user_id, token);

CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_active_seen
    ON user_push_tokens (user_id, is_active, last_seen_at DESC);

COMMIT;

