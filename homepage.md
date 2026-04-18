I. Homepage Feed Mechanics & UI

Initial Load: The feed fetches 50 profiles initially.

Pagination: Pre-loading for the next 50 profiles begins gracefully when the user scrolls to the 35th profile.

Location Gate: If location permission is denied, the feed shows an empty state (just the logo) with an "Enable Location" prompt. No content or filters load until granted.

Free Tier Limits: Free users are capped at 20 profile views per 24 hours. Viewing full profiles via the story section counts toward this limit.

Paywall Trigger: Tapping the 21st profile triggers the "View unlimited profiles" gradient paywall. If dismissed, a timer pill appears on the home screen.

Card Actions: Tapping a profile opens the full view with "Add", "Ignore", and "Comment" buttons.

Action Syncing: Actions trigger respective notification pills ("friend request sent", "comment sent"). A "Seen" badge is applied and syncs across all instances of that profile (feed, stories, activities).

Revisiting Profiles (Premium Only): Premium users can reopen seen profiles. If they previously Added/Commented, all buttons are deactivated. If they previously Ignored, the Add/Comment buttons reactivate.

II. Feed Layout & Dynamic Banners (Canonical Placement Contract)

Placement is computed from total candidate inventory after filters (`allCandidates`) and applies once per feed page composition.

Suggested For You:

- Frequency: Exactly once.
- Placement: `insertAfterCards = 10` (after 10 regular cards).
- Condition: Only render when `allCandidates >= 30`.
- Payload size: Up to 10 profiles.

Verify Banner:

- Frequency: Exactly once.
- Condition: Only for unverified users.
- Placement when Suggested exists (`allCandidates >= 30`): `insertAfterCards = 16` (6 cards after Suggested insertion point).
- Placement when Suggested is hidden (`allCandidates < 30`): `insertAfterCards = 10`.

Boost Banner:

- Frequency: Exactly once.
- Global lockout: Never show while user has an active boost.
- Unverified + low inventory lockout: If user is unverified and `allCandidates < 30`, hide the banner.
- Placement in normal inventory flow: `insertAfterCards = 28` (12 cards after Verify at 16).
- Verified fallback placement (no Verify banner in stack): `insertAfterCards = 22`.

III. The Filter Section & Mutual Matching Rules

Default State: Pre-populated using the "Who do you want to date" choices from onboarding.

Mutual Consent Rule: Gender preferences must be complimentary. Age must be mutually satisfactory (User A must fall in User B's age range, and vice versa).

Primary Filter (Distance): Uses geospatial blocks to sort nearby users rather than querying the full database. Default is 20 units, minimum 2, maximum 150+. "Expand distance" is checked by default.

Age Range: Defaults to +/- 5 years from the user's age. Absolute boundaries are 18 to 80. The UI slider enforces a minimum 4-year gap at all times. "Expand age range" is checked by default.

Premium Filters: "Switch City" (calculates distance from a mocked city like Gurugram instead of current GPS) and "Advance Filters" (lifestyle, what you are looking for) are strictly paywalled.

Verified Only Toggle: Free to use, but the user themselves must be verified to activate it.

Exclusions: The feed will permanently or temporarily hide users who are: paused, hidden, deleted, in privacy mode, already friends, mutually blocked, or soft-hidden (previously seen/ignored profiles are hidden for 30 days before returning as fresh).

IV. The Story Ecosystem

Visibility: Stories are drawn from all mutual preferences, not just friends. Order is shuffled with no priority given to friends.

Empty States: If a preferred user has no active story, an empty ring is shown (up to 5 times in the feed). Tapping it opens their full profile.

View Limits: Maximum of 5 active stories per user. Lifespan is exactly 24 hours. Retained on the backend for 6 months for legal compliance.

Upload Rules: Requires a verified profile. Tapping the "+" icon for unverified users triggers the "Verified Vibes Only" block. Users can toggle audience visibility (friends only vs. all preferences).

Interactions: Friends can reply/like, which pushes to the Chat page. Non-friends can like or comment (costs comment quota), which pushes to the creator's Story Activity page.

Story Activity Hierarchy: Prioritizes high-value actions to prevent duplicates. Hierarchy is Comment > Like > View.

Privacy Mode Views: Passive views from Premium Privacy Mode users are invisible unless they actively leave a Like or Comment.

Moderation: 1 report instantly removes the story and alerts the user. 3 reports equal 1 formal warning. 2 consecutive warnings lead to a permanent ban on the 3rd offense.

V. The Main Feed Algorithm (Scoring Logic)

After profiles pass the mutual filter gates, they are ranked based on a 195-point system. Ties are broken via shuffling.

Category	Condition	Points Awarded
Boost	Active Boost	100
Activity Status	Online	40
Active < 5 mins	35
Active < 30 mins	30
Active < 1 hour	25
Active < 1 day	20
Active < 3 days	15
Active < 1 week	10
Active < 1 month	5
Active > 1 month	0
Completion	Profile Completion %	% multiplied by 0.3
New User	"New Here" Badge Active	10
Premium	Active Premium	15
Profile Completion Percentage Breakdown:

Photos: 24% (4% each up to 6)

Verify Profile: 10%

Basics & Lifestyle: 20% (2% per field, 10 fields)

Written Prompts: 12% (4% each up to 3)

Looking For: 6% (3% each up to 2)

Interests: 5% (1% each up to 5)

Bio: 5%

Preset Message: 2%

Marital Status: 2%

Languages: 2%

Ethnicity: 2%

Pronouns: 2%

Occupation: 2%

Education: 2%

Current City: 2%

Hometown: 2%


1. The "Heartbeat" (Active Status Tracking)

Your scoring algorithm gives a massive 40 points for being "Online" and scales down based on minutes/hours.

What's missing: How does the backend actually know they are online?

The Fix: You need a heartbeat mechanism. Either establish a WebSocket connection when the app opens, or have the Android app silently ping a POST /api/v1/users/me/heartbeat endpoint every 3-5 minutes while the app is in the foreground to update their last_active timestamp.

2. The "End of the Line" (Zero Profiles State)

You have the "Expand Age/Distance" toggles to prevent running out of profiles, but eventually, a user will hit the bottom of the database.

What's missing: What does the UI show when the array of 50 pre-loaded profiles hits 0?

The Fix: You need a specific "Global Empty State" design. Usually, this is a screen saying "You've seen everyone nearby! Check back later or adjust your filters," accompanied by an animation so the app doesn't just look frozen.

3. The 24-Hour Timer Anchor (Free Tier Limit)

Free users get 20 profiles per 24 hours.

What's missing: Is this a hard reset at midnight, or a rolling 24-hour window?

The Fix: For a rolling window (which is standard), your backend needs to log the exact timestamp of their 1st profile view of the day. The timer pill on the homepage needs to count down exactly 24 hours from that specific timestamp, not just reset at 12:00 AM.