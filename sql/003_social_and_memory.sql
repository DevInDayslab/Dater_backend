-- =========================================================
-- DATABASE FLOW 3: SOCIAL GRAPH & MEMORY ENGINE
-- Sections aligned with architecture:
-- - Feed Algorithm exclusions + 30-day soft hide memory
-- - Social graph interactions, friendships, blocks, reports
-- =========================================================

-- ---------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'interaction_type_enum') THEN
        CREATE TYPE interaction_type_enum AS ENUM ('REQUEST', 'COMMENT_REQUEST', 'IGNORE', 'VIEWED');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'request_status_enum') THEN
        CREATE TYPE request_status_enum AS ENUM ('PENDING', 'ACCEPTED', 'IGNORED');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_content_type_enum') THEN
        CREATE TYPE report_content_type_enum AS ENUM ('PROFILE', 'STORY', 'CHAT');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status_enum') THEN
        CREATE TYPE report_status_enum AS ENUM ('PENDING', 'RESOLVED');
    END IF;
END $$;

-- ---------------------------------------------------------
-- user_interactions
-- Tracks Request / Comment Request / Ignore / Viewed
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interaction_type interaction_type_enum NOT NULL,
    comment_text TEXT,
    request_status request_status_enum,
    request_acted_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (user_id <> target_id),
    CHECK (
        (interaction_type = 'COMMENT_REQUEST' AND comment_text IS NOT NULL AND length(trim(comment_text)) > 0)
        OR (interaction_type <> 'COMMENT_REQUEST' AND comment_text IS NULL)
    ),
    CHECK (
        (interaction_type IN ('REQUEST', 'COMMENT_REQUEST') AND request_status IS NOT NULL)
        OR (interaction_type IN ('IGNORE', 'VIEWED') AND request_status IS NULL)
    ),
    CHECK (
        (
            interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
            AND request_status = 'PENDING'
            AND request_acted_at IS NULL
        )
        OR (
            interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
            AND request_status IN ('ACCEPTED', 'IGNORED')
            AND request_acted_at IS NOT NULL
        )
        OR interaction_type IN ('IGNORE', 'VIEWED')
    )
);

-- Auto set/clear expires_at based on interaction type.
-- Ignore / Viewed => NOW + 30 days (feed hide memory)
-- Request types     => NULL
CREATE OR REPLACE FUNCTION set_interaction_expiry_30d()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.interaction_type IN ('IGNORE', 'VIEWED') THEN
        NEW.expires_at := NOW() + INTERVAL '30 days';
    ELSE
        NEW.expires_at := NULL;
    END IF;

    IF NEW.interaction_type IN ('REQUEST', 'COMMENT_REQUEST') THEN
        NEW.request_status := COALESCE(NEW.request_status, 'PENDING'::request_status_enum);
    ELSE
        NEW.request_status := NULL;
        NEW.request_acted_at := NULL;
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_interaction_expiry_30d ON user_interactions;
CREATE TRIGGER trg_set_interaction_expiry_30d
BEFORE INSERT OR UPDATE ON user_interactions
FOR EACH ROW
EXECUTE FUNCTION set_interaction_expiry_30d();

-- ---------------------------------------------------------
-- friendships
-- Consistency rule: u1_id is always smaller UUID than u2_id
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS friendships (
    u1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    u2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (u1_id, u2_id),
    CHECK (u1_id <> u2_id),
    CHECK (u1_id < u2_id)
);

-- ---------------------------------------------------------
-- blocks (permanent exclusion)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocks (
    blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);

-- ---------------------------------------------------------
-- reports
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_type report_content_type_enum NOT NULL,
    reason TEXT NOT NULL,
    status report_status_enum NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    CHECK (reporter_id <> reported_id)
);

-- ---------------------------------------------------------
-- PERFORMANCE INDEXING (feed-critical)
-- ---------------------------------------------------------
-- Required composite index for fast "already interacted with target?" checks
CREATE INDEX IF NOT EXISTS idx_user_interactions_user_target
    ON user_interactions (user_id, target_id);

-- Required cleanup-worker index for expiry scans
CREATE INDEX IF NOT EXISTS idx_user_interactions_expires_at
    ON user_interactions (expires_at);

-- Practical feed helper: quickly fetch active 30-day hides by user
CREATE INDEX IF NOT EXISTS idx_user_interactions_user_expires_at
    ON user_interactions (user_id, expires_at)
    WHERE interaction_type IN ('IGNORE', 'VIEWED');

-- One active friend request per direction at a time.
-- Prevents both REQUEST and COMMENT_REQUEST from being simultaneously pending.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_interactions_pending_request_pair
    ON user_interactions (user_id, target_id)
    WHERE interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
      AND request_status = 'PENDING';

-- Fast exclusion checks for silently ignored requests in feed.
CREATE INDEX IF NOT EXISTS idx_user_interactions_ignored_request_pair
    ON user_interactions (user_id, target_id)
    WHERE interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
      AND request_status = 'IGNORED';

-- Social graph lookup helpers
CREATE INDEX IF NOT EXISTS idx_friendships_u2_u1
    ON friendships (u2_id, u1_id);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked_id
    ON blocks (blocked_id);

CREATE INDEX IF NOT EXISTS idx_reports_status_created_at
    ON reports (status, created_at DESC);
