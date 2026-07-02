# Dater Premium QA checklist (license tester)

Setup: Play Console → License testing; install from **Internal testing** track.

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | First-time buy (`month`) | Paywall closes; `premium.isActive`; verification row; `acknowledged_at` set |
| 2 | Play-first pricing | Paywall shows Play currency, not admin INR on CTA |
| 3 | All 3 base plans | `week-one`, `month`, `three-month` launch without `OFFER_NOT_FOUND` |
| 4 | Idempotent verify | Replay same token → 200, no duplicate grants |
| 5 | Auto-resubscribe | RTDN `RENEWED` extends `premium_expires_at` without app open |
| 6 | User cancels | `auto_renewing=false`; premium works until expiry |
| 7 | Expiration | `premium.isActive=false`; expired sheet once ~12s on any tab |
| 8 | Crash mid-purchase | Relaunch → premium active via reconcile |
| 9 | Offline verify | Reconnect → reconcile completes |
| 10 | Pending payment | 202 `PURCHASE_PENDING`; no grant until confirmed |
| 11 | Ack retry | `billing:retry-fulfillment` acknowledges within cron window |
| 12 | Legacy endpoint blocked | `POST /entitlements/premium/purchase` → 403 in prod |
| 13 | Grace period | `premium_status=GRACE_PERIOD`; `is_premium=true` |
| 14 | On hold | `is_premium=false`; `premium_status=ON_HOLD` |
| 15 | Paused | `is_premium=false`; `premium_status=PAUSED` |
| 16 | Expired sheet once | Dismiss → no re-show until next expiry; Renew → paywall |
| 17 | No expired sheet on upgrade | Success sheet only after new purchase |

## DB checks

```sql
SELECT premium_expires_at, premium_status, is_premium FROM users WHERE id = '...';
SELECT * FROM store_subscriptions WHERE platform = 'GOOGLE_PLAY';
SELECT * FROM store_purchase_verifications ORDER BY created_at DESC LIMIT 5;
```

## Logs

`billing_verify`, `billing_rtdn`, `billing_ack_failed`, `billing_subscription_state_applied`
