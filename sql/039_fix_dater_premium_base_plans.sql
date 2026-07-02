-- Align admin catalog with live Play Console base plan IDs (week-one, month, three-month).

UPDATE product_configurations SET
  google_play_product_id = 'dater_premium',
  google_play_base_plan_id = 'week-one'
WHERE pack_code = 'PREMIUM_WEEK';

UPDATE product_configurations SET
  google_play_product_id = 'dater_premium',
  google_play_base_plan_id = 'month'
WHERE pack_code = 'PREMIUM_MONTH';

UPDATE product_configurations SET
  google_play_product_id = 'dater_premium',
  google_play_base_plan_id = 'three-month'
WHERE pack_code = 'PREMIUM_THREE_MONTHS';
