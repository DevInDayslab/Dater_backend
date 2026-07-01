-- Base plan IDs for multi-plan subscriptions sharing one google_play_product_id.

ALTER TABLE product_configurations
    ADD COLUMN IF NOT EXISTS google_play_base_plan_id VARCHAR(64);

COMMENT ON COLUMN product_configurations.google_play_base_plan_id IS
    'Play subscription base plan ID when multiple plans share one google_play_product_id (e.g. week, month).';

-- Suggested SKU mapping (update in Play Console + DaterAdmin as needed).
UPDATE product_configurations SET
    google_play_product_id = 'dater_premium',
    google_play_base_plan_id = 'week'
WHERE pack_code = 'PREMIUM_WEEK' AND google_play_product_id IS NULL;

UPDATE product_configurations SET
    google_play_product_id = 'dater_premium',
    google_play_base_plan_id = 'month'
WHERE pack_code = 'PREMIUM_MONTH' AND google_play_product_id IS NULL;

UPDATE product_configurations SET
    google_play_product_id = 'dater_premium',
    google_play_base_plan_id = 'three-months'
WHERE pack_code = 'PREMIUM_THREE_MONTHS' AND google_play_product_id IS NULL;

UPDATE product_configurations SET google_play_product_id = 'boost_3'
WHERE pack_code = 'BOOST_3' AND google_play_product_id IS NULL;

UPDATE product_configurations SET google_play_product_id = 'boost_6'
WHERE pack_code = 'BOOST_6' AND google_play_product_id IS NULL;

UPDATE product_configurations SET google_play_product_id = 'boost_15'
WHERE pack_code = 'BOOST_15' AND google_play_product_id IS NULL;

UPDATE product_configurations SET google_play_product_id = 'comments_2'
WHERE pack_code = 'COMMENTS_2' AND google_play_product_id IS NULL;

UPDATE product_configurations SET google_play_product_id = 'comments_5'
WHERE pack_code = 'COMMENTS_5' AND google_play_product_id IS NULL;

UPDATE product_configurations SET google_play_product_id = 'comments_15'
WHERE pack_code = 'COMMENTS_15' AND google_play_product_id IS NULL;

UPDATE product_configurations SET google_play_product_id = 'chat_unlock_single'
WHERE pack_code = 'CHAT_UNLOCK_SINGLE' AND google_play_product_id IS NULL;
