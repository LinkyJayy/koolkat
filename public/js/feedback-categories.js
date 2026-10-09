// Categories for Suggestions and Bug reports (one is required). Shared by
// the server (to check them) and the app (for the menus).

export const SUGGESTION_CATEGORIES = [
  ['new-playable', '🎮 A new Playable'],
  ['playables', '🕹 Playables'],
  ['klicks', '📸 Klicks & Camera'],
  ['chats', '💬 Chats & calls'],
  ['reels', '🎬 Reels'],
  ['music', '🎵 Music'],
  ['profile', '🙂 Profile & customising'],
  ['shop', '🛒 Bolt & Gem Shop'],
  ['unlimited', '👑 KoolKat Unlimited'],
  ['other', '✨ Something else'],
];

export const BUG_CATEGORIES = [
  ['kart', '🏎 Kat Kart'],
  ['escape', '🏃 KatEscape'],
  ['wordle', '🔤 Kat Wordle'],
  ['circles', '🔴 Circle Chaos'],
  ['invaders', '🐭 Kat Invaders'],
  ['klicks', '📸 Klicks & Camera'],
  ['chats', '💬 Chats & calls'],
  ['reels', '🎬 Reels'],
  ['music', '🎵 Music'],
  ['profile', '🙂 Profile'],
  ['shop', '🛒 Bolt & Gem Shop'],
  ['other', '🐞 Something else'],
];

export const categoryLabel = (list, id) => list.find(([c]) => c === id)?.[1] ?? id;
