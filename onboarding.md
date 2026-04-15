Phone Number Gate: * One phone number = exactly one unique profile/ID.

Check if the user is Registered, Banned, or Under 18.

Banned Users: Blocked permanently from entering the platform.

Deleted Users: If a user who deleted their account returns, they are treated as a completely new user. (Note: Retain their old deleted data for 6 months per compliance).

The Age Gate (< 18 Logic):

If a user selects an age under 18 (e.g., 17), block them and show "Under 18, come back later."

Record the exact date they attempted to join. Calculate and store the exact date they turn 18.

If they try to log in before that date, block them. If they return after that date, allow them in.

When they finally confirm they are 18+, save that exact timestamp.

OTP & Captcha:

Show underage or banned states after OTP verification if applicable.

Route to either Home (existing user) or Onboarding (new user).

Captcha: Only trigger if the backend detects multiple OTP attempts (suspected spam).

Navigation Lock: Disable gesture-based "swipe back" entirely during Auth/Onboarding. Users must only use the physical UI back buttons on the screen.

2. Onboarding Data & State Management

Progressive Saving: Update the database at every single step as the user progresses. Do not wait to save everything at the end.

7-Day Retention Rule: If a user drops off mid-onboarding, save their exact state. If they return within 7 days, resume from that exact step. If they return after 7 days, wipe it and start from Step 1.

Mandatory Data Tracking: You must capture and timestamp the following upon account creation:

Phone number, IP address, Device IDs, Account creation date.

Consent report (exact timestamp of T&C / Privacy Policy acceptance).

Verification document timestamp (when the selfie is processed).

3. Profile Creation Inputs

Gender:

Save exactly what is chosen (e.g., "Trans Woman", not just "Woman").

UI State Change: Selections only register when the user taps "Save and Close" on the bottom sheet, not just when tapping the option.

Visibility: Gender is shown on the profile by default. If the user toggles it off on the confirmation screen, remove the gender section and icon from their full profile completely.

Dating Preferences: The "Who do you want to date" selection must automatically pre-populate the user's Main Feed Filters.

Basics & Lifestyle:

Default Values: Sliders (like Height defaulting to 3 feet) should be treated as "Not Inputted" if the user doesn't physically change them from the default position.

Partial Skips: If a user answers 2-3 fields but skips the rest of the page, save the answered ones and leave the rest blank.

Be Kind Screen: Add links to T&C and Privacy Policy here again and log the acceptance timestamp.

4. Photo Upload & AWS Rekognition

File Constraints: Minimum 40 KB, Maximum 6 MB. Images must be compressed during upload.

UI Requirements: Drag-and-hold to reorder. Enforce an overlay frame so users crop their photos to the exact aspect ratio needed for Dater's UI.

AWS Rekognition (Mandatory):

Content Moderation: Scan immediately for nudes, weapons, or harmful imagery.

Failure Flow: If flagged, show a "Not Verified" bottom sheet, display a "Your images have been removed" screen, delete the flagged uploads, and force them to upload safe pictures.

Liveness/Matching: The uploaded profile photos must be matched against a live selfie taken by the user at that time.

5. OS Permissions & First Load

Location & Notifications: * If denied initially, do not spam system requests. Show an "Enable Location" state.

Denied Location State: The app loads an empty state (just the Dater logo, no content, no filter icons). The nav bar still works. If they try to access feeds, trigger the system-level permission prompt again.

Allowed Location State: Save their exact coordinates (for the geospatial algorithm). Auto-fetch and display their City/State (e.g., "Delhi DL" or "Gurugram HR").

Home Feed Initialization: After permissions are granted, load the skeleton UI (circles for stories, rectangles for cards) so everything matches the layout, then overlay the "How Dater Works" tutorial screen before revealing the actual profiles.