// Circle Chaos rules, shared by the server (online games) and the browser
// (Practice against bots). The game is plain data, so it's easy to test.
//
// The bot spills the bag of circles into a random pile, the Deck. On your
// turn you take a circle: only your own team's colour or a rainbow one
// (Lose 2, Lose 4, Lucky); the others' colours stay in the Deck for them.
//  - your colour: +1 circle;
//  - Lose 2 / Lose 4: pick an opponent, they lose that many circles;
//  - Lucky: something random happens (see LUCKY).
// Everyone gets 15 turns. Most circles at the end wins.

export const TEAMS = ['red', 'yellow', 'green', 'blue', 'purple'];
export const TURNS = 15;
const randomInt = (n) => Math.floor(Math.random() * n);

/**
 * The Lucky Card outcomes. "player" played it, "next" goes next, "prev"
 * went just before, "random" is a random other team.
 */
export const LUCKY = [
  'everyone-none', // Everyone has no circles!
  'everyone-none-but-player', // Everyone has no circles, except for Player!
  'flip', // The turn order is Flipped!
  'random-next', // Random Team can go next
  'everyone-4', // Everyone gets 4 Circles!
  'next-all', // Next person loses all circles!
  'next-4', // Next person loses 4 Circles!
  'prev-all', // Previous person loses all circles!
  'prev-4', // Previous person loses 4 circles!
];

export const RAINBOW = ['lose2', 'lose4', 'lucky'];

function shuffle(deck, rand) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** The bag of circles, spilled into a random pile. */
export function newDeck(teams, rand = randomInt) {
  const deck = [];
  for (const team of teams) for (let i = 0; i < 14; i++) deck.push(team);
  for (let i = 0; i < teams.length * 2; i++) deck.push('lose2', 'lucky');
  for (let i = 0; i < teams.length; i++) deck.push('lose4');
  return shuffle(deck, rand);
}

// ---------- the rules (the game state is plain data, so it's easy to test) ----------

/** Who's still playing: here, with turns left. */
export const canPlay = (game, id) => {
  const p = game.players.find((x) => x.id === id);
  return p && !p.gone && p.turns < TURNS;
};
const seat = (game, id) => game.players.findIndex((p) => p.id === id);
const teamOf = (game, id) => game.players.find((p) => p.id === id);

/** The next person after `id` going `dir`, who can play (or null). */
export function nextAfter(game, id, dir = game.dir, { anyone = false } = {}) {
  const n = game.players.length;
  const at = seat(game, id);
  for (let k = 1; k <= n; k++) {
    const p = game.players[(at + dir * k + n * k) % n];
    if (p.id === id) continue;
    if (anyone ? !p.gone : canPlay(game, p.id)) return p.id;
  }
  return null;
}

const lose = (p, n) => {
  const before = p.circles;
  p.circles = n === 'all' ? 0 : Math.max(0, p.circles - n);
  return before - p.circles;
};

/** Play a Lucky Card: returns what happened, and maybe who goes next. */
export function playLucky(game, playerId, rand = randomInt) {
  const player = teamOf(game, playerId);
  const others = game.players.filter((p) => p.id !== playerId && !p.gone);
  const next = teamOf(game, nextAfter(game, playerId) ?? nextAfter(game, playerId, game.dir, { anyone: true }));
  const prev = game.prevId && game.prevId !== playerId ? teamOf(game, game.prevId) : null;
  // Only outcomes that make sense right now (no "previous" on the very first turn).
  const choices = LUCKY.filter((o) => {
    if (o.startsWith('prev')) return Boolean(prev);
    if (o.startsWith('next')) return Boolean(next);
    if (o === 'random-next') return others.some((p) => canPlay(game, p.id));
    return true;
  });
  const outcome = choices[rand(choices.length)];
  const result = { outcome, by: player.id };
  switch (outcome) {
    case 'everyone-none':
      for (const p of game.players) p.circles = 0;
      break;
    case 'everyone-none-but-player':
      for (const p of game.players) if (p.id !== playerId) p.circles = 0;
      break;
    case 'flip':
      game.dir = -game.dir;
      break;
    case 'random-next': {
      const can = others.filter((p) => canPlay(game, p.id));
      result.target = can[rand(can.length)].id;
      result.nextId = result.target;
      break;
    }
    case 'everyone-4':
      for (const p of game.players) if (!p.gone) p.circles += 4;
      break;
    case 'next-all':
    case 'next-4':
      result.target = next.id;
      result.lost = lose(next, outcome === 'next-all' ? 'all' : 4);
      break;
    case 'prev-all':
    case 'prev-4':
      result.target = prev.id;
      result.lost = lose(prev, outcome === 'prev-all' ? 'all' : 4);
      break;
  }
  return result;
}

/** End the current turn and move on (or end the game). */
export function endTurn(game, nextId = null) {
  const current = teamOf(game, game.turnId);
  current.turns += 1;
  game.prevId = current.id;
  game.pending = null;
  let next = nextId && canPlay(game, nextId) ? nextId : nextAfter(game, current.id);
  if (!next && canPlay(game, current.id)) next = current.id; // everyone else is done
  game.turnId = next;
  return next;
}

/**
 * Take a circle. Each team only takes its own colour and the rainbow circles
 * (Lose 2, Lose 4, Lucky): the other teams' circles stay in the Deck for them.
 * Returns the event.
 */
export function draw(game, rand = randomInt) {
  const player = teamOf(game, game.turnId);
  const event = { type: 'draw', by: player.id };
  const takeable = (c) => c === player.team || RAINBOW.includes(c);
  let at = game.deck.findLastIndex(takeable);
  if (at < 0) {
    // Nothing left for you: the bot spills the bag again.
    game.deck = shuffle([...game.deck, ...newDeck(game.players.map((p) => p.team), rand)], rand);
    event.refill = true;
    at = game.deck.findLastIndex(takeable);
  }
  const [circle] = game.deck.splice(at, 1);
  event.circle = circle;
  if (TEAMS.includes(circle)) {
    player.circles += 1;
    event.to = player.id;
    endTurn(game);
  } else if (circle === 'lucky') {
    Object.assign(event, playLucky(game, player.id, rand), { type: 'draw' });
    endTurn(game, event.nextId);
  } else {
    // Lose 2 / Lose 4: you pick who loses them (or the only choice is made for you).
    const targets = game.players.filter((p) => p.id !== player.id && !p.gone);
    if (targets.length === 1) {
      Object.assign(event, penalty(game, circle, targets[0].id));
      endTurn(game);
    } else {
      game.pending = { circle, by: player.id };
      event.choose = true;
    }
  }
  return event;
}

function penalty(game, circle, targetId) {
  const target = teamOf(game, targetId);
  return { target: target.id, lost: lose(target, circle === 'lose4' ? 4 : 2) };
}

/** Lose 2 / Lose 4: the opponent you picked loses them. */
export function choose(game, targetId) {
  const { circle, by } = game.pending;
  if (targetId === by || !teamOf(game, targetId) || teamOf(game, targetId).gone) return null;
  const event = { type: 'penalty', by, circle, ...penalty(game, circle, targetId) };
  endTurn(game);
  return event;
}

/** Same circles, same place. */
export const ranked = (players) =>
  [...players]
    .sort((a, b) => b.circles - a.circles)
    .map((p, i, list) => ({ place: list.findIndex((q) => q.circles === p.circles) + 1, id: p.id, team: p.team, name: p.name, circles: p.circles, gone: p.gone }));
