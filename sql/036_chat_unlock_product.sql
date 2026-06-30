-- Dynamic chat unlock product (admin-editable, mobile-synced).

ALTER TABLE product_configurations
    ADD COLUMN IF NOT EXISTS compare_at_price_paise INT
        CHECK (compare_at_price_paise IS NULL OR compare_at_price_paise > 0);

ALTER TABLE product_configurations
    DROP CONSTRAINT IF EXISTS product_configurations_category_check;

ALTER TABLE product_configurations
    ADD CONSTRAINT product_configurations_category_check
        CHECK (category IN ('PREMIUM', 'BOOST', 'COMMENTS', 'CHAT'));

INSERT INTO product_configurations (
    pack_code, category, quantity, duration_days, plan_code,
    display_title, display_label, price_paise, compare_at_price_paise,
    badge_type, badge_text, is_default, is_active, sort_order
) VALUES (
    'CHAT_UNLOCK_SINGLE', 'CHAT', 1, NULL, NULL,
    '1', 'Chat', 9900, 14900,
    NULL, NULL, TRUE, TRUE, 1
) ON CONFLICT (pack_code) DO NOTHING;

COMMENT ON COLUMN product_configurations.compare_at_price_paise IS
    'Optional strikethrough / compare-at price for chat unlock and similar single-SKU offers.';
