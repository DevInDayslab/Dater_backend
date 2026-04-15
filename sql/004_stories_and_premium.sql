-- =========================================================
-- DATABASE FLOW 4: REAL-TIME, STORIES, & PREMIUM
-- =========================================================

-- ---------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'story_media_type_enum') THEN
        CREATE TYPE story_media_type_enum AS ENUM ('IMAGE', 'VIDEO');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'story_interaction_type_enum') THEN
        CREATE TYPE story_interaction_type_enum AS ENUM ('VIEW', 'LIKE', 'COMMENT');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_item_type_enum') THEN
        CREATE TYPE purchase_item_type_enum AS ENUM ('UNLOCK_CHAT', 'BOOST', 'SUBSCRIPTION');
    END IF;
END $$;

-- ---------------------------------------------------------
-- stories
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_url TEXT NOT NULL,
    media_type story_media_type_enum NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    deleted_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);

-- Active story retrieval and cleanup performance
CREATE INDEX IF NOT EXISTS idx_stories_expires_at
    ON stories (expires_at);

CREATE INDEX IF NOT EXISTS idx_stories_user_created_at_desc
    ON stories (user_id, created_at DESC);

-- ---------------------------------------------------------
-- story_interactions (Hierarchy: VIEW / LIKE / COMMENT)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interaction_type story_interaction_type_enum NOT NULL,
    comment_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (actor_user_id <> story_owner_id),
    CHECK (
        (interaction_type = 'COMMENT' AND comment_text IS NOT NULL AND length(trim(comment_text)) > 0)
        OR (interaction_type <> 'COMMENT' AND comment_text IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_story_interactions_story_type_created_at
    ON story_interactions (story_id, interaction_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_story_interactions_owner_created_at
    ON story_interactions (story_owner_id, created_at DESC);

-- Prevent duplicate VIEW rows from same actor for same story
CREATE UNIQUE INDEX IF NOT EXISTS uq_story_interactions_single_view
    ON story_interactions (story_id, actor_user_id)
    WHERE interaction_type = 'VIEW';

-- Prevent duplicate LIKE rows from same actor for same story
CREATE UNIQUE INDEX IF NOT EXISTS uq_story_interactions_single_like
    ON story_interactions (story_id, actor_user_id)
    WHERE interaction_type = 'LIKE';

-- ---------------------------------------------------------
-- story_replies
-- Reply to story (friends-only rule enforced in service layer)
-- Stored as a chat-linked reference event similar to Instagram.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    replier_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reply_text TEXT NOT NULL,
    -- This is populated after creating the corresponding chat message row
    -- in the chat module migration/implementation.
    chat_message_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (replier_user_id <> story_owner_id),
    CHECK (length(trim(reply_text)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_story_replies_story_owner_created_at
    ON story_replies (story_owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_story_replies_replier_owner
    ON story_replies (replier_user_id, story_owner_id, created_at DESC);

-- ---------------------------------------------------------
-- chat_restrictions (male throttler / unlock / cooldown)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_restrictions (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_count SMALLINT NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    is_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
    cooldown_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, target_id),
    CHECK (user_id <> target_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_restrictions_cooldown_until
    ON chat_restrictions (cooldown_until);

-- ---------------------------------------------------------
-- premium_boosts
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS premium_boosts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > started_at)
);

-- Feed should check active boosts quickly
CREATE INDEX IF NOT EXISTS idx_premium_boosts_user_expires_at
    ON premium_boosts (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_premium_boosts_active_window
    ON premium_boosts (started_at, expires_at);

-- ---------------------------------------------------------
-- user_purchases
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type purchase_item_type_enum NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    transaction_id VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_purchases_user_created_at_desc
    ON user_purchases (user_id, created_at DESC);
