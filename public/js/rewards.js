// Gems 💎 for each Playable: 1 to 10, the better you did. Shared by the
// server (online games) and the app (Solo and Practice).

export const MIN_GEMS = 1;
export const MAX_GEMS = 10;
export const BOLTS_PER_GEM = 100;
const clamp = (n) => Math.max(MIN_GEMS, Math.min(MAX_GEMS, Math.round(n)));

/** By finishing place: 1st gets 10, last gets 1. */
export const placeGems = (place, count) => (count <= 1 ? MAX_GEMS : clamp(MAX_GEMS - ((MAX_GEMS - MIN_GEMS) * (place - 1)) / (count - 1)));
/** Kat Wordle: fewer guesses, more gems (and 1 for trying). */
export const wordleGems = (won, guesses) => (won ? [10, 9, 7, 5, 4, 3][guesses - 1] ?? 3 : 1);
/** KatEscape: 1, plus 1 for every 400 m. */
export const escapeGems = (metres) => clamp(1 + Math.floor((Number(metres) || 0) / 400));
/** Kat Invaders: 1, plus 1 for every 300 points. */
export const invaderGems = (score) => clamp(1 + Math.floor((Number(score) || 0) / 300));
/** Chaser vs Cop: the winner gets 10, the other 3. */
export const chaseGems = (won) => (won ? MAX_GEMS : 3);
