// Client-side game cache shared by REST snapshots and SSE events. Every Game
// JSON carries a `version` that grows with each change, so whichever copy
// arrives last, the newest one wins.

// Deleted ids remembered per page; deletions are rare, this only bounds memory.
const MAX_DELETED_IDS = 500;

export class GameStore {
  #entries = new Map();
  // Ids deleted on the server. A deletion carries no version, and a game id is
  // never reused, so any copy of these games that arrives later (a snapshot
  // or single-game fetch that was already in flight) is stale.
  #deleted = new Set();
  #listeners = new Set();
  #accept;

  // `accept(game)` decides whether a game belongs in this view (e.g. the
  // public board's time window); rejected games are removed.
  constructor({ accept = () => true } = {}) {
    this.#accept = accept;
  }

  get size() {
    return this.#entries.size;
  }

  get(id) {
    return this.#entries.get(id)?.game ?? null;
  }

  all() {
    return [...this.#entries.values()].map((entry) => entry.game);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change) {
    for (const listener of [...this.#listeners]) listener(change);
  }

  upsert(game) {
    if (!game || typeof game.id !== 'string' || this.#deleted.has(game.id)) return false;
    const current = this.#entries.get(game.id);
    if (current && current.game.version >= game.version) return false;
    if (!this.#accept(game)) {
      if (current) this.#drop(game.id);
      return false;
    }
    this.#entries.set(game.id, { game, receivedAt: Date.now() });
    this.#emit({ type: 'upsert', game, previous: current?.game ?? null });
    return true;
  }

  // The game was deleted on the server (SSE `removed`, or our DELETE succeeded).
  remove(id) {
    this.#deleted.add(id);
    if (this.#deleted.size > MAX_DELETED_IDS) this.#deleted.delete(this.#deleted.values().next().value);
    return this.#drop(id);
  }

  // Re-applies `accept` to every game (e.g. the board's time window moved on).
  refilter() {
    for (const { game } of [...this.#entries.values()]) {
      if (!this.#accept(game)) this.#drop(game.id);
    }
  }

  #drop(id) {
    const current = this.#entries.get(id);
    if (!current) return false;
    this.#entries.delete(id);
    this.#emit({ type: 'remove', id, previous: current.game });
    return true;
  }

  // Applies a REST snapshot whose request started at `requestedAt` (client
  // clock). Games missing from it are gone, unless an SSE event delivered
  // them after the request started (then they are newer than the snapshot)
  // or the snapshot only holds part of the games and `covers(game)` says
  // this one is outside that part.
  replaceAll(games, requestedAt, covers = () => true) {
    const seen = new Set();
    for (const game of games) {
      seen.add(game.id);
      this.upsert(game);
    }
    for (const [id, entry] of [...this.#entries]) {
      if (!seen.has(id) && entry.receivedAt < requestedAt && covers(entry.game)) this.#drop(id);
    }
    this.#emit({ type: 'sync' });
  }
}

// Wraps an async loader so overlapping calls collapse into one run plus at
// most one follow-up (a reconnect during a fetch still gets a fresh fetch).
export function coalesce(load) {
  let running = null;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        await load();
      } finally {
        running = null;
        if (again) {
          again = false;
          // Loaders report their own errors; nobody awaits the follow-up.
          run().catch(() => {});
        }
      }
    })();
    return running;
  };
  return run;
}
