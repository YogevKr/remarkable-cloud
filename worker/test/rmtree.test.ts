// Run: npm test (node --test; Node >= 23 strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  editMetadata,
  indexBlob,
  merkleHash,
  newMetadata,
  parseIndex,
  serializeIndex,
  type Entry,
} from "../src/util/rmtree.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

const docs: Entry[] = [
  { hash: h("b"), type: "80000000", id: "bbbb-2", subfiles: 3, size: 30 },
  { hash: h("a"), type: "80000000", id: "aaaa-1", subfiles: 4, size: 40 },
];

test("serialize writes schema 3, entries sorted by id, newline after every line", () => {
  assert.equal(
    serializeIndex({ schema: "3", entries: docs }),
    `3\n${h("a")}:80000000:aaaa-1:4:40\n${h("b")}:80000000:bbbb-2:3:30\n`,
  );
});

test("parse then serialize gives the same bytes", () => {
  const text = serializeIndex({ schema: "3", entries: docs });
  assert.equal(serializeIndex(parseIndex(text)), text);
});

test("merkle hash = sha256 of the raw child hashes in id order, not of the index text", async () => {
  const expected = createHash("sha256")
    .update(Buffer.concat([Buffer.from(h("a"), "hex"), Buffer.from(h("b"), "hex")]))
    .digest("hex");
  assert.equal(await merkleHash(docs), expected);
  const blob = await indexBlob({ schema: "3", entries: docs });
  assert.equal(blob.hash, expected);
  assert.notEqual(blob.hash, createHash("sha256").update(blob.bytes).digest("hex"));
});

test("parse skips the v4 summary line; writing v4 is refused", () => {
  const idx = parseIndex(`4\n0:.:1:40\n${h("a")}:80000000:aaaa-1:4:40\n`);
  assert.equal(idx.entries.length, 1);
  assert.throws(() => serializeIndex(idx), /not supported/);
});

test("parse rejects a malformed line and an unknown schema", () => {
  assert.throws(() => parseIndex("3\nnot-a-line\n"), /bad index line/);
  assert.throws(() => parseIndex("9\n"), /unsupported index schema/);
});

test("editMetadata keeps unknown tablet keys and changes only what was asked", () => {
  const meta = { ...newMetadata("Doc", "DocumentType", "", 1000), lastOpenedPage: 7, futureKey: "x" };
  const out = editMetadata(meta, { parent: "trash" }, 2000);
  assert.equal(out.parent, "trash");
  assert.equal(out.visibleName, "Doc");
  assert.equal(out.lastModified, "2000");
  assert.equal(out.lastOpenedPage, 7);
  assert.equal(out.futureKey, "x");
  assert.equal(meta.parent, "", "input is not mutated");
});
