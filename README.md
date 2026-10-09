# KoolKat

A private, Snapchat alternative. You take photos in the app with the front or rear camera, add a caption, and send them to friends as **Klicks**. Klicks are **end-to-end encrypted**, can only go to **friends**, and stay saved so you can view them again. Sending each other Klicks every day builds **streaks**, and you can **chat** with friends one-on-one or in groups.

## Features

Photos taken in KoolKat are called **Klicks**.

- **Accounts.** Sign up and sign in with a username and password. Sessions persist across reloads.
- **Friends.** Search by username, send, accept, ignore or cancel requests, and remove friends. Adding someone who already added you accepts their request.
- **QR code friending.** 🔳 *Friends → My QR code* (or *Profile → My QR code*) shows your code. A friend taps *Friends → Scan QR*, or points their phone's normal camera at it, and you're friends straight away, with no request to accept. The code changes every few minutes and stops working after 10, so an old screenshot can't be used to add you.
- **Nearby.** 📍 *Friends → Nearby* lists people about 150 m from you who have Nearby open at the same moment; tap **Add** to send a request. It uses your phone's location (Bluetooth isn't available to web apps). Your location is only sent while the screen is open, is held in the server's memory for at most 2 minutes, is never saved, and is never shown to anyone: others only see your name.
- **Friends-only.** The server refuses to deliver a Klick to anyone who isn't an accepted friend. It also refuses to let a recipient download a Klick after the two of them stop being friends.
- **Camera.** Uses the front or rear camera with a flip button. Selfies are mirrored like a normal selfie camera.
- **KatCam.** 😺 The two-camera button on the camera screen puts both cameras in one Klick: the back camera fills the picture and your selfie sits in the corner (flip swaps them). If the phone can run both cameras at once you see both live. Most phones can't, so KatCam takes the second picture right after the first ("Now smile! 📸"). It's sent as one normal, end-to-end encrypted Klick.
- **Captions.** Tap the photo to add a caption, and tap somewhere else to move it. Long captions (up to 150 characters) wrap onto more lines. The caption is encrypted along with the photo.
- **Saved Klicks.** Klicks you receive stay in your inbox, so you can open them again whenever you like. They stay end-to-end encrypted, and only the friends a Klick was sent to can open it. If you unfriend someone, their Klicks are hidden until you're friends again.
- **View your own Klicks.** Each Klick is also encrypted for you, so you can open it again from *Klicks → Sent*. As the sender, deleting a Klick removes it for everyone.
- **Deleting Klicks.** Open a Klick and tap 🗑 to remove it from your inbox. Once every recipient has deleted it, the encrypted data is removed from the server for good.
- **Favorites.** ⭐ Tap the star on any Klick (received or sent) to favorite it. The ★ button on the home screen shows all your favorites.
- **Chats.** 💬 Message any friend from *Chats → New chat*, or the **Message** button on their friend card. Messages are end-to-end encrypted like Klicks: each message has its own key, wrapped for each person in the chat.
- **Group chats.** 👥 *Chats → New group*: pick at least 2 friends and optionally a name. Anyone in the group can rename it, add their own friends, or leave. People who join later only see messages sent after they joined. (The group *name* isn't encrypted; messages are.)
- **Calls and FaceTime.** 📞 Voice **Calls** and 📹 **FaceTime** (video) with any friend: tap the phone or camera button at the top of a chat, or *Call* / *FaceTime* on their friend card. Answer or decline on the incoming-call screen; during a call you can mute, and on FaceTime turn your camera off or flip it. The sound and picture go straight between the two phones, encrypted by WebRTC, and the messages that set the call up are end-to-end encrypted with your KoolKat keys, so the server can't listen in or join. If KoolKat is closed, an incoming call arrives as a notification that stays on screen until you tap it (with notifications turned on); calls you don't answer within 45 seconds show as missed. Calls are one-to-one.
- **Sounds.** 🔔 `koolkat_notification.wav` plays for new Klicks, messages and friend requests while KoolKat is open, and `koolkat_calling.wav` rings while you're calling someone and when a Call or FaceTime comes in. Turn the notification sound off in your profile (calls still ring). When KoolKat is closed, your phone plays its normal notification sound: websites can't choose that.
- **Streaks.** 🔥 A streak grows by one for each day both friends send each other a Klick. ⌛ means you'll lose it if you don't both send one today. A missed day resets it.
- **Sent view.** Shows "Delivered" or "Opened" for Klicks you've sent.
- **Push notifications.** 🔔 Get notified about new Klicks, messages, friend requests, accepted requests, and streaks that are about to end. Turn them on from the banner on the Klicks screen or in your profile. Notifications only say *who* sent something, never what.
- **News.** 📣 The megaphone button on the home screen opens News: codes, events and updates posted by admins. Posts can include a code with a one-tap **Redeem** button. A badge shows when there's something new. Admins can add **one photo or video** to a post (*Add photo or video* when writing it): photos up to 15 MB (JPEG, PNG, GIF, WebP), videos up to 100 MB (MP4 plays everywhere; MOV and WebM too, where the phone supports them). Files are kept in a `media` folder next to the database, so on Railway they're on the volume and survive updates; deleting a post deletes its file. Admins can **edit** posts afterwards (title, text, code, and keep, swap or remove the photo/video); edited posts say *Updated*.
- **News polls and comments.** Admins can add a poll (optional question, 2–4 choices) when writing or editing a post; anyone can vote once, see the results, and change or undo their vote (changing the choices restarts the vote). Anyone can comment with 💬 (in both styles); you can delete your own comments, and admins can delete any.
- **News styles.** Switch at the top of News (remembered on each device):
  - 📰 **Formal**: like reading a newspaper: serif headline, "By @username" byline with the date, the photo or video across the page, and a big first letter on longer articles.
  - 📱 **TikTok**: a full-screen feed you swipe up through, one post per screen. The @username above the title opens their profile; *...more* shows the whole title and text; ❤️ likes the post (with a count) and ⭐ saves it to **Favorite Articles** (*Favorites → Favorite Articles*, separate from Favorite Klicks). Videos play muted while they're on screen; tap for sound.
- **Profiles and profile pictures.** Tap your picture in *Profile* to choose one from your gallery (cropped to a square), or *Remove picture*. It shows everywhere your name does. Tapping someone's name in News opens their profile (picture, badge, flair, admin tag, when they joined, and *Add friend* or *Message*). Admins can reset a profile picture in *Admin tools*.
- **Home.** KoolKat opens on Home, laid out like YouTube: chips (All, Reels, News, Friends, ⭐ Favorites), your friends, a shelf of the newest KoolKat Reels, and News as big cards. A tab bar at the bottom has Home, Reels, the Camera, Music and Chats (Klicks are at the top of Home); the camera screen is now just the camera.
- **KoolKat Reels** 🎬. Short videos, like TikTok: swipe up through them full screen, tap to pause, double-tap to heart, and open comments, share or mute from the side. Everyone can watch, heart and comment; posting (up to 100 MB and 3 minutes, 20 a day) is part of KoolKat Unlimited. Reels are public to everyone on KoolKat (not end-to-end encrypted). You (or an admin) can delete a Reel, and you can delete comments on your Reels.
- **KoolKat Music** 🎵. Like Spotify: artists with KoolKat Unlimited post songs (MP3, M4A, WAV, OGG, FLAC or AAC, up to 50 MB) with an album name, an album cover and, if they like, a music video (up to 200 MB). Anyone can listen, heart ♥ (Liked Songs), comment and search by song, album or artist. The player keeps playing while you use the rest of KoolKat (a mini player sits above the tab bar; tap it for Now Playing, where you can switch between the song and its music video), works with your phone's lock-screen controls, and counts a play after 30 seconds. The artist (or an admin) can delete a song; artists can delete comments on their songs. Songs are public to everyone on KoolKat.
- **Explicit songs.** Artists can mark a song as explicit when they post it; it shows an **E** next to the title.
- **KoolKat Playables** 🎮 (for everyone, from Home):
  - **Kat Kart**: a kart race like Mario Kart, drawn in pseudo-3D, over three laps of one of six maps (Kool Kircuit, with its cheerleaders in every colour; Nighttime; Crystal Cavern; Kingdom, inside the castle's throne room; Gold Mine; or Rainbow Wonderland, where everything's a rainbow; picked in the menu, by the host online, or Random). Every map has hills: the ground is drawn column by column from a heightmap, so hills rise above the horizon and hide what's behind them, and you're a little slower going up and faster coming down. **Solo**: you (blue) race seven computer Kats, each in its own colour (red, green, yellow, purple, orange, pink, brown). The bots start easy (level 1); every win makes them faster and every loss makes them easier, so they settle at your level (remembered on your device). **Online**: tap *Make a race*, share the 4-letter code, and up to 8 friends join; the host starts it. Each racer gets their slot's colour, phones share positions through the server about 10 times a second, and everyone sees the same podium. Hold the left or right side of the screen (or A/D, the arrow keys, or a controller's D-pad or sticks) to steer; a minimap in the top-right corner shows everyone; grass slows you down and the orange pads give you a boost. A silent 3-2-1-GO! countdown, music during the race (the Kat Kart OST by Zalith9: *Natho Town*, *Crystal Cavern*, *Kingdom Dominance*, *Gold Mine* and *Rainbow Wonderland*, by default each map's own song (Kool Kircuit: *Natho Town*; Nighttime and Crystal Cavern: *Crystal Cavern*; Kingdom: *Kingdom Dominance*; Gold Mine: *Gold Mine*; Rainbow Wonderland: *Rainbow Wonderland*), or any song or Random, chosen in the Kat Kart menu or by the host in an online race; looping without a gap, with a “Now Playing” popup at GO), a live leaderboard and minimap, and a podium at the end. Your best finish is remembered on your device.
  - **Kat Kart power-ups**: drive through the rainbow "?" boxes to get one, then tap the item button (or Space / W / ↑, or A, X or a shoulder button on a controller) to use it. **Double Speed** (×1.5) and **Triple Speed** (×2, half as common) speed you up; **Mouse** (others at ×0.5), **Food Bowl** (others at ×0.25, rarer than Mouse) and **Thunder** (others can't move at all, rarest) slow everyone else down, online too. The computer Kats use them as well. All the power-up pictures are pixelated like the game.
  - **Bolts ⚡**, the currency for all Playables (saved on your account, shown on the Playables page): win any game for **+100** (1st in Kat Kart, Circle Chaos, Kat Invaders or KatEscape's All Chasers; the winner of Chaser vs Cop; solving a Kat Wordle; surviving 2 minutes of Kat Invaders solo), and when a KatEscape run ends, **every bolt you collected is yours**. Online games pay out from the server when they end (once per game); Solo and Practice games are limited to one reward per game every 20 seconds and 25,000 bolts a day. Spend them in the Bolt Shop.
  - **Gems 💎**, the second currency: finish any Playable for **1 to 10 gems**, the better you did (by place in Kat Kart, Circle Chaos and Kat Invaders online and in Practice; fewer guesses in Kat Wordle; 1 per 400 m in KatEscape; 1 per 300 points in Kat Invaders solo; 10 for the winner of Chaser vs Cop and 3 for the other). Online games pay out on the server; Solo and Practice are limited to one reward per game every 20 seconds and 300 gems a day.
  - **Gem Shop** (the 💎 tab in the shop): everything in the Bolt Shop priced in gems at 1 gem = 100 bolts (team colours 5 💎, the 30-day Unlimited trial 25 💎, Lifetime Unlimited 100 💎), with the **Gem Badge** (50 💎, a 💎 next to your name) instead of the Bolt Badge. Selling gives back what you paid, in what you paid with.
  - **Bolt Shop** (🛒 on the Playables page): **team colours** for Circle Chaos and Kat Invaders, 500 bolts each: Orange, Pink, Teal, White, Gray, Black and Brown (the first five are free, and all of them come with KoolKat Unlimited); the **Bolt Badge** (a ⚡ next to your name, for everyone to see) for 5,000; and **KoolKat Unlimited**: a **30-day trial** for 2,500, or **Lifetime** for 10,000 (for as long as you keep it; you can upgrade during a trial). Anything you bought can be **sold back for every bolt you paid** (selling Unlimited ends it). The shop also swaps **gems ⇄ bolts** at 1 gem = 100 bolts, either way. Locked team colours show a 🔒 in the team pickers; tap one to open the shop.
  - **Suggestions & Bug reports** (KoolKat Unlimited, from your profile): send a suggestion (what it is, what it could do, and a category) or a bug report (what's wrong, and a category). You can see how yours are doing. The owner gets a notification for each new one, and goes through them in Admin tools → Suggestions & Bug reports: search, filter by category and status, sort newest or oldest, and approve suggestions. Every admin can verify bug reports (a blue check: it's a real bug); only the owner can search, sort and filter them. **Admins can reply** to any suggestion or bug report (other admins see suggestions as a plain list so they can reply; searching, sorting and approving stay with the owner). The person who sent it sees the replies under it and gets a notification.
  - **Multi-touch** in Kat Kart, KatEscape and Kat Invaders: every finger counts. Kat Kart: steer with one finger and tap the power-up with another (with fingers on both sides, the newest one steers). KatEscape: swipe with any finger, even while another rests on the screen, and keep swiping (left, then up) without lifting. Kat Invaders: drag one finger to move while another taps or holds to shoot (a finger held still keeps shooting).
  - **Kat Invaders**: mice come down from the top; shoot as many as you can in 2 minutes. Each mouse shows its points (10 to 50). Mice don't fight back, but if one gets close to you, you lose a life: Easy 5 lives, Medium 3, Hard 1. Swipe left / right to move, swipe up or tap to shoot (keyboard ← → / A D and Space; controller stick / D-pad and A). Teams Red, Yellow, Green, Blue and Purple, each with its own cat and blaster. **Solo** (best score remembered), **Practice** vs 1 to 4 bots, or **online** for 2 to 5 people with a code: the host picks the difficulty and the music, and everyone gets the same mice (from the same seed) and races for points. Music: the Kat Kart OST.
  - **Kat Survival**: a top-down survival game with the KoolKat cat (its shirt in your team colour; the back of its head when it walks away). Everyone starts with food, a sword (10 damage), 15 wood and a campfire. **5 minutes of daylight** to get ready: hit trees for wood and rocks for stone, hunt cows and pigs for food (they don't fight back), put down your campfire and fill it with wood (each wood burns 12 seconds; 10 wood + 5 stone makes another campfire). All set sooner? Tap **Ready for night** (twice, Solo) to skip the rest of the day; online the night starts once everyone still standing is ready. Then **3 minutes of night**: it's freezing away from a burning campfire (you lose health), and the bears come hunting (3 to 5 damage a hit; they're out by day too, but only go for you if you get close). Eat to stay fed and heal. Still standing when the sun comes up? You survived (100 bolts; gems for surviving and for animals hunted). **Solo**, or **online** for 2 to 5 people with a code: the server runs the world (animals, campfires, trees and the clock) and everyone survives the same night together; if you're out you watch the others. Thumbstick wherever you put your left thumb, with Swing / Eat / Add wood / Put down / Make fire buttons (multi-touch: move and swing at once); keyboard WASD / arrows, Space to swing, E eat, F add wood, Q put down, C make a campfire, R ready for night; controller stick and buttons. A minimap shows everyone, the campfires and bears nearby. Music: the Kat Kart OST (the host picks online).
  - **Circle Chaos**: 2 to 5 people online (make a game, share the 4-letter code), one team each: Red, Yellow, Green, Blue or Purple (pick a free one in the lobby). The dealer bot spills the bag of circles into a random pile, the Deck (all drawn in chunky pixels like Kat Kart and KatEscape). The bag holds 14 of each team's colour and always 8 each of Lose 2, Lose 4 and Lucky. On your turn pick the circle you want (each shows how many are left in the Deck):
    - each team only takes its own colour (+1) and the rainbow circles; the other teams' colours stay in the Deck for them (if there's nothing left for you, the bot spills the bag again);
    - **Lose 2** / **Lose 4**: pick an opponent to lose that many;
    - **Lucky Card**: one of: everyone has no circles; everyone but you has no circles; the turn order is flipped; a random team goes next; everyone gets 4 circles; the next person loses all / 4 circles; the previous person loses all / 4 circles.
    Music: the Kat Kart OST (the host picks online; you pick in Practice).
    Everyone gets 15 turns; most circles wins (ties share a place). Take longer than 30 seconds and the bot takes your turn for you. The server keeps the deck, so nobody can peek.
    - **Practice**: pick your team and 1 to 4 bots and play on your own (the same rules, run on your phone; bots make whoever's winning lose their circles). Practice games don't count towards your wins.
  - **KatEscape**: an endless runner like Subway Surfers, in the same chunky pixels. KoolKat runs down three train tracks with the cop on its tail: switch lanes, jump over low barriers, roll under high ones and stay off the trains (some are coming at you). Collect bolts ⚡; they make a trail along the safe way through. Every 750 bolts gives you Double Speed and every 2500 Triple Speed (you smash through anything while boosted); those only come from bolts. Thunder, now and then on the track, clears the obstacles ahead. Clip a barrier or the side of a train and the cop catches up; do it again before you get away, or hit a train head-on, and you're caught. Swipe, use the arrow keys / WASD, or a controller's D-pad / stick (A jump, B roll). Music: the Kat Kart OST by Zalith9 (*Natho Town*, *Crystal Cavern*, *Kingdom Dominance*, *Gold Mine*, *Rainbow Wonderland* or Random, picked on the start screen and remembered), with a “Now Playing” popup when you start running. Your best score is remembered on your device.
    - **One revive a game** (solo and All Chasers): caught or crashed? Revive once with the way ahead cleared and a moment where nothing can hurt you.
    - **One revive each in Chaser vs Cop** too, for both the chaser and the cop: you come back in at the normal 8 m gap. Out of revives? A cop who crashes into a train hands the win to the chaser.
    - **Multiplayer** (make a game and share its 4-letter code; the host picks the mode and the music):
      - **All Chasers**: up to 8 people run the same course, each from a bot cop. Mouse boxes on the track slow your cop down for 1 second (a stumble then can't get you caught). Out of revives? Spectate whoever's still running (◀ ▶ to switch). Highest score wins.
      - **Chaser vs Cop**: 2 people. One is the chaser, one is the cop running the same course behind them; the host picks who's who. Stumbles slow you down, the cop just bounces off trains, and the only power-up is the Mouse: the cop grabs it from item boxes and throws it (tap it, E / Enter, or X / Y on a controller), slowing the chaser down until the cop is closer than normal. The cop wins by closing the gap; the chaser wins by lasting 90 seconds.
      - **Practice**: All Chasers against bot runners, no friends needed.
  - **Kat Wordle**: guess the 5-letter word in six tries, with up to three hints (the number of syllables, then the first letter, then the last letter). Blue means the right letter in the right spot, dark blue means it's in the word somewhere else, grey means it isn't in the word. Every game has a new random word. Words come from SCOWL (see `public/vendor/SCOWL-COPYRIGHT.txt`).
- **KoolKat on a PC.** Works in Chrome, Edge and other desktop browsers: on a wide screen KoolKat shows in a phone-sized column in the middle (Kat Kart uses the whole window). Webcams work, built in or plugged in (USB); if you have more than one, the switch-camera button goes through them, and KoolKat remembers your choice. Space takes a photo.
- **Keyboard and controller.** Every menu, Playables included, and KoolKat's own “Are you sure?” boxes (A / Enter = yes, B / Esc = no): Tab or the arrow keys move between buttons, Enter/Space presses, Esc goes back. On a game controller the D-pad or stick moves, A presses, B goes back and LB/RB switch tabs. In Kat Kart, steer with A/D or ←/→ on a keyboard, or the D-pad or either stick on a controller (B quits the race).
- **Profile pages.** Everyone has a profile page like TikTok's: their name, picture, @username, Friends, Reels and Likes counts, Message / Call / Add friend buttons, social links and a grid of their Reels. On your own page, *Edit profile* opens your settings.
- **Verified badge.** The owner (zalith9) can give any account a blue verified tick in *Admin tools → Verified accounts*, and take it away again. It shows next to their name everywhere, before the Kool badge.
- **Social links.** Anyone can add their YouTube, Instagram, TikTok, Facebook, X (Twitter) and Linktree in *Profile → 🔗 Social links*, as a username or a link. They show as round buttons on your profile that open your pages. Links are checked on the server and can only point to that site.
- **Installable app (PWA).** KoolKat installs like a normal app, with its own icon, full screen and no browser bars. On Android and desktop, use *Profile → Install KoolKat*. On iPhone, use Safari's *Share → Add to Home Screen*. Long-press the icon for shortcuts to the camera, Klicks and Chats. It opens even offline, and when a new version is deployed it shows *"A new version of KoolKat is ready → Reload"*.
- **Emojis.** 😺 iPhones, iPads and Macs show Apple's own emojis. Everyone else (Android, Windows, Linux) sees the newest Android emojis: Google's **Android 17 "Noto 3D"** designs, including the Unicode 17 ones, even on older phones. The emoji font is split into pieces and each device only downloads the ones it shows (most pieces are 20–900 KB; people, hands and skin tones together are about 5 MB, downloaded the first time one appears, then kept). Browsers that can't draw the 3D format (e.g. Firefox) get the previous flat Android designs. (Apple's emoji font can't be included: Apple only licenses it for its own devices.)
- **Birthdays.** 🎉 shows next to your name on your birthday. After signing up (or the first sign-in with this version) KoolKat asks for your birthday: just the month and day, never the year, and only to show the 🎉; nobody sees the date itself. You can skip it, and change or remove it any time with *Profile → Birthday*. It follows your time zone, and 29 February birthdays are celebrated on the 28th in other years.
- **Inter Display font and text style.** All text uses Inter Display. In *Profile → Text style* choose **Regular text, SemiBold headings** (the default) or **Semibold text, Bold headings**; the choice is remembered on that device.
- **Light and dark mode.** Choose System, Light or Dark under *Appearance* on the sign-in screen or in your profile. The choice is remembered on that device.

## KoolKat Free vs KoolKat Unlimited

KoolKat is completely free, and so is **KoolKat Unlimited**. Unlimited isn't sold: you get it from an admin.

| | KoolKat Free | KoolKat Unlimited (free, from admins) |
| --- | --- | --- |
| Storage for Klicks you've sent | 512 MB | 2.5 GB |
| Kool badge 👑 next to your name | – | ✓ |
| Kool flair (custom line under your name, default "i have nine lives") | – | ✓ |
| Custom app icon: Classic, Crown, Glow, or your own picture | – | ✓ |
| Custom badge picture (with *Reset Badge to Default*) | – | ✓ |
| BFFs 💙: heart friends to pin them to the top of your friends and chats | – | ✓ |
| Chat themes: background (presets, any colour, or your own picture) and bubble colour | – | ✓ |
| Accent colour: any colour instead of KoolKat blue (colour picker or a hex code) | – | ✓ |
| Activity Bubbles 🫧: show friends what you're up to | – | ✓ |
| Kat Map 🗺: see where your friends are | – | ✓ |
| QR friending, Nearby, KatCam, Calls and FaceTime | ✓ | ✓ |

Storage counts the Klicks you've sent that still exist. Deleting a sent Klick (it's removed for everyone) frees the space. When it's full, KoolKat asks you to delete some. Badges and flair are shown to your friends in their friend list, your profile, your Klicks and chats.

**Customising (Profile → KoolKat Unlimited):**

- **App icon.** Pick *Crown* or *Glow*, or *Upload a picture from your gallery* (cropped to a square). The browser tab icon changes straight away, and installing KoolKat uses your icon. Browsers don't let a website change an icon that's already on the home screen, so to switch there, remove KoolKat and install it again. (Chrome on Android may also update it by itself after a while.)
- **Kool badge.** *Choose from gallery* replaces the crown next to your name with your own picture, for everyone who sees your name. *Reset Badge to Default* brings the crown back. Uploaded badge and icon pictures are served from unguessable links so browsers can show them.
- **Accent colour.** In *Profile → Edit profile*, pick a preset, use the colour picker, or paste a hex code (like `#FF0000`, `ff0000` or `#f00`) and tap *Apply*. It replaces KoolKat blue on buttons, tabs and highlights everywhere in the app, on all your devices; text on top switches to dark for light colours so it stays readable. The blue circle goes back to the default. Your Kool badge (the crown, unless you uploaded your own badge) and your Kool flair are shown in your accent colour too, to everyone who sees them. The KoolKat icon follows it as well: the logo inside the app, the browser tab icon and the home-screen icon (unless you picked Crown, Glow or your own icon). Phones only update a home-screen icon now and then (Android) or when it's added (iPhone: remove KoolKat from the Home Screen and add it again).
- **Chat themes.** Pick a background (Midnight, Sunset, Ocean, Forest, Candy, any colour, or a picture from your gallery) and the colour of your own message bubbles (they match your accent colour unless you pick one; *Match accent* goes back to that). The text colour adjusts automatically so it stays readable. Themes change how chats look for you; your background picture is only ever sent to you.
- **Activity Bubbles.** Choose an emoji, write what you're doing (up to 40 characters), and show it until you clear it or for 1, 4, 8 or 24 hours. Your friends see it in their friends list, on your friend card, and at the top of your chat; you see it on your profile. People who aren't your friends never see it.
- **Kat Map.** *Friends → 🗺* shows you and your friends on a map (OpenStreetMap). Sharing is **off (👻 Ghost)** until you pick **💙 BFFs** (only friends you've made BFFs) or **👥 Friends**. Tap a friend in the list to fly to them, or their pin to open their card. KoolKat sends your location while it's open on your screen (every 30 seconds, or sooner when you move); friends see your last spot with how long ago it was, and spots older than 24 hours disappear. Going back to Ghost deletes your location from the server. Both people need Unlimited. **Background:** websites and installed web apps can't get your location while they're in the background or closed (browsers block it), so your friends see where you were when you last had KoolKat open. Live background tracking would need a native app from the app stores.
- **BFFs.** Open a friend's card and tap **Make BFF**. BFFs get their own section at the top of *Friends*, and their chats are pinned to the top of *Chats*, with the 💙 heart. Only you see who your BFFs are. Unfriending someone removes the heart.

There are three ways to get Unlimited:

- **Redeem a code** (*Profile → Have a code?*, or the **Redeem** button on a News post).
- **Ask for it**: *Profile → 🎁 Ask an admin for KoolKat Unlimited*, with an optional message. Admins get a notification and can approve or decline. After a decline you can ask again the next day.
- **Get a gift** from an admin.

### Admin tools

The account **`zalith9`** is the admin. Capitalisation doesn't matter, and usernames are unique regardless of capitalisation, so there can only be one zalith9. Set `KOOLKAT_ADMINS` to a comma-separated list to change it. Admins always have **KoolKat Unlimited forever** (it can't expire or be taken away), and get an **Admin tools** button in their profile, where they can:

- **(owner only) make other people admins, or remove them** (*Admins*). The owner is the account in `KOOLKAT_ADMINS` (zalith9); only the owner sees this section, and the owner can't be removed. Admins added this way are saved in the database;
- **(owner only) verify accounts** (*Verified accounts*): give someone the verified tick by username, or remove it. They get a notification;

- **create redeemable codes** with their own text (or a random `KOOL-XXXX-XXXX`), a **usage limit**, an **expiry date**, and how many days of Unlimited they give (or forever). Each person can use a code once;
- see how many times each code has been used, and copy or delete codes;
- **give KoolKat Unlimited to any user** for a number of days, or forever, and take a gift back;
- **reset someone's badge, app icon, Activity Bubble, profile picture, or all of them** (*Reset badge, icon or activity*), for example if they upload an inappropriate picture or write something rude. Uploaded pictures are deleted, and they get a notification;
- **approve or decline requests** for Unlimited (the button shows how many are waiting);
- **post to News** (title, text, an optional code, and optionally a notification to everyone), and delete posts.

> Admin rights come from the username. If the database is ever lost (for example, Railway without a volume), whoever registers `zalith9` first becomes admin. Keep a volume attached.

### Calls on difficult networks (optional TURN server)

Calls connect the two phones directly, which works on most Wi-Fi and mobile networks. Some networks (some mobile carriers, school or work Wi-Fi) block direct connections; then the call says *"Couldn't connect the call"*. A **TURN server** fixes that by relaying the (still encrypted) call. For example, [Metered](https://www.metered.ca/stun-turn) has a free tier: create an app, then put the TURN addresses, username and password it shows into Railway → **Variables** as `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL`. Without these, KoolKat uses public STUN servers only.

## End-to-end encryption

All encryption runs in the browser with the Web Crypto API (`public/js/crypto.js`). The server never sees your password, your private key, photos or captions.

1. **Your password never leaves your device.** PBKDF2-SHA256 (600,000 iterations) stretches it into two independent keys:
   - an *auth secret*, which is sent to the server to log in and stored there as an scrypt hash;
   - a *vault key*, which never leaves the device and encrypts your private key.
2. **Identity keys.** At sign-up the device generates a P-256 ECDH key pair. The public key is uploaded. The private key is uploaded only after it has been encrypted with the vault key, so you can sign in on another device and nobody else (including the server) can read it. On your device, the key is held as a *non-extractable* `CryptoKey` in IndexedDB.
3. **Each Klick** (photo + caption) is encrypted with a fresh random AES-256-GCM key. That key is then wrapped separately for each recipient: a new ephemeral ECDH key pair is combined with the friend's public key, HKDF turns the result into a wrapping key, and AES-GCM wraps the Klick's key. Only the recipient's private key can unwrap it. The Klick's key is also wrapped for the sender, so they can view it later. Chat messages work the same way, wrapped for every member of the chat.
4. **Safety codes.** Your profile and each friend's page show a fingerprint of the public key. If you and a friend see the same code, no one (not even the server) has swapped in their own key.

> ⚠️ Because KoolKat can't see your password, **it can't reset it.** If you forget your password, you lose your account.

## Running it

Requires **Node.js 22.13+**. It uses the built-in `node:sqlite`, so there are no native modules to compile.

```bash
npm install
npm start            # http://localhost:3000
npm test             # API, streak and encryption tests
```

Configuration (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `KOOLKAT_DB` | `data/koolkat.db` | SQLite database file. On Railway, defaults to the attached volume; don't set it there |
| `KOOLKAT_ALLOW_TEMPORARY_STORAGE` | – | Set to `1` to let KoolKat start on Railway without a volume (data is wiped on every update; only for testing) |
| `TLS_CERT` / `TLS_KEY` | – | Serve HTTPS directly with this certificate and key |
| `TRUST_PROXY` | `1` on Railway, else off | Number of reverse proxies in front of the server, so rate limiting sees real client IPs |
| `ALLOWED_ORIGINS` | – | Comma-separated sites allowed to use the API from another domain, e.g. `https://linkyjayy.github.io` for GitHub Pages |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Web Push keys. If you don't set them, a key pair is generated once and saved in the database. Generate your own with `npx web-push generate-vapid-keys` |
| `CANONICAL_HOST` | – | The app's own domain, e.g. `kool-kat.com`. Visits to the `….up.railway.app` address redirect there |
| `TURN_URLS` | – | Optional: TURN server(s) for Calls and FaceTime, comma-separated (e.g. `turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp`) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | The TURN server's username and password |
| `TURN_SECRET` | – | Instead of a fixed password: coturn's shared secret, for short-lived passwords |
| `KOOLKAT_ADMINS` | `zalith9` | Usernames (any capitalisation, comma-separated) that get admin tools |
| `VAPID_SUBJECT` | repo URL | Contact URL or `mailto:` address sent to push services |

## Deploying to Railway

[Railway](https://railway.com) runs the backend **and** serves the app, so you get one `https://` link that works on phones (camera and notifications included). The repo already has a `railway.json`, so there's nothing to configure in code.

1. **Create the service.** Sign in at railway.com, then go to **New Project → Deploy from GitHub repo** and pick `LinkyJayy/koolkat`. Railway installs and starts it automatically.
2. **Attach a volume. Don't skip this.** Without one, every deploy or restart **deletes all accounts, friends, Klicks and chats**. In the project, right-click the KoolKat service (or press ⌘K / Ctrl+K and type *volume*), choose **Attach volume**, and use the mount path `/data`. KoolKat finds the volume and stores its database there automatically.
3. **Get a link.** Open the service → **Settings → Networking → Generate Domain**. Your app is now at something like `https://koolkat-production.up.railway.app`.
4. **Optional:** in the service's **Variables**, set `VAPID_SUBJECT` to `mailto:you@example.com` so push services can contact you.

Every push to the deployed branch redeploys automatically. The deploy logs show `Database: /data/koolkat.db (Railway volume at /data)` once the volume is attached, and `https://<your-domain>/api/health` shows `"storage":"permanent"`.

**KoolKat won't start on Railway without a volume.** An update without one would start with an empty database and wipe every account, so the deploy stops instead with `STOPPED: KoolKat's database would be lost…` in the logs, and Railway keeps the previous version running. Attach the volume (step 2) and redeploy. Admins also see a red warning in their profile if storage is ever temporary.

With Railway serving the app, you don't need GitHub Pages. You can turn it off under *Settings → Pages*.

### Custom domain (kool-kat.com on Squarespace)

1. **Squarespace:** go to **Domains → kool-kat.com → DNS** and apply the **Railway** preset. It points the bare domain at Railway.
2. **Railway:** open the KoolKat service → **Settings → Networking → + Custom Domain**, enter `kool-kat.com`, and pick port `8080` (or the port in your deploy logs). Wait for the green ✓. Railway issues the HTTPS certificate automatically. Until then, browsers show "connection is not private".
3. **Railway variables:** add `CANONICAL_HOST=kool-kat.com`. Visits to the old `….up.railway.app` address are then redirected to the domain.
4. **Optional `www`:** also add `www.kool-kat.com` as a custom domain in Railway, and create the CNAME record Railway shows for `www` in Squarespace's DNS.

Sign-ins, saved keys and notification settings are stored per website address, so people who used the old Railway address sign in once more on the new domain (and turn notifications on again).

### Using it on your phone

Browsers only allow the camera on `https://` or on `http://localhost`. To use KoolKat from a phone, do one of the following:

- run it behind an HTTPS reverse proxy or tunnel (Caddy, nginx, Cloudflare Tunnel, ngrok…) and set `TRUST_PROXY=1`, **or**
- create a certificate (for example with [mkcert](https://github.com/FiloSottile/mkcert)) and start the server with `TLS_CERT=cert.pem TLS_KEY=key.pem npm start`.

You can then use "Add to Home Screen" to install KoolKat like an app.

### Installable app (PWA) details

- `public/manifest.webmanifest`: name, icons (including padded "maskable" ones for Android's round icons), shortcuts, and screenshots for the install dialog.
- `public/sw.js`: the service worker. It saves the app's files on the device so KoolKat opens instantly and offline, and never caches `/api/` (Klicks and messages are always fetched live and stay end-to-end encrypted). The server fills in its version from a hash of the app's files, so every deploy that changes them is picked up as an update. The page then offers a reload instead of switching under you.
- If you add a new file to `public/js/`, also add it to `PRECACHE` in `sw.js`. A test checks this.

### Push notifications

Notifications use the standard Web Push API, so they work without any third-party account:

- **Android, Windows, Mac, Linux:** Chrome, Edge and Firefox work in the browser. Brave needs *Use Google services for push messaging* turned on.
- **iPhone / iPad (iOS 16.4+):** first add KoolKat to your Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on.
- KoolKat must be opened over `https://` (or `localhost`).
- Streak reminders are sent in the last 4 hours before your streak ends (midnight UTC).

## GitHub Pages (optional)

You only need this if you want the app on `github.io` while the backend runs elsewhere. With Railway (above) you can skip it. GitHub Pages can host KoolKat's **web app**, but it only serves static files, so it **can't run the backend**. The backend still has to run somewhere with a public `https://` address: a server, a hosting service like Render, Railway or Fly.io, or your own computer through a tunnel. Then:

1. **Start the backend** and allow your Pages site to talk to it:
   ```bash
   ALLOWED_ORIGINS=https://<your-github-username>.github.io npm start
   ```
2. **Tell the Pages build where the backend is.** In the repo, go to *Settings → Secrets and variables → Actions → Variables* and add `KOOLKAT_API_URL`, for example `https://koolkat-api.example.com`.
3. **Turn on Pages.** Go to *Settings → Pages* and set *Source* to **GitHub Actions**.
4. **Deploy.** Push to the default branch, or run *Actions → Deploy to GitHub Pages → Run workflow*. The site appears at `https://<your-github-username>.github.io/koolkat/`.

The workflow (`.github/workflows/pages.yml`) publishes the `public/` folder and writes the backend address into `js/config.js`. To host the frontend anywhere else, edit `public/js/config.js` by hand.

> Free GitHub accounts can only use Pages on **public** repositories. A private repo needs GitHub Pro, Team or Enterprise.

## Project layout

```
server/
  index.js      HTTP(S) server entry point and periodic jobs
  app.js        Express app and REST API
  auth.js       auth-secret hashing, sessions, rate limiting
  streaks.js    streak rules
  push.js       Web Push: subscriptions, notifications, streak reminders
  plans.js      KoolKat Free / Unlimited, codes, admins
  news.js       News posts (admins write, everyone reads)
  customize.js  Unlimited app icons, custom badges, BFFs, per-icon manifest
  social.js     QR friend codes, Nearby, Activity Bubbles, chat themes
  katmap.js     Kat Map sharing settings and friends' locations
  kartrooms.js  Kat Kart online races: lobbies, positions and results (in memory)
  escaperooms.js  KatEscape online games: All Chasers and Chaser vs Cop (in memory)
  circlerooms.js  Circle Chaos: the rules, the deck and online games (in memory)
  invaderrooms.js Kat Invaders online games (in memory)
  bolts.js      Bolts ⚡ and gems 💎: rewards, limits and swaps
  shop.js       The Bolt Shop and Gem Shop: team colours, KoolKat Unlimited, the badges; buying and selling
  feedback.js   Suggestions and Bug reports (Unlimited users send; the owner and admins go through them)
  music.js      KoolKat Music: songs, covers, music videos, hearts, plays and comments
  reels.js      KoolKat Reels: videos, hearts, views and comments
  png.js        Reads and writes PNGs, to draw the icon in an accent colour
  socials.js    Social media links: turns a username or link into a safe link to that site
  calls.js      Calls and FaceTime: ringing, answering, passing encrypted call setup between phones
  chats.js      direct and group chats (end-to-end encrypted messages)
  http.js       shared request validation helpers
  db.js         SQLite schema
public/
  index.html, css/styles.css
  js/app.js       UI: camera, captions, inbox, viewer, friends
  js/crypto.js    end-to-end encryption (shared with the tests)
  js/qr.js        drawing and scanning friend QR codes
  js/katcam.js    KatCam: both cameras in one Klick
  js/calls.js     Calls and FaceTime (WebRTC) and the call screen
  js/input.js     keyboard and game controller navigation for every menu
  js/escape.js    KatEscape (Playables): the endless runner, solo / practice / online
  js/circles.js   Circle Chaos (Playables): the pixel table and what each circle did
  js/circle-rules.js  Circle Chaos rules, shared by the server and Practice
  js/invaders.js  Kat Invaders (Playables): the shooter, solo / practice / online
  js/teams.js     Team colours (the free five and the Bolt Shop ones)
  js/rewards.js   How many gems each Playable gives (shared by the server and the app)
  js/feedback-categories.js  Categories for suggestions and bug reports
  js/kart.js      Kat Kart (Playables): the pseudo-3D kart race
  js/wordle.js    Kat Wordle (Playables), with its word list in js/wordle-words.js
  js/sounds.js    notification and calling sounds
  sounds/         koolkat_notification.wav, koolkat_calling.wav
  vendor/         qrcode-generator (MIT), jsQR (Apache-2.0) and Leaflet (BSD-2), served locally
  fonts/emoji/    Noto Color Emoji, 3D (Android 17) and flat (SIL Open Font License: OFL.txt, OFL-3D.txt), in pieces
  css/emoji.css   loads those pieces; js/theme.js turns them on for non-Apple devices
  fonts/inter/    Inter Display Regular, SemiBold, Bold (SIL Open Font License: OFL.txt); css/fonts.css loads them
  js/api.js       API client
  js/keystore.js  IndexedDB storage for the unlocked private key
  js/push.js      turning notifications on and off
  js/config.js    backend address (for GitHub Pages / separate hosting)
  js/theme.js     light / dark mode
  sw.js           service worker: offline app shell, updates, notifications
  manifest.webmanifest, icons/, screenshots/  installable-app metadata
.github/workflows/pages.yml  GitHub Pages deployment
railway.json                 Railway build / start / health-check settings
test/api.test.js  end-to-end API tests, including real encrypt/decrypt
```

## API

All endpoints are under `/api` and take and return JSON. Authenticated endpoints need `Authorization: Bearer <token>`.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/register` | Create account: `username, displayName, authSecret, publicKey, encryptedPrivateKey, privateKeyIv` |
| POST | `/auth/login` | `username, authSecret` → token + encrypted private key |
| POST | `/auth/logout` | Revoke the current session |
| GET | `/me` | Current user |
| GET | `/users/search?q=` | Find users by username prefix |
| GET | `/friends` | Friends (with public keys and streaks), incoming and outgoing requests |
| POST | `/friends/request` | `username`: send a request (or accept theirs) |
| POST | `/friends/:id/accept` | Accept a request |
| DELETE | `/friends/:id` | Decline, cancel or unfriend |
| POST | `/snaps` | Send an encrypted snap: `iv, ephemeralPublicKey, ciphertext, recipients[{userId, wrappedKey, wrapIv}]` |
| GET | `/snaps/inbox?before=` | Received snaps from current friends, newest first (metadata only, 50 per page) |
| GET | `/snaps/sent` | Sent snaps and who has opened them |
| GET | `/snaps/:id` | Download a snap's ciphertext (recipients who are still friends with the sender only) |
| POST | `/snaps/:id/viewed` | Mark as opened, so the sender sees "Opened" |
| DELETE | `/snaps/:id` | Remove a snap from your inbox. The data is deleted once no recipient has it |
| POST | `/me/flair` | `flair`: set your Kool flair (Unlimited; empty = default) |
| POST | `/codes/redeem` | `code`: redeem a KoolKat Unlimited code |
| GET / POST | `/admin/codes` | Admin: list / create codes (`code?, maxUses?, expiresAt?, grantDays?`) |
| DELETE | `/admin/codes/:code` | Admin: delete a code |
| POST | `/admin/grant` / `/admin/revoke` | Admin: give (`username, days?`) or take back gifted Unlimited |
| POST / DELETE | `/snaps/:id/favorite` | Favorite / unfavorite a Klick |
| GET | `/favorites` | Your favorite Klicks |
| GET | `/chats` | Your chats (members with public keys, unread counts) |
| POST | `/chats/direct` | `userId`: open the chat with a friend |
| POST | `/chats/group` | `memberIds` (2+ friends), `name?`: create a group |
| POST | `/chats/:id/members` / `/name` / `/leave` / `/read` | Add friends, rename, leave, mark read |
| GET / POST | `/chats/:id/messages` | Read (`?before=`) / send an encrypted message (`iv, ephemeralPublicKey, ciphertext, keys[]`) |
| POST | `/me/app-icon` | `icon`: `default` / `crown` / `glow` / `custom` (+ `icon512`, `icon192` PNGs to upload) |
| POST / DELETE | `/me/badge` | Upload a custom badge (`image` PNG) / reset to the default |
| GET | `/app-icons/:id/:size.png`, `/badges/:id.png` | Uploaded icon / badge pictures |
| POST / DELETE | `/bffs/:userId` | Heart / un-heart a friend |
| POST | `/admin/reset-customization` | Admin: `username`, `badge?`, `icon?`: reset their badge and/or app icon |
| POST | `/unlimited/request` | `message?`: ask the admins for KoolKat Unlimited |
| GET | `/admin/requests` | Admin: pending requests |
| POST | `/admin/requests/:id/approve` / `/decline` | Admin: approve (`days?`, blank = forever) or decline |
| GET | `/friend-code` | Your current QR friend code (`code, expiresAt`) |
| POST | `/friends/qr` | `code`: become friends with the code's owner |
| POST / DELETE | `/nearby` | `lat, lng, accuracy`: check in and list people nearby / leave Nearby |
| POST / DELETE | `/me/activity` | Unlimited: set (`emoji, text, hours?`) / clear your Activity Bubble |
| POST | `/me/chat-theme` | Unlimited: `background, color?, bubble?, image?` (JPEG base64) |
| GET | `/me/chat-background` | Your own chat background picture |
| POST | `/calls` | `to, kind` (`audio` = Call, `video` = FaceTime), `device`: ring a friend |
| POST | `/calls/:id/answer` / `decline` / `end` | Answer (`device`), decline, or hang up / cancel |
| POST | `/calls/:id/signal` | `device, data`: an encrypted call setup message for the other phone |
| GET | `/calls/events?device=&after=` | Waits up to 25 s for call events (incoming, answered, ended, signal) |
| GET | `/calls/active` | The call ringing for you (or in progress) |
| GET | `/calls/ice` | STUN/TURN servers for calls |
| POST | `/map/settings` | Unlimited: `mode` = `off` (deletes your location), `bffs` or `friends` |
| POST | `/map/location` | Unlimited: `lat, lng, accuracy` while sharing |
| GET | `/map` | Unlimited: your sharing mode and location, and friends sharing with you |
| GET | `/news` / `/news/unread` | News posts / unread count |
| POST | `/news/seen` | Mark News as read |
| POST / DELETE | `/news` / `/news/:id` | Admin: post (`title, body?, code?, notify?, mediaId?`) / delete |
| POST | `/news/media` | Admin: upload a photo or video (the raw file as the body); returns `mediaId` |
| POST | `/news/:id` | Admin: edit a post (`title, body?, code?, mediaId?, removeMedia?`) |
| POST / DELETE | `/news/:id/like` / `/news/:id/save` | Heart / save (Favorite Articles) a post, or undo |
| GET | `/news/saved` | Your Favorite Articles |
| GET | `/users/:id` | Someone's profile |
| POST / DELETE | `/news/:id/vote` | `choice`: vote in a post's poll / undo |
| GET / POST | `/news/:id/comments` | Comments on a post / add one (`body`) |
| DELETE | `/news/comments/:id` | Delete your comment (admins: any) |
| GET / POST | `/admin/admins` | Owner: list admins / make someone an admin (`username`) |
| DELETE | `/admin/admins/:username` | Owner: remove an admin |
| GET / POST | `/admin/verified` | Owner: list verified accounts / verify someone (`username`) |
| DELETE | `/admin/verified/:username` | Owner: remove someone's verified badge |
| POST | `/kart/rooms` | Kat Kart: make an online race (returns its 4-letter code) |
| POST | `/kart/rooms/:code/join` | Join a race that hasn't started |
| GET | `/kart/rooms/:code` | The lobby (who's in) |
| POST | `/kart/rooms/:code/song` | Host: pick the race music (`song`: `natho-town`, `crystal-cavern`, `kingdom-dominance` or `random`) |
| POST | `/kart/rooms/:code/start` | Host: start the race (GO in 4 seconds) |
| POST | `/kart/rooms/:code/state` | Send your kart (`x, y, h, v, progress, lap, finished`); returns everyone's, and the results when it's over |
| POST | `/kart/rooms/:code/leave` | Leave the race |
| GET | `/music` | Songs, newest first (`?user=ID`, `?q=` search, `?before=ID`) and whether you can post |
| GET | `/music/home` | Top songs and your Liked Songs |
| POST | `/music/upload?kind=audio\|video\|cover` | Unlimited: upload the song, music video or album cover (raw bytes) |
| POST | `/music` | Unlimited: post a song (`title, album, audioId, videoId, coverId, duration`) |
| GET / DELETE | `/music/:id` | One song / delete it (artist or admin) |
| POST / DELETE | `/music/:id/like` | Heart / unheart |
| POST | `/music/:id/play` | Count a play |
| GET / POST | `/music/:id/comments` | Comments / comment |
| DELETE | `/music/comments/:id` | Delete a comment (its author, the artist or an admin) |
| GET | `/reels` | Reels, newest first (`?user=ID`, `?before=ID`, `?limit=`) and whether you can post |
| POST | `/reels/upload` | Unlimited: upload a video or its thumbnail (raw bytes) |
| POST | `/reels` | Unlimited: post a Reel (`videoId, posterId, caption`) |
| GET / DELETE | `/reels/:id` | One Reel / delete it (author or admin) |
| POST / DELETE | `/reels/:id/like` | Heart / unheart |
| POST | `/reels/:id/view` | Count a view (once per person) |
| GET / POST | `/reels/:id/comments` | Comments / comment |
| DELETE | `/reels/comments/:id` | Delete a comment (its author, the Reel's author or an admin) |
| GET | `/accent-icons/:hex/:name.png` | The KoolKat icon drawn in a colour (`icon-192`, `icon-512`, `logo`…) |
| POST | `/me/accent` | Unlimited: set your accent colour (`color: '#rrggbb'`, or `null` for KoolKat blue) |
| POST | `/me/socials` | Save social links (`youtube, instagram, tiktok, facebook, x, linktree`; a username or link, `''` removes it) |
| POST / DELETE | `/me/birthday` | `month, day, timeZone` (or `skip`) / remove your birthday |
| POST / DELETE | `/me/avatar` | `image` (square JPEG, base64): set / remove your profile picture |
| GET | `/news/media/:id` | A post's photo or video |
| GET | `/push/key` | The server's VAPID public key |
| POST | `/push/subscribe` | Save this device's `PushSubscription` (as JSON) |
| POST | `/push/unsubscribe` | `endpoint`: stop notifications for a device |
