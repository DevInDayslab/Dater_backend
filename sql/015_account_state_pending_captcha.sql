-- Login flow: issued JWT before captcha is solved (app can resume Captcha screen after restart).

DO $$
BEGIN
  ALTER TYPE account_state_enum ADD VALUE 'PENDING_CAPTCHA';
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;
