-- Rename consumable pack codes to tiered BOOST_1/2/3 and COMMENTS_1/2/3;
-- wire google_play_product_id to Play Console SKUs.
-- Idempotent: migrate.js re-runs every file; 035 may re-seed legacy pack codes after a prior 042 run.

DO $$
BEGIN
    -- Remove legacy rows re-inserted by 035 when new tier codes already exist.
    IF EXISTS (SELECT 1 FROM product_configurations WHERE pack_code = 'BOOST_1') THEN
        DELETE FROM product_configurations
        WHERE pack_code IN ('BOOST_6', 'BOOST_15');

        DELETE FROM product_configurations
        WHERE pack_code = 'BOOST_3'
          AND quantity = 3
          AND google_play_product_id IS DISTINCT FROM 'boost_plan3';
    END IF;

    IF EXISTS (SELECT 1 FROM product_configurations WHERE pack_code = 'COMMENTS_1') THEN
        DELETE FROM product_configurations
        WHERE pack_code IN ('COMMENTS_5', 'COMMENTS_15');

        DELETE FROM product_configurations
        WHERE pack_code = 'COMMENTS_2'
          AND quantity = 2;
    END IF;

    -- Finish a previously interrupted rename (temp pack codes left behind).
    IF EXISTS (SELECT 1 FROM product_configurations WHERE pack_code LIKE '_MIG_%') THEN
        UPDATE product_configurations SET pack_code = 'BOOST_1'
        WHERE pack_code = '_MIG_BOOST_1'
          AND NOT EXISTS (SELECT 1 FROM product_configurations WHERE pack_code = 'BOOST_1');

        UPDATE product_configurations SET pack_code = 'BOOST_2'
        WHERE pack_code = '_MIG_BOOST_2'
          AND NOT EXISTS (SELECT 1 FROM product_configurations WHERE pack_code = 'BOOST_2');

        UPDATE product_configurations SET pack_code = 'BOOST_3'
        WHERE pack_code = '_MIG_BOOST_3'
          AND NOT EXISTS (SELECT 1 FROM product_configurations WHERE pack_code = 'BOOST_3');

        UPDATE product_configurations SET pack_code = 'COMMENTS_1'
        WHERE pack_code = '_MIG_COMMENTS_1'
          AND NOT EXISTS (SELECT 1 FROM product_configurations WHERE pack_code = 'COMMENTS_1');

        UPDATE product_configurations SET pack_code = 'COMMENTS_2'
        WHERE pack_code = '_MIG_COMMENTS_2'
          AND NOT EXISTS (SELECT 1 FROM product_configurations WHERE pack_code = 'COMMENTS_2');

        UPDATE product_configurations SET pack_code = 'COMMENTS_3'
        WHERE pack_code = '_MIG_COMMENTS_3'
          AND NOT EXISTS (SELECT 1 FROM product_configurations WHERE pack_code = 'COMMENTS_3');
    END IF;

    -- Legacy catalog still present (BOOST_6 / COMMENTS_5 are unique to pre-042 seeds).
    IF EXISTS (
        SELECT 1 FROM product_configurations
        WHERE pack_code IN ('BOOST_6', 'BOOST_15', 'COMMENTS_5', 'COMMENTS_15')
    ) THEN
        UPDATE product_configurations SET pack_code = '_MIG_BOOST_1' WHERE pack_code = 'BOOST_3';
        UPDATE product_configurations SET pack_code = '_MIG_BOOST_2' WHERE pack_code = 'BOOST_6';
        UPDATE product_configurations SET pack_code = '_MIG_BOOST_3' WHERE pack_code = 'BOOST_15';
        UPDATE product_configurations SET pack_code = 'BOOST_1' WHERE pack_code = '_MIG_BOOST_1';
        UPDATE product_configurations SET pack_code = 'BOOST_2' WHERE pack_code = '_MIG_BOOST_2';
        UPDATE product_configurations SET pack_code = 'BOOST_3' WHERE pack_code = '_MIG_BOOST_3';

        UPDATE product_configurations SET pack_code = '_MIG_COMMENTS_1' WHERE pack_code = 'COMMENTS_2';
        UPDATE product_configurations SET pack_code = '_MIG_COMMENTS_2' WHERE pack_code = 'COMMENTS_5';
        UPDATE product_configurations SET pack_code = '_MIG_COMMENTS_3' WHERE pack_code = 'COMMENTS_15';
        UPDATE product_configurations SET pack_code = 'COMMENTS_1' WHERE pack_code = '_MIG_COMMENTS_1';
        UPDATE product_configurations SET pack_code = 'COMMENTS_2' WHERE pack_code = '_MIG_COMMENTS_2';
        UPDATE product_configurations SET pack_code = 'COMMENTS_3' WHERE pack_code = '_MIG_COMMENTS_3';
    END IF;
END $$;

UPDATE product_configurations SET google_play_product_id = 'boost_one'
WHERE pack_code = 'BOOST_1'
  AND (google_play_product_id IS DISTINCT FROM 'boost_one');

UPDATE product_configurations SET google_play_product_id = 'boost_plan2'
WHERE pack_code = 'BOOST_2'
  AND (google_play_product_id IS DISTINCT FROM 'boost_plan2');

UPDATE product_configurations SET google_play_product_id = 'boost_plan3'
WHERE pack_code = 'BOOST_3'
  AND (google_play_product_id IS DISTINCT FROM 'boost_plan3');

UPDATE product_configurations SET google_play_product_id = 'comment_one'
WHERE pack_code = 'COMMENTS_1'
  AND (google_play_product_id IS DISTINCT FROM 'comment_one');

UPDATE product_configurations SET google_play_product_id = 'comment_2'
WHERE pack_code = 'COMMENTS_2'
  AND (google_play_product_id IS DISTINCT FROM 'comment_2');

UPDATE product_configurations SET google_play_product_id = 'comment_3'
WHERE pack_code = 'COMMENTS_3'
  AND (google_play_product_id IS DISTINCT FROM 'comment_3');

UPDATE product_configurations SET google_play_product_id = 'chat_unlock'
WHERE pack_code = 'CHAT_UNLOCK_SINGLE'
  AND (google_play_product_id IS DISTINCT FROM 'chat_unlock');

-- Historical purchase rows (only when legacy pack codes remain in ledger tables).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM user_purchases WHERE pack_code IN ('BOOST_6', 'BOOST_15')) THEN
        UPDATE user_purchases SET pack_code = 'BOOST_1' WHERE pack_code = 'BOOST_3';
        UPDATE user_purchases SET pack_code = 'BOOST_2' WHERE pack_code = 'BOOST_6';
        UPDATE user_purchases SET pack_code = 'BOOST_3' WHERE pack_code = 'BOOST_15';
    END IF;

    IF EXISTS (SELECT 1 FROM user_purchases WHERE pack_code IN ('COMMENTS_5', 'COMMENTS_15')) THEN
        UPDATE user_purchases SET pack_code = 'COMMENTS_1' WHERE pack_code = 'COMMENTS_2';
        UPDATE user_purchases SET pack_code = 'COMMENTS_2' WHERE pack_code = 'COMMENTS_5';
        UPDATE user_purchases SET pack_code = 'COMMENTS_3' WHERE pack_code = 'COMMENTS_15';
    END IF;

    IF EXISTS (SELECT 1 FROM store_purchase_verifications WHERE pack_code IN ('BOOST_6', 'BOOST_15')) THEN
        UPDATE store_purchase_verifications SET pack_code = 'BOOST_1' WHERE pack_code = 'BOOST_3';
        UPDATE store_purchase_verifications SET pack_code = 'BOOST_2' WHERE pack_code = 'BOOST_6';
        UPDATE store_purchase_verifications SET pack_code = 'BOOST_3' WHERE pack_code = 'BOOST_15';
    END IF;

    IF EXISTS (SELECT 1 FROM store_purchase_verifications WHERE pack_code IN ('COMMENTS_5', 'COMMENTS_15')) THEN
        UPDATE store_purchase_verifications SET pack_code = 'COMMENTS_1' WHERE pack_code = 'COMMENTS_2';
        UPDATE store_purchase_verifications SET pack_code = 'COMMENTS_2' WHERE pack_code = 'COMMENTS_5';
        UPDATE store_purchase_verifications SET pack_code = 'COMMENTS_3' WHERE pack_code = 'COMMENTS_15';
    END IF;
END $$;
