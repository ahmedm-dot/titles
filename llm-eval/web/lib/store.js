// Run storage. On Netlify: Netlify Blobs (private; only this site's server code can read it).
// Locally (no Netlify Blobs environment): JSON files in .data/runs/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getStore } from '@netlify/blobs';

const STORE = 'eval-runs';
const LOCAL_DIR = path.join(process.cwd(), '.data', 'runs');
const ID_RE = /^[a-z0-9-]{8,64}$/;

function blobs() {
  // BLOBS_* vars are only for testing against a local Netlify Blobs server.
  if (process.env.BLOBS_EDGE_URL) {
    return getStore({
      name: STORE,
      siteID: process.env.BLOBS_SITE_ID,
      token: process.env.BLOBS_TOKEN,
      edgeURL: process.env.BLOBS_EDGE_URL,
      uncachedEdgeURL: process.env.BLOBS_EDGE_URL,
      consistency: 'strong',
    });
  }
  try {
    return getStore({ name: STORE, consistency: 'strong' }); // configured automatically on Netlify
  } catch {
    return null; // not on Netlify
  }
}

export async function saveRun(run) {
  const store = blobs();
  if (store) {
    await store.setJSON(run.id, run);
    return;
  }
  if (process.env.NETLIFY) throw new Error('Netlify Blobs is not available for this site.');
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DIR, `${run.id}.json`), JSON.stringify(run));
}

const isRun = (x) => Array.isArray(x?.rows) && Array.isArray(x?.models);

export async function getRun(id) {
  if (!ID_RE.test(id)) return null;
  const store = blobs();
  let run = null;
  try {
    run = store
      ? await store.get(id, { type: 'json' })
      : JSON.parse(await fs.readFile(path.join(LOCAL_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
  return isRun(run) ? run : null; // skip anything that isn't an uploaded run
}

export async function listRunIds() {
  const store = blobs();
  const ids = store
    ? (await store.list()).blobs.map((b) => b.key)
    : (await fs.readdir(LOCAL_DIR).catch(() => [])).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
  // ids start with a sortable timestamp, so newest first
  return ids.filter((id) => ID_RE.test(id)).sort().reverse();
}
