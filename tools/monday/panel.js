/**
 * The side panel. Renders with plain DOM (textContent only: nothing from
 * monday.com is ever parsed as HTML) and keeps all state in one object.
 */
import {
  STAGES, STAGE_ORDER, decideSync, draftPrompt, dueLabel, dueState, editUrl, escapeHtml, findItemForPage,
  isFirstSight, isSyncNote, localToday, myWork, publishGate, safeUrl, SYNC_PREFIX, titleFor,
} from './model.js';
import { MAX_ITEMS, createMondayAdapter } from './api.js';

const POLL_MS = 30000;
const POLL_MAX_MS = 300000; // back off to 5 minutes while monday.com or the admin API keeps failing
const TOKEN_HELP = 'https://support.monday.com/hc/en-us/articles/360005144659-Does-monday-com-have-an-API';

/** Spectrum 2 status-light colours per stage; unknown labels fall back to the board's colour. */
const STAGE_DOTS = {
  [STAGES.BRIEF]: 'var(--s2-fuchsia-900, #b130bd)',
  [STAGES.DRAFTING]: 'var(--s2-blue-900, #3b63fb)',
  [STAGES.REVIEW]: 'var(--s2-orange-700, #e86a00)',
  [STAGES.CHANGES]: 'var(--s2-red-900, #d73220)',
  [STAGES.APPROVED]: 'var(--s2-green-700, #0ba45d)',
  [STAGES.PUBLISHED]: 'var(--s2-green-1000, #03714a)',
};
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

/** Spectrum 2 workflow icons (18px), trusted constants only. */
const ICONS = {
  more: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="16" cy="10" r="1.6"/></svg>',
  refresh: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.2 8.3A6.5 6.5 0 1 0 16 13"/><path d="M16.5 3.5v4.8h-4.8"/></svg>',
  alert: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.2 18.4 17H1.6z" fill="currentColor"/><path d="M10 7.5v4.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.3" r="1.1" fill="#fff"/></svg>',
  info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="currentColor"/><path d="M10 9v5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="6.2" r="1.1" fill="#fff"/></svg>',
  sparkle: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor"><path d="M8 2.5l1.3 3.7L13 7.5l-3.7 1.3L8 12.5 6.7 8.8 3 7.5l3.7-1.3zM14.5 11l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
};

function icon(name) {
  const span = document.createElement('span');
  span.className = 'mp-icon';
  span.innerHTML = ICONS[name];
  return span;
}

/**
 * Tiny hyperscript helper. `href` only accepts http(s) URLs; `key` marks a
 * focusable element so focus survives re-renders.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (v === undefined || v === null || v === false) return;
    if (k === 'className') node.className = v;
    else if (k === 'key') node.dataset.key = v;
    else if (k === 'href') node.setAttribute('href', safeUrl(v) || '#');
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  });
  children.flat().forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return node;
}

/** Links that leave the panel; the label tells screen-reader users it opens a new tab. */
function external(href, label, props = {}) {
  return el('a', {
    ...props, href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${label} (opens in a new tab)`,
  }, label);
}

export function mountPanel(root, {
  page, actions = {}, storage, adapterFactory = createMondayAdapter, embedded = true, demo = false,
  persistent = true, live = document.getElementById('mp-live'),
}) {
  const state = {
    view: 'loading', // loading | connect | boards | setup | main | error
    tab: 'page',
    me: null,
    boards: [],
    board: null,
    items: [],
    truncated: false,
    item: null,
    status: null,
    busy: '',
    message: null, // { level, text }
    promptPreview: '',
    draft: '', // comment being typed; kept across re-renders
    error: '',
  };
  let adapter = null;
  let pollTimer = null;
  let pollDelay = POLL_MS;
  let refreshSeq = 0;
  let lastSnapshot = '';
  let syncing = false;

  const set = (patch) => { Object.assign(state, patch); render(); };
  const flash = (level, text) => {
    set({ message: { level, text } });
    if (live) live.textContent = text;
    setTimeout(() => { if (state.message?.text === text) set({ message: null }); }, 5000);
  };

  function signOut(message) {
    clearTimeout(pollTimer);
    storage.setToken(null);
    adapter = null;
    set({ view: 'connect', error: message });
  }

  /** Runs one user action at a time, with a busy state and readable errors. */
  async function guard(label, fn) {
    if (state.busy) return;
    set({ busy: label, message: null });
    try {
      await fn();
    } catch (e) {
      if (e.code === 'unauthorized') { signOut(e.message); return; }
      flash('error', e.message || 'Something went wrong.');
    } finally {
      set({ busy: '' });
    }
  }

  // ---------- flows ----------

  async function start() {
    const token = storage.token();
    if (!token) { set({ view: 'connect' }); return; }
    adapter = adapterFactory({ token });
    await guard('Connecting', async () => {
      const me = await adapter.me();
      set({ me });
      const boardId = storage.board(page.org, page.site);
      if (boardId) await openBoard(boardId);
      else await listBoards();
    });
  }

  async function connect(token) {
    const clean = token.trim();
    if (!clean) return;
    adapter = adapterFactory({ token: clean });
    await guard('Connecting', async () => {
      const me = await adapter.me();
      storage.setToken(clean);
      set({ me, error: '' });
      await listBoards();
    });
  }

  async function listBoards() {
    const boards = await adapter.boards();
    set({ boards, view: 'boards' });
  }

  async function openBoard(id) {
    let board;
    try {
      board = await adapter.board(id);
    } catch (e) {
      if (e.code === 'notfound') { storage.setBoard(page.org, page.site, null); await listBoards(); return; }
      throw e;
    }
    storage.setBoard(page.org, page.site, board.id);
    if (!board.ready) { set({ board, view: 'setup' }); return; }
    set({ board, view: 'main' });
    schedulePoll(); // before the first read, so one failure doesn't stop syncing for good
    await refresh();
  }

  async function refresh({ quiet = false } = {}) {
    refreshSeq += 1;
    const seq = refreshSeq;
    const [items, status] = await Promise.all([adapter.items(state.board), page.status()]);
    if (seq !== refreshSeq) return; // a newer read finished first: don't show older data
    const item = findItemForPage(items, page.org, page.site, page.path);
    const snapshot = JSON.stringify({ items, status });
    if (!quiet || snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      set({ items, item, status, truncated: Boolean(items.truncated) });
    }
    if (item) await syncFromPage(item, status, { quiet });
  }

  /** Write preview/publish events back to the item, at most once each. */
  async function syncFromPage(item, status, { quiet }) {
    if (syncing) return;
    const marker = storage.marker(item.id);
    if (status && isFirstSight(marker)) {
      // First time this browser sees the item: earlier previews/publishes are history, not news.
      storage.setMarker(item.id, { previewAt: status.previewAt, liveAt: status.liveAt });
      return;
    }
    const decision = decideSync(item, status, marker);
    if (!decision) return;
    // Remember the event before writing: a failed write is reported, never retried into duplicates.
    storage.setMarker(item.id, decision.marker);
    if (!decision.stage) return;
    syncing = true;
    try {
      await adapter.addNote(item.id, decision.note);
      await adapter.updateItem(state.board, item.id, { stage: decision.stage, liveUrl: decision.liveUrl });
      // Re-read so stage colours and the new comment come from the board itself.
      await refresh({ quiet: true });
      flash('success', `monday.com updated: ${decision.stage}${quiet ? ' (page state changed)' : ''}`);
    } finally {
      syncing = false;
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!document.hidden && !state.busy && state.view === 'main') {
        try {
          await refresh({ quiet: true });
          pollDelay = POLL_MS;
        } catch (e) {
          if (e.code === 'unauthorized') { signOut(e.message); return; }
          pollDelay = Math.min(pollDelay * 2, POLL_MAX_MS);
          if (e.code === 'rate') flash('error', e.message);
        }
      }
      if (state.view === 'main') schedulePoll();
    }, pollDelay);
  }

  /** Already previewed or published before linking? That history isn't news. */
  function rememberBaseline(itemId) {
    if (state.status) storage.setMarker(itemId, { previewAt: state.status.previewAt, liveAt: state.status.liveAt });
  }

  async function linkItem(target) {
    await guard('Linking', async () => {
      // Keep a stage someone already set; only a fresh item becomes Drafting.
      const fresh = !target.stage || target.stage === STAGES.BRIEF;
      await adapter.updateItem(state.board, target.id, {
        pageUrl: editUrl(page.org, page.site, page.path),
        stage: fresh ? STAGES.DRAFTING : undefined,
      });
      rememberBaseline(target.id);
      await refresh();
      flash('success', 'Page linked to the item.');
    });
  }

  async function createItem() {
    await guard('Creating', async () => {
      const name = titleFor(await page.html(), page.path);
      const id = await adapter.createItem(state.board, {
        name, pageUrl: editUrl(page.org, page.site, page.path), ownerId: state.me?.id, stage: STAGES.DRAFTING,
      });
      rememberBaseline(id);
      await refresh();
      flash('success', `Created "${name}" on ${state.board.name}.`);
    });
  }

  async function setStage(stage) {
    const { item } = state;
    await guard('Saving', async () => {
      await adapter.updateItem(state.board, item.id, { stage });
      await adapter.addNote(item.id, `${SYNC_PREFIX} Stage set to ${stage} by ${state.me?.name ?? 'the author'}`);
      await refresh({ quiet: true });
    });
  }

  async function comment() {
    const clean = state.draft.trim();
    if (!clean) return;
    await guard('Posting', async () => {
      await adapter.addNote(state.item.id, clean);
      state.draft = ''; // only once monday.com has it
      await refresh();
      flash('success', 'Comment posted to monday.com.');
    });
  }

  function askAssistant(item) {
    const prompt = draftPrompt(item, { pagePath: page.path });
    if (actions.setPrompt) {
      actions.setPrompt(prompt, { autoSend: false });
      flash('success', 'The brief is in the assistant. Review it and press send.');
    } else {
      set({ promptPreview: prompt }); // demo / standalone: show what the assistant would get
    }
  }

  function insertBrief(item) {
    const paras = item.brief.split(/\n+/).map((p) => p.trim()).filter(Boolean);
    actions.sendHTML?.(paras.map((p) => `<p>${escapeHtml(p)}</p>`).join(''));
  }

  function disconnect() {
    clearTimeout(pollTimer);
    storage.clear();
    adapter = null;
    set({
      view: 'connect', me: null, board: null, items: [], item: null, boards: [], draft: '',
    });
  }

  function simulate(kind) {
    page.simulate(kind);
    guard('Syncing', refresh);
  }

  // ---------- views ----------

  function header() {
    return el('header', { className: 'mp-head' },
      el('div', { className: 'mp-brand' },
        el('span', { className: 'mp-logo', 'aria-hidden': 'true' }),
        el('div', {},
          el('h1', { className: 'mp-title' }, 'Content workflow'),
          el('span', { className: 'mp-sub' }, state.board ? state.board.name : 'monday.com'))),
      state.me && el('details', { className: 'mp-menu' },
        el('summary', { 'aria-label': 'More', className: 'nx-action-btn-icon', key: 'menu' }, icon('more')),
        el('div', { className: 'mp-menu-list' },
          state.board && external(state.board.url, 'Open board in monday.com'),
          el('button', { type: 'button', onClick: () => guard('Loading boards', listBoards) }, 'Switch board'),
          el('button', { type: 'button', onClick: disconnect }, 'Disconnect monday.com'))));
  }

  function connectView() {
    const input = el('input', {
      id: 'mp-token',
      key: 'token',
      className: 'nx-input',
      type: 'password',
      autocomplete: 'off',
      placeholder: 'Paste your token',
      required: true,
    });
    return el('section', { className: 'mp-card mp-connect' },
      el('h2', {}, 'Connect monday.com'),
      el('p', {}, 'See the content item behind this page, draft from its brief, and keep its status in sync as you preview and publish.'),
      state.error && el('p', { className: 'mp-note error', role: 'alert' }, state.error),
      el('form', { onSubmit: (e) => { e.preventDefault(); connect(input.value); } },
        el('label', { for: 'mp-token' }, 'Personal API token'),
        input,
        el('button', { type: 'submit', className: 'nx-btn-accent', disabled: Boolean(state.busy) }, state.busy || 'Connect')),
      !persistent && el('p', { className: 'mp-note warn' }, 'This browser blocks storage for the panel, so you\'ll need to paste the token again next time.'),
      el('p', { className: 'mp-fine' },
        'In monday.com: your avatar › Developers › My access tokens. ',
        external(TOKEN_HELP, 'How to find it'),
        '. The token stays in this browser and is only sent to monday.com.'));
  }

  function boardsView() {
    return el('section', { className: 'mp-card' },
      el('h2', {}, 'Pick the content board'),
      el('p', { className: 'mp-fine' }, `Used for every page on ${page.site}. You can switch later.`),
      state.boards.length
        ? el('ul', { className: 'mp-list' }, state.boards.map((b) => el('li', {},
          el('button', {
            type: 'button', className: 'mp-row', key: `board-${b.id}`, onClick: () => guard('Opening board', () => openBoard(b.id)),
          }, b.name))))
        : el('p', {}, 'No boards found. Create one in monday.com, then reopen this panel.'));
  }

  function setupView() {
    const { board } = state;
    return el('section', { className: 'mp-card' },
      el('h2', {}, 'Prepare the board'),
      el('p', {}, `"${board.name}" needs a few columns so pages and items stay linked:`),
      el('ul', { className: 'mp-bullets' }, board.missing.map((m) => el('li', {}, m))),
      el('button', {
        type: 'button',
        className: 'nx-btn-accent',
        key: 'prepare',
        disabled: Boolean(state.busy),
        onClick: () => guard('Adding columns', async () => {
          const ready = await adapter.prepareBoard(board);
          await openBoard(ready.id);
        }),
      }, state.busy || 'Add the columns'),
      el('p', { className: 'mp-fine' }, 'Existing columns and items are not changed.'));
  }

  function stagePill(item) {
    const color = STAGE_DOTS[item.stage] ?? (HEX_COLOR.test(item.stageColor) ? item.stageColor : '');
    const node = el('span', { className: 'mp-status' }, el('i', { 'aria-hidden': 'true' }), item.stage || 'No stage');
    if (color) node.style.setProperty('--dot', color); // CSSOM, not a style attribute: CSP-safe
    return node;
  }

  function dueChip(item) {
    if (item.stage === STAGES.PUBLISHED) return null;
    const today = localToday();
    const label = dueLabel(item.due, today);
    return label ? el('span', { className: `mp-due ${dueState(item.due, today)}` }, label) : null;
  }

  function itemCard(item) {
    const gate = publishGate(item);
    return el('section', { className: 'mp-card mp-item' },
      el('div', { className: 'mp-item-top' }, stagePill(item), dueChip(item)),
      el('h2', {}, item.name),
      item.owners.length > 0 && el('p', { className: 'mp-fine' }, `Owner: ${item.owners.map((o) => o.name).join(', ')}`),
      gate && el('div', { className: `mp-note ${gate.level}` },
        el('p', { className: 'mp-note-title' }, icon(gate.level === 'info' ? 'info' : 'alert'), gate.title),
        el('p', {}, gate.text)),
      el('div', { className: 'mp-actions' },
        item.brief && (actions.setPrompt || demo) && el('button', {
          type: 'button', className: 'nx-btn-accent', key: 'draft', onClick: () => askAssistant(item),
        }, icon('sparkle'), 'Draft with assistant'),
        item.brief && actions.sendHTML && el('button', {
          type: 'button', className: 'nx-action-btn', key: 'insert', onClick: () => insertBrief(item),
        }, 'Insert brief'),
        external(item.url, 'Open item', { className: 'nx-action-btn' })));
  }

  function stageCard(item) {
    return el('section', { className: 'mp-card' },
      el('h3', {}, 'Stage'),
      el('div', { className: 'mp-stages', role: 'group', 'aria-label': 'Content stage' },
        STAGE_ORDER.map((s) => el('button', {
          type: 'button',
          key: `stage-${s}`,
          className: `nx-action-btn nx-btn-sm${s === item.stage ? ' on' : ''}`,
          'aria-pressed': String(s === item.stage),
          disabled: Boolean(state.busy),
          onClick: () => s !== item.stage && setStage(s),
        }, s))),
      el('p', { className: 'mp-fine' }, syncLine()));
  }

  function commentsCard(item) {
    const textarea = el('textarea', {
      className: 'nx-input mp-textarea',
      key: 'comment',
      rows: 2,
      placeholder: 'Reply on monday.com…',
      'aria-label': 'Comment',
      onInput: (e) => { state.draft = e.target.value; }, // no re-render while typing
    });
    textarea.value = state.draft;
    return el('section', { className: 'mp-card' },
      el('h3', {}, 'Comments'),
      item.updates.length
        ? el('ul', { className: 'mp-updates' }, item.updates.map((u) => el('li', { className: isSyncNote(u.text) ? 'sync' : '' },
          el('strong', {}, u.author), el('span', { className: 'mp-fine' }, ` · ${relTime(u.at)}`),
          el('p', {}, u.text))))
        : el('p', { className: 'mp-fine' }, 'No comments yet.'),
      el('form', { className: 'mp-comment', onSubmit: (e) => { e.preventDefault(); comment(); } },
        textarea,
        el('button', { type: 'submit', className: 'nx-action-btn', key: 'post', disabled: Boolean(state.busy) }, 'Post')));
  }

  function pageTab() {
    const { item } = state;
    if (!item) return unlinkedView();
    return el('div', { className: 'mp-stack' },
      itemCard(item),
      state.promptPreview && el('section', { className: 'mp-card mp-demo' },
        el('h3', {}, 'Sent to the Workspace assistant'),
        el('p', { className: 'mp-brief mp-fine' }, state.promptPreview),
        el('button', {
          type: 'button', className: 'nx-action-btn nx-btn-sm', onClick: () => set({ promptPreview: '' }),
        }, 'Close')),
      item.brief && el('section', { className: 'mp-card' },
        el('h3', {}, 'Brief'),
        el('p', { className: 'mp-brief' }, item.brief)),
      stageCard(item),
      commentsCard(item));
  }

  function syncLine() {
    const s = state.status;
    if (!s) return 'Preview and publish status unavailable: set the stage by hand.';
    if (s.liveAt) return `Published ${relTime(s.liveAt)}. Previewing moves the item to In review; publishing marks it Published.`;
    if (s.previewAt) return `Previewed ${relTime(s.previewAt)}. Publishing marks the item Published.`;
    return 'Previewing moves the item to In review; publishing marks it Published.';
  }

  function unlinkedView() {
    const open = state.items.filter((i) => !i.pageUrl && i.stage !== STAGES.PUBLISHED);
    return el('div', { className: 'mp-stack' },
      el('section', { className: 'mp-card' },
        el('h2', {}, 'This page has no item yet'),
        state.truncated
          // The page's item may be beyond what was read: creating one could duplicate it.
          ? el('p', { className: 'mp-note warn' }, `The board has more than ${MAX_ITEMS} items, so the panel can't be sure. Link the page from monday.com: paste its Workspace URL into the item's Page column.`)
          : [
            el('p', {}, 'Link it to an item on the board, or create one from this page.'),
            el('button', {
              type: 'button', className: 'nx-btn-accent', key: 'create', disabled: Boolean(state.busy), onClick: createItem,
            }, state.busy === 'Creating' ? 'Creating…' : 'Create item from this page'),
          ]),
      el('section', { className: 'mp-card' },
        el('h3', {}, 'Link to an existing item'),
        open.length
          ? el('ul', { className: 'mp-list' }, open.slice(0, 25).map((i) => el('li', {},
            el('button', {
              type: 'button', className: 'mp-row', key: `link-${i.id}`, disabled: Boolean(state.busy), onClick: () => linkItem(i),
            },
            el('span', { className: 'mp-row-name' }, i.name),
            el('span', { className: 'mp-row-meta' }, stagePill(i), dueChip(i))))))
          : el('p', { className: 'mp-fine' }, 'Every open item is already linked to a page.')));
  }

  function workTab() {
    const mine = myWork(state.items, state.me?.id);
    if (!mine.length) return el('section', { className: 'mp-card' }, el('p', {}, 'Nothing assigned to you on this board. Nice.'));
    return el('section', { className: 'mp-card' },
      el('h3', {}, `Assigned to you (${mine.length})`),
      el('ul', { className: 'mp-list' }, mine.map((i) => el('li', {},
        el('a', {
          className: 'mp-row',
          key: `work-${i.id}`,
          href: i.pageUrl || i.url,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        el('span', { className: 'mp-row-name' }, i.name),
        el('span', { className: 'mp-row-meta' }, stagePill(i), dueChip(i),
          el('span', { className: 'mp-fine' }, i.pageUrl ? 'Open page (new tab)' : 'Open item (new tab)')))))));
  }

  /** WAI-ARIA tabs: roving tabindex, arrow keys, Home and End. */
  function tabs() {
    const list = [['page', 'This page'], ['work', 'My work']];
    const mineCount = myWork(state.items, state.me?.id).length;
    const select = (id) => set({ tab: id });
    const onKeyDown = (e) => {
      const i = list.findIndex(([id]) => id === state.tab);
      const next = {
        ArrowRight: (i + 1) % list.length,
        ArrowLeft: (i - 1 + list.length) % list.length,
        Home: 0,
        End: list.length - 1,
      }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      select(list[next][0]);
      root.querySelector(`#mp-tab-${list[next][0]}`)?.focus(); // focus follows the selection
    };
    return el('div', { className: 'mp-tabs' },
      el('div', { role: 'tablist', 'aria-label': 'Panel views', onKeyDown },
        list.map(([id, label]) => el('button', {
          type: 'button',
          role: 'tab',
          id: `mp-tab-${id}`,
          key: `tab-${id}`,
          'aria-controls': 'mp-tabpanel',
          'aria-selected': String(state.tab === id),
          tabindex: state.tab === id ? '0' : '-1',
          onClick: () => select(id),
        }, label, id === 'work' && mineCount ? el('span', { className: 'mp-count' }, mineCount) : null))),
      el('button', {
        type: 'button',
        className: 'nx-action-btn-icon mp-refresh',
        key: 'refresh',
        'aria-label': 'Refresh',
        title: 'Refresh',
        disabled: Boolean(state.busy),
        onClick: () => guard('Refreshing', refresh),
      }, icon('refresh')));
  }

  function mainView() {
    return el('div', {},
      tabs(),
      el('div', { role: 'tabpanel', id: 'mp-tabpanel', 'aria-labelledby': `mp-tab-${state.tab}` },
        state.tab === 'page' ? pageTab() : workTab()),
      demo && page.simulate && el('section', { className: 'mp-card mp-demo' },
        el('h3', {}, 'Demo mode'),
        el('p', { className: 'mp-fine' }, 'Sample data, nothing is saved. Simulate what the author does in Workspace:'),
        el('div', { className: 'mp-actions' },
          el('button', { type: 'button', className: 'nx-action-btn', disabled: Boolean(state.busy), onClick: () => simulate('preview') }, 'Preview the page'),
          el('button', { type: 'button', className: 'nx-action-btn', disabled: Boolean(state.busy), onClick: () => simulate('live') }, 'Publish the page'))));
  }

  function render() {
    // Everything is rebuilt, so carry focus (and the caret) over by key.
    const active = document.activeElement;
    const focusKey = root.contains(active) ? active.dataset.key : '';
    const caret = focusKey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;

    const body = {
      loading: () => el('p', { className: 'mp-fine mp-center' }, 'Loading…'),
      connect: connectView,
      boards: boardsView,
      setup: setupView,
      main: mainView,
    }[state.view]?.() ?? el('p', { role: 'alert' }, state.error);
    root.replaceChildren(...[
      header(),
      !embedded && !demo && el('p', { className: 'mp-note info' }, `Standalone mode: ${page.org}/${page.site}${page.path}. Insert and assistant actions need Experience Workspace.`),
      state.message && el('p', { className: `mp-note ${state.message.level}` }, state.message.text),
      state.busy && state.view === 'main' && el('div', { className: 'mp-progress', role: 'progressbar', 'aria-label': state.busy }),
      body,
    ].filter((n) => n instanceof Node));

    const target = focusKey && root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (target) {
      target.focus();
      if (caret && target.setSelectionRange) target.setSelectionRange(...caret);
    }
  }

  render();
  if (page.path === '/' && !page.site) {
    set({ view: 'error', error: 'Open a page in Experience Workspace to use this panel.' });
  } else {
    start();
  }
  return { state, refresh, destroy: () => clearTimeout(pollTimer) };
}

export function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
