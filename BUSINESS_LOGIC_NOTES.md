# Dater Backend Business Logic Notes (Flows 1-8)

This file captures the finalized business rules and schema intent so Node.js implementation stays consistent with DB design.

## Scope Covered

- Flow 1: Core user, auth, onboarding schema
- Flow 2: Profile + preferences + filters
- Flow 3: Social graph + memory engine
- Flow 4: Real-time stories + premium controls
- Flow 5: Chat states + account states
- Flow 6: Compliance logs + daily limits
- Flow 7: Account-state cleanup
- Flow 8: Story-reply chat FK integrity

---

## Migration Files and Order

- `sql/001_core_user_auth_onboarding.sql`
- `sql/002_profile_and_filters.sql`
- `sql/003_social_and_memory.sql`
- `sql/004_stories_and_premium.sql`
- `sql/005_chat_and_states.sql`
- `sql/006_compliance_and_limits.sql`
- `sql/007_account_state_cleanup.sql`
- `sql/008_story_reply_chat_fk.sql`
- `sql/009_auth_finalization_and_captcha.sql`
- `sql/010_consent_and_creation_tracking.sql`
- `sql/011_be_kind_acceptance.sql`
- `sql/012_user_photos_moderation_s3.sql` (`s3_key`, `moderation_status` on `user_photos`)
- `sql/013_user_photos_blur_hash.sql` (`blur_hash` on `user_photos`)
- `sql/014_auth_captcha_challenges.sql`
- `sql/015_account_state_pending_captcha.sql`
- `sql/016_living_in_city_mode.sql` (`users.living_in_city_mode`)

`src/scripts/migrate.js` runs all numbered SQL files in ascending order.

### Profile photos — backend implemented (aligns with `backend_raw` §16–18, partial)

- **Presign:** `POST /api/v1/users/me/photos/presign` — body `photoOrder` 1–6, optional `blurHash`; returns presigned **PUT** for **WebP** (`image/webp`), no S3 ACL. Replacing a slot soft-deletes the prior row and best-effort deletes its S3 object.
- **Upload:** Client **PUT** bytes to the presigned URL, then **confirm:** `POST /api/v1/users/me/photos/:photoId/confirm`.
- **Moderation:** Server **GetObject** from S3 → **sharp** transcode to **JPEG** → parallel **Rekognition** `DetectModerationLabels` + `DetectFaces` (`Attributes: ALL`) on the same JPEG buffer. At or above 80% confidence on configured explicit nudity / graphic violence / weapons → hard fail: S3 deleted, `FAILED_MODERATION` + `deleted_at`. No human face (or face too small / low confidence) → hard fail `FACE_NOT_DETECTED`. **Woman** profiles (`gender_main`, legacy `gender`, or woman sub-labels in `user_gender_more_options`) require primary-face `Gender.Value === Female` at ≥85% confidence; otherwise hard fail `GENDER_MISMATCH` (same removal path as NSFW). Verified users still run `CompareFaces` against the verification anchor after the above pass.
- **Stale uploads:** Pending rows older than a configurable window (default 1 hour) are expired (same failure path + S3 cleanup) on presign, confirm, and `GET /me` maintenance hook.
- **Confirm before PUT:** If the object key is missing in S3, API returns **409** with `code: "S3_OBJECT_MISSING"` (not a 502 moderation error).
- **Read model:** `GET /api/v1/users/me` includes `profilePhotos[]` with `moderationStatus` and `blurHash` when stored.
- **Photo confirm debug logs:** Grep server output for `photo_confirm_REJECTED` (includes `rejectStep` + `rejectCode`), `photo_confirm_scan` (full Rekognition face/gender/moderation snapshot), or `photo_confirm_face_compare`. Set `DEBUG_SERVER_LOG=1` in production to enable. Non-production confirm responses may include `debugRejectStep` / `debugRejectDetail` on reject. Android Logcat: tag `DaterPhotoUpload`.

**Not yet in backend:** feed PostGIS engine, selfie `CompareFaces`, stories, chat, premium gates — see `backend_raw.md` and roadmap in `.cursorcontext`.

---

## Flow 1: Core User / Auth / Onboarding

### Required Constraints

- `users.id` is UUID primary key.
- `users.location` uses `GEOMETRY(Point, 4326)` with GIST index.
- `onboarding_step` tracks exact current step.
- `onboarding_updated_at` supports 7-day onboarding memory rule.
- `deleted_at` supports 6-month soft delete retention.
- `last_active_at` has DESC index for feed ordering.
- `age_agreement_timestamp` stores 18+ confirmation time.
- `be_kind_accepted_at` stores explicit acceptance time from the Guidelines "I accept" step.
- `is_banned`, `is_verified`, `is_premium` default `false`.

### Auth/OTP

- OTP challenges in `auth_otp_challenges`.
- Session/JWT tracking in `user_sessions`.

### Onboarding Multi-Selects

- `user_gender_more_options`
- `user_dating_preferences`
- `user_looking_for`
- `user_interests`
- `user_photos`

### Location Permission Contract (Onboarding -> Home)

- Location coordinates (`users.location`) and `users.location_granted=true` are written only when user grants location permission on the dedicated **"Enable location permission"** step near the end of onboarding.
- If location is not granted, app must route/show Home in **no-location state** (no feed cards) until permission is enabled.
- Once permission is granted later, app updates coordinates + granted flag and exits no-location state.

---

## Flow 2: Profile & Preferences

## Source-of-truth consistency

- Profile height is single-source: `users.height_inches` (no duplicate profile height field elsewhere).
- "Who you want to date" source is onboarding table `user_dating_preferences`.
- `user_filters` is only for "ideal match" side (what user wants), not duplicate profile fields.

### Users Table Expansion (Profile Side)

- `profile_completion_percentage` (0-100)
- `ethnicity`
- `occupation_job_title`, `occupation_company`
- `education_institution_name`, `education_passing_year`
- `living_in_city`, `home_town_city`
- `living_in_city_mode` (`FOLLOW_DEVICE` | `MANUAL_SWITCH`)
- `bio`, `preset_message`
- `profile_updated_at`

### Living in, hometown, and browse location

- `home_town_city` — profile-only; never written by GPS or geocoder.
- `living_in_city` — profile-only **manual** label when the user saves it (typically `living_in_city_mode === MANUAL_SWITCH`). GPS pings **do not** write or overwrite this column (`PATCH profile-core`).
- `living_in_city_mode` — `FOLLOW_DEVICE` means “not pinning a manual profile city”; `MANUAL_SWITCH` means the user chose a city for the profile bubble.
- City picker (`GET /me/cities`) searches the full Postgres `cities` table worldwide by default; pass `country=IN` (or another ISO2) to scope browse/search. GPS reverse-geocode remains country-scoped (default `IN`).
- City picker: `GET /api/v1/users/me/cities?q=&page=&pageSize=&country=&selected=` — search + paginated; full list is never dumped. Data source: `cities` table seeded from `backend/src/data/Cities_world_coordinates.csv`.

### Profile Multi-Select Tables

- `user_pronouns`
- `user_languages`
- `user_written_prompts` (question+answer, ordered up to 3)

### Filters Table (Ideal Match Side)

`user_filters` includes:

- Basic:
  - `distance_pref_km` (2-150)
  - `age_min`, `age_max`
  - `expand_age_range`, `expand_distance`
  - `only_verified_profiles`
  - `preferred_location_city` (**premium** switch-city for feed/browse anchor; separate from profile `living_in_city`)
- Advanced scalar:
  - `min_height_inches`, `max_height_inches`
  - `show_other_people_if_run_out`

### Filter Multi-Select Tables

- `user_filter_preferred_genders`
- `user_filter_languages`
- `user_filter_marital_statuses`
- `user_filter_looking_for`
- `user_filter_drinking_preferences`
- `user_filter_smoking_preferences`
- `user_filter_exercise_preferences`
- `user_filter_religion_preferences`
- `user_filter_education_preferences`
- `user_filter_star_sign_preferences`
- `user_filter_kids_preferences`
- `user_filter_political_preferences`
- `user_filter_pet_preferences`
- `user_filter_ethnicity_preferences`
- `user_filter_pronoun_preferences`

### Bootstrap Consistency in SQL

- Auto-create a `user_filters` row for users missing one.
- Backfill `user_filter_preferred_genders` from `user_dating_preferences` when missing.

---

## Flow 3: Social Graph & Memory Engine

### Interaction Model (Finalized)

`user_interactions.interaction_type`:

- `REQUEST` (normal friend request)
- `COMMENT_REQUEST` (friend request with custom message)
- `IGNORE` (profile ignore for feed memory)
- `VIEWED` (profile seen for feed memory)

Important:

- There is no `LIKE` interaction type.
- There is no cancel state.
- `REQUEST` and `COMMENT_REQUEST` are mutually exclusive request subtypes.

### Request State Model

`request_status_enum`:

- `PENDING`
- `ACCEPTED`
- `IGNORED`

Rules:

- Request rows (`REQUEST`/`COMMENT_REQUEST`) always have a request status.
- `COMMENT_REQUEST` requires non-empty `comment_text`.
- `REQUEST` must have `comment_text = NULL`.
- `PENDING` -> `request_acted_at = NULL`
- `ACCEPTED`/`IGNORED` -> `request_acted_at` is required.

### Silent Burial Rule (Ignored Friend Request)

- Ignoring a friend request sets request status to `IGNORED`.
- Sender receives no notification (silent burial).
- Feed should treat ignored request pairs as mutually excluded.
- App-level undo behavior remains UI/session-level until finalized write.

### 30-Day Soft Hide Rule

- Only applies to `interaction_type IN ('IGNORE', 'VIEWED')`.
- `expires_at = NOW() + INTERVAL '30 days'`.
- Feed excludes rows where expiry is in future.

### Friendships

- Stored in `friendships`.
- `u1_id` must always be lexicographically smaller UUID than `u2_id`.
- DB enforces with `CHECK (u1_id < u2_id)` + composite PK.

### Blocks

- Stored in `blocks`.
- Permanent exclusion, no expiry.

### Reports

- Stored in `reports`.
- `content_type`: `PROFILE`, `STORY`, `CHAT`
- `status`: `PENDING`, `RESOLVED`

### Feed-Critical Indexes

- `user_interactions(user_id, target_id)` for fast skip checks.
- `user_interactions(expires_at)` for cleanup worker.
- Partial index for active memory rows: `(user_id, expires_at)` where type is `IGNORE/VIEWED`.
- Unique partial index to prevent dual pending requests:
  - one pending request row per `(user_id, target_id)` for request types.
- Index for ignored request pairs to support silent-burial exclusion.

---

## Implementation Notes for Node.js Services

- Keep business logic in service layer; DB constraints act as guardrails.
- Use transactions for request acceptance:
  1) mark request `ACCEPTED`
  2) create normalized friendship pair (`u1_id`, `u2_id`)
- For feed candidate exclusion, check all:
  - blocks (both directions)
  - friendships
  - active 30-day memory (`IGNORE`/`VIEWED` with future `expires_at`)
  - ignored requests (`request_status = 'IGNORED'`) both directions

---

## Flow 4: Stories, Real-Time & Premium

### Story Visibility Logic (Who Sees Whose Story)

- Default: stories are visible to users matching mutual preferences (gender/age/distance), not just friends.
- Story ordering in story rail is shuffled/randomized (friends are not prioritized by default).
- Creator choice at upload:
  - `Only Friends`
  - `All Preferences`
- Privacy mode exception:
  - if creator has premium privacy mode enabled, story audience is forced to `Only Friends`.
  - `All Preferences` option must be removed from upload flow.
- Empty states:
  - show "no story" profile placeholders (up to 5) for matched users with no active stories.
  - tapping placeholder opens full profile.

### Story Timelines, Limits, Retention

- Story lifespan is exactly 24 hours (`expires_at`).
- Maximum 5 active stories per user at a time.
- 6th upload attempt should be blocked with limit popup UX.
- Expired/deleted stories must be retained for 6 months for compliance (soft retention policy).

### Story Interactions (Friend vs Non-Friend Rules)

- Stored interactions:
  - `VIEW`
  - `LIKE`
  - `COMMENT`
- Friends:
  - replies/comments are pushed into private chat thread.
  - likes are also represented in chat activity stream.
- Non-friends:
  - comments require active comments quota (or purchase flow).
  - non-friend comment acts as request with note, routed to story activity.
  - likes route to story activity (not chat).

### Story Replies

- `story_replies` stores reply events linked to story and chat reference.
- Friends-only condition for replies must be enforced in service layer.
- Reply should create chat message with story reference metadata (Instagram-like context).

### Story Activity Page Rules

- Creator can open story activity by swiping up on own active story.
- Count formatting should support compact style (`999`, `1k`, `1.1k`, etc.).
- De-dup hierarchy per actor on activity page:
  - `COMMENT > LIKE > VIEW`
- Privacy mode viewer behavior:
  - passive views may be hidden.
  - active actions (like/comment) remain visible.
- Story ring viewed-state:
  - once viewed, ring should shift to grey/seen style.

### Sync with Main Feed

- Tapping story avatar/name opens full profile.
- Actions from story must sync to main feed card state immediately.
- Story-driven profile opens should respect free-tier profile-view limits (20/day).
- Once free limit is hit, show same timer/paywall behavior used by home feed.

### Story Upload Gate & Moderation

- Upload gate:
  - unverified users cannot post stories.
  - tapping `+` should trigger "Verified Vibes Only" style gate.
- Reporting:
  - 1 report => immediate story removal + creator notification.
  - 3 total story reports => 1 warning.
- Warning/ban progression:
  - 2 consecutive warnings -> 3rd warning triggers absolute ban.
- Admin logging:
  - bans, report reasons, removals, moderation actions must be logged with timestamps.

### Premium + Real-Time Tables (Flow 4 SQL)

- `stories`: media URL, media type, 24h expiry.
- `story_interactions`: view/like/comment.
- `story_replies`: chat-linked story reply references.
- `chat_restrictions`: 3-message throttler, unlock flag, cooldown window.
- `premium_boosts`: boost windows for feed top-stack priority.
- `user_purchases`: unlock chat / boost / subscription transactions.

---

## Flow 5: Chat, Relation State, Account State

### Chat Core Mechanics

- Sorting modes to support in service/query layer:
  - Recent (default chronological by `last_message_at`)
  - Nearby (distance-based)
  - Unread (push unread chats up)
  - Unanswered (inbound waiting for reply)
- Search:
  - WhatsApp-style search should query chat participants and message text.
- Reply badge:
  - `has_reply_badge` stored in `chat_thread_user_state`.

### Chat + Profile/Story Linking

- From chat header:
  - tap user name -> open full profile (guarded by `can_view_profile` state).
  - story ring -> open active story view if available.
- Story reply in chat:
  - store message with `message_type='STORY_REPLY_REFERENCE'`.
  - link to `stories` / `story_replies` references.

### Unlock Chat + Message Limits

- Base limiter state stored in `chat_restrictions` (Flow 4):
  - `message_count`
  - `is_unlocked`
  - `cooldown_until`
- Per-chat unlock purchases tracked in:
  - `chat_unlock_events` + `user_purchases(item_type='UNLOCK_CHAT')`
- 3-message limiter and cooldown rules are enforced in service layer based on gender matrix.

### Chat Initiation + Preset Message

- Chat thread starts when request is accepted.
- Request source can be normal request or comment-request note.
- Accepting user's preset message should auto-insert first message.
- If both have preset messages, accepting user's preset wins.

### Muting, Delete Chat, Unfriend End-State

- Mute persistence is pair-level, not thread-lifetime:
  - `chat_user_pair_preferences` keeps mute even if chat is deleted visually.
- Delete chat:
  - set `is_deleted_from_inbox=true` in `chat_thread_user_state`.
  - message records remain for retention.
- Unfriend behavior:
  - user A: remove instantly from inbox (soft/visibility state).
  - user B: set `relationship_state='CHAT_ENDED'`, disable profile/report access,
    keep row for 3 days (`relationship_state_expires_at`), then hide from inbox.

### Deleted Accounts & Bottom Feed Organization

- If counterpart account is deleted:
  - set per-user `relationship_state='DELETED_ACCOUNT'`
  - `can_view_profile=false`
- Ended/deleted/unfriended states should be pushed to bottom:
  - use `pinned_to_bottom=true` and sort accordingly.

### Moderation / Admin DMs

- Admin messages are normal inbox messages:
  - `chat_threads.thread_type='ADMIN_DM'`
  - `chat_messages.sender_type='ADMIN_SYSTEM'`
- Chat 3-dots moderation actions (block/report/unfriend) map to:
  - `blocks`
  - `reports(content_type='CHAT')`
  - thread user state changes.

### User Account States (Global)

- Stored in `users.account_state`:
  - `ACTIVE`
  - `PAUSED`
  - `PRIVACY_MODE`
  - `HIDDEN_BY_MODERATION`
  - `DELETED`
  - `BANNED`
  - `UNDERAGE_BLOCKED`
- Supporting columns after cleanup migration (`007`):
  - `paused_until`
  - `profile_hidden_at`
  - `underage_until`
  - `new_here_until` (72h badge window)
  - moderation warning counters
- Canonical rule:
  - `users.account_state` is single source of truth for account visibility/status.
  - legacy overlap flags are dropped in `007`.

### Data Retention

- Chat content, sender/receiver timestamps, and deleted chat records must be retained for 6 months.
- Deleting from inbox is visual state only, not destructive delete.

---

## Flow 6: Compliance, Audit, Limits

- `user_daily_profile_view_usage`: per-user per-day counters for free-tier 20 profile views/day.
- `profile_view_events`: raw profile-open events including source (`FEED`, `STORY`, `STORY_ACTIVITY`).
- `customer_support_reports`: support tickets submitted by users.
- `moderation_actions_log`: warning/ban/content-removal/admin moderation actions.
- `law_enforcement_disclosures_log`: legal disclosure trail for compliance.
- `notification_events`: auditable notification/inbox events (including silent events).

---

## Flow 7: Account State Cleanup (Pre-launch)

- Backfills `users.account_state` from legacy flags where needed.
- Drops overlapping status flags to avoid split-brain state reads:
  - `is_banned`
  - `is_paused`
  - `privacy_mode_enabled`

---

## Flow 8: Integrity FK

- Adds FK from `story_replies.chat_message_id` -> `chat_messages.id`.
- Purpose: ensure story-reply references only point to valid chat messages.

---

## Flow 9: Identity verification (Face Liveness + CompareFaces)

- **Migration:** `sql/018_verification.sql` — `user_verification_sessions`, `users.verified_at`, `users.verification_selfie_s3_key`, `users.verification_last_attempt_at`.
- **API:** `POST /api/v1/users/me/verify-liveness/session`, `/preview`, `/complete` (see `users.controller.js` + `verification.service.js`).
- **Policy:** Liveness confidence ≥ 90; `CompareFaces` similarity ≥ 90 vs each **APPROVED** profile photo; non-matching approved photos are soft-deleted + S3 removed (best effort). If **no** approved photo matches after cleanup → `account_state = HIDDEN_BY_MODERATION`, selfie still stored as anchor for recovery uploads.
- **Success:** Selfie stored at `verifications/selfies/{userId}.webp`, `is_verified = true`, `account_state = ACTIVE`, `onboarding_completed_at` set if null; response includes refreshed `userPhotos`.
- **Future uploads:** `photoModeration` + `photos.controller` require face match to verification selfie (or approved fallback) when user is verified, hidden-with-anchor, or selfie key exists; NSFW + weapons/violence rules unchanged/expanded.
- **Android:** Amplify `FaceLivenessDetector` requires a valid Cognito **Identity Pool** in `app/src/main/res/raw/amplifyconfiguration.json` (unauth IAM: `rekognition:StartFaceLivenessSession`). Backend uses IAM for `CreateFaceLivenessSession` / `GetFaceLivenessSessionResults` / `CompareFaces`.

