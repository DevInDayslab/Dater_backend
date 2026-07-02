# Dater Premium — QA Checklist

Use this after every backend deploy and Android billing build. Run server checks first, then device tests on a **license tester account** with an **Internal testing** Play build (not sideloaded debug unless API base is dev).

---

## A. Server preflight (run on EC2 before device QA)

| # | Check | Command / action | Pass criteria |
|---|--------|------------------|---------------|
| A1 | Play credentials load | `npm run verify:play-config` | `OK: Google Play billing credentials loaded` |
| A2 | No circular dependency | `npm run verify:billing-modules` | `OK: billing module graph` |
| A3 | Catalog base plans | `npm run verify:products-catalog` | week-one / month / three-month on premium rows |
| A4 | PM2 clean restart | `pm2 restart dater-api && pm2 logs dater-api --lines 30` | **No** `subscriptionStateGrantsAccess is not a function` warning |
| A5 | Products API | `curl -s http://localhost:3000/api/v1/config/products \| jq '.data.premium[].googlePlayBasePlanId'` | `week-one`, `month`, `three-month` |

**Env requirements on server:**
- `GOOGLE_PLAY_SERVICE_ACCOUNT_PATH=./secrets/google-play-service-account.json` (or single-line JSON)
- `GOOGLE_PLAY_PACKAGE_NAME=com.daterplat.app`
- `BILLING_DEV_MODE=false`

---

## B. Play Console preflight

| # | Check | Pass criteria |
|---|--------|---------------|
| B1 | Subscription product | `dater_premium` active |
| B2 | Base plans | `week-one`, `month`, `three-month` active |
| B3 | Service account | `dater-play-api@datermain.iam.gserviceaccount.com` linked in API access |
| B4 | License testers | Your Google account added |
| B5 | Internal testing | Latest AAB uploaded; install from Play link |

---

## C. Android client — paywall & pricing

| # | Scenario | Steps | Pass criteria |
|---|----------|-------|---------------|
| C1 | Cold open paywall | Profile → Upgrade | Week / Month / 3-month show **distinct** Play prices (not all same) |
| C2 | Price source | Compare paywall vs Play purchase sheet | Prices match verbatim |
| C3 | No backend priceLabel | Inspect UI | No hardcoded ₹99 etc. from catalog |
| C4 | Disk cache | Open paywall → kill app → reopen | Prices appear instantly from cache |
| C5 | Foreground refresh | Background app 5 min → foreground | Silent price refresh if Play changed |

---

## D. Purchase & verify (subscription)

| # | Scenario | Steps | Pass criteria |
|---|----------|-------|---------------|
| D1 | First purchase | Select plan → Subscribe → complete test payment | Success sheet; premium features unlock |
| D2 | Backend verify | Check `pm2 logs` during purchase | No 503 `PLAY_NOT_CONFIGURED`; no JS TypeError |
| D3 | DB state | Query user after purchase | `is_premium=true`, `premium_expires_at` future, `premium_plan_code` matches plan |
| D4 | Already owned restore | Tap Subscribe again after D1 | Play says subscribed; app **restores** and shows premium (not stuck message) |
| D5 | App restart reconcile | Kill app → reopen | Premium still active (reconcile on billing connect) |
| D6 | Wrong plan inference | Buy **month** plan specifically | Backend grants `MONTH` / `PREMIUM_MONTH`, not week |
| D7 | Cancel flow | User cancels in Play | Premium until period end; status `CANCELLED` |
| D8 | Expiry | Wait or use license-tester accelerated renewal | Premium revokes after expiry |

---

## E. Entitlements in app

| # | Feature | Pass criteria |
|---|---------|---------------|
| E1 | Profile badge | Shows premium / expiry |
| E2 | Who viewed you | Unlocked for premium |
| E3 | Weekly boost | Boost credit granted per plan rules |
| E4 | `/users/me` entitlements | `premium.status=ACTIVE`, `expiresAt` set |

---

## F. RTDN / renewals (production)

| # | Scenario | Pass criteria |
|---|----------|---------------|
| F1 | Pub/Sub push endpoint | `POST /api/v1/billing/google-webhook` reachable |
| F2 | Renewal notification | `premium_expires_at` extends on `SUBSCRIPTION_RENEWED` |
| F3 | Grace period | `SUBSCRIPTION_IN_GRACE_PERIOD` keeps access |
| F4 | On hold | `SUBSCRIPTION_ON_HOLD` revokes access |
| F5 | Cron | `billing:retry-fulfillment` + `billing:reconcile-subscriptions` scheduled |

---

## G. Failure modes (must show clear errors, not crash)

| # | Condition | Expected app message | Expected HTTP code |
|---|-----------|---------------------|-------------------|
| G1 | Play not configured | Server-side only | 503 `PLAY_NOT_CONFIGURED` |
| G2 | Invalid token | Verification failed | 400 |
| G3 | Pending payment | Pending message | 202 |
| G4 | User cancels | Silent / no error | — |
| G5 | Offline | Offline message | — |

---

## Deploy order (every billing fix)

1. Push backend → EC2 pull → `npm run verify:play-config` → `npm run verify:billing-modules` → `pm2 restart dater-api`
2. Confirm A4 logs clean
3. Build & upload AAB to Internal testing (if Android changed)
4. Run checklist sections C → D → E on license tester device

---

## Current known fixes (2026-07-03)

- **Circular dependency:** `subscriptionState.service` ↔ `billingVerification.service` broken via `storeBillingLedger.service.js`
- **Multiline .env JSON:** use `GOOGLE_PLAY_SERVICE_ACCOUNT_PATH` file path
- **Restore path:** Android handles `ITEM_ALREADY_OWNED` by querying subs + verify
- **Plan resolution:** Backend infers pack from Google subscription line item `basePlanId`
