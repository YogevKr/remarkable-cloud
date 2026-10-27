import type { Env } from "../types";
import { blobKey } from "../util/r2presign";
import { crc32cHeader } from "../util/hash";
import { casRoot, getRoot } from "../roots";
import {
  DOC_TYPE,
  FILE_TYPE,
  editMetadata,
  indexBlob,
  jsonBytes,
  newContent,
  newFolderContent,
  newMetadata,
  parseIndex,
  sha256hex,
  type DocType,
  type Entry,
} from "../util/rmtree";

// Drive operations on one user's tree. Reads walk the same blobs the tablet
// syncs; every write builds new blobs, then moves the root pointer with CAS
// (retrying on a concurrent tablet sync) and tells the tablet to sync.

export type Kind = "folder" | "pdf" | "epub" | "notebook";

export interface Item {
  id: string;
  name: string;
  kind: Kind;
  parent: string; // "" = top level, "trash" = in Trash, else a folder id
  modified: number; // ms since epoch
  size: number; // payload bytes for pdf/epub, all files otherwise
}

export class DriveError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 502,
    message: string,
  ) {
    super(message);
  }
}

const TRASH = "trash";

// ---- Blobs ----------------------------------------------------------------

async function putBlob(env: Env, uid: string, hash: string, bytes: Uint8Array) {
  const crc = crc32cHeader(bytes).slice("crc32c=".length);
  await env.BLOBS.put(blobKey(uid, hash), bytes, { customMetadata: { crc32c: crc } });
}

async function getText(env: Env, uid: string, hash: string): Promise<string> {
  const obj = await env.BLOBS.get(blobKey(uid, hash));
  if (!obj) throw new Error(`blob ${hash} missing`);
  return obj.text();
}

async function putFile(env: Env, uid: string, id: string, bytes: Uint8Array): Promise<Entry> {
  const hash = await sha256hex(bytes);
  await putBlob(env, uid, hash, bytes);
  return { hash, type: FILE_TYPE, id, subfiles: 0, size: bytes.byteLength };
}

// Stores a document index and returns its root-index line.
async function putDoc(env: Env, uid: string, id: string, files: Entry[]): Promise<Entry> {
  const { hash, bytes } = await indexBlob({ schema: "3", entries: files });
  await putBlob(env, uid, hash, bytes);
  return { hash, type: DOC_TYPE, id, subfiles: files.length, size: files.reduce((n, f) => n + f.size, 0) };
}

// ---- Reads ----------------------------------------------------------------

interface Tree {
  generation: number;
  schema: string;
  entries: Entry[];
}

async function loadTree(env: Env, uid: string): Promise<Tree> {
  const root = await getRoot(env, uid);
  if (!root) return { generation: 0, schema: "3", entries: [] };
  const idx = parseIndex(await getText(env, uid, root.hash));
  return { generation: root.generation, schema: idx.schema, entries: idx.entries };
}

// A doc index hash fixes every byte below it, so the summary can be cached forever.
const infoCache = new Map<string, Item>();

async function docInfo(env: Env, uid: string, entry: Entry): Promise<Item> {
  const key = `${uid}/${entry.hash}`;
  const hit = infoCache.get(key);
  if (hit) return hit;
  const files = parseIndex(await getText(env, uid, entry.hash)).entries;
  const metaFile = files.find((f) => f.id.endsWith(".metadata"));
  const meta = metaFile ? JSON.parse(await getText(env, uid, metaFile.hash)) : {};
  const payload = files.find((f) => /\.(pdf|epub)$/.test(f.id));
  const kind: Kind =
    meta.type === "CollectionType" ? "folder" : payload ? (payload.id.endsWith(".pdf") ? "pdf" : "epub") : "notebook";
  const item: Item = {
    id: entry.id,
    name: typeof meta.visibleName === "string" ? meta.visibleName : entry.id,
    kind,
    parent: typeof meta.parent === "string" ? meta.parent : "",
    modified: Number(meta.lastModified) || 0,
    size: payload ? payload.size : entry.size,
  };
  if (infoCache.size > 20_000) infoCache.clear();
  infoCache.set(key, item);
  return item;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function listItems(env: Env, uid: string): Promise<{ generation: number; items: Item[] }> {
  const tree = await loadTree(env, uid);
  const items = await mapLimit(tree.entries, 16, (e) => docInfo(env, uid, e));
  return { generation: tree.generation, items };
}

export async function openPayload(
  env: Env,
  uid: string,
  id: string,
): Promise<{ name: string; ext: "pdf" | "epub"; body: ReadableStream; size: number }> {
  const tree = await loadTree(env, uid);
  const entry = tree.entries.find((e) => e.id === id);
  if (!entry) throw new DriveError(404, "item not found");
  const files = parseIndex(await getText(env, uid, entry.hash)).entries;
  const payload = files.find((f) => /\.(pdf|epub)$/.test(f.id));
  if (!payload) throw new DriveError(415, "only PDF and EPUB files can be downloaded");
  const obj = await env.BLOBS.get(blobKey(uid, payload.hash));
  if (!obj) throw new Error(`blob ${payload.hash} missing`);
  const info = await docInfo(env, uid, entry);
  return { name: info.name, ext: payload.id.endsWith(".pdf") ? "pdf" : "epub", body: obj.body, size: payload.size };
}

// ---- Writes ---------------------------------------------------------------

// Applies `change` to the newest root and commits it with CAS. A tablet sync
// between the read and the write makes CAS fail; then the change runs again
// on the new root.
async function commit(
  env: Env,
  uid: string,
  source: string,
  change: (entries: Entry[]) => Promise<Entry[]>,
): Promise<number> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tree = await loadTree(env, uid);
    if (tree.schema !== "3") throw new DriveError(409, `root schema ${tree.schema} is not supported for writes`);
    const entries = await change(tree.entries.map((e) => ({ ...e })));
    const { hash, bytes } = await indexBlob({ schema: "3", entries });
    await putBlob(env, uid, hash, bytes);
    const res = await casRoot(env, uid, tree.generation, hash, source);
    if (res.ok) {
      const hub = env.USER_HUB.get(env.USER_HUB.idFromName(uid));
      await hub.notifySync(source);
      return res.generation;
    }
  }
  throw new DriveError(409, "the tablet changed the library during the write; try again");
}

export async function addDocument(
  env: Env,
  uid: string,
  source: string,
  doc: { name: string; ext: "pdf" | "epub"; bytes: Uint8Array; parent: string },
): Promise<string> {
  await checkTarget(env, uid, (await loadTree(env, uid)).entries, doc.parent); // fail fast, before the upload
  const id = crypto.randomUUID();
  const files = [
    await putFile(env, uid, `${id}.metadata`, jsonBytes(newMetadata(doc.name, "DocumentType", doc.parent, Date.now()))),
    await putFile(env, uid, `${id}.content`, jsonBytes(newContent(doc.ext))),
    await putFile(env, uid, `${id}.${doc.ext}`, doc.bytes),
  ];
  const line = await putDoc(env, uid, id, files);
  await commit(env, uid, source, async (entries) => {
    await checkTarget(env, uid, entries, doc.parent);
    return [...entries, line];
  });
  return id;
}

export async function createFolder(env: Env, uid: string, source: string, name: string, parent: string): Promise<string> {
  const id = crypto.randomUUID();
  const type: DocType = "CollectionType";
  const files = [
    await putFile(env, uid, `${id}.metadata`, jsonBytes(newMetadata(name, type, parent, Date.now()))),
    await putFile(env, uid, `${id}.content`, jsonBytes(newFolderContent())),
  ];
  const line = await putDoc(env, uid, id, files);
  await commit(env, uid, source, async (entries) => {
    await checkTarget(env, uid, entries, parent);
    return [...entries, line];
  });
  return id;
}

// Rename, move, trash (parent "trash") and restore (parent "") all edit .metadata only.
export async function updateItem(
  env: Env,
  uid: string,
  source: string,
  id: string,
  change: { name?: string; parent?: string },
): Promise<void> {
  await commit(env, uid, source, async (entries) => {
    const i = entries.findIndex((e) => e.id === id);
    if (i < 0) throw new DriveError(404, "item not found");
    if (change.parent !== undefined) await checkTarget(env, uid, entries, change.parent, id);
    const files = parseIndex(await getText(env, uid, entries[i].hash)).entries;
    const m = files.findIndex((f) => f.id.endsWith(".metadata"));
    if (m < 0) throw new DriveError(409, "item has no metadata");
    const meta = JSON.parse(await getText(env, uid, files[m].hash));
    files[m] = await putFile(env, uid, files[m].id, jsonBytes(editMetadata(meta, change, Date.now())));
    entries[i] = await putDoc(env, uid, id, files);
    return entries;
  });
}

// Checks a target folder against the exact entries a commit is about to write,
// so a concurrent tablet change cannot slip in between the check and the CAS.
// The target must be a live folder (no ancestor in Trash), and a folder must not
// move into itself or into one of its own subfolders.
async function checkTarget(env: Env, uid: string, entries: Entry[], parent: string, movingId?: string) {
  if (parent === "" || parent === TRASH) return;
  const items = await mapLimit(entries, 16, (e) => docInfo(env, uid, e));
  const byId = new Map(items.map((x) => [x.id, x]));
  const target = byId.get(parent);
  if (!target || target.kind !== "folder") throw new DriveError(400, "target folder not found");
  for (let cur: Item | undefined = target, hops = 0; cur && hops < 1000; hops++) {
    if (cur.id === movingId) throw new DriveError(400, "a folder cannot move into itself");
    if (cur.parent === TRASH) throw new DriveError(400, "target folder is in the Trash");
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
}
