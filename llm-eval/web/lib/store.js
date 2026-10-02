// Run storage. Picks the backend for the host it runs on:
//   - Vercel: private Vercel Blob store (needs BLOB_READ_WRITE_TOKEN, added when you connect a Blob store)
//   - Netlify: Netlify Blobs (configured automatically)
//   - anywhere else (local dev): JSON files in .data/runs/
// In every case runs are only readable by this app's server code, never by public URL.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getStore } from '@netlify/blobs';
import { get as vGet, list as vList, put as vPut } from '@vercel/blob';

const ID_RE = /^[a-z0-9-]{8,64}$/;
const LOCAL_DIR = path.join(process.cwd(), '.data', 'runs');
const isRun = (x) => Array.isArray(x?.rows) && Array.isArray(x?.models);

const vercel = {
  async save(run) {
    await vPut(`runs/${run.id}.json`, JSON.stringify(run), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
  },
  async load(id) {
    const res = await vGet(`runs/${id}.json`, { access: 'private', useCache: false });
    return res ? JSON.parse(await new Response(res.stream).text()) : null;
  },
  async ids() {
    const { blobs } = await vList({ prefix: 'runs/', limit: 1000 });
    return blobs.map((b) => b.pathname.slice('runs/'.length).replace(/\.json$/, ''));
  },
};

const netlify = (store) => ({
  save: (run) => store.setJSON(run.id, run),
  load: (id) => store.get(id, { type: 'json' }),
  ids: async () => (await store.list()).blobs.map((b) => b.key),
});

const local = {
  async save(run) {
    if (process.env.VERCEL || process.env.NETLIFY) throw new Error('No storage connected. On Vercel: Storage -> Create -> Blob (Private), then redeploy.');
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, `${run.id}.json`), JSON.stringify(run));
  },
  load: async (id) => JSON.parse(await fs.readFile(path.join(LOCAL_DIR, `${id}.json`), 'utf8')),
  ids: async () => (await fs.readdir(LOCAL_DIR).catch(() => [])).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)),
};

function backend() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return vercel;
  // BLOBS_* vars are only for testing against a local Netlify Blobs server.
  if (process.env.BLOBS_EDGE_URL) {
    const url = process.env.BLOBS_EDGE_URL;
    return netlify(getStore({ name: 'eval-runs', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN, edgeURL: url, uncachedEdgeURL: url, consistency: 'strong' }));
  }
  if (!process.env.VERCEL) {
    try {
      return netlify(getStore({ name: 'eval-runs', consistency: 'strong' })); // configured automatically on Netlify
    } catch {}
  }
  return local;
}

export const saveRun = (run) => backend().save(run);

export async function getRun(id) {
  if (!ID_RE.test(id)) return null;
  try {
    const run = await backend().load(id);
    return isRun(run) ? run : null; // skip anything that isn't an uploaded run
  } catch {
    return null;
  }
}

// ids start with a sortable timestamp, so newest first
export const listRunIds = async () => (await backend().ids()).filter((id) => ID_RE.test(id)).sort().reverse();
