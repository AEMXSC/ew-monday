/**
 * Entry point. Waits for the Experience Workspace SDK; if the panel is opened
 * on its own (local testing), falls back to standalone mode after 3 s and
 * reads org/site/path from the query string.
 */
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { mountPanel } from './panel.js';
import { createPage } from './page.js';
import { browserStorage, memoryStore, panelStore } from './storage.js';

const SDK_TIMEOUT = 3000;

async function init() {
  const root = document.getElementById('monday-app');
  const timeout = new Promise((resolve) => { setTimeout(() => resolve(null), SDK_TIMEOUT); });
  const sdk = await Promise.race([DA_SDK, timeout]).catch(() => null);

  const params = new URLSearchParams(window.location.search);
  const context = sdk?.context ?? {
    org: params.get('org') ?? '',
    site: params.get('site') ?? '',
    path: params.get('path') ?? '/',
  };
  const actions = sdk?.actions ?? {};
  // Outside Workspace there is no signed-in fetch: status reads then fail and the panel says so.
  const daFetch = actions.daFetch ?? ((url, opts) => window.fetch(url, opts));

  let page = createPage({
    org: context.org,
    site: context.site || context.repo,
    path: context.path || '/',
    daFetch,
  });

  // ?demo=1 runs against built-in sample data: no account, nothing leaves the browser.
  const demo = params.get('demo') === '1';
  let options = {};
  if (demo) {
    const { createDemoAdapter } = await import('./demo-adapter.js');
    if (!page.org) page = { ...page, org: 'demo', site: 'frescopa', path: page.path === '/' ? '/coffee' : page.path };
    const published = { previewAt: null, liveAt: null };
    page = {
      ...page,
      status: async () => ({
        ...published,
        previewUrl: `https://main--${page.site}--${page.org}.aem.page${page.path}`,
        liveUrl: `https://www.frescopa.coffee${page.path}`,
      }),
      html: async () => '',
      simulate: (kind) => { published[kind === 'live' ? 'liveAt' : 'previewAt'] = new Date().toISOString(); },
    };
    const adapter = createDemoAdapter({ page });
    const storage = browserStorage(memoryStore());
    storage.setToken('demo');
    options = { adapterFactory: () => adapter, storage, demo: true };
  }

  const { store, persistent } = panelStore();
  mountPanel(root, {
    page, actions, storage: browserStorage(store), persistent, embedded: Boolean(sdk), ...options,
  });
}

init().catch((e) => {
  document.getElementById('monday-app').textContent = `The panel could not start: ${e.message}`;
});
