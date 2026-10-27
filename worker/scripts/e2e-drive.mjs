#!/usr/bin/env node
// End-to-end check of the drive against a running Worker, from both sides:
// a fake tablet (device API) and a drive user (Access-protected API).
// Use a THROWAWAY account: the script writes to that account's library.
//
// Local (wrangler dev, see README "Drive" section):
//   node scripts/e2e-drive.mjs --api http://127.0.0.1:8787 --drive http://localhost:8787 \
//     --code <pairing code> --jwt-key <private-jwk.json> --aud <aud> --iss https://<team> --email <identity>
// Production (Access service token in CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET):
//   node scripts/e2e-drive.mjs --api https://<cloud host> --drive https://<drive host> --code <code> --service-token [--web <url>]

import { createHash, createSign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    api: { type: "string" },
    drive: { type: "string" },
    code: { type: "string" },
    "jwt-key": { type: "string" },
    aud: { type: "string" },
    iss: { type: "string" },
    email: { type: "string", default: "e2e@example.test" },
    "service-token": { type: "boolean", default: false },
    html: { type: "boolean", default: false },
    web: { type: "string" },
  },
});
if (!opt.api || !opt.drive || !opt.code) throw new Error("need --api, --drive and --code");

let failed = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
  return ok;
}
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const merkle = (entries) =>
  sha256(Buffer.concat([...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((e) => Buffer.from(e.hash, "hex"))));
const index = (entries) =>
  `3\n${[...entries].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => `${e.hash}:${e.type}:${e.id}:${e.subfiles}:${e.size}\n`).join("")}`;
const parse = (text) =>
  text.split("\n").slice(1).filter(Boolean).map((l) => {
    const [hash, type, id, subfiles, size] = l.split(":");
    return { hash, type, id, subfiles: Number(subfiles), size: Number(size) };
  });

// ---- Drive auth ------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function localJwt(overrides = {}) {
  const jwk = JSON.parse(readFileSync(opt["jwt-key"], "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ aud: [opt.aud], iss: opt.iss, email: opt.email, iat: now, nbf: now, exp: now + 600, ...overrides }));
  const sig = createSign("RSA-SHA256").update(`${header}.${claims}`).sign({ key: jwk, format: "jwk" });
  return `${header}.${claims}.${b64url(sig)}`;
}
function driveHeaders(extra = {}) {
  if (opt["service-token"]) {
    const id = process.env.CF_ACCESS_CLIENT_ID, secret = process.env.CF_ACCESS_CLIENT_SECRET;
    if (!id || !secret) throw new Error("CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET not set");
    return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, ...extra };
  }
  return { "Cf-Access-Jwt-Assertion": localJwt(), ...extra };
}
async function drive(path, { method = "GET", json, form, headers = {}, raw = false } = {}) {
  const h = driveHeaders(headers);
  if (method !== "GET") h["X-Drive"] ??= "1";
  let body;
  if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(opt.drive + path, { method, headers: h, body, redirect: "manual" });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---- Fake tablet -----------------------------------------------------------
let userToken = "";
async function device(path, { method = "GET", body, json } = {}) {
  const headers = { Authorization: `Bearer ${userToken}` };
  if (json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
  return fetch(opt.api + path, { method, headers, body });
}
async function blob(hash) {
  const res = await device(`/sync/v3/files/${hash}`);
  if (!res.ok) throw new Error(`device GET blob ${hash}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function putBlob(hash, bytes) {
  const res = await device(`/sync/v3/files/${hash}`, { method: "PUT", body: bytes });
  if (!res.ok) throw new Error(`device PUT blob: ${res.status}`);
}
async function root() {
  const res = await device("/sync/v3/root");
  if (res.status === 404) return { hash: "", generation: 0 };
  return res.json();
}

// The tablet's own view: walk the tree from the root and check every hash.
async function tabletView() {
  const r = await root();
  const rootText = (await blob(r.hash)).toString();
  const docs = parse(rootText);
  let ok = merkle(docs) === r.hash && rootText.startsWith("3\n");
  const out = new Map();
  for (const d of docs) {
    const idxText = (await blob(d.hash)).toString();
    const files = parse(idxText);
    ok &&= merkle(files) === d.hash && files.length === d.subfiles && files.reduce((n, f) => n + f.size, 0) === d.size;
    const doc = { files: {}, meta: null };
    for (const f of files) {
      const bytes = await blob(f.hash);
      ok &&= sha256(bytes) === f.hash && bytes.length === f.size && f.type === "0";
      doc.files[f.id.replace(`${d.id}`, "")] = bytes;
      if (f.id.endsWith(".metadata")) doc.meta = JSON.parse(bytes.toString());
    }
    out.set(d.id, doc);
  }
  return { generation: r.generation, docs: out, hashesOk: ok };
}

// ---- Run --------------------------------------------------------------------
const pdfBytes = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n% ${randomUUID()}\n`,
);
const epubBytes = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from(randomUUID())]);

// 1. Pair a fake tablet.
const deviceId = randomUUID();
let res = await fetch(`${opt.api}/token/json/2/device/new`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: opt.code, deviceDesc: "remarkable", deviceID: deviceId }),
});
if (!check(res.ok, "pair fake tablet with code")) process.exit(1);
const deviceToken = await res.text();
res = await fetch(`${opt.api}/token/json/2/user/new`, { method: "POST", headers: { Authorization: `Bearer ${deviceToken}` } });
if (!check(res.ok, "device token -> user token")) process.exit(1);
userToken = await res.text();

// 2. Tablet syncs a notebook up, like a real device.
const nbId = randomUUID();
const nbFiles = {
  ".metadata": Buffer.from(JSON.stringify({ createdTime: "0", lastModified: String(Date.now()), lastOpened: "", lastOpenedPage: 0, parent: "", pinned: false, type: "DocumentType", visibleName: "E2E notebook" })),
  ".content": Buffer.from(JSON.stringify({ fileType: "notebook", formatVersion: 2, pageCount: 1 })),
  ".pagedata": Buffer.from("Blank\n"),
  "/page-1.rm": Buffer.from(`reMarkable .lines file, version=6 ${randomUUID()}`),
};
const nbEntries = [];
for (const [suffix, bytes] of Object.entries(nbFiles)) {
  const hash = sha256(bytes);
  await putBlob(hash, bytes);
  nbEntries.push({ hash, type: "0", id: `${nbId}${suffix}`, subfiles: 0, size: bytes.length });
}
const nbHash = merkle(nbEntries);
await putBlob(nbHash, Buffer.from(index(nbEntries)));
let r0 = await root();
const prevDocs = r0.hash ? parse((await blob(r0.hash)).toString()) : [];
const rootEntries = [...prevDocs, { hash: nbHash, type: "80000000", id: nbId, subfiles: 4, size: nbEntries.reduce((n, e) => n + e.size, 0) }];
const rootHash = merkle(rootEntries);
await putBlob(rootHash, Buffer.from(index(rootEntries)));
res = await device("/sync/v3/root", { method: "PUT", json: { generation: r0.generation, hash: rootHash, broadcast: true } });
check(res.ok, "tablet commits a notebook with root CAS");

// 3. Tablet listens for live-sync messages.
const messages = [];
try {
  const wsUrl = opt.api.replace(/^http/, "ws") + "/notifications/ws/json/1";
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${userToken}` } });
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; setTimeout(() => bad(new Error("timeout")), 8000); });
  globalThis.__ws = ws;
} catch (err) {
  console.log(`WARN  could not open the notification WebSocket: ${err.message}`);
}

// 4. Drive auth gates.
if (!opt["service-token"]) {
  res = await fetch(`${opt.drive}/api/items`);
  check(res.status === 401, "drive without Access JWT -> 401", `got ${res.status}`);
  res = await fetch(`${opt.drive}/api/items`, { headers: { "Cf-Access-Jwt-Assertion": localJwt({ aud: ["other-app"] }) } });
  check(res.status === 401, "drive with JWT for another Access app -> 401", `got ${res.status}`);
  res = await fetch(`${opt.drive}/api/items`, { headers: { "Cf-Access-Jwt-Assertion": localJwt({ exp: 1 }) } });
  check(res.status === 401, "drive with expired JWT -> 401", `got ${res.status}`);
  res = await fetch(`${opt.drive}/api/items`, { headers: { "Cf-Access-Jwt-Assertion": localJwt({ email: "stranger@example.test" }) } });
  check(res.status === 403, "drive with unmapped identity -> 403", `got ${res.status}`);
} else {
  res = await fetch(`${opt.drive}/api/items`, { redirect: "manual" });
  check(res.status === 302 || res.status === 403, "drive without login is stopped by Access", `got ${res.status}`);
}
// The device API answers 401 (its sync middleware covers every path) or 404; never drive data.
res = await fetch(`${opt.api}/api/items`, { headers: driveHeaders() });
const deviceBody = await res.text();
check((res.status === 401 || res.status === 404) && !deviceBody.includes('"items"'), "device hostname does not serve the drive API", `got ${res.status}`);
let d = await drive("/api/folders", { method: "POST", json: { name: "x" }, headers: { "X-Drive": "0" } });
check(d.status === 403, "write without X-Drive header -> 403", `got ${d.status}`);
d = await drive("/api/folders", { method: "POST", json: { name: "x" }, headers: { Origin: "https://evil.example" } });
check(d.status === 403, "write from another origin -> 403", `got ${d.status}`);
res = await drive("/", { raw: true });
const pageText = await res.text();
check(res.status === 200 && pageText.includes("<title>Tablet Drive</title>"), "drive page loads");
check(/frame-ancestors 'none'/.test(res.headers.get("content-security-policy") || ""), "drive page sends a CSP");

// 5. Drive sees the tablet's notebook.
d = await drive("/api/items");
const nb = d.data.items?.find((x) => x.id === nbId);
check(d.status === 200 && nb?.kind === "notebook" && nb?.name === "E2E notebook", "drive lists the tablet notebook");

// 6. Drive writes.
d = await drive("/api/folders", { method: "POST", json: { name: "E2E folder" } });
const folderId = d.data.id;
check(d.status === 201 && folderId, "create folder");
d = await drive("/api/folders", { method: "POST", json: { name: "E2E sub", parent: folderId } });
const subId = d.data.id;
check(d.status === 201 && subId, "create subfolder");

const upload = async (name, bytes, parent = "") => {
  const form = new FormData();
  form.append("parent", parent);
  form.append("file", new Blob([bytes]), name);
  return drive("/api/upload", { method: "POST", form });
};
d = await upload("E2E paper.pdf", pdfBytes, folderId);
const pdfId = d.data.id;
check(d.status === 201 && pdfId && d.data.name === "E2E paper", "upload PDF into folder");
d = await upload("E2E book.epub", epubBytes);
const epubId = d.data.id;
check(d.status === 201 && epubId, "upload EPUB");

// Top-level uploads go into one "Drive" folder at the top level, created on first use.
const driveFolderId = d.data.parent;
const liveDriveFolders = (items) => items.filter((x) => x.kind === "folder" && x.name === "Drive" && x.parent === "");
let listed = await drive("/api/items");
check(liveDriveFolders(listed.data.items).some((f) => f.id === driveFolderId), "top-level upload lands in the Drive folder");
const [par1, par2] = await Promise.all([upload("E2E parallel 1.pdf", pdfBytes), upload("E2E parallel 2.pdf", pdfBytes)]);
listed = await drive("/api/items");
check(par1.status === 201 && par2.status === 201 && par1.data.parent === driveFolderId && par2.data.parent === driveFolderId &&
  liveDriveFolders(listed.data.items).length === 1,
  "parallel top-level uploads share one Drive folder", `${liveDriveFolders(listed.data.items).length} live Drive folder(s)`);
d = await upload("fake.pdf", Buffer.from("not a pdf"));
check(d.status === 415, "reject a .pdf that is not a PDF", `got ${d.status}`);
d = await upload("notes.txt", Buffer.from("hello"));
check(d.status === 415, "reject an unsupported file type", `got ${d.status}`);
d = await upload("x.pdf", pdfBytes, "no-such-folder");
check(d.status === 400, "reject upload into a missing folder", `got ${d.status}`);

d = await drive(`/api/items/${pdfId}`, { method: "PATCH", json: { name: "E2E renamed" } });
check(d.status === 200, "rename");
d = await drive(`/api/items/${epubId}`, { method: "PATCH", json: { parent: subId } });
check(d.status === 200, "move EPUB into subfolder");
d = await drive(`/api/items/${folderId}`, { method: "PATCH", json: { parent: subId } });
check(d.status === 400, "refuse to move a folder into its own subfolder", `got ${d.status}`);
d = await drive(`/api/items/${folderId}`, { method: "PATCH", json: { parent: folderId } });
check(d.status === 400, "refuse to move a folder into itself", `got ${d.status}`);
// A folder in Trash (or below one) is never a valid target.
d = await drive("/api/folders", { method: "POST", json: { name: "E2E soon trashed" } });
const goneId = d.data.id;
d = await drive("/api/folders", { method: "POST", json: { name: "E2E deep", parent: goneId } });
const deepId = d.data.id;
d = await drive(`/api/items/${goneId}`, { method: "PATCH", json: { parent: "trash" } });
check(d.status === 200 && deepId, "trash a folder that has a subfolder");
d = await drive(`/api/items/${epubId}`, { method: "PATCH", json: { parent: goneId } });
check(d.status === 400, "refuse to move into a folder in Trash", `got ${d.status}`);
d = await drive(`/api/items/${epubId}`, { method: "PATCH", json: { parent: deepId } });
check(d.status === 400, "refuse to move into a subfolder of a trashed folder", `got ${d.status}`);
d = await upload("x.pdf", pdfBytes, deepId);
check(d.status === 400, "refuse to upload into a subfolder of a trashed folder", `got ${d.status}`);
d = await drive("/api/folders", { method: "POST", json: { name: "x", parent: goneId } });
check(d.status === 400, "refuse to create a folder in a trashed folder", `got ${d.status}`);

d = await drive(`/api/items/${pdfId}`, { method: "PATCH", json: { parent: "trash" } });
check(d.status === 200, "move PDF to Trash");
d = await drive(`/api/items/${nbId}`, { method: "PATCH", json: { parent: "trash" } });
check(d.status === 200, "move tablet notebook to Trash");
d = await drive(`/api/items/${nbId}`, { method: "PATCH", json: { parent: "" } });
check(d.status === 200, "restore tablet notebook");

res = await drive(`/api/items/${pdfId}/file`, { raw: true });
const dl = Buffer.from(await res.arrayBuffer());
check(res.status === 200 && dl.equals(pdfBytes) && res.headers.get("content-type") === "application/pdf", "download gives the same PDF bytes");
d = await drive(`/api/items/${nbId}/file`);
check(d.status === 415, "notebook download is refused (not PDF/EPUB)", `got ${d.status}`);

// 7. Concurrency: a stale tablet commit gets 412; a drive write after a tablet commit still lands.
const before = await root();
res = await device("/sync/v3/root", { method: "PUT", json: { generation: before.generation - 1, hash: before.hash } });
check(res.status === 412, "stale tablet root write -> 412", `got ${res.status}`);
res = await device("/sync/v3/root", { method: "PUT", json: { generation: before.generation, hash: before.hash } });
check(res.ok, "tablet commit moves the generation");
d = await drive("/api/folders", { method: "POST", json: { name: "E2E after tablet" } });
check(d.status === 201, "drive write after a tablet commit");

// 8. Optional: HTML upload and web page render (Browser Rendering).
if (opt.html) {
  d = await upload("E2E page.html", Buffer.from("<!doctype html><title>E2E</title><h1>Hello tablet</h1><p>Rendered by the drive.</p>"), folderId);
  check(d.status === 201, "upload HTML -> PDF", `got ${d.status} ${d.data.message || ""}`);
  globalThis.__htmlId = d.data.id;
}
if (opt.web) {
  d = await drive("/api/web", { method: "POST", json: { url: opt.web, parent: folderId } });
  check(d.status === 201, "save web page as PDF", `got ${d.status} ${d.data.message || d.data.name || ""}`);
  globalThis.__webId = d.data.id;
}

// 9. The tablet's view: every hash valid, every change visible.
const view = await tabletView();
check(view.hashesOk, "tablet walk: every Merkle and sha256 hash matches");
const meta = (id) => view.docs.get(id)?.meta;
check(meta(folderId)?.type === "CollectionType" && meta(folderId)?.visibleName === "E2E folder", "tablet sees the folder");
check(meta(subId)?.parent === folderId, "tablet sees the subfolder inside the folder");
check(meta(driveFolderId)?.type === "CollectionType" && meta(driveFolderId)?.visibleName === "Drive" && meta(driveFolderId)?.parent === "",
  "tablet sees the Drive folder at the top level");
check(meta(par1.data.id)?.parent === driveFolderId, "tablet sees top-level uploads inside Drive");
check(meta(pdfId)?.visibleName === "E2E renamed" && meta(pdfId)?.parent === "trash", "tablet sees the PDF renamed and in Trash");
check(view.docs.get(pdfId)?.files[".pdf"]?.equals(pdfBytes), "tablet gets the exact PDF bytes");
check(JSON.parse(view.docs.get(pdfId)?.files[".content"] ?? "{}").fileType === "pdf", "PDF .content says fileType pdf");
check(meta(epubId)?.parent === subId && !!view.docs.get(epubId)?.files[".epub"], "tablet sees the EPUB in the subfolder");
check(meta(nbId)?.parent === "" && view.docs.get(nbId)?.files["/page-1.rm"]?.equals(nbFiles["/page-1.rm"]), "notebook restored, pages untouched");
check(Object.keys(view.docs.get(nbId)?.files ?? {}).length === 4, "notebook keeps all 4 files");
if (globalThis.__htmlId) {
  const pdf = view.docs.get(globalThis.__htmlId)?.files[".pdf"];
  check(!!pdf && pdf.subarray(0, 4).toString() === "%PDF", "rendered HTML is a PDF on the tablet", pdf ? `${pdf.length} bytes` : "missing");
}
if (globalThis.__webId) {
  const pdf = view.docs.get(globalThis.__webId)?.files[".pdf"];
  check(!!pdf && pdf.subarray(0, 4).toString() === "%PDF", "rendered web page is a PDF on the tablet", pdf ? `${pdf.length} bytes` : "missing");
}

// 10. Live-sync messages reached the tablet.
if (globalThis.__ws) {
  await new Promise((ok) => setTimeout(ok, 1500));
  const fromDrive = messages.filter((m) => m.message?.attributes?.event === "SyncComplete" && String(m.message.attributes.sourceDeviceID).startsWith("drive:"));
  check(fromDrive.length > 0, "tablet got SyncComplete messages from the drive", `${fromDrive.length} messages`);
  globalThis.__ws.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
