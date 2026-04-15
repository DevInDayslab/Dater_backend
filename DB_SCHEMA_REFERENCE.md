# Dater DB Schema Reference

Quick reference for what each schema object is for, based on Flows 1-8.

## Migration Order

- `001_core_user_auth_onboarding.sql`
- `002_profile_and_filters.sql`
- `003_social_and_memory.sql`
- `004_stories_and_premium.sql`
- `005_chat_and_states.sql`
- `006_compliance_and_limits.sql`
- `007_account_state_cleanup.sql`
- `008_story_reply_chat_fk.sql`
- `009_auth_finalization_and_captcha.sql`
- `010_consent_and_creation_tracking.sql`
- `011_be_kind_acceptance.sql`
- `012_user_photos_moderation_s3.sql`
- `013_user_photos_blur_hash.sql`
- `014_auth_captcha_challenges.sql`
- `015_account_state_pending_captcha.sql`
- `016_living_in_city_mode.sql`

## Core User/Auth

- `users`: primary user identity, profile core, onboarding state, location, retention timestamps, account flags.
- `auth_otp_challenges`: OTP attempt tracking, expiry, captcha-required signals.
- `user_sessions`: JWT/session lifecycle, device/ip/user-agent level session data.

## Onboarding/Profile Data

- `user_gender_more_options`: selected detailed gender option(s).
- `user_dating_preferences`: onboarding "who you want to date".
- `user_looking_for`: relationship intent options.
- `user_interests`: interests selected.
- `user_photos`: profile photos (ordered, soft deletable).
- `user_pronouns`: selected pronouns.
- `user_languages`: user-known languages.
- `user_written_prompts`: prompt/answer pairs for profile.

## Filters (Ideal Match)

- `user_filters`: scalar filter config (distance, age range, expand toggles, verified-only, city, height range, run-out behavior).
- `user_filter_preferred_genders`: target genders in filter.
- `user_filter_languages`: target languages filter.
- `user_filter_marital_statuses`: preferred marital statuses.
- `user_filter_looking_for`: preferred relationship intent.
- `user_filter_drinking_preferences`: preferred drinking habits.
- `user_filter_smoking_preferences`: preferred smoking habits.
- `user_filter_exercise_preferences`: preferred exercise habits.
- `user_filter_religion_preferences`: preferred religion values.
- `user_filter_education_preferences`: preferred education values.
- `user_filter_star_sign_preferences`: preferred star signs.
- `user_filter_kids_preferences`: preferred kids preference values.
- `user_filter_political_preferences`: preferred political values.
- `user_filter_pet_preferences`: preferred pet values.
- `user_filter_ethnicity_preferences`: preferred ethnicity values.
- `user_filter_pronoun_preferences`: preferred pronoun values.

## Social Graph & Memory Engine

- `user_interactions`: requests/comment-requests + feed memory actions (ignore/viewed) + request status lifecycle.
- `friendships`: accepted friendship pairs (normalized u1/u2).
- `blocks`: permanent user-to-user block exclusions.
- `reports`: moderation reports (profile/story/chat).

## Stories & Premium

- `stories`: story media entries with 24h expiry.
- `story_interactions`: views/likes/comments on stories.
- `story_replies`: story reply events with chat linkage reference.
- `chat_restrictions`: per pair 3-message limiter + unlock/cooldown state.
- `premium_boosts`: active boost windows for feed priority.
- `user_purchases`: paid events (unlock chat / boost / subscription).

## Chat + Account States

- `chat_threads`: chat container (direct/admin DM), creation source, last activity.
- `chat_thread_participants`: users participating in thread.
- `chat_messages`: message rows (text/system/story reply references).
- `chat_user_pair_preferences`: pair-level mute persistence.
- `chat_thread_user_state`: per-user inbox state (unread/reply badge/delete/chat-ended/deleted-account/access flags/sort helpers).
- `chat_unlock_events`: per-chat unlock purchase linkage.

## Compliance + Limits

- `user_daily_profile_view_usage`: strict daily counters for profile-view limit enforcement.
- `profile_view_events`: raw event log for profile opens by source.
- `customer_support_reports`: support tickets and status lifecycle.
- `moderation_actions_log`: structured moderation audit trail.
- `law_enforcement_disclosures_log`: legal disclosure audit.
- `notification_events`: user notification ledger (including silent events).

## Global Account/Visibility State in `users`

- `account_state`: ACTIVE / PAUSED / PRIVACY_MODE / HIDDEN_BY_MODERATION / DELETED / BANNED / UNDERAGE_BLOCKED
- `paused_until`
- `profile_hidden_at`
- `underage_until`
- `new_here_until`
- moderation warning counters
- `living_in_city_mode`: `FOLLOW_DEVICE` or `MANUAL_SWITCH` for current city behavior.
- Note: overlap booleans are removed by `007_account_state_cleanup.sql`; read account state from `account_state`.

