-- =========================================================
-- DATABASE FLOW 6: COMPLIANCE, AUDIT, DAILY LIMITS
-- =========================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_action_type_enum') THEN
        CREATE TYPE moderation_action_type_enum AS ENUM (
            'WARNING_ISSUED',
            'STORY_REMOVED',
            'CONTENT_REMOVED',
            'PROFILE_HIDDEN',
            'BAN_ISSUED',
            'BAN_REVOKED',
            'REPORT_RESOLVED'
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_event_type_enum') THEN
        CREATE TYPE notification_event_type_enum AS ENUM (
            'REQUEST_SENT',
            'REQUEST_ACCEPTED',
            'REQUEST_COMMENT_SENT',
            'REQUEST_IGNORED_SILENT',
            'STORY_LIKED',
            'STORY_COMMENTED',
            'CHAT_MESSAGE'
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'profile_view_source_enum') THEN
        CREATE TYPE profile_view_source_enum AS ENUM (
            'FEED',
            'STORY',
            'STORY_ACTIVITY'
        );
    END IF;
END $$;

-- ---------------------------------------------------------
-- Daily profile view accounting (free-tier 20/day)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_daily_profile_view_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date DATE NOT NULL,
    profile_view_count INTEGER NOT NULL DEFAULT 0 CHECK (profile_view_count >= 0),
    last_view_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, usage_date)
);

CREATE TABLE IF NOT EXISTS profile_view_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    viewer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source profile_view_source_enum NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (viewer_user_id <> viewed_user_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_view_events_viewer_created_at
    ON profile_view_events (viewer_user_id, created_at DESC);

-- ---------------------------------------------------------
-- Support + moderation + legal/audit logs
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_support_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    subject VARCHAR(160) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customer_support_reports_status_created
    ON customer_support_reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS moderation_actions_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_admin_id UUID,
    action_type moderation_action_type_enum NOT NULL,
    reason TEXT,
    source_report_id UUID REFERENCES reports(id) ON DELETE SET NULL,
    related_story_id UUID REFERENCES stories(id) ON DELETE SET NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_target_created
    ON moderation_actions_log (target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS law_enforcement_disclosures_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    requested_by_agency VARCHAR(160) NOT NULL,
    request_reference VARCHAR(160),
    disclosed_data_summary TEXT NOT NULL,
    disclosed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    handled_by_admin_id UUID
);

-- ---------------------------------------------------------
-- Notification/inbox event audit
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type notification_event_type_enum NOT NULL,
    reference_id UUID,
    is_silent BOOLEAN NOT NULL DEFAULT FALSE,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_events_recipient_created
    ON notification_events (recipient_user_id, created_at DESC);
