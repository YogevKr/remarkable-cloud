import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { accessIdentity, driveUid } from "./access";
import { renderPdf } from "./render";
import { DriveError, addDocument, createFolder, listItems, openPayload, updateItem } from "./store";
import page from "./ui.html";

// The drive: a web page + JSON API on its own hostname, behind Cloudflare Access.
// The tablet never comes here; it keeps using the device API on CLOUD_HOST.

type DriveEnv = { Bindings: Env; Variables: { uid: string; who: string } };
type Ctx = Context<DriveEnv>;

export const drive = new Hono<DriveEnv>();

const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // under the 100 MB Workers request limit

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

drive.use("*", async (c, next) => {
  const who = await accessIdentity(c.env, c.req.header("Cf-Access-Jwt-Assertion"));
  if (!who) return c.text("Cloudflare Access login required", 401);
  const uid = driveUid(c.env, who);
  if (!uid) return c.text("This login has no reMarkable account", 403);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    // A custom header makes any cross-site write need a CORS preflight, which we never grant.
    if (c.req.header("X-Drive") !== "1") return c.text("missing X-Drive header", 403);
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.text("cross-origin write refused", 403);
  }
  c.set("uid", uid);
  c.set("who", who);
  await next();
  c.header("cache-control", "no-store");
});

drive.onError((err, c) => {
  if (err instanceof DriveError) return c.json({ message: err.message }, err.status);
  console.error(`drive error: ${err instanceof Error ? err.stack : err}`);
  return c.json({ message: "internal error" }, 500);
});

const source = (c: Ctx) => `drive:${c.get("who")}`;

function cleanName(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
  return name || "Untitled";
}

function splitName(filename: string): { base: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return { base: filename, ext: "" };
  return { base: filename.slice(0, dot), ext: filename.slice(dot + 1).toLowerCase() };
}

function startsWith(bytes: Uint8Array, magic: string): boolean {
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}

async function body<T>(c: Ctx): Promise<Partial<T>> {
  const json = await c.req.json<Partial<T>>().catch(() => null);
  if (!json || typeof json !== "object") throw new DriveError(400, "expected a JSON body");
  return json;
}

function parentOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new DriveError(400, "parent must be a string");
  return value;
}

drive.get("/", (c) => c.html(page, 200, PAGE_HEADERS));

drive.get("/api/items", async (c) => c.json(await listItems(c.env, c.get("uid"))));

drive.get("/api/items/:id/file", async (c) => {
  const f = await openPayload(c.env, c.get("uid"), c.req.param("id"));
  const filename = `${f.name}.${f.ext}`;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(f.body, {
    headers: {
      "content-type": f.ext === "pdf" ? "application/pdf" : "application/epub+zip",
      "content-length": String(f.size),
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

// One file per request: PDF and EPUB as they are, HTML rendered to PDF.
// An upload to the top level (parent "") goes into the "Drive" folder; the reply has the real parent.
drive.post("/api/upload", async (c) => {
  if (Number(c.req.header("content-length") || 0) > MAX_UPLOAD_BYTES) throw new DriveError(413, "file is larger than 95 MB");
  const form = await c.req.formData().catch(() => null);
  const file: unknown = form?.get("file"); // workers-types types this as string | null
  if (!form || !(file instanceof File)) throw new DriveError(400, "expected a multipart field named file");
  const parent = parentOf(form.get("parent") ?? "");
  const { base, ext } = splitName(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());

  let doc: { ext: "pdf" | "epub"; bytes: Uint8Array };
  if (ext === "pdf") {
    if (!startsWith(bytes, "%PDF")) throw new DriveError(415, `${file.name} is not a PDF file`);
    doc = { ext, bytes };
  } else if (ext === "epub") {
    if (!startsWith(bytes, "PK")) throw new DriveError(415, `${file.name} is not an EPUB file`);
    doc = { ext, bytes };
  } else if (ext === "html" || ext === "htm") {
    doc = { ext: "pdf", bytes: (await renderPdf(c.env, { html: new TextDecoder().decode(bytes) })).pdf };
  } else {
    throw new DriveError(415, "use PDF, EPUB, or HTML files");
  }
  const name = cleanName(base);
  const saved = await addDocument(c.env, c.get("uid"), source(c), { name, parent, ...doc });
  return c.json({ ...saved, name }, 201);
});

drive.post("/api/web", async (c) => {
  const req = await body<{ url: string; parent: string; name: string }>(c);
  let url: URL;
  try {
    url = new URL(String(req.url ?? ""));
  } catch {
    throw new DriveError(400, "enter a full URL, for example https://example.com/article");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new DriveError(400, "only http and https URLs");
  const parent = parentOf(req.parent);
  const r = await renderPdf(c.env, { url: url.toString() });
  const name = cleanName(String(req.name || r.title || `${url.hostname}${url.pathname}`));
  const saved = await addDocument(c.env, c.get("uid"), source(c), { name, parent, ext: "pdf", bytes: r.pdf });
  return c.json({ ...saved, name }, 201);
});

drive.post("/api/folders", async (c) => {
  const req = await body<{ name: string; parent: string }>(c);
  const name = cleanName(String(req.name ?? ""));
  const id = await createFolder(c.env, c.get("uid"), source(c), name, parentOf(req.parent));
  return c.json({ id, name }, 201);
});

// Rename and move. Trash = parent "trash"; restore = parent "".
drive.patch("/api/items/:id", async (c) => {
  const req = await body<{ name: string; parent: string }>(c);
  const change: { name?: string; parent?: string } = {};
  if (req.name !== undefined) change.name = cleanName(String(req.name));
  if (req.parent !== undefined) change.parent = parentOf(req.parent);
  if (change.name === undefined && change.parent === undefined) throw new DriveError(400, "nothing to change");
  await updateItem(c.env, c.get("uid"), source(c), c.req.param("id"), change);
  return c.json({ ok: true });
});

drive.all("*", (c) => c.json({ message: "not found" }, 404));
