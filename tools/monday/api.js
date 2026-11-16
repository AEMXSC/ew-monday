/**
 * monday.com adapter. Maps boards and items into the tool-neutral work item
 * shape described in model.js, so the panel never sees monday.com's schema.
 *
 * Adapter contract (what a Wrike / Asana / Smartsheet adapter must provide):
 *   me() -> { id, name }
 *   boards() -> [{ id, name }]
 *   board(id) -> { id, name, url, columns, missing: [titles] }
 *   prepareBoard(board) -> board            (adds missing columns)
 *   items(board) -> [workItem]
 *   createItem(board, { name, pageUrl, ownerId, stage }) -> workItem id
 *   updateItem(board, itemId, { stage?, pageUrl?, liveUrl? })
 *   addNote(itemId, text)
 */
import { STAGES, escapeHtml } from './model.js';

export const ENDPOINT = 'https://api.monday.com/v2';

/** Boards are read up to this many items. */
export const MAX_ITEMS = 500;

/** Column titles this extension creates when a board doesn't have them. */
export const COLUMN_TITLES = Object.freeze({
  stage: 'Content stage',
  page: 'Page',
  live: 'Live URL',
  owner: 'Owner',
  due: 'Due',
  brief: 'Brief',
});

export class MondayError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'MondayError';
    this.status = status;
    this.code = code;
  }
}

export function createMondayAdapter({ token, fetch = (...a) => window.fetch(...a), timeout = 20000 }) {
  async function gql(query, variables = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new MondayError(e.name === 'AbortError' ? 'monday.com did not answer in time.' : 'Could not reach monday.com.');
    } finally {
      clearTimeout(timer);
    }
    const body = await resp.json().catch(() => ({}));
    if (resp.status === 401 || body.error_code === 'UserUnauthorizedException') {
      throw new MondayError('monday.com rejected the token. Check it, or create a new one.', { status: 401, code: 'unauthorized' });
    }
    if (resp.status === 429 || body.error_code === 'ComplexityException') {
      throw new MondayError('monday.com is rate limiting requests. Try again in a minute.', { status: 429, code: 'rate' });
    }
    const err = body.errors?.[0]?.message || body.error_message;
    if (!resp.ok || err) throw new MondayError(err || `monday.com error ${resp.status}`, { status: resp.status });
    return body.data;
  }

  return {
    name: 'monday.com',

    async me() {
      const { me } = await gql('query { me { id name } }');
      return { id: String(me.id), name: me.name };
    },

    async boards() {
      const { boards } = await gql(`query {
        boards(limit: 100, state: active, order_by: used_at) { id name type }
      }`);
      return boards.filter((b) => b.type === 'board').map((b) => ({ id: String(b.id), name: b.name }));
    },

    async board(id) {
      const { boards } = await gql(`query ($ids: [ID!]) {
        boards(ids: $ids) { id name url columns { id title type } }
      }`, { ids: [id] });
      if (!boards?.length) throw new MondayError('That board is gone, or you no longer have access to it.', { code: 'notfound' });
      return describeBoard(boards[0]);
    },

    async prepareBoard(board) {
      const wanted = [
        ['stage', 'status'], ['page', 'link'], ['live', 'link'],
        ['owner', 'people'], ['due', 'date'], ['brief', 'long_text'],
      ];
      for (const [key, type] of wanted) {
        if (!board.columns[key]) {
          // Sequential on purpose: monday.com orders columns by creation.
          // eslint-disable-next-line no-await-in-loop
          await gql(`mutation ($b: ID!, $t: String!, $ty: ColumnType!) {
            create_column(board_id: $b, title: $t, column_type: $ty) { id }
          }`, { b: board.id, t: COLUMN_TITLES[key], ty: type });
        }
      }
      return this.board(board.id);
    },

    async items(board) {
      const out = [];
      let cursor = null;
      do {
        // eslint-disable-next-line no-await-in-loop
        const data = await gql(`query ($ids: [ID!], $cursor: String) {
          boards(ids: $ids) {
            items_page(limit: 100, cursor: $cursor) {
              cursor
              items {
                id name url
                column_values {
                  id type text
                  ... on StatusValue { label label_style { color } }
                  ... on PeopleValue { persons_and_teams { id kind } }
                  ... on LinkValue { url }
                  ... on DateValue { date }
                }
                updates(limit: 20) { id text_body created_at creator { name } }
              }
            }
          }
        }`, { ids: [board.id], cursor });
        const page = data.boards?.[0]?.items_page;
        if (!page) break;
        out.push(...page.items.map((i) => toWorkItem(i, board)));
        cursor = page.cursor;
      } while (cursor && out.length < MAX_ITEMS);
      // A board bigger than this may hide the page's item: the panel then won't offer to create a duplicate.
      out.truncated = Boolean(cursor);
      return out;
    },

    async createItem(board, { name, pageUrl, ownerId, stage = STAGES.DRAFTING }) {
      const values = columnValues(board, { stage, pageUrl, ownerId });
      const { create_item: item } = await gql(`mutation ($b: ID!, $n: String!, $v: JSON) {
        create_item(board_id: $b, item_name: $n, column_values: $v, create_labels_if_missing: true) { id }
      }`, { b: board.id, n: name, v: JSON.stringify(values) });
      return String(item.id);
    },

    async updateItem(board, itemId, changes) {
      const values = columnValues(board, changes);
      if (!Object.keys(values).length) return;
      await gql(`mutation ($b: ID!, $i: ID!, $v: JSON!) {
        change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v, create_labels_if_missing: true) { id }
      }`, { b: board.id, i: itemId, v: JSON.stringify(values) });
    },

    async addNote(itemId, text) {
      await gql(`mutation ($i: ID!, $t: String!) {
        create_update(item_id: $i, body: $t) { id }
      }`, { i: itemId, t: escapeHtml(text).replace(/\n/g, '<br>') }); // update bodies are HTML
    },
  };
}

/** Pick the columns the workflow needs, by title first, then by type. */
export function describeBoard(raw) {
  const cols = raw.columns ?? [];
  const byTitle = (title, type) => cols.find((c) => c.type === type
    && c.title.trim().toLowerCase() === title.toLowerCase());
  const byType = (type, exclude = []) => cols.find((c) => c.type === type && !exclude.includes(c.id));
  const briefCol = cols.find((c) => c.type === 'long_text' && /brief/i.test(c.title)) ?? byType('long_text');

  const page = byTitle(COLUMN_TITLES.page, 'link');
  const live = byTitle(COLUMN_TITLES.live, 'link');
  const columns = {
    stage: byTitle(COLUMN_TITLES.stage, 'status') ?? byType('status'),
    page,
    live,
    owner: byType('people'),
    due: byTitle(COLUMN_TITLES.due, 'date') ?? byType('date') ?? byType('timeline'),
    brief: briefCol,
  };
  const required = ['stage', 'page'];
  const optional = ['live', 'owner', 'due', 'brief'];
  return {
    id: String(raw.id),
    name: raw.name,
    url: raw.url ?? '',
    columns,
    missing: [...required, ...optional].filter((k) => !columns[k]).map((k) => COLUMN_TITLES[k]),
    ready: required.every((k) => columns[k]),
  };
}

export function toWorkItem(raw, board) {
  const values = Object.fromEntries((raw.column_values ?? []).map((v) => [v.id, v]));
  const col = (key) => (board.columns[key] ? values[board.columns[key].id] : undefined);
  const stage = col('stage');
  const due = col('due');
  // The column's text lists people and teams in the same order as persons_and_teams.
  const names = (col('owner')?.text ?? '').split(',').map((s) => s.trim());
  const owners = (col('owner')?.persons_and_teams ?? [])
    .map((p, i) => ({ ...p, name: names[i] ?? '' }))
    .filter((p) => p.kind === 'person');
  return {
    id: String(raw.id),
    name: raw.name,
    url: raw.url ?? '',
    stage: stage?.label ?? stage?.text ?? '',
    stageColor: stage?.label_style?.color ?? '',
    due: due?.date ?? dueFromText(due?.text),
    owners: owners.map((p) => ({ id: String(p.id), name: p.name })),
    brief: col('brief')?.text ?? '',
    pageUrl: col('page')?.url ?? '',
    liveUrl: col('live')?.url ?? '',
    updates: (raw.updates ?? []).map((u) => ({
      id: String(u.id), author: u.creator?.name ?? 'Someone', text: u.text_body ?? '', at: u.created_at,
    })),
  };
}

/** Timeline columns render as "2026-11-10 - 2026-11-20"; the end date is the due date. */
function dueFromText(text) {
  const dates = (text ?? '').match(/\d{4}-\d{2}-\d{2}/g);
  return dates ? dates[dates.length - 1] : '';
}

export function columnValues(board, { stage, pageUrl, liveUrl, ownerId } = {}) {
  const c = board.columns;
  const v = {};
  if (stage && c.stage) v[c.stage.id] = { label: stage };
  if (pageUrl && c.page) v[c.page.id] = { url: pageUrl, text: 'Edit in Workspace' };
  if (liveUrl && c.live) v[c.live.id] = { url: liveUrl, text: 'Live page' };
  if (ownerId && c.owner) v[c.owner.id] = { personsAndTeams: [{ id: Number(ownerId), kind: 'person' }] };
  return v;
}
