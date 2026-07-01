-- Cross-platform store billing ledger (Google Play today; App Store later).
-- purchase_token: Play purchase token or Apple transaction / original transaction id.

CREATE TABLE IF NOT EXISTS store_purchase_verifications (
    id               BIGSERIAL PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform         VARCHAR(16) NOT NULL CHECK (platform IN ('GOOGLE_PLAY', 'APP_STORE')),
    store_order_id   VARCHAR(128) NOT NULL,
    purchase_token   TEXT NOT NULL,
    store_product_id VARCHAR(128) NOT NULL,
    pack_code        VARCHAR(64) NOT NULL REFERENCES product_configurations(pack_code),
    purchase_type    VARCHAR(16) NOT NULL CHECK (purchase_type IN ('SUBSCRIPTION', 'INAPP')),
    store_state      VARCHAR(32) NOT NULL,
    acknowledged_at  TIMESTAMPTZ,
    consumed_at      TIMESTAMPTZ,
    user_purchase_id UUID REFERENCES user_purchases(id) ON DELETE SET NULL,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_store_purchase_verifications_platform_order UNIQUE (platform, store_order_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spv_platform_token_product
    ON store_purchase_verifications (platform, purchase_token, store_product_id);

CREATE INDEX IF NOT EXISTS idx_spv_user_id
    ON store_purchase_verifications (user_id);

CREATE TABLE IF NOT EXISTS store_subscriptions (
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform         VARCHAR(16) NOT NULL CHECK (platform IN ('GOOGLE_PLAY', 'APP_STORE')),
    store_product_id VARCHAR(128) NOT NULL,
    purchase_token   TEXT NOT NULL,
    latest_order_id  VARCHAR(128),
    expiry_time      TIMESTAMPTZ,
    auto_renewing    BOOLEAN,
    store_state      VARCHAR(32),
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, platform)
);

CREATE TABLE IF NOT EXISTS store_webhook_events (
    platform     VARCHAR(16) NOT NULL CHECK (platform IN ('GOOGLE_PLAY', 'APP_STORE')),
    message_id   VARCHAR(256) NOT NULL,
    event_type   VARCHAR(64) NOT NULL,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (platform, message_id)
);

COMMENT ON TABLE store_purchase_verifications IS
    'Idempotent ledger for mobile store purchase verification (Google Play, App Store).';
COMMENT ON TABLE store_subscriptions IS
    'Latest subscription mirror per user and store platform for renewals and reconcile.';
COMMENT ON TABLE store_webhook_events IS
    'Dedup store for store server notifications (Play RTDN, App Store Server Notifications).';
COMMENT ON COLUMN store_purchase_verifications.platform IS
    'GOOGLE_PLAY or APP_STORE — shared fulfillment path via billingVerification.service.';
COMMENT ON COLUMN store_purchase_verifications.purchase_token IS
    'Opaque store receipt identifier; never trusted without server-side store API verification.';
