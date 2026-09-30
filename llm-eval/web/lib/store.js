// Run storage. On Vercel: a *private* Vercel Blob store (CV data never gets a public URL).
// Locally (no BLOB_READ_WRITE_TOKEN): JSON files in .data/runs/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { get, list, put } from '@vercel/blob';

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const LOCAL_DIR = path.join(process.cwd(), '.data', 'runs');
const ID_RE = /^[a-z0-9-]{8,64}$/;

export async function saveRun(run) {
  const body = JSON.stringify(run);
  if (useBlob()) {
    await put(`runs/${run.id}.json`, body, {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
    });
    return;
  }
  if (process.env.VERCEL) throw new Error('No Blob store connected. In Vercel: Storage -> Create -> Blob, then redeploy.');
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DIR, `${run.id}.json`), body);
}

export async function getRun(id) {
  if (!ID_RE.test(id)) return null;
  if (useBlob()) {
    const res = await get(`runs/${id}.json`, { access: 'private', useCache: false });
    if (!res) return null;
    return JSON.parse(await new Response(res.stream).text());
  }
  try {
    return JSON.parse(await fs.readFile(path.join(LOCAL_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function listRunIds() {
  let names = [];
  if (useBlob()) {
    const { blobs } = await list({ prefix: 'runs/', limit: 1000 });
    names = blobs.map((b) => b.pathname.slice('runs/'.length));
  } else {
    names = await fs.readdir(LOCAL_DIR).catch(() => []);
  }
  // ids start with a sortable timestamp, so newest first
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort().reverse();
}
