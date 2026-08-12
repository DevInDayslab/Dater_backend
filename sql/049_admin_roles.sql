-- Admin roles: FULL (DaterAdmin) vs SEO (DaterSeoAdmin).
-- Only one SEO admin account is allowed.

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'FULL'
    CHECK (role IN ('FULL', 'SEO'));

UPDATE admin_users SET role = 'FULL' WHERE role IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_one_seo
  ON admin_users ((role)) WHERE role = 'SEO';
