/**
 * In-memory stand-in for monday.com, loaded with ?demo=1 on the panel URL.
 * Same contract as api.js, so the whole panel can be tried without an account.
 * Nothing leaves the browser; changes reset on reload.
 */
import { STAGES } from './model.js';

const STAGE_COLORS = {
  [STAGES.BRIEF]: '#a25ddc',
  [STAGES.DRAFTING]: '#579bfc',
  [STAGES.REVIEW]: '#fdab3d',
  [STAGES.CHANGES]: '#e2445c',
  [STAGES.APPROVED]: '#00c875',
  [STAGES.PUBLISHED]: '#037f4c',
};

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

export function createDemoAdapter({ page } = {}) {
  const me = { id: '1', name: 'You (demo)' };
  const board = {
    id: 'demo',
    name: 'Fréscopa content calendar (demo)',
    url: 'https://monday.com',
    columns: { stage: {}, page: {}, live: {}, owner: {}, due: {}, brief: {} },
    missing: [],
    ready: true,
  };
  let seq = 100;
  const nextId = () => { seq += 1; return String(seq); };
  const pageLink = (path) => (page ? `https://da.live/canvas#/${page.org}/${page.site}${path}` : '');
  const item = (name, stage, due, brief, extra = {}) => ({
    id: nextId(),
    name,
    url: 'https://monday.com',
    stage,
    stageColor: STAGE_COLORS[stage],
    due,
    owners: [me],
    brief,
    pageUrl: '',
    liveUrl: '',
    updates: [],
    ...extra,
  });

  const items = [
    item('World Tour 2026 landing page', STAGES.BRIEF, day(4),
      'Announce the Fréscopa World Tour 2026: 12 cities, pop-up cafés, live roasting.\n\nAudience: existing customers and coffee fans near tour cities.\nMust include: hero with tour dates, city list, "Find your city" CTA, sign-up for tour news.\nTone: warm, crafted, not salesy.',
      { updates: [{ id: 'u1', author: 'Brand team', text: 'Use the new tour photography from the DAM, not stock.', at: ago(90) }] }),
    item('Holiday gift guide', STAGES.DRAFTING, day(9),
      'Gift guide for coffee lovers in three price bands. Feature the Atelier machines and the holiday roast.'),
    item('Cold brew season launch', STAGES.BRIEF, day(-1),
      'Launch page for the cold brew range. Lead with the 18-hour steep story, then recipes.'),
    item('Barista academy sign-up', STAGES.APPROVED, day(2),
      'Sign-up page for in-café barista classes: dates, price, booking form.'),
  ];
  if (page) {
    items.push(item('Page refresh', STAGES.CHANGES, day(1),
      'Seasonal refresh: new hero image, tighter intro, add the holiday roast.', {
        pageUrl: pageLink(page.path),
        updates: [
          { id: 'u2', author: 'Legal', text: 'Please remove "the best coffee in the world". We can\'t substantiate it. Everything else is approved.', at: ago(25) },
          { id: 'u3', author: 'You (demo)', text: 'Experience Workspace · Ready for review', at: ago(180) },
        ],
      }));
  }

  const find = (id) => items.find((i) => i.id === id);
  const wait = () => new Promise((r) => { setTimeout(r, 250); });

  return {
    name: 'monday.com (demo)',
    async me() { await wait(); return me; },
    async boards() { return [{ id: board.id, name: board.name }]; },
    async board() { return board; },
    async prepareBoard() { return board; },
    async items() { await wait(); return items.map((i) => ({ ...i, updates: [...i.updates] })); },
    async createItem(_b, { name, pageUrl, stage = STAGES.DRAFTING }) {
      const it = item(name, stage, day(7), '', { pageUrl });
      items.unshift(it);
      return it.id;
    },
    async updateItem(_b, id, { stage, pageUrl, liveUrl }) {
      const it = find(id);
      if (!it) return;
      if (stage) Object.assign(it, { stage, stageColor: STAGE_COLORS[stage] ?? '' });
      if (pageUrl) it.pageUrl = pageUrl;
      if (liveUrl) it.liveUrl = liveUrl;
    },
    async addNote(id, text) {
      find(id)?.updates.unshift({ id: nextId(), author: me.name, text, at: new Date().toISOString() });
    },
  };
}
