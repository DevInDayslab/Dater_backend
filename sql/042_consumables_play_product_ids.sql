-- Rename consumable pack codes to tiered BOOST_1/2/3 and COMMENTS_1/2/3;
-- wire google_play_product_id to Play Console SKUs.

-- Avoid unique-key collisions during rename (BOOST_15 -> BOOST_3 while BOOST_3 exists).
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

UPDATE product_configurations SET google_play_product_id = 'boost_one'
WHERE pack_code = 'BOOST_1';

UPDATE product_configurations SET google_play_product_id = 'boost_plan2'
WHERE pack_code = 'BOOST_2';

UPDATE product_configurations SET google_play_product_id = 'boost_plan3'
WHERE pack_code = 'BOOST_3';

UPDATE product_configurations SET google_play_product_id = 'comment_one'
WHERE pack_code = 'COMMENTS_1';

UPDATE product_configurations SET google_play_product_id = 'comment_2'
WHERE pack_code = 'COMMENTS_2';

UPDATE product_configurations SET google_play_product_id = 'comment_3'
WHERE pack_code = 'COMMENTS_3';

UPDATE product_configurations SET google_play_product_id = 'chat_unlock'
WHERE pack_code = 'CHAT_UNLOCK_SINGLE';

-- Historical purchase rows (admin revenue / analytics).
UPDATE user_purchases SET pack_code = 'BOOST_1' WHERE pack_code = 'BOOST_3';
UPDATE user_purchases SET pack_code = 'BOOST_2' WHERE pack_code = 'BOOST_6';
UPDATE user_purchases SET pack_code = 'BOOST_3' WHERE pack_code = 'BOOST_15';
UPDATE user_purchases SET pack_code = 'COMMENTS_1' WHERE pack_code = 'COMMENTS_2';
UPDATE user_purchases SET pack_code = 'COMMENTS_2' WHERE pack_code = 'COMMENTS_5';
UPDATE user_purchases SET pack_code = 'COMMENTS_3' WHERE pack_code = 'COMMENTS_15';

UPDATE store_purchase_verifications SET pack_code = 'BOOST_1' WHERE pack_code = 'BOOST_3';
UPDATE store_purchase_verifications SET pack_code = 'BOOST_2' WHERE pack_code = 'BOOST_6';
UPDATE store_purchase_verifications SET pack_code = 'BOOST_3' WHERE pack_code = 'BOOST_15';
UPDATE store_purchase_verifications SET pack_code = 'COMMENTS_1' WHERE pack_code = 'COMMENTS_2';
UPDATE store_purchase_verifications SET pack_code = 'COMMENTS_2' WHERE pack_code = 'COMMENTS_5';
UPDATE store_purchase_verifications SET pack_code = 'COMMENTS_3' WHERE pack_code = 'COMMENTS_15';
