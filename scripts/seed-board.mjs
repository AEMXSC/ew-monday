#!/usr/bin/env node
/**
 * Creates a demo content board in your monday.com account, ready for the
 * panel: the workflow columns plus a few items in different stages.
 *
 *   MONDAY_TOKEN=... node scripts/seed-board.mjs --org aemxsc --site frescopa26 \
 *     [--name "Fréscopa content calendar"] [--review-page /coffee]
 *
 * --review-page links one item to an existing page in "Changes requested",
 * so the panel shows the reviewer warning straight away.
 */
import { createMondayAdapter } from '../tools/monday/api.js';
import { STAGES, editUrl } from '../tools/monday/model.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));

const token = process.env.MONDAY_TOKEN;
if (!token || !args.org || !args.site) {
  console.error('Usage: MONDAY_TOKEN=... node scripts/seed-board.mjs --org <org> --site <site> [--name <board>] [--review-page /path]');
  process.exit(1);
}

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const ITEMS = [
  {
    name: 'World Tour 2026 landing page',
    stage: STAGES.BRIEF,
    due: day(4),
    brief: 'Announce the Fréscopa World Tour 2026: 12 cities, pop-up cafés, live roasting.\n\nAudience: existing customers and coffee fans near tour cities.\nMust include: hero with tour dates, city list with dates, "Find your city" CTA, sign-up for tour news.\nTone: warm, crafted, not salesy.',
  },
  {
    name: 'Holiday gift guide',
    stage: STAGES.DRAFTING,
    due: day(9),
    brief: 'Gift guide for coffee lovers: three price bands (under $25, under $75, splurge). Feature the Atelier machines and the holiday roast. CTA to the shop.',
  },
  {
    name: 'Cold brew season launch',
    stage: STAGES.BRIEF,
    due: day(-1),
    brief: 'Launch page for the cold brew range. Lead with the 18-hour steep story, then recipes. Needs nutrition note from legal.',
  },
  {
    name: 'Barista academy sign-up',
    stage: STAGES.APPROVED,
    due: day(2),
    brief: 'Sign-up page for in-café barista classes. Dates, price, what you take home, booking form.',
  },
];

async function main() {
  const fetch = globalThis.fetch;
  const api = createMondayAdapter({ token, fetch });
  const me = await api.me();
  console.log(`Signed in as ${me.name}`);

  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation ($n: String!) { create_board(board_name: $n, board_kind: public) { id } }',
      variables: { n: args.name ?? 'Fréscopa content calendar' },
    }),
  });
  const created = await res.json();
  if (created.errors || !created.data?.create_board) throw new Error(JSON.stringify(created.errors ?? created));
  let board = await api.board(created.data.create_board.id);
  board = await api.prepareBoard(board);
  console.log(`Board "${board.name}" ready: ${board.url}`);

  const all = [...ITEMS];
  if (args['review-page']) {
    all.push({
      name: `Refresh ${args['review-page']}`,
      stage: STAGES.CHANGES,
      due: day(1),
      pageUrl: editUrl(args.org, args.site, args['review-page']),
      brief: 'Seasonal refresh of the page: new hero image, tighter intro, add the holiday roast.',
      note: 'Legal: please remove "the best coffee in the world". We can\'t substantiate it. Everything else is approved.',
    });
  }

  for (const it of all) {
    // eslint-disable-next-line no-await-in-loop
    const id = await api.createItem(board, {
      name: it.name, stage: it.stage, ownerId: me.id, pageUrl: it.pageUrl,
    });
    const extra = {};
    if (board.columns.due) extra[board.columns.due.id] = { date: it.due };
    if (board.columns.brief) extra[board.columns.brief.id] = { text: it.brief };
    // eslint-disable-next-line no-await-in-loop
    await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }',
        variables: { b: board.id, i: id, v: JSON.stringify(extra) },
      }),
    });
    // eslint-disable-next-line no-await-in-loop
    if (it.note) await api.addNote(id, it.note);
    console.log(`  + ${it.name} (${it.stage})`);
  }
  console.log('\nDone. Open a page in Experience Workspace and pick this board in the panel.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
