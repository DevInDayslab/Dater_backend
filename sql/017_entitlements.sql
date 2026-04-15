ALTER TABLE users
    ADD COLUMN IF NOT EXISTS premium_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS premium_plan_code VARCHAR(32),
    ADD COLUMN IF NOT EXISTS premium_status VARCHAR(24) NOT NULL DEFAULT 'INACTIVE'
        CHECK (premium_status IN ('INACTIVE', 'ACTIVE', 'EXPIRED'));

ALTER TABLE user_purchases
    ADD COLUMN IF NOT EXISTS pack_code VARCHAR(40),
    ADD COLUMN IF NOT EXISTS quantity INTEGER,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS user_boost_wallet (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    remaining_credits INTEGER NOT NULL DEFAULT 0 CHECK (remaining_credits >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_boost_activations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activated_count INTEGER NOT NULL CHECK (activated_count > 0),
    started_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > started_at),
    purchase_id UUID REFERENCES user_purchases(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_boost_activations_active
    ON user_boost_activations (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS user_comment_wallet (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    remaining_paid_comments INTEGER NOT NULL DEFAULT 0 CHECK (remaining_paid_comments >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_comment_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_count INTEGER NOT NULL CHECK (used_count > 0),
    reason VARCHAR(40) NOT NULL DEFAULT 'COMMENT_REQUEST',
    purchase_id UUID REFERENCES user_purchases(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_comment_usage_user_created
    ON user_comment_usage (user_id, created_at DESC);

