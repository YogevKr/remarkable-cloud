// Content-addressing helpers: sha256 hex + crc32c (Castagnoli) for x-goog-hash headers.

export async function sha256hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// CRC32C (Castagnoli, reflected poly 0x82F63B78) — what reMarkable's GCS client expects.
const CRC32C_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32C_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// "crc32c=<base64 of 4 big-endian bytes>" — the value reMarkable puts in x-goog-hash.
export function crc32cHeader(data: Uint8Array): string {
  const v = crc32c(data);
  const bytes = new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `crc32c=${btoa(s)}`;
}
