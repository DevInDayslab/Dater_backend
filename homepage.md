1. The Core Feed Algorithm (Filtering & Filtering)

Before a profile even gets scored, it must pass the strict mutual filtering system.

Primary Filter (Geospatial Distance): The algorithm prioritizes distance sorting using spatial algorithms. Searches are restricted to a set radius (default 20km, max 150+ km, min 2km) from the user's location (or their "Switch City" location if Premium).

The Mutual Consent Rule: The algorithm is strictly mutually satisfactory.

Gender: User A will only see User B if User A's gender preference includes User B AND User B's gender preference includes User A.

Age: User A's actual age must fall within User B's preferred age range, and vice versa.

Exclusions (Who NOT to show):

Accounts that are Paused, Banned, or Deleted.

Profiles in Privacy Mode or Hidden by Admins.

Existing friends.

Blocked users (mutual block enforcement).

Soft-Hides (30-Day Rule): If a user has already "Seen" a profile or explicitly hit "Ignore," that profile is hidden from their feed for exactly 30 days. After 30 days, it returns as a fresh profile.

2. Profile Scoring & Feed Order

Once the pool of valid profiles is determined, they are ordered based on a scoring system. If two profiles have the exact same score, they are shuffled.

Scoring Category	Condition / Range	Points Awarded
Boost Status	Active Boost	100 points
User Activity	Online	40 points
Active within 5 mins	35 points
Active within 30 mins	30 points
Active within 1 hr	25 points
Active within 1 day	20 points
Active within 3 days	15 points
Active within 1 week	10 points
Active within 1 month	5 points
> 1 month ago	0 points
Profile Completion	0% to 100% completed	% × 0.3 (Max 30 points)
New Here Badge	Account < 72 hours old	10 points
Premium User	Active Premium	15 points
3. Feed Layout, Limits & Banners

The feed loads dynamically and intersperses specific sections and banners based on strict positional rules.

Loading Constraints: Initially loads 50 profiles. Once the user scrolls to the 35th profile, the backend pre-loads the next 50.

Free Tier Limit: Free users can only view 20 profiles per 24 hours (Note: Viewing full profiles via the Story feed counts toward this limit). Hitting the limit triggers a timer pill and a Premium paywall.

Suggested For You Section:

Shows a max of 10 profiles that highly match the user's explicit interests, basics, lifestyle, and "looking for" tags.

Appears exactly once, right after the first 10 normal feed cards.

Condition: Only appears if there are at least 30 valid profiles available in the feed overall.

Verify Banner:

Shown only to unverified users.

Appears 6 profiles after the "Suggested for you" section. (If the Suggested section wasn't shown due to low inventory, it appears after the 10th normal profile).

Boost Banner:

Shown to users who don't currently have an active boost.

Appears 12 profiles after the Verify banner. (If the Verify banner wasn't shown, adjust accordingly. If inventory is < 30 profiles and the user isn't verified, hide the boost banner entirely).

4. Profile Interactions (Add, Ignore, Comment)

When a user taps a card in the feed, it opens the full profile with three main actions. These actions sync universally (e.g., if you do this from a Story, it updates the Feed).

Add: Sends a standard friend request. The profile closes, and an "Add" notification pill appears.

Comment: Acts as a friend request with a text note. The profile closes, and a "Comment sent" pill appears. (Deducted from available comments quota).

Ignore: Soft-hides the profile for 30 days.

Revisiting Seen Profiles (Premium Only): Free users cannot open profiles they've already swiped on. Premium users can. If they open an old profile:

If they previously Added or Commented: All action buttons are deactivated.

If they previously Ignored: The "Add" and "Comment" buttons become active again, but "Ignore" remains deactivated.

5. The Story Algorithm & Mechanics

Stories have their own distinct ecosystem, mixing WhatsApp-style viewing with algorithmic feed rules.

Visibility & Ordering:

Lifespan is 24 hours, max 5 stories active at once.

Must be a verified user to upload (unverified users hit a "Verified Vibes Only" gate).

Stories are shown from everyone in your mutual filter preferences, not just friends. They are shuffled with no priority given to friends.

View count formats identically to Instagram (999 -> 1k -> 1.1k).

Empty States: If a user in your preferences hasn't uploaded a story, they appear as a blank story ring (up to 5 profiles). Tapping this acts as a shortcut to their full profile.

Interactions based on Relationship:

Friends: Replies and Likes behave like WhatsApp and go directly into the private Chat.

Non-Friends: Comments cost a "comment credit." Comments and Likes go to the creator's "Story Activity" page.

Story Activity Hierarchy (For the Creator):

If a viewer performs multiple actions, only the highest tier is shown to prevent spam. The hierarchy is: Comment > Like > View.

Privacy Mode Exception: If a viewer has Premium Privacy Mode on, their passive "View" is invisible. However, if they actively Like or Comment, they reveal themselves in the activity list.

Moderation & Bans:

If a story gets 1 report, it is immediately removed, and the user gets a notification.

3 removed stories = 1 account warning.

2 consecutive warnings = The 3rd warning results in an absolute platform ban.


Profile Completion section scores-

Section Number	Section Name	Percentage	Sub-items / Description
1	Photos	24%	6 photos (4% each)
2	Verify profile	10%	
3	Basics & Lifestyle	20%	10 fields (Split 2% each)
4	Preset message	2%	
5	looking for	6%	Can choose upto 2. (Split 3% each)
6	Interests	5%	Up to 5 interests (1% each)
7	Bio	5%	
8	Marital Status	2%	
9	Languages	2%	
10	Written Prompts	12%	Up to 3 prompts (4% each)
11	Ethnicity	2%	
12	Pronouns	2%	
13	Occupation	2%	
14	Education (Institution name)	2%	
15	Current City	2%	
16	Hometown City	2%	