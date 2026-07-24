-- Seed App Store product IDs onto existing packs (Android Google Play IDs untouched).
-- Also add an additive pending chat-unlock wallet for orphaned StoreKit retries without threadId.

UPDATE product_configurations
SET apple_product_id = 'com.dater.boost.planone'
WHERE pack_code = 'BOOST_1'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.boost.planone');

UPDATE product_configurations
SET apple_product_id = 'com.dater.boost.plantwo'
WHERE pack_code = 'BOOST_2'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.boost.plantwo');

UPDATE product_configurations
SET apple_product_id = 'com.dater.boost.planthree'
WHERE pack_code = 'BOOST_3'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.boost.planthree');

UPDATE product_configurations
SET apple_product_id = 'com.dater.comment.planone'
WHERE pack_code = 'COMMENTS_1'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.comment.planone');

UPDATE product_configurations
SET apple_product_id = 'com.dater.comment.plantwo'
WHERE pack_code = 'COMMENTS_2'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.comment.plantwo');

UPDATE product_configurations
SET apple_product_id = 'com.dater.comment.planthree'
WHERE pack_code = 'COMMENTS_3'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.comment.planthree');

UPDATE product_configurations
SET apple_product_id = 'com.dater.premium.planone'
WHERE pack_code = 'PREMIUM_WEEK'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.premium.planone');

UPDATE product_configurations
SET apple_product_id = 'com.dater.premium.plantwo'
WHERE pack_code = 'PREMIUM_MONTH'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.premium.plantwo');

UPDATE product_configurations
SET apple_product_id = 'com.dater.premium.planthree'
WHERE pack_code = 'PREMIUM_THREE_MONTHS'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.premium.planthree');

UPDATE product_configurations
SET apple_product_id = 'com.dater.chat.unlock'
WHERE pack_code = 'CHAT_UNLOCK_SINGLE'
  AND (apple_product_id IS DISTINCT FROM 'com.dater.chat.unlock');

CREATE TABLE IF NOT EXISTS user_chat_unlock_wallet (
    user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    remaining_credits INT NOT NULL DEFAULT 0 CHECK (remaining_credits >= 0),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE user_chat_unlock_wallet IS
    'Pending chat-unlock credits (e.g. Apple StoreKit retry without threadId). Additive; Android unused.';
