export const DAY_MS = 24 * 60 * 60 * 1000;

export const dayNumber = (ms) => Math.floor(ms / DAY_MS);

/**
 * Snapchat-style streaks.
 *
 * A pair of friends "keeps" a day when both of them send each other at least
 * one snap on that (UTC) day. Keeping consecutive days grows the streak; a
 * full day without both sides snapping resets it.
 *
 * Given the friendship row and who just sent a snap, returns the updated
 * streak columns.
 */
export function applySnapToStreak(friendship, senderId, now) {
  const today = dayNumber(now);
  const next = {
    low_last_day: friendship.low_last_day,
    high_last_day: friendship.high_last_day,
    streak_count: friendship.streak_count,
    streak_day: friendship.streak_day,
  };
  if (senderId === friendship.user_low) next.low_last_day = today;
  else next.high_last_day = today;

  const bothToday = next.low_last_day === today && next.high_last_day === today;
  if (bothToday && next.streak_day !== today) {
    next.streak_count = next.streak_day === today - 1 ? next.streak_count + 1 : 1;
    next.streak_day = today;
  }
  return next;
}

/**
 * The streak as the user should see it right now.
 * - count: 0 once a day has been missed.
 * - expiring: true when the streak will be lost if nobody keeps today.
 * - youNeedToSnap / theyNeedToSnap: who still owes a snap today.
 */
export function describeStreak(friendship, viewerId, now) {
  const today = dayNumber(now);
  const alive = friendship.streak_day != null && friendship.streak_day >= today - 1;
  const count = alive ? friendship.streak_count : 0;
  const viewerIsLow = viewerId === friendship.user_low;
  const mine = viewerIsLow ? friendship.low_last_day : friendship.high_last_day;
  const theirs = viewerIsLow ? friendship.high_last_day : friendship.low_last_day;
  return {
    count,
    expiring: count > 0 && friendship.streak_day === today - 1,
    youNeedToSnap: mine !== today,
    theyNeedToSnap: theirs !== today,
    // When the current day (and so the grace period) ends, in ms since epoch.
    expiresAt: count > 0 ? (friendship.streak_day + 2) * DAY_MS : null,
  };
}
