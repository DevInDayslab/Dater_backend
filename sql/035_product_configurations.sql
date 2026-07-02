-- Product catalog for dynamic paywall pricing (admin-editable, mobile-synced).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'purchase_item_type_enum' AND e.enumlabel = 'COMMENTS'
    ) THEN
        ALTER TYPE purchase_item_type_enum ADD VALUE 'COMMENTS';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS product_configurations (
    pack_code              VARCHAR(64) PRIMARY KEY,
    category               VARCHAR(16) NOT NULL CHECK (category IN ('PREMIUM', 'BOOST', 'COMMENTS')),
    quantity               INT NOT NULL CHECK (quantity > 0),
    duration_days          INT CHECK (duration_days IS NULL OR duration_days > 0),
    plan_code              VARCHAR(32),
    display_title          VARCHAR(32) NOT NULL,
    display_label          VARCHAR(32) NOT NULL,
    price_paise            INT NOT NULL CHECK (price_paise > 0),
    currency               VARCHAR(3) NOT NULL DEFAULT 'INR',
    badge_type             VARCHAR(16) CHECK (badge_type IS NULL OR badge_type IN ('MOST_POPULAR', 'SAVE')),
    badge_text             VARCHAR(32),
    is_default             BOOLEAN NOT NULL DEFAULT FALSE,
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order             SMALLINT NOT NULL,
    google_play_product_id VARCHAR(128),
    apple_product_id       VARCHAR(128),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_configurations_category_sort
    ON product_configurations (category, sort_order);

INSERT INTO product_configurations (
    pack_code, category, quantity, duration_days, plan_code,
    display_title, display_label, price_paise, badge_type, badge_text,
    is_default, is_active, sort_order
) VALUES
    ('PREMIUM_WEEK', 'PREMIUM', 1, 7, 'WEEK', '1', 'Week', 49900, NULL, NULL, TRUE, TRUE, 1),
    ('PREMIUM_MONTH', 'PREMIUM', 1, 30, 'MONTH', '1', 'Month', 99900, 'MOST_POPULAR', NULL, FALSE, TRUE, 2),
    ('PREMIUM_THREE_MONTHS', 'PREMIUM', 1, 90, 'THREE_MONTHS', '3', 'Months', 219900, 'SAVE', 'Save 25%', FALSE, TRUE, 3),
    ('BOOST_1', 'BOOST', 3, NULL, NULL, '3', 'Boosts', 19900, NULL, NULL, FALSE, TRUE, 1),
    ('BOOST_2', 'BOOST', 6, NULL, NULL, '6', 'Boosts', 54900, 'MOST_POPULAR', NULL, TRUE, TRUE, 2),
    ('BOOST_3', 'BOOST', 15, NULL, NULL, '15', 'Boosts', 119900, 'SAVE', 'Save 25%', FALSE, TRUE, 3),
    ('COMMENTS_1', 'COMMENTS', 2, NULL, NULL, '2', 'Comments', 19900, NULL, NULL, FALSE, TRUE, 1),
    ('COMMENTS_2', 'COMMENTS', 5, NULL, NULL, '5', 'Comments', 44900, 'MOST_POPULAR', NULL, TRUE, TRUE, 2),
    ('COMMENTS_3', 'COMMENTS', 15, NULL, NULL, '15', 'Comments', 119900, 'SAVE', 'Save 25%', FALSE, TRUE, 3)
ON CONFLICT (pack_code) DO NOTHING;

COMMENT ON TABLE product_configurations IS 'Admin-editable monetization catalog consumed by mobile paywalls.';
