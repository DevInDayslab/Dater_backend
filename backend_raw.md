Backend of DATER app


1. Splash screen opens 
2. On the first page login page , the terms and conditions privacy policy add links and highlight 
3. What is your number screen, when user enters number check if user already registered or not , check if user banned or not , user < 18 or not (if user selects 17 then we will show you are under 18 come back later , and if user comes after 1 year then he is 18 and then we will allow but if user comes in a month then don’t allow).
4. Deleted users data keep for 6 months , one number can only be associated with one profile and if banned they stay out of the platform if deleted user comes back log him in as a new user 
5. Phone number , Photo , Account creation date , Account deletion date , IP address , Device Ids , Login Logout timestamps , Last location (GPS / ip based, user activities like friend request , bloc reports , chats , content meta data , sender receiver timestamps , message content , consent report (timestamp of term and condition acceptance i.e. account creation time, reports and flags report submissions against user or by user and their timestamps, verification document (selfie verification used by user and its timestamp) , payment transaction, customer support reports done by user , moderation actions(bans warnings etc with timestamp , flags and removal of content timestamps and records , law enforcement information given to them reports , login logout session data , last otp sent timestamps, ) - all these compulsory 
6. Next step otp verifies show under 18 or banned if applicable. Check user already existing user or new , show onboarding accordingly only if new user captcha screen shows only if multiple OTP attempts made and user is suspected spam
7. No screen should go back thru gesture in the auth / onboarding flow except screen with actual back button there.
8. For onboarding flow if user leaves onboarding in between I.e. doesn’t complete it keep his data for 7 days so that if he comes back in 7 days he should be at the step he left from and should not need to start over from step 1 
9. Every number has a unique id associated
10. On every step update detail in the database as we progress not together at once
11. Age selector - if selected under 18 then show under 18 blocked and save in records that this user was 17 on this particular date and will be allowed to use dater after another particular date when they turn 18 when they tap confirm on age confirmation save that timestamp as the time user agreed to being 18 years + of age 
12. The gender shown on the users profile would be the exact one chosen from the selector page , if trans woman is chosen show that not woman, show specific one , on show more bottom sheet when tapping a option doesn’t select the option tapping the save and close button selects it not just tapping it, state changes on tapping save and close basically 
13. Gender confirmation screen - show gender on profile button on by default , if turned off the gender section in full profile gets removed for this user completely with icon 
14. The who do you want to date page I.e. the preferences user selects during onboarding flow will be pre selected in the filters page (when user opens filter page for first time it should be there pre selected) so the profiles shown would match the same 
15. What You’re looking for page - this option comes in advance filter , user can select any of these options thru advance filter and their feed will be altered accordingly 
16. Photo section - drag and hold to reorder , and when user uploads photo there should be a frame as and overlay so user can select the part of the photo in an exact ratio so it fits in all our profile pictures used in the app , AWS reKognition to be implemented the photos uploaded to be matched with a selfie user takes at current time 
17. Minimum photo size 40kb , and max photo size 6 mb 
18. In the photo step once uploaded check for nudes harmful images weapons thru AWS REKOGNITION and if conditions failed I.e. its a nude or gun whatever then show the bottom sheet not verified and remove those image (your images have been removed screen) and tell them to upload good pictures 
19. Compress image while uploading 
20. Then martial status (to be used in advance filter , not preset)
21. Interest , reflect on main profile as much as selected if skipped they can add thru edit profile flow 
22. On lifestyle and basics the age selector keep 3 feet as default and if the position of it not changed from default then take is as not selected or not inputed by user I.e. they haven’t inputed their height same for all other options below as this page has option to skip they can later fill in edit profile and all these are to be used in advance filter as an option we can filter using these also if any selected they reflect directly in edit profile , if user selects or answers 2-3 sections instead of all and then skips then the selected / answered ones save them and should be kept as answered even if they skip same for interests section.
23. Be kind and respectful page terms and conditions and privacy policy add links and save its timestamp for accepting privacy policy and terms and conditions 
24. On location permission , if upped later don’t ask for permission if allow then ask for permission thru system, same for notification permission screen
25. If location not allowed show the enable location state on home and there then ask for permissions again 
26. If location permission is not allowed then no content comes just logo, no filter icon on top just the allow permission state user can use the nav bar to go to other screens also, this state will be opened then ask system level location and notify permission and then show the tile loading on Home Screen diff tile loading cards for each content like circle for story rectangular for cards so everything matches and after profile loading show the how dater works screen 
27. When user allows location permission  their coordinates are saved.
28. For searching user based on location search based on geo spacial algorithm so we don’t use query on full database just on the ones set in the particular distance from user according to filter but primary would be distance sorting geo spatial way so we have blocks not running query on full db.
29. When location permission is allowed then auto fetch the city / state and put that as users location I.e. Delhi DL , or Gurugram HR like this 
30. For stories - if any of the users preference hasn’t added a story then show the last no story state so those profiles 5 times in the story section tapping on this empty story state would open the users full profile view like it opens when we tap on a users card on home 
31. When story is viewed normal like WhatsApp , if users are friends then they reply which goes into chat and if not friends then user comments which is visible in the story activities part , user can only comment if they have active comments available and if they don’t then tapping send button in comment would open purchase comment page 
32. Like would be visible in chat if friends , if not friends then like visible in story activity.
33. If story is active and user does no activity on the story then it goes into the view, if user liked then his profile goes into liked your story section , if commented then it goes into commented section , if user commented and liked both then show commented not liked. So hierarchy would be comment > like > view. If user is In privacy mode then the view on story won’t be visible but if a privacy mode user likes or comments (does any activity by themselves then it will be visible)
34. Stories stay within preferences of user same as the profile cards 
35. User viewed stories will be the greyish outline circle 
36. If user see’s story and taps the name of the user then open the full profile , even thru this flow if user see’s a profile seen badge should be applied in the home feed and if any actions performed comment ignore request etc that should be in sync with the feed as it is the same exact profile 
37. User can report a story also , if 3 reports are made then 1 warning is sent to the user like 3 reports = 1 warning. If even 1 report on a story then remove story and 3 reports warning sent to user account if 2 consecutive warnings sent then on the 3rd one ban user from using the application. All these flows can be monitored overruled and even executed thru the admin panel , save data of all bans , reports , warnings that what was the reason what was the content that caused this etc.
38. When report made on story then show a bottom sheet that your story xyz posted x hours ago violated our terms “we have removed your story” to show the user that tnc hasn’t been followed and story removed because reported.
39. Add story - Plus button tapping share your story screen opens and if not verified then the bottom sheet of verified vibes only opens up else the upload story flow, if user has already been verified and have already had uploaded a story in the past then tapping + button won’t open the gradient page instead take directly to upload story flow.
40. Plus icon just for adding story if story active then tapping profile avatar opens users story and swiping up opens story activity page 
41. Max 5 story can be uploaded at the same time and 24 hours is lifeline of a story 
42. If 5 stories already there then tapping the plus icon opens up the pop up of edit profile minimum 2 photos required make it max 5 stories can be uploaded at a time pop up 
43. Story activity - opens up if user swipes up on self story content liked , commented view etc like we discussed above
44. Same from here if user taps on a profile open full profile page if user see’s the profile that should be visible in all states that seen or any action like comment ignore accept etc performed then should be in sync everywhere 
45. If already friend then the chat button there
46. If anyone here has story active then we can view story from here also 
47. Profile opens up tapping pfp or name etc 
48. The 0 views tab right now should be like Insta like after 999 it should e like 1k 1.1k like this 
49. Story data to be kept acc to govt data for 6 months 
50. For story view only stories that are inside our preference show them and order keep shuffle , no priority to friends 
51. While uploading user has option to toggle to whom he wants to show the story , only friends , all preferences etc 
52. Feed cards - tapping on a profile opens profile add ignore comment button there when opening for first time. If user taps add then profile closes and the friends request sent notification pill comes (story one) and the seen badge should be visible on all opened profiles
53. User taps profile - and taps ignore , then profile closes and ignore notification shown 
54. User opens profile taps comment - comment sent profile closes and the comment sent pill notification appears 
55. Only premium users can view seen profile again , if not premium then the premium paywall will open instead of full profile page 
56. Premium user opens a profile which they already added earlier - button states like: added comment ignore all deactivated 
57. (Basically when user sends a comment thru profile they are sending a friend request with a text note and the user that receives it will see option to accept or reject same like a normal friend request)
58. If premium user again opens a seen profile and he hadn’t made any action earlier on it then all buttons stay same active 
59. If user had already seen a profile and added or commented then all three buttons deactivated , it can be either added or commented as both perform similar role 
60. If user had ignored the profile last time then add and comment buttons will stay active and ignore will be inactive 
61. Suggested for you section show max 10 profiles same all mechanism seen etc 
62. For free user they can only see 20 profiles in 24 hours , if they tap on the 21st profile then show the view unlimited profiles gradient page redirect to premium etc if user doesn’t buy then the timer pill on homepage will start. If user taps the timer then directly show premium purchase paywall 
63. Premium user can view unlimited profiles 
64. Suggested for you section comes just once after first 10 profiles so total 10 as card and 10 in suggested for you section are required ,  if we don’t have minimum 30 profiles after applying filters preferences etc don’t show this suggested for you section as it will be weirdly placed 
65. Verify banner only show to those that don’t have a verified profile first occurrence after 6 profiles after suggested for you section if number of profiles < 30 so suggested for you section not there then show the verify yourself banner after 10 profiles 
66. If user verified then same position as verified badge everywhere all condition and don’t show verify yourself badge in this case.  Boost banner will be visible to all users except ones with active boost position if verify badge is also there I.e. user isn’t verified nor has active boost then the boost banner show 12 profiles after verify yourself badge. If suggested for you is not shown I.e. profiles < 30 then verify show after 10 profiles and if user. if user not verified ad profiles less than 30 then don’t show boost banner.
67. Initially load 50 profiles on first load together 
68. As user scrolls at the end start pre load at 35th profiles for next 50 and if user scrolls till end before profiles loaded then show title loading indicator towards end gracefully 
69. Filter page - Filter who you want to date options should be preselected by default like user selected in onboarding 
70. Age default +-5 from users age max age 80 and min age 18 on onboarding also make this 18 - 80 age selector slider gap bw min and max stays minimum 4 so gap between lower end of age spectrum and higher end should be at least 4 all the time 
71. Expand age range if needed checked by default - it expands the age range to load maximum profiles minimum 50 required and expand on both sides lower and upper slider won’t change that will stay same just backend will show profiles in feed this way 
72. Distance - shows distance acc to city like Gurugram if set 40k range will see Delhi, distance would be the primary filter other preferences will be set after this expand distance checked by default same works as expand age , progressive search geo spatial. Max limit 150+, minimum 2 , default 20.
73.  Location - switch city only for premium users user selects a city like Gurugram then the location distance calculated for other profiles are calculated from this city so I will see people around there  and switch city state in profile will be visible, similarly I can select kerela and I will see profiles around Kerela only in my distance range , if user not premium then location page save and close should be paywall , if user had premium and had applied switch city and the premium expired then shift to current city automatically.
74. City name in this section only appears when switch city is applied otherwise show current location.
75. Languages - only show profiles with any of selected languages languages filter is free
76. If user themself isn’t verified then prompt to verify their profile oterhwise togglee button turns on and applying will show verified profiles only
77. Advance filter only for premium users when user clicks save and close if not premium then prompt for dater premium paywall 
78. In Filter page and advance filter page the bottom cta buttons will only be there only if some changes applied to the existing setup.
79. On adv filter show other people if I run out button on by default 
80. My profile - percentage progress bar for how much profile completed verified badge if verified otherwise grey badge 
81. Privacy mode badge show if active thru settings , account paused if paused thru settings , profile hidden if aws verification didn’t match (hidden by admin)
82. If none of these badges active then the content below moved up a bit 
83. If comment and boost available show availability like shown in comment right now otherwise show price like shown in boost rn
84. Active boost state loader timer 
85. Upgrade premium paywall , if already bought then active until button from Figma 
86. Settings - hide my name: every occurrence of name show only first letter 
87. Privacy mode premium feature if not premium feature then redirect to paywall , and if premium user then profile hidden from feed of user but this user can view any profile and apply filters etc , only thru notification request etc their profile can be accessed , thru feed nobody can view their profile no matter they uploaded story etc also story will only be visible to friend add story option upload to all will be removed 
88. Pause account - profile of user hidden and feed section pause state shown they can’t see feed and won’t be seen in feed but can chat etc this will be according to timer If timer chosen or if until I resume option tapped then unpause manually 
89. When logged out then profile visibility on last location
90. Delete account - proper delete no visible anywhere etc 
91. On friends page the sort by near by acc to coordinates   MAIN ALGORITHM 

92.  Filter will play main role in the feed algorithm and the distance  chosen by users -> main primary point is distance 
93. If man is looking for woman and woman looking for man then only show profile to each other considering other constraints also set accordingly 
94. If my gender is selected in the filter of the other person then only show my profile to them and vice versa should be true , I.e. both user’s preferences should be complimentary to each other i.e. my gender should be selected in their filter section and their gender in mine 
95. For age also keep mutual satisfactory algo - if user age is 30 and user looking for age 18 to 40 , then show profiles which have filter range in which my age is there i.e. their age preference range can be 20-35, 25-32 but if their age range preference is 41-50 then the profile will not be shown to me and neither mine shown to her.
96. In notification centre only show request from the gender in my preference , so if I have male as the chosen gender preference then just show requests from male profiles just based on gender no other criteria not age not language nothing just based on gender.
97. In feed we won’t show profiles that are paused , privacy mode , if profile hidden, If already a friend , if I blocked user & if user blocked me both cases don’t show profile , deleted profile won’t be visible , already seen profiles won’t be shown again for 30 days to the same user soft hide mechanism , once the 30 days pass then show it as a fresh profile I.e. the seen badge will be gone in 30 days ,also if I ignored a profile soft hide it for 30 days then show again afterwards as a fresh profile. 
98.  if the other user already ignored me then don’t show their profile to me.
99. If user thru inter marked show verified profiles only then show verified profiles only
100. The “new” badge on user profile will be there for 72 hours       
101. ORDER OF PROFILES IN FEED: logic will be based on points below What if 2 and more profiles have same score? Shuffle.
Category	Possible Values / Range	Points / Score
Boost Status	Yes	100
	No	0
User Active Status	Online	40
	Active within 5 minutes	35
	Active within 30 minutes	30
	Active within 1 hour	25
	Active within 1 day	20
	Active within 3 days	15
	Active within 1 week	10
	Active within 1 month	5
	More than 1 month ago	0
Profile Completion	0% to 100%	Profile Completion % × 0.3
New Here Badge	Yes (Max 2 days)	10
	No	0
Premium User	Yes	15
	No	0


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



  102. Suggested for you section what profiles to show - profiles matching my interests / basics and lifestyles and what you are looking for , martial status , languages etc show in suggested for you  So thru algorithm we get a list of people matching requirement , then thru the scoring we create order , then thru this interest etc matching we position in suggested for you 




	CHATPAGE 
103.  Reply badge shown on the chat cards user hasn’t replied to yet on both seen and not seen messages 
104.  The mute button when activated the the users notifications won’t come same mechanism like WhatsApp no badges in app also and no push notification for muted chats
105.  Chat delete - delete the chat (but keep record on the db just delete it for the user)
106.  If a mute chat deleted and the other user texts again still it will stay muted until unmute operation is done by user 
107.  Haptic feedback on muting a person and unmuting a person
108.  Search bar - cans search any chat like WhatsApp mechanism 
109.  Sort messages by - by default recent , nearby: least distance up and most down , unread: unread messages all up , unanswered: all unanswered move up 
110.  In particular chat page - tapping name opens full profile , if uploaded story show story circle - tapping opens story view
111.  3 dots tapping unfriend , Block , report same mechanism standard 
112.  As soon as u1 unfriends u2 then remove u2 from friends chat everywhere for u1 , and for u2 in chat show chat ended state and on 3 dots option remove report option this state would be there for 3 days then remove from u2 chat also and this would have been gotten removed same time from u2s friendlist also this state u2 can’t view u1s profile thru chat also.
113.  Deleted account state - u2 will see deleted account state for chat and can’t view users profile   
114. Unlock this chat mechanism - this restriction is just for male user , a male user can send only 3 messages per chat , when he types 4th message and taps send button then show the unlock unlimited messages screen gradient one and tapping it they can go buy premium , if they purchase thru this flow then user comes back into this chat and the message they typed and sent will be sent now. But if user does not buy the premium and he comes back to this chat then the unlock this chat badge appears on this chat , this badge stays for 1 hours that means chat locked for 1 hour and after 1 hour again he can send 3 messages.
115.  If user taps the timer pill in the chat unlock this chat for rs 99 and he pays then this particular chat will be unlocked this is not premium this is just unlocking this chat won’t apply to others just this particular chat will become unlimited 
116.  Keep this limited chat mechanism for Male to female (applied to male) , non binary to female (applied to non binary) ,  Male to Male applied to both sides  , male to non binary applied to both sides ,,, [female to female no restriction] 
117.  Replying to a message add haptic 
118.  Unfriended chats , deleted account , chat ended would be at the bottom , sorted by latest 
119. Option to message a user as the company thru admin panel this will be in their messages page DM only      EditProfile 
120.  Hold and drag mechanism for photos , minimum 2 photos required no nude allowed etc same as onboarding do this thru AWS rekognition  progress bar moved live as user fills out details 
121. Verify profile - take photo system , liveness detection , verify with photo uploaded and actual person there 
122. If profile of user hidden by admins , then all pages will show the hidden profile state except profile page , upload photo will be shown so they upload their real photo with the already stored selfie 
123.  You are not verified try again option also if selfie blur etc
124. If any options in basics profile or any tab already selected in onboarding so pre select them here also 
125.  Preset message - if u1 sent friend request to u2 and u2 accepts , u2 had preset message set then on a accepting friend request then automatically chat starts and preset message sent in chat like a normal message  2nd condition of this when both u1 and u2 have preset message then the one accepting the friend request will send the preset message.
126.  Pick a prompt , when we already have selected one prompt and answered it then in next time that won’t be an option to answer I.e. you can answer one prompt one time only.
127. Rest fields simple just input them etc.
128.  In current city and hometown in edit profile the current city option won’t be there these will be in filter flow only 
129.  In languages in edit profile the already selected options should come at the top rest alphabetically.
130. Full profile view :- jis section k option profile me selected/added nahi hai wo field/section completely hide rahega.
131. View 20 profiles limit also includes story section profile views and story activities section profile views. Show “View full profiles in” timer badge on story activities screen like feed section if user has viewed 20 profiles.
132. Write comment:- show available comments count on top right badge. If comments not available show “0 comments available” badge once and then hide.    