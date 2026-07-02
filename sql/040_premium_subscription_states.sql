-- Extend premium_status for Google Play subscription lifecycle states.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_premium_status_check;

ALTER TABLE users
  ADD CONSTRAINT users_premium_status_check
  CHECK (
    premium_status IN (
      'INACTIVE',
      'ACTIVE',
      'EXPIRED',
      'GRACE_PERIOD',
      'ON_HOLD',
      'PAUSED',
      'CANCELLED'
    )
  );

COMMENT ON COLUMN users.premium_status IS
  'Mirrors store subscription access: ACTIVE/GRACE/CANCELLED may grant access until premium_expires_at; ON_HOLD/PAUSED/EXPIRED/INACTIVE do not.';
