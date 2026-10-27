// Sync-1.5 hash tree, schema 3, exactly as the tablet writes it (docs/PROTOCOL.md §5).
// Checked against a real reMarkable 2 tree on OS 3.27:
// - root and per-document indexes are "3\n" + one line per entry, sorted by id;
// - an index blob is stored under the Merkle hash of its entries, NOT sha256(index bytes);
// - every other blob (.metadata, .content, .pdf, ...) is stored under sha256(bytes).
// No imports, so `node --test` can load it directly.

export const DOC_TYPE = "80000000";
export const FILE_TYPE = "0";

export interface Entry {
  hash: string;
  type: string; // DOC_TYPE in the root index, FILE_TYPE in a document index
  id: string; // doc uuid (root) or file name like "<uuid>.metadata" (document)
  subfiles: number;
  size: number;
}

export interface Index {
  schema: string;
  entries: Entry[];
}

export function parseIndex(text: string): Index {
  const lines = text.split("\n");
  const schema = lines[0].trim();
  if (schema !== "3" && schema !== "4") throw new Error(`unsupported index schema "${schema}"`);
  const entries: Entry[] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (schema === "4" && line.startsWith("0:.:")) continue; // v4 summary line
    const f = line.split(":");
    if (f.length !== 5) throw new Error(`bad index line "${line}"`);
    entries.push({ hash: f[0], type: f[1], id: f[2], subfiles: Number(f[3]), size: Number(f[4]) });
  }
  return { schema, entries };
}

// Byte order, like Go's string compare in the reference (ids are ASCII).
function byId(a: Entry, b: Entry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function serializeIndex(index: Index): string {
  if (index.schema !== "3") throw new Error(`writing schema "${index.schema}" is not supported`);
  const lines = [...index.entries].sort(byId).map((e) => `${e.hash}:${e.type}:${e.id}:${e.subfiles}:${e.size}`);
  return `3\n${lines.map((l) => `${l}\n`).join("")}`;
}

export async function sha256hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`bad hash "${hex}"`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function merkleHash(entries: Entry[]): Promise<string> {
  const sorted = [...entries].sort(byId);
  const buf = new Uint8Array(sorted.length * 32);
  sorted.forEach((e, i) => buf.set(hexToBytes(e.hash), i * 32));
  return sha256hex(buf);
}

// An index blob ready to store: key = Merkle hash, body = index text.
export async function indexBlob(index: Index): Promise<{ hash: string; bytes: Uint8Array }> {
  return { hash: await merkleHash(index.entries), bytes: new TextEncoder().encode(serializeIndex(index)) };
}

// ---- Document files ------------------------------------------------------

export type DocType = "DocumentType" | "CollectionType";

// The key set the tablet itself writes on OS 3.x.
export function newMetadata(name: string, type: DocType, parent: string, nowMs: number): Record<string, unknown> {
  return {
    createdTime: String(nowMs),
    lastModified: String(nowMs),
    lastOpened: "",
    lastOpenedPage: 0,
    parent,
    pinned: false,
    type,
    visibleName: name,
  };
}

// Keeps every key the tablet wrote; changes only what was asked.
export function editMetadata(
  meta: Record<string, unknown>,
  change: { name?: string; parent?: string },
  nowMs: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta, lastModified: String(nowMs) };
  if (change.name !== undefined) out.visibleName = change.name;
  if (change.parent !== undefined) out.parent = change.parent;
  return out;
}

// Same template rmfakecloud uses for uploads; the tablet fills in pages on first open.
export function newContent(fileType: "pdf" | "epub"): Record<string, unknown> {
  return {
    dummyDocument: false,
    extraMetadata: { LastPen: "Finelinerv2", LastTool: "Finelinerv2", ThicknessScale: "", LastFinelinerv2Size: "1" },
    fileType,
    fontName: "",
    lastOpenedPage: 0,
    lineHeight: -1,
    margins: 180,
    orientation: "portrait",
    pageCount: 0,
    pages: [],
    textScale: 1,
    transform: { m11: 1, m12: 0, m13: 0, m21: 0, m22: 1, m23: 0, m31: 0, m32: 0, m33: 1 },
  };
}

// A tablet folder is .metadata + .content, and its .content is only this.
export function newFolderContent(): Record<string, unknown> {
  return { tags: [] };
}

export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
