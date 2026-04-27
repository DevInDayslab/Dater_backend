-- Keep deletion audit rows for retention even after hard-deleting users.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'user_account_deletion_audit'
          AND column_name = 'user_id'
          AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE user_account_deletion_audit
            ALTER COLUMN user_id DROP NOT NULL;
    END IF;
END $$;

DO $$
DECLARE
    fk_name text;
BEGIN
    SELECT conname
      INTO fk_name
      FROM pg_constraint
     WHERE conrelid = 'user_account_deletion_audit'::regclass
       AND contype = 'f'
       AND conname = 'user_account_deletion_audit_user_id_fkey'
     LIMIT 1;

    IF fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE user_account_deletion_audit DROP CONSTRAINT %I', fk_name);
    END IF;
END $$;

COMMENT ON TABLE user_account_deletion_audit IS
'Deletion retention log (6 months). Rows persist after hard-deleting the original users row.';
