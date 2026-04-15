-- =========================================================
-- DATABASE FLOW 5: CHAT, RELATION STATES, ACCOUNT STATES
-- =========================================================

-- ---------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_thread_type_enum') THEN
        CREATE TYPE chat_thread_type_enum AS ENUM ('DIRECT', 'ADMIN_DM');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_sender_type_enum') THEN
        CREATE TYPE chat_sender_type_enum AS ENUM ('USER', 'ADMIN_SYSTEM');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_message_type_enum') THEN
        CREATE TYPE chat_message_type_enum AS ENUM ('TEXT', 'STORY_REPLY_REFERENCE', 'SYSTEM');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_relationship_state_enum') THEN
        CREATE TYPE chat_relationship_state_enum AS ENUM (
            'ACTIVE',
            'CHAT_ENDED',
            'DELETED_ACCOUNT',
            'BLOCKED'
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_state_enum') THEN
        CREATE TYPE account_state_enum AS ENUM (
            'ACTIVE',
            'PAUSED',
            'PRIVACY_MODE',
            'HIDDEN_BY_MODERATION',
            'DELETED',
            'BANNED',
            'UNDERAGE_BLOCKED'
        );
    END IF;
END $$;

-- ---------------------------------------------------------
-- User account/visibility states
-- ---------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS account_state account_state_enum NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN IF NOT EXISTS privacy_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS profile_hidden_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS underage_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS new_here_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS moderation_warning_count SMALLINT NOT NULL DEFAULT 0 CHECK (moderation_warning_count >= 0),
    ADD COLUMN IF NOT EXISTS moderation_consecutive_warning_count SMALLINT NOT NULL DEFAULT 0 CHECK (moderation_consecutive_warning_count >= 0);

CREATE INDEX IF NOT EXISTS idx_users_account_state ON users (account_state);
CREATE INDEX IF NOT EXISTS idx_users_new_here_until ON users (new_here_until);

-- ---------------------------------------------------------
-- chat_threads
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_type chat_thread_type_enum NOT NULL DEFAULT 'DIRECT',
    created_from_interaction_id UUID REFERENCES user_interactions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_last_message_at_desc
    ON chat_threads (last_message_at DESC);

-- ---------------------------------------------------------
-- chat_thread_participants
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_thread_participants (
    thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_thread_participants_user
    ON chat_thread_participants (user_id, thread_id);

-- ---------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    sender_type chat_sender_type_enum NOT NULL DEFAULT 'USER',
    sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    message_type chat_message_type_enum NOT NULL DEFAULT 'TEXT',
    message_text TEXT,
    referenced_story_id UUID REFERENCES stories(id) ON DELETE SET NULL,
    referenced_story_reply_id UUID REFERENCES story_replies(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    CHECK (
        (message_type = 'TEXT' AND message_text IS NOT NULL AND length(trim(message_text)) > 0)
        OR (message_type <> 'TEXT')
    )
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created_at
    ON chat_messages (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_created_at
    ON chat_messages (sender_user_id, created_at DESC);

-- ---------------------------------------------------------
-- chat_user_pair_preferences (mute persistence across recreates)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_user_pair_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    muted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, target_id),
    CHECK (user_id <> target_id)
);

-- ---------------------------------------------------------
-- chat_thread_user_state
-- Stores per-user UI/behavior state for a thread
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_thread_user_state (
    thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- inbox + unread + sorting support
    last_read_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    unread_count_cache INTEGER NOT NULL DEFAULT 0 CHECK (unread_count_cache >= 0),
    has_reply_badge BOOLEAN NOT NULL DEFAULT FALSE,
    last_inbound_message_at TIMESTAMPTZ,
    last_outbound_message_at TIMESTAMPTZ,

    -- local delete (visual only; DB retention remains)
    is_deleted_from_inbox BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_from_inbox_at TIMESTAMPTZ,

    -- relation-driven state for this user
    relationship_state chat_relationship_state_enum NOT NULL DEFAULT 'ACTIVE',
    relationship_state_set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    relationship_state_expires_at TIMESTAMPTZ,
    can_report BOOLEAN NOT NULL DEFAULT TRUE,
    can_view_profile BOOLEAN NOT NULL DEFAULT TRUE,

    -- push to bottom grouping for ended/deleted states
    pinned_to_bottom BOOLEAN NOT NULL DEFAULT FALSE,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_thread_user_state_user_sort
    ON chat_thread_user_state (user_id, pinned_to_bottom, last_inbound_message_at DESC, last_outbound_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_thread_user_state_relationship_expiry
    ON chat_thread_user_state (relationship_state, relationship_state_expires_at);

-- ---------------------------------------------------------
-- chat_unlock_events
-- Rs99 per-chat unlock audit trail
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_unlock_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purchase_id UUID REFERENCES user_purchases(id) ON DELETE SET NULL,
    unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (user_id <> target_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_unlock_events_user_target
    ON chat_unlock_events (user_id, target_id, unlocked_at DESC);

-- ---------------------------------------------------------
-- Performance helpers for search/sort
-- ---------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_chat_messages_text_search_hint
    ON chat_messages (thread_id, deleted_at, created_at DESC);
