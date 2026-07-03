BEGIN;

ALTER TABLE user_comment_wallet
  ADD COLUMN IF NOT EXISTS last_comment_grant_at TIMESTAMPTZ;

ALTER TABLE user_boost_wallet
  ADD COLUMN IF NOT EXISTS last_boost_grant_at TIMESTAMPTZ;

-- Comment grants: start IST day gate from deploy (no retroactive top-ups).
UPDATE user_comment_wallet
SET last_comment_grant_at = NOW()
WHERE last_comment_grant_at IS NULL;

-- Boost grants: leave last_boost_grant_at NULL so first sync uses subscription anchor week math.

COMMIT;
