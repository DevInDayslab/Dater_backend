DATER APP: BACKEND SYSTEM REQUIREMENT DOCUMENT (SRD)
1. GLOBAL COMPLIANCE & DATA RETENTION
6-Month Cold Storage: Deleted user data must be kept for 6 months (Govt compliance). If a deleted user returns, log them in as a completely new user.

7-Day Onboarding Memory: If a user abandons the onboarding flow, keep their state (onboarding_step) for exactly 7 days. If they return within 7 days, resume from the exact step.

Banned Users: One phone number = one profile. Banned users are permanently blacklisted and kept in the DB to prevent re-registration.

Session & Activity Logging (Compulsory): Must track: Phone, Photo, Account creation/deletion dates, IP address, Device IDs, Login/Logout timestamps, Last location (GPS/IP), sender/receiver timestamps for chats, consent timestamp (T&C acceptance), verification document timestamp, customer support reports, and moderation actions.

2. AUTHENTICATION & ONBOARDING
Phone & OTP (MSG91): Check if user is registered, banned, or under 18. CAPTCHA required if multiple suspected spam attempts occur.

Strict Age Gate (18+): * If a user selects an age < 18 (e.g., 17), block them.

Logic: Calculate exact date they turn 18. If they return after that date, allow them. If they return before, keep them blocked.

Save the exact timestamp of when they confirm they are 18+.

Incremental DB Updates: Save data at each step of onboarding, not all at once at the end.

Gender Selection: Store the exact string chosen (e.g., "Trans Woman", not just "Woman"). Toggle for "Show gender on profile" (default on).

Location Initialization: If permission allowed, save PostGIS coordinates and auto-fetch City/State (e.g., Delhi DL). If denied, serve an "Enable Location" UI state; no feed content loads.

3. MEDIA PIPELINE (AWS S3 + REKOGNITION)
Requires minimum 2 profile photos are required to make a profile
Upload Limits: Min size 40kb, Max size 6mb. Backend must auto-compress.

Automated Moderation (Rekognition): Scan all uploads for Nudity/Weapons. If failed, immediately delete from S3 and trigger "Images removed / Not verified" bottom sheet.

Profile Verification: Liveness detection. Compare uploaded profile photos against a real-time selfie using Rekognition (CompareFaces).

Stories: Max 5 active at a time. 24-hour exact lifespan. 

4. THE FEED ALGORITHM (POSTGIS MATCHING)
Primary Filter: Distance (Geo-spatial PostGIS query). Default 20km, Min 2km, Max 150km+.

Mutual Exclusion (CRITICAL): User A is only shown to User B if:

User A's gender is in User B's preferences.

User B's gender is in User A's preferences.

User A's age is within User B's requested age range.

User B's age is within User A's requested age range.

Exclusion Rules (Do NOT show profiles if):

Paused, Privacy Mode active, Admin Hidden.

Already a friend, Blocked (mutual), or Deleted.

30-Day Soft Hide: If User A has seen or ignored User B, hide User B from User A's feed for 30 days. After 30 days, show as a fresh profile.

Pagination: Load 50 profiles initially. Start pre-fetching the next 50 when the user hits the 35th card.

Suggested For You: Inserted exactly once after the first 10 cards. Requires a minimum pool of 30 matching profiles to activate. Ordered by matching interests, basics, and lifestyle.

5. FEED SCORING SYSTEM (ORDERING)
Sort valid profiles based on the sum of these points. If tied, shuffle.

Boost Status: Active (100 pts) | Inactive (0 pts)

Active Status: Online (40) | < 5m (35) | < 30m (30) | < 1h (25) | < 1d (20) | < 3d (15) | < 1w (10) | < 1m (5) | > 1m (0)

Profile Completion: (Percentage 0-100) * 0.3

New Badge: Active for first 72 hours (10 pts) | No (0 pts)

Premium User: Yes (15 pts) | No (0 pts)

Profile Completion Breakdown (Max 100%): Photos (24%), Verify Profile (10%), Basics/Lifestyle (20%), Preset Msg (2%), Looking For (6%), Interests (5%), Bio (5%), Marital (2%), Languages (2%), Prompts (12%), Ethnicity (2%), Pronouns (2%), Occupation (2%), Education (2%), Current City (2%), Hometown (2%).

6. CHAT & SOCIAL GRAPH (WEBSOCKETS)
Action Flow: Sending a comment from a profile acts as a Friend Request with a text note.

Story Interactions: Hierarchy is Comment > Like > View. (Views are hidden if user is in Privacy Mode, but active Likes/Comments are always shown).

Chat Sorting: Default (Recent) | Nearby (Shortest distance) | Unread | Unanswered.

Chat Deletion/Unfriend: If U1 unfriends U2, chat vanishes for U1 immediately. For U2, show "Chat Ended" state with report option removed for 3 days, then completely remove.

The Gender Chat Lock (Male Restriction):

Male -> Female OR Male -> Non-Binary.

Male user can send a maximum of 3 messages per chat.

On 4th attempt, trigger Premium Paywall or "Unlock this chat for Rs 99" (1-hour lock if ignored).

Female -> Female has NO restriction.

7. PREMIUM & LIMITATIONS
Free Users: Hard limit of 20 profile views per 24 hours (includes feed, story views, and story activity views). Triggers timer/paywall on the 21st view.

Premium Users: Unlimited views. Can re-view "Seen" profiles (Add, Comment, Ignore buttons update state dynamically based on past actions). Can change location city (calculate distance from the new mock coordinates).

Privacy Mode (Premium): Profile hidden from the main feed entirely. Can only be discovered via outbound requests/comments. Cannot post public stories (Friends only).

8. MODERATION & REPORTING
Story Strikes: 1 Report = Story removed + 1 Warning. 2 consecutive warnings = Ban on 3rd offense.

Admin Panel Sync: All bans, reports, warnings, content flags, and law enforcement requests must be logged with timestamps and reasons for admin review.