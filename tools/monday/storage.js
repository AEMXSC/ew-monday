/**
 * Browser storage for the panel. Everything lives in localStorage on the
 * panel's own web address: the author's monday.com token, the board picked
 * per site, and which preview/publish events were already written back.
 */
const PREFIX = 'ew-monday:';

/**
 * The panel's localStorage, or an in-memory store when the browser blocks it
 * (third-party storage off, sandboxed frame). `persistent` says which one.
 */
export function panelStore(win = window) {
  try {
    const store = win.localStorage;
    store.getItem(PREFIX);
    return { store, persistent: true };
  } catch {
    return { store: memoryStore(), persistent: false };
  }
}

export function browserStorage(store) {
  const read = (key) => {
    try {
      return JSON.parse(store.getItem(PREFIX + key));
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      if (value === null || value === undefined) store.removeItem(PREFIX + key);
      else store.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage blocked (private mode, policy): the panel still works for this session.
    }
  };

  return {
    token: () => read('token'),
    setToken: (t) => write('token', t),
    board: (org, site) => read(`board:${org}/${site}`),
    setBoard: (org, site, id) => write(`board:${org}/${site}`, id),
    marker: (itemId) => read(`sync:${itemId}`) ?? {},
    setMarker: (itemId, m) => write(`sync:${itemId}`, m),
    clear() {
      try {
        const keys = [];
        for (let i = 0; i < store.length; i += 1) keys.push(store.key(i));
        keys.filter((k) => k?.startsWith(PREFIX)).forEach((k) => store.removeItem(k));
      } catch {
        // nothing to clear
      }
    },
  };
}

/** In-memory stand-in for tests and for browsers that block storage. */
export function memoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
