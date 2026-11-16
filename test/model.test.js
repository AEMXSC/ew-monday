import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES, decideSync, draftPrompt, dueLabel, dueState, editUrl, findItemForPage,
  linksToPage, myWork, publishGate, titleFor, webPath,
} from '../tools/monday/model.js';

const item = (extra = {}) => ({
  id: '1', name: 'World Tour landing page', url: 'https://x.monday.com/boards/1/pulses/1', stage: STAGES.DRAFTING,
  stageColor: '', due: '', owners: [], brief: '', pageUrl: '', liveUrl: '', updates: [], ...extra,
});

test('edit URLs and page matching survive index pages, .html and trailing slashes', () => {
  assert.equal(editUrl('aemxsc', 'frescopa26', '/tour'), 'https://da.live/canvas#/aemxsc/frescopa26/tour');
  assert.equal(webPath('/index'), '/');
  assert.equal(webPath('/roasts/index'), '/roasts/');
  assert.equal(webPath('/tour.html'), '/tour');
  assert.ok(linksToPage('https://da.live/canvas#/aemxsc/frescopa26/tour', 'aemxsc', 'frescopa26', '/tour'));
  assert.ok(linksToPage('https://da.live/edit#/aemxsc/frescopa26/tour.html', 'aemxsc', 'frescopa26', 'tour/'));
  assert.ok(!linksToPage('https://da.live/canvas#/aemxsc/frescopa26/tour-2', 'aemxsc', 'frescopa26', '/tour'));
  assert.ok(!linksToPage('', 'aemxsc', 'frescopa26', '/tour'));
  const items = [item({ id: 'a' }), item({ id: 'b', pageUrl: editUrl('aemxsc', 'frescopa26', '/tour') })];
  assert.equal(findItemForPage(items, 'aemxsc', 'frescopa26', '/tour').id, 'b');
  assert.equal(findItemForPage(items, 'aemxsc', 'frescopa26', '/other'), null);
});

test('due dates bucket and read naturally', () => {
  const today = '2026-11-16';
  assert.equal(dueState('', today), 'none');
  assert.equal(dueState('2026-11-14', today), 'overdue');
  assert.equal(dueState('2026-11-16', today), 'today');
  assert.equal(dueState('2026-11-18', today), 'soon');
  assert.equal(dueState('2026-11-30', today), 'later');
  assert.equal(dueLabel('2026-11-15', today), 'Overdue by 1 day');
  assert.equal(dueLabel('2026-11-17', today), 'Due tomorrow');
  assert.equal(dueLabel('2026-11-30', today), 'Due Nov 30');
});

test('publish gate warns by stage and surfaces the reviewer, not our sync notes', () => {
  const changes = item({
    stage: STAGES.CHANGES,
    updates: [
      { id: '2', author: 'Courtney', text: 'Experience Workspace · Ready for review' },
      { id: '1', author: 'Legal', text: 'Remove the "free forever" claim.' },
    ],
  });
  assert.deepEqual(publishGate(changes), { level: 'error', title: 'Changes requested', text: 'Legal: Remove the "free forever" claim.' });
  assert.equal(publishGate(item({ stage: STAGES.REVIEW })).level, 'warn');
  assert.equal(publishGate(item({ stage: STAGES.DRAFTING })).level, 'info');
  assert.equal(publishGate(item({ stage: STAGES.APPROVED })), null);
  assert.equal(publishGate(item({ stage: STAGES.PUBLISHED })), null);
});

test('sync: preview moves open items to review, publish marks published, each only once', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const preview = decideSync(item(), { previewAt: t1, liveAt: null, previewUrl: 'https://main--s--o.aem.page/tour' });
  assert.equal(preview.stage, STAGES.REVIEW);
  assert.match(preview.note, /Ready for review: https:\/\/main--s--o\.aem\.page\/tour/);
  assert.equal(decideSync(item({ stage: STAGES.REVIEW }), { previewAt: t1 }, preview.marker), null, 'same event is not replayed');

  // A preview while approved must not demote the item back to review.
  const quiet = decideSync(item({ stage: STAGES.APPROVED }), { previewAt: t2, liveAt: null }, preview.marker);
  assert.equal(quiet.stage, undefined);
  assert.equal(quiet.marker.previewAt, t2);

  const live = decideSync(item({ stage: STAGES.APPROVED }), { previewAt: t2, liveAt: t2, liveUrl: 'https://www.frescopa.coffee/tour' }, quiet.marker);
  assert.equal(live.stage, STAGES.PUBLISHED);
  assert.equal(live.liveUrl, 'https://www.frescopa.coffee/tour');
  assert.equal(decideSync(item({ stage: STAGES.PUBLISHED }), { previewAt: t2, liveAt: t2 }, live.marker), null);
  assert.equal(decideSync(item(), null), null);
});

test('my work: assigned, open, soonest first, undated last', () => {
  const me = { id: '42', name: 'Me' };
  const items = [
    item({ id: 'late', name: 'B', due: '2026-12-01', owners: [me] }),
    item({ id: 'soon', name: 'A', due: '2026-11-17', owners: [me] }),
    item({ id: 'none', name: 'C', owners: [me] }),
    item({ id: 'done', stage: STAGES.PUBLISHED, owners: [me] }),
    item({ id: 'other', owners: [{ id: '7', name: 'Someone' }] }),
  ];
  assert.deepEqual(myWork(items, 42).map((i) => i.id), ['soon', 'late', 'none']);
});

test('assistant prompt carries brief, human comments and due date, not sync notes', () => {
  const p = draftPrompt(item({
    brief: 'Announce the 2026 World Tour. CTA: find a city.',
    due: '2026-11-20',
    updates: [
      { id: '1', author: 'Experience Workspace', text: 'Experience Workspace · Ready for review' },
      { id: '2', author: 'Brand', text: 'Use the new tour photography.' },
    ],
  }), { pagePath: '/tour' });
  assert.match(p, /Draft the page \/tour/);
  assert.match(p, /Announce the 2026 World Tour/);
  assert.match(p, /Brand: Use the new tour photography/);
  assert.match(p, /Due Nov 20/);
  assert.doesNotMatch(p, /Ready for review/);
});

test('new item titles come from the page h1, else the path', () => {
  assert.equal(titleFor('<body><main><div><h1 id="x">Fréscopa <em>World</em> Tour &amp; more</h1></div></main></body>', '/tour'), 'Fréscopa World Tour & more');
  assert.equal(titleFor('', '/campaigns/holiday-gift-guide'), 'Holiday Gift Guide');
  assert.equal(titleFor('', '/index'), 'Home');
});
