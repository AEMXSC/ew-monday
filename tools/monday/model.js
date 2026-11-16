/**
 * Pure workflow logic: no DOM, no network. Unit-tested in test/model.test.js.
 *
 * A "work item" is the tool-neutral shape every adapter (monday.com today,
 * Wrike/Asana/Smartsheet next) maps its data into:
 *   { id, name, url, stage, stageColor, due, owners: [{id,name}], brief,
 *     updates: [{id, author, text, at}], pageUrl, liveUrl }
 */

/** Content stages, in workflow order. Labels are created on the board if missing. */
export const STAGES = Object.freeze({
  BRIEF: 'Brief',
  DRAFTING: 'Drafting',
  REVIEW: 'In review',
  CHANGES: 'Changes requested',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
});

export const STAGE_ORDER = Object.freeze(Object.values(STAGES));

const OPEN_STAGES = new Set(['', STAGES.BRIEF, STAGES.DRAFTING, STAGES.CHANGES]);

/** Canvas edit URL of a page; this is what the board's "Page" link column stores. */
export function editUrl(org, site, path) {
  return `https://da.live/canvas#/${org}/${site}${normalizePath(path)}`;
}

/** "/index" and "" become "/"; strips ".html" and trailing slashes elsewhere. */
export function webPath(path) {
  const p = normalizePath(path).replace(/\.html$/, '');
  if (p === '/index' || p.endsWith('/index')) return p.slice(0, -'index'.length) || '/';
  return p;
}

export function normalizePath(path) {
  if (!path) return '/';
  const p = path.startsWith('/') ? path : `/${path}`;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** True when a stored link URL points at this page (any host, canvas or edit view). */
export function linksToPage(url, org, site, path) {
  if (!url) return false;
  const target = `/${org}/${site}${normalizePath(path)}`.toLowerCase();
  const hash = url.split('#')[1] ?? '';
  const candidate = normalizePath(decodeURIComponent(hash).replace(/\.html$/, '')).toLowerCase();
  return candidate === target;
}

export function findItemForPage(items, org, site, path) {
  return items.find((i) => linksToPage(i.pageUrl, org, site, path)) ?? null;
}

/** Due-date bucket relative to today (both "YYYY-MM-DD"). */
export function dueState(due, today) {
  if (!due) return 'none';
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86400000);
  if (Number.isNaN(days)) return 'none';
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 2) return 'soon';
  return 'later';
}

export function dueLabel(due, today) {
  const state = dueState(due, today);
  if (state === 'none') return '';
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86400000);
  if (state === 'overdue') return days === -1 ? 'Overdue by 1 day' : `Overdue by ${-days} days`;
  if (state === 'today') return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due ${formatDate(due)}`;
}

export function formatDate(iso) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * What the author should know before publishing, from the item's stage.
 * Returns null when there is nothing to warn about.
 */
export function publishGate(item) {
  if (!item) return null;
  const latest = latestReviewNote(item);
  if (item.stage === STAGES.CHANGES) {
    return { level: 'error', title: 'Changes requested', text: latest || 'A reviewer asked for changes. Fix them before you publish.' };
  }
  if (item.stage === STAGES.REVIEW) {
    return { level: 'warn', title: 'Waiting for approval', text: 'This page is in review. Publish once it is approved.' };
  }
  if (OPEN_STAGES.has(item.stage)) {
    return { level: 'info', title: 'Not approved yet', text: 'Preview the page to send it for review.' };
  }
  return null;
}

/** Newest update not written by this extension (reviewer comments, not our sync notes). */
export function latestReviewNote(item) {
  const note = (item.updates ?? []).find((u) => !isSyncNote(u.text));
  return note ? `${note.author}: ${note.text}` : '';
}

export const SYNC_PREFIX = 'Experience Workspace ·';

export function isSyncNote(text = '') {
  return text.trim().startsWith(SYNC_PREFIX);
}

/**
 * Decide what to write back to the board after the page's preview/publish
 * state changed. `status` = { previewAt, liveAt } (ISO strings or null) from
 * the AEM admin API; `marker` = the same pair as last handled for this item.
 * Returns null, or { stage, liveUrl?, note, marker }.
 */
export function decideSync(item, status, marker = {}) {
  if (!item || !status) return null;
  const newer = (a, b) => Boolean(a) && (!b || Date.parse(a) > Date.parse(b));
  const next = { previewAt: status.previewAt ?? null, liveAt: status.liveAt ?? null };

  if (newer(status.liveAt, marker.liveAt) && item.stage !== STAGES.PUBLISHED) {
    return {
      stage: STAGES.PUBLISHED,
      liveUrl: status.liveUrl ?? null,
      note: `${SYNC_PREFIX} Published${status.liveUrl ? `: ${status.liveUrl}` : ''}`,
      marker: next,
    };
  }
  if (newer(status.previewAt, marker.previewAt) && OPEN_STAGES.has(item.stage)) {
    return {
      stage: STAGES.REVIEW,
      note: `${SYNC_PREFIX} Ready for review${status.previewUrl ? `: ${status.previewUrl}` : ''}`,
      marker: next,
    };
  }
  if (newer(status.liveAt, marker.liveAt) || newer(status.previewAt, marker.previewAt)) {
    return { marker: next }; // state moved but stage is already right: just remember it
  }
  return null;
}

/** Items assigned to `meId` that are still open, soonest due first, undated last. */
export function myWork(items, meId) {
  return items
    .filter((i) => i.owners.some((o) => String(o.id) === String(meId)))
    .filter((i) => i.stage !== STAGES.PUBLISHED)
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.name.localeCompare(b.name));
}

/** The prompt handed to the Workspace assistant (not sent until the author presses send). */
export function draftPrompt(item, { pagePath } = {}) {
  const lines = [
    `Draft the page ${pagePath || 'I have open'} from this brief in monday.com ("${item.name}").`,
  ];
  if (item.brief) lines.push('', 'Brief:', item.brief.trim());
  const notes = (item.updates ?? []).filter((u) => !isSyncNote(u.text)).slice(0, 3);
  if (notes.length) {
    lines.push('', 'Comments on the item:');
    notes.forEach((n) => lines.push(`- ${n.author}: ${n.text.trim()}`));
  }
  if (item.due) lines.push('', `Due ${formatDate(item.due)}.`);
  lines.push('', 'Keep our brand voice, use the blocks this site already has, and keep the copy concise.');
  return lines.join('\n');
}

/** Page title for a new item: first h1 in the page HTML, else a readable path. */
export function titleFor(html, path) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html ?? '');
  const fromH1 = m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
  if (fromH1) return decodeEntities(fromH1);
  const slug = webPath(path).split('/').filter(Boolean).pop() || 'Home';
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/** No sync marker yet: the panel hasn't seen this item's page state before. */
export function isFirstSight(marker) {
  return !marker || !('previewAt' in marker || 'liveAt' in marker);
}
