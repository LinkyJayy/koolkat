// Kat Wordle: guess the 5-letter word in six tries. Every game picks a new
// random word. Blue = right letter, right spot; dark blue = in the word but
// somewhere else; grey = not in the word.
import { ANSWERS, isWord } from './wordle-words.js';

const ROWS = 6;
const LENGTH = 5;
const STATS_KEY = 'koolkat.katWordle';
const KEYS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const RANK = { absent: 1, present: 2, correct: 3 };

// Words the rules below get wrong.
const SYLLABLE_EXCEPTIONS = { maybe: 2, naive: 2, quiet: 2, reuse: 2, cruel: 2, fluid: 2, vague: 1, deity: 3, onion: 2, union: 2, every: 3, react: 2, ideal: 3, being: 2, doing: 2, going: 2, suing: 2, queue: 1 };
/** How many syllables a word has (for the first hint). */
export function syllables(word) {
  const known = SYLLABLE_EXCEPTIONS[word];
  if (known) return known;
  let w = word.toLowerCase();
  // Silent e at the end ("smile", "whale"), but "table", "apple" keep their -le.
  if (/e$/.test(w) && !/[^aeiouy]le$/.test(w) && !/[aeiouy]{2}e$/.test(w)) w = w.slice(0, -1);
  w = w.replace(/^y/, '').replace(/qu/g, 'q');
  let count = 0;
  for (const g of w.match(/[aeiouy]+/g) ?? []) {
    count += 1;
    // Vowels said separately: "piano", "video", "audio", "dying", "layer".
    count += (g.match(/ia|io|eo|ua|uo|ao|iu|yi|y[aeiou]/g) ?? []).length;
  }
  return Math.max(1, count);
}


/** How each letter of a guess scores against the answer (handles repeated letters). */
export function score(guess, answer) {
  const result = Array(LENGTH).fill('absent');
  const left = {};
  for (let i = 0; i < LENGTH; i++) {
    if (guess[i] === answer[i]) result[i] = 'correct';
    else left[answer[i]] = (left[answer[i]] ?? 0) + 1;
  }
  for (let i = 0; i < LENGTH; i++) {
    if (result[i] === 'correct') continue;
    if (left[guess[i]] > 0) {
      result[i] = 'present';
      left[guess[i]] -= 1;
    }
  }
  return result;
}

function loadStats() {
  try {
    return { played: 0, wins: 0, streak: 0, best: 0, guesses: [0, 0, 0, 0, 0, 0], ...JSON.parse(localStorage.getItem(STATS_KEY) || '{}') };
  } catch {
    return { played: 0, wins: 0, streak: 0, best: 0, guesses: [0, 0, 0, 0, 0, 0] };
  }
}
function saveStats(stats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // Stats are just for fun.
  }
}

function make(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** Sets up Kat Wordle in its screen. Returns { start } for a new game. */
export function createKatWordle({ board, keyboard, message, result, hints }) {
  const game = { answer: '', rows: [], current: '', done: false, busy: false, hints: 0 };

  // Three hints, one at a time: syllables, then the first letter, then the last.
  const hintButton = make('button', 'btn small kw-hint-btn');
  hintButton.type = 'button';
  const hintList = make('div', 'kw-hint-list');
  hints.replaceChildren(hintButton, hintList);
  const HINTS = [
    (w) => { const n = syllables(w); return `🗣 ${n} syllable${n === 1 ? '' : 's'}`; },
    (w) => `🔤 Starts with ${w[0].toUpperCase()}`,
    (w) => `🏁 Ends with ${w[LENGTH - 1].toUpperCase()}`,
  ];
  function drawHints() {
    const left = HINTS.length - game.hints;
    hintButton.textContent = left ? `💡 Hint (${left} left)` : '💡 No hints left';
    hintButton.disabled = !left || game.done;
    hintList.replaceChildren(...HINTS.slice(0, game.hints).map((h) => make('span', 'kw-hint', h(game.answer))));
  }
  hintButton.addEventListener('click', () => {
    if (game.hints >= HINTS.length || game.done) return;
    game.hints += 1;
    drawHints();
  });
  const keyButtons = new Map();

  // Keyboard
  keyboard.replaceChildren();
  KEYS.forEach((row, r) => {
    const line = make('div', 'kw-keys');
    if (r === 2) line.append(keyButton('enter', 'Enter', 'kw-wide'));
    for (const letter of row) line.append(keyButton(letter, letter.toUpperCase()));
    if (r === 2) line.append(keyButton('back', '⌫', 'kw-wide'));
    keyboard.append(line);
  });
  function keyButton(key, label, cls = '') {
    const b = make('button', `kw-key ${cls}`, label);
    b.type = 'button';
    b.dataset.key = key;
    if (key === 'back') b.setAttribute('aria-label', 'Delete');
    b.addEventListener('click', () => press(key));
    if (key.length === 1) keyButtons.set(key, b);
    return b;
  }

  // Board
  const tiles = [];
  board.replaceChildren();
  for (let r = 0; r < ROWS; r++) {
    const row = make('div', 'kw-row');
    tiles.push([]);
    for (let c = 0; c < LENGTH; c++) {
      const tile = make('div', 'kw-tile');
      row.append(tile);
      tiles[r].push(tile);
    }
    board.append(row);
  }

  let messageTimer = null;
  function say(text, ms = 1600) {
    message.textContent = text;
    message.hidden = false;
    clearTimeout(messageTimer);
    if (ms) messageTimer = setTimeout(() => (message.hidden = true), ms);
  }

  function start() {
    game.answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
    game.rows = [];
    game.current = '';
    game.done = false;
    game.busy = false;
    game.hints = 0;
    drawHints();
    for (const row of tiles) for (const tile of row) {
      tile.textContent = '';
      tile.className = 'kw-tile';
    }
    for (const b of keyButtons.values()) b.classList.remove('correct', 'present', 'absent');
    message.hidden = true;
    result.hidden = true;
  }

  function drawCurrent() {
    const r = game.rows.length;
    if (r >= ROWS) return;
    tiles[r].forEach((tile, i) => {
      tile.textContent = game.current[i]?.toUpperCase() ?? '';
      tile.classList.toggle('filled', Boolean(game.current[i]));
    });
  }

  function press(key) {
    if (game.done || game.busy) return;
    if (key === 'enter') return submit();
    if (key === 'back') game.current = game.current.slice(0, -1);
    else if (/^[a-z]$/.test(key) && game.current.length < LENGTH) game.current += key;
    drawCurrent();
  }

  function shake() {
    const row = board.children[game.rows.length];
    row.classList.remove('kw-shake');
    void row.offsetWidth;
    row.classList.add('kw-shake');
  }

  function submit() {
    const guess = game.current;
    if (guess.length < LENGTH) {
      shake();
      return say('Not enough letters');
    }
    if (!isWord(guess)) {
      shake();
      return say('Not in word list');
    }
    const marks = score(guess, game.answer);
    const r = game.rows.length;
    game.rows.push(guess);
    game.current = '';
    game.busy = true;
    // Flip the tiles one by one.
    tiles[r].forEach((tile, i) => {
      setTimeout(() => {
        tile.classList.add('flip');
        setTimeout(() => tile.classList.add(marks[i]), 180);
      }, i * 260);
    });
    setTimeout(() => {
      marks.forEach((mark, i) => {
        const b = keyButtons.get(guess[i]);
        const now = ['correct', 'present', 'absent'].find((c) => b.classList.contains(c));
        if (!now || RANK[mark] > RANK[now]) {
          b.classList.remove('correct', 'present', 'absent');
          b.classList.add(mark);
        }
      });
      game.busy = false;
      if (guess === game.answer) finish(true);
      else if (game.rows.length === ROWS) finish(false);
    }, LENGTH * 260 + 200);
  }

  function finish(won) {
    game.done = true;
    drawHints();
    const stats = loadStats();
    stats.played += 1;
    if (won) {
      stats.wins += 1;
      stats.streak += 1;
      stats.best = Math.max(stats.best, stats.streak);
      stats.guesses[game.rows.length - 1] += 1;
    } else stats.streak = 0;
    saveStats(stats);
    const words = ['Genius!', 'Magnificent!', 'Impressive!', 'Splendid!', 'Great!', 'Phew!'];
    say(won ? words[game.rows.length - 1] : game.answer.toUpperCase(), 0);
    setTimeout(() => showResult(won, stats), 900);
  }

  function showResult(won, stats) {
    message.hidden = true;
    const title = result.querySelector('.kw-result-title');
    title.textContent = won ? `🎉 You got it in ${game.rows.length}!` : '😿 So close!';
    result.querySelector('.kw-result-word').textContent = `The word was ${game.answer.toUpperCase()}`;
    const nums = result.querySelector('.kw-stats');
    nums.replaceChildren(
      ...[
        [stats.played, 'Played'],
        [stats.played ? Math.round((stats.wins / stats.played) * 100) : 0, 'Win %'],
        [stats.streak, 'Streak'],
        [stats.best, 'Best streak'],
      ].map(([n, label]) => {
        const box = make('div', 'kw-stat');
        box.append(make('strong', '', String(n)), make('span', '', label));
        return box;
      })
    );
    const most = Math.max(1, ...stats.guesses);
    const dist = result.querySelector('.kw-dist');
    dist.replaceChildren(
      ...stats.guesses.map((n, i) => {
        const line = make('div', 'kw-dist-row');
        const bar = make('span', `kw-dist-bar${won && i === game.rows.length - 1 ? ' now' : ''}`, String(n));
        bar.style.width = `${Math.max(8, (n / most) * 100)}%`;
        line.append(make('span', 'kw-dist-n', String(i + 1)), bar);
        return line;
      })
    );
    result.hidden = false;
  }

  // Typing on a real keyboard.
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key === 'Enter' ? 'enter' : e.key === 'Backspace' ? 'back' : e.key.toLowerCase();
    if (key === 'enter' || key === 'back' || /^[a-z]$/.test(key)) {
      e.preventDefault();
      press(key);
    }
  }

  return { start, onKey, get answer() { return game.answer; } };
}
