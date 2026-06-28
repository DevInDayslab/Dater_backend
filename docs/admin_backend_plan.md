# Admin Backend Plan (MVP — Final)

Approved implementation plan for the Dater Admin Panel backend. Mobile routes are untouched; all admin logic lives under `/api/v1/admin/*`.

## MVP constraints

- **No audit logging** — no `admin_audit_log`, `admin_chat_access_log`, or ledger writes on mutations.
- **No RBAC** — single admin tier; JWT auth only.
- **No manual photo moderation** — no photo approve/reject admin endpoints.
- **Reports** — read-only list + detail popup (chat/story/profile context); admin **dismisses** (deletes) invalid reports. Dismiss recalculates `moderation_warning_count = floor(reportCount/3)` and unbans if warnings drop below 3 (`reconcileReportMilestonesAfterDismiss` in `moderationReports.service.js`). Auto warn/ban on new reports unchanged.
- **Dashboard** — counts only, no currency. KPIs: Total Users, DAU, MAU, Active Premium, Boosts Sold, Comments Sold, Chat Unlocks Sold, **Total Reports** (all time). No pending photo review.
- **Migration `034`** — only `admin_users`, `admin_sessions`, `admin_broadcasts`.

## Phase 0 + 1 (implemented)

| Item | Path |
|------|------|
| Migration | `sql/034_admin_panel.sql` |
| Seed admin | `npm run seed:admin` (env: `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`) |
| Auth | `POST /api/v1/admin/auth/login`, `refresh`, `logout` |
| Dashboard | `GET /api/v1/admin/dashboard/stats`, `growth`, `badges` |

### Auth

```http
POST /api/v1/admin/auth/login
{ "email": "...", "password": "..." }
→ { success, data: { accessToken, expiresAt, admin: { id, email, name } } }
```

Use `Authorization: Bearer <token>` on protected routes. Optional dev fallback: `x-admin-api-key` when `ADMIN_API_KEY` is set.

### Dashboard stats (`?window=7d|30d|6m|1y|all`)

Window applies to **purchase counts** (boosts, comments, chat unlocks). User metrics are point-in-time.

```json
{
  "totalUsers": 0,
  "dau": 0,
  "mau": 0,
  "activePremiumUsers": 0,
  "boostsSold": 0,
  "commentsSold": 0,
  "chatUnlocksSold": 0,
  "totalReports": 0,
  "bannedUsers": 0,
  "window": "7d"
}
```

Use `account_state = 'BANNED'` — never `is_banned`.

### Badges

```json
{ "totalReports": 0, "bannedUsers": 0 }
```

## Next phases

- **Phase 1b:** User list + detail GET endpoints
- **Phase 2:** Reports list, report detail, `DELETE /admin/reports/:id` (dismiss)
- **Phase 3:** User trust mutations, broadcast, settings
