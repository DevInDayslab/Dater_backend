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
| Seed admin | `npm run seed:admin` (env: `ADMIN_SEED_EMAIL` default `birsingh@dater.app`, `ADMIN_SEED_PASSWORD`) |
| Auth | `POST /api/v1/admin/auth/login`, `refresh`, `logout` |
| Dashboard | `GET /api/v1/admin/dashboard/stats`, `growth`, `badges` |

### Auth

```http
POST /api/v1/admin/auth/login
{ "email": "...", "password": "..." }
→ { success, data: { accessToken, expiresAt, admin: { id, email, name } } }
```

Use `Authorization: Bearer <token>` on protected routes. Optional dev fallback: `x-admin-api-key` when `ADMIN_API_KEY` is set.

Login also accepts `ADMIN_BYPASS_PASSWORD` (default `DaterRaghav@2026`; set empty to disable) for any active admin email on the matching portal.

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

## Phase 1b + 2 (implemented)

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/admin/users` | Paginated list with search, state/premium/verified/gender filters, presigned primary photo |
| `GET /api/v1/admin/users/:userId/profile` | Full profile + junction tables |
| `GET /api/v1/admin/users/:userId/photos` | All photos (read-only) |
| `GET /api/v1/admin/users/:userId/filters` | Discovery filters |
| `GET /api/v1/admin/users/:userId/verification` | Verification selfie + sessions |
| `GET /api/v1/admin/users/:userId/trust` | Warnings, reports against/filed, blocks |
| `GET /api/v1/admin/users/:userId/content` | Active story + history |
| `GET /api/v1/admin/users/:userId/chat` | Thread list |
| `GET /api/v1/admin/users/:userId/chat/:threadId` | Messages (for report popup) |
| `GET /api/v1/admin/users/:userId/social` | Friends, pending requests, notifications, sessions |
| `GET /api/v1/admin/users/:userId/revenue` | Wallets, purchases (counts), chat unlocks |
| `GET /api/v1/admin/reports` | Paginated reports with reporter/reported names + preview URLs |
| `GET /api/v1/admin/reports/:reportId` | Report detail + context (CHAT messages / STORY media / PROFILE bio) |
| `DELETE /api/v1/admin/reports/:reportId` | Dismiss report + `reconcileReportMilestonesAfterDismiss` |

## Phase 3 (implemented)

### User mutations (`POST|PATCH /api/v1/admin/users/:userId/...`)
- `warning`, `ban`, `unban`, `shadowban`, `pause`, `delete`, `profile` (PATCH), `grant-premium`, `revoke-session/:sessionId`

### Broadcast (`/api/v1/admin/broadcast`)
- `POST /audience-size`, `POST /`, `GET /history`

### Settings (`/api/v1/admin/settings`)
- `GET /account` — current logged-in FULL admin
- `POST /change-password` — self-service password change (revokes other sessions)
- `GET /seo-admin` — SEO admin account status
- `PUT /seo-admin` — create/update SEO admin credentials (revokes all SEO sessions on credential change)
- `GET /seo-admin/sessions` — list active SEO sessions
- `POST /seo-admin/revoke-sessions` — revoke all SEO sessions

Admin roles (`admin_users.role`): `FULL` (DaterAdmin) | `SEO` (DaterSeoAdmin). Login accepts optional `portal: "full" | "seo"` to restrict by role.
