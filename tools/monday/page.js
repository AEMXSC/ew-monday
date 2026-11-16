/**
 * The page side: reads the open page's preview/publish state and title with
 * the author's Workspace sign-in (actions.daFetch). Never writes to the page.
 */
import { webPath, normalizePath } from './model.js';

const HLX_ADMIN = 'https://admin.hlx.page';
const DA_SOURCE = 'https://admin.da.live/source';

export function createPage({ org, site, path, daFetch, timeout = 15000 }) {
  const timed = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await daFetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    org,
    site,
    path: normalizePath(path),

    /**
     * { previewAt, liveAt, previewUrl, liveUrl } or null when the admin API
     * can't be read (no access, or a site setup this panel doesn't know).
     */
    async status() {
      try {
        const resp = await timed(`${HLX_ADMIN}/status/${org}/${site}/main${webPath(path)}`);
        if (!resp.ok) return null;
        return parseStatus(await resp.json());
      } catch {
        return null;
      }
    },

    async html() {
      try {
        const resp = await timed(`${DA_SOURCE}/${org}/${site}${normalizePath(path)}.html`);
        return resp.ok ? await resp.text() : '';
      } catch {
        return '';
      }
    },
  };
}

export function parseStatus(json) {
  const stamp = (s) => (s && s.status === 200 && s.lastModified ? new Date(s.lastModified).toISOString() : null);
  return {
    previewAt: stamp(json?.preview),
    liveAt: stamp(json?.live),
    previewUrl: json?.preview?.url ?? null,
    liveUrl: json?.live?.url ?? null,
  };
}
