'use strict';

/**
 * Vercel Blob storage driver.
 *
 * Requires:  npm install @vercel/blob
 *            BLOB_READ_WRITE_TOKEN=...   (added automatically by the Blob store)
 *
 * On Vercel a function's own filesystem is read-only except for an ephemeral
 * /tmp, so every CSV/JSON document and every uploaded image has to live in an
 * external store. Blobs are immutable, so writes use allowOverwrite.
 *
 * NOTE: this driver is provided for deployment; the local driver is what the
 * dev server and the test suite use.
 */

const cache = new Map(); // key -> { value, at }
const CACHE_MS = Number(process.env.BLOB_CACHE_MS || 0);

function client() {
  let blob;
  try {
    blob = require('@vercel/blob');
  } catch {
    throw new Error(
      "STORAGE_DRIVER=vercel-blob requires the @vercel/blob package: run 'npm install @vercel/blob'"
    );
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('STORAGE_DRIVER=vercel-blob requires BLOB_READ_WRITE_TOKEN to be set');
  }
  return blob;
}

async function locate(key) {
  const { list } = client();
  const res = await list({ prefix: key, limit: 1 });
  const hit = (res.blobs || []).find(b => b.pathname === key);
  return hit ? hit.url : null;
}

async function readFile(key) {
  if (CACHE_MS && cache.has(key) && Date.now() - cache.get(key).at < CACHE_MS) {
    return Buffer.from(cache.get(key).value);
  }
  const url = await locate(key);
  if (!url) {
    const err = new Error(`blob not found: ${key}`);
    err.code = 'ENOENT';
    throw err;
  }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to read blob ${key}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (CACHE_MS) cache.set(key, { value: buf, at: Date.now() });
  return buf;
}

async function readText(key) {
  return (await readFile(key)).toString('utf8');
}

async function writeFile(key, data) {
  const { put } = client();
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  await put(key, body, {
    access: 'public',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: key.endsWith('.json') ? 'application/json'
      : key.endsWith('.csv') ? 'text/csv'
        : key.endsWith('.png') ? 'image/png'
          : key.endsWith('.pdf') ? 'application/pdf'
            : 'image/jpeg'
  });
  if (CACHE_MS) cache.set(key, { value: body, at: Date.now() });
  return true;
}

async function exists(key) {
  return Boolean(await locate(key));
}

async function remove(key) {
  const url = await locate(key);
  if (!url) return false;
  const { del } = client();
  await del(url);
  cache.delete(key);
  return true;
}

async function list(prefix) {
  const { list: blobList } = client();
  const res = await blobList({ prefix });
  return (res.blobs || []).map(b => b.pathname.split('/').pop());
}

async function stat(key) {
  const url = await locate(key);
  if (!url) return null;
  const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  return { size: Number(res.headers.get('content-length') || 0), mtime: new Date() };
}

module.exports = { exists, readFile, readText, writeFile, remove, list, stat, persistent: true };
