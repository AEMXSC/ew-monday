import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENDPOINT, MondayError, columnValues, createMondayAdapter, describeBoard, toWorkItem,
} from '../tools/monday/api.js';
import { parseStatus } from '../tools/monday/page.js';
import { browserStorage, memoryStore } from '../tools/monday/storage.js';

const rawBoard = {
  id: 11,
  name: 'Fréscopa content calendar',
  url: 'https://x.monday.com/boards/11',
  columns: [
    { id: 'name', title: 'Name', type: 'name' },
    { id: 'status', title: 'Status', type: 'status' },
    { id: 'stage_1', title: 'Content stage', type: 'status' },
    { id: 'link_page', title: 'Page', type: 'link' },
    { id: 'link_live', title: 'Live URL', type: 'link' },
    { id: 'person', title: 'Owner', type: 'people' },
    { id: 'date4', title: 'Due', type: 'date' },
    { id: 'text_brief', title: 'Brief', type: 'long_text' },
  ],
};

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, ...opts, body: JSON.parse(opts.body) });
    const next = responses.shift();
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('board columns: titled columns win over the first column of a type', () => {
  const b = describeBoard(rawBoard);
  assert.equal(b.columns.stage.id, 'stage_1');
  assert.equal(b.columns.page.id, 'link_page');
  assert.equal(b.columns.live.id, 'link_live');
  assert.equal(b.ready, true);
  assert.deepEqual(b.missing, []);
  const bare = describeBoard({ id: 1, name: 'x', columns: [{ id: 's', title: 'Status', type: 'status' }] });
  assert.equal(bare.ready, false);
  assert.deepEqual(bare.missing, ['Page', 'Live URL', 'Owner', 'Due', 'Brief']);
});

test('items map into the tool-neutral work item shape', () => {
  const board = describeBoard(rawBoard);
  const w = toWorkItem({
    id: 99,
    name: 'World Tour landing page',
    url: 'https://x.monday.com/boards/11/pulses/99',
    column_values: [
      { id: 'stage_1', type: 'status', text: 'In review', label: 'In review', label_style: { color: '#fdab3d' } },
      { id: 'link_page', type: 'link', text: 'Edit', url: 'https://da.live/canvas#/aemxsc/frescopa26/tour' },
      { id: 'person', type: 'people', text: 'Courtney R, Sam', persons_and_teams: [{ id: 5, kind: 'person' }, { id: 6, kind: 'person' }] },
      { id: 'date4', type: 'date', text: '2026-11-20', date: '2026-11-20' },
      { id: 'text_brief', type: 'long_text', text: 'Announce the tour.' },
    ],
    updates: [{ id: 1, text_body: 'Looks good', created_at: '2026-11-16T10:00:00Z', creator: { name: 'Legal' } }],
  }, board);
  assert.equal(w.stage, 'In review');
  assert.equal(w.stageColor, '#fdab3d');
  assert.equal(w.pageUrl, 'https://da.live/canvas#/aemxsc/frescopa26/tour');
  assert.deepEqual(w.owners, [{ id: '5', name: 'Courtney R' }, { id: '6', name: 'Sam' }]);
  assert.equal(w.due, '2026-11-20');
  assert.equal(w.brief, 'Announce the tour.');
  assert.deepEqual(w.updates[0], { id: '1', author: 'Legal', text: 'Looks good', at: '2026-11-16T10:00:00Z' });
});

test('timeline columns use their end date as the due date', () => {
  const board = describeBoard({ id: 1, name: 'x', columns: [{ id: 's', title: 'Status', type: 'status' }, { id: 't', title: 'Timeline', type: 'timeline' }] });
  const w = toWorkItem({ id: 1, name: 'x', column_values: [{ id: 't', type: 'timeline', text: '2026-11-10 - 2026-11-20' }] }, board);
  assert.equal(w.due, '2026-11-20');
});

test('column values use monday.com JSON formats and skip unmapped columns', () => {
  const board = describeBoard(rawBoard);
  assert.deepEqual(columnValues(board, {
    stage: 'Published', pageUrl: 'https://da.live/canvas#/o/s/p', liveUrl: 'https://www.x.com/p', ownerId: '5',
  }), {
    stage_1: { label: 'Published' },
    link_page: { url: 'https://da.live/canvas#/o/s/p', text: 'Edit in Workspace' },
    link_live: { url: 'https://www.x.com/p', text: 'Live page' },
    person: { personsAndTeams: [{ id: 5, kind: 'person' }] },
  });
  const noLive = describeBoard({ ...rawBoard, columns: rawBoard.columns.filter((c) => c.id !== 'link_live') });
  assert.deepEqual(columnValues(noLive, { liveUrl: 'https://www.x.com/p' }), {});
});

test('adapter sends the token only to monday.com and creates labels if missing', async () => {
  const fetch = fakeFetch([{ body: { data: { change_multiple_column_values: { id: '9' } } } }]);
  const api = createMondayAdapter({ token: 'tok', fetch });
  await api.updateItem(describeBoard(rawBoard), '9', { stage: 'In review' });
  const [call] = fetch.calls;
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.headers.Authorization, 'tok');
  assert.match(call.body.query, /create_labels_if_missing: true/);
  assert.equal(call.body.variables.v, JSON.stringify({ stage_1: { label: 'In review' } }));
});

test('adapter turns monday.com failures into readable errors', async () => {
  const unauthorized = createMondayAdapter({ token: 'bad', fetch: fakeFetch([{ status: 401, body: { errors: [{ message: 'Not Authenticated' }] } }]) });
  await assert.rejects(unauthorized.me(), (e) => e instanceof MondayError && e.code === 'unauthorized');
  const gqlError = createMondayAdapter({ token: 't', fetch: fakeFetch([{ body: { errors: [{ message: 'Column not found' }] } }]) });
  await assert.rejects(gqlError.me(), /Column not found/);
  const rate = createMondayAdapter({ token: 't', fetch: fakeFetch([{ body: { error_code: 'ComplexityException' } }]) });
  await assert.rejects(rate.me(), (e) => e.code === 'rate');
});

test('items follow the cursor across pages', async () => {
  const page = (ids, cursor) => ({ body: { data: { boards: [{ items_page: { cursor, items: ids.map((id) => ({ id, name: `#${id}`, column_values: [], updates: [] })) } }] } } });
  const fetch = fakeFetch([page([1, 2], 'c1'), page([3], null)]);
  const items = await createMondayAdapter({ token: 't', fetch }).items(describeBoard(rawBoard));
  assert.deepEqual(items.map((i) => i.id), ['1', '2', '3']);
  assert.equal(fetch.calls[1].body.variables.cursor, 'c1');
});

test('admin status: only successful preview/publish counts', () => {
  assert.deepEqual(parseStatus({
    preview: { status: 200, lastModified: 'Mon, 16 Nov 2026 10:00:00 GMT', url: 'https://main--s--o.aem.page/tour' },
    live: { status: 404 },
  }), {
    previewAt: '2026-11-16T10:00:00.000Z', liveAt: null, previewUrl: 'https://main--s--o.aem.page/tour', liveUrl: null,
  });
  assert.deepEqual(parseStatus(null), { previewAt: null, liveAt: null, previewUrl: null, liveUrl: null });
});

test('storage is namespaced and clear() only removes our keys', () => {
  const store = memoryStore();
  store.setItem('other', 'keep');
  const s = browserStorage(store);
  s.setToken('tok');
  s.setBoard('o', 's', '11');
  s.setMarker('9', { previewAt: 'x' });
  assert.equal(s.token(), 'tok');
  assert.equal(s.board('o', 's'), '11');
  assert.deepEqual(s.marker('9'), { previewAt: 'x' });
  assert.deepEqual(s.marker('nope'), {});
  s.clear();
  assert.equal(s.token(), null);
  assert.equal(store.getItem('other'), 'keep');
});
