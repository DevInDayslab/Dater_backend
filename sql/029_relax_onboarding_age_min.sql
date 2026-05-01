-- 029_relax_onboarding_age_min.sql
-- Onboarding now supports minimum age 2 (UI allows 2..80).

BEGIN;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_age_years_check;

-- Keep upper bound broad for backward compatibility with any historical rows.
ALTER TABLE users
  ADD CONSTRAINT users_age_years_check CHECK (age_years BETWEEN 2 AND 100);

COMMIT;

