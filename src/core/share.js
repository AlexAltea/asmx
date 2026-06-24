/*
 * Share encoding: one gzip container carried in the URL hash,
 *   #v=1&s=base64url( gzip( JSON header + "\n" + raw ELF ) )
 * where the header is { cpu: {name: hexvalue}, bp?: [...], log?: [...] } and the ELF is the
 * non-stack guest memory (see core/elf.js). JSON.stringify never emits a raw
 * newline, so the first 0x0A byte delimits header and ELF. Compression is the
 * platform-native CompressionStream (gzip) and the URL text is the native
 * Uint8Array base64url codec (Baseline 2025; node ≥22.13, older node needs the
 * test shim in tests/test_share.mjs); no dependency either way.
 *
 * `v` versions the payload spec: the decoder dispatches on it (absent -> 1), so
 * a future format bump keeps the v=1 parser around and old links keep working.
 */

// ---- gzip via the streams API (browser + node ≥18) ----------------------
async function gzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Snapshot -> the URL-hash value ("s=..."). `bp` and `log` (optional, may be
 * empty) ride in the header alongside the register file; `log` is the console's
 * [ts, level, message] triples.
 * @param {{elfBytes: Uint8Array, cpu: Record<string,string>, bp?: Array, log?: Array}} snap
 */
export async function encodeShareHash({ elfBytes, cpu, bp, log }) {
    const header = { cpu };
    if (bp && bp.length) header.bp = bp;
    if (log && log.length) header.log = log;
    const head = enc.encode(JSON.stringify(header) + "\n");
    const blob = new Uint8Array(head.length + elfBytes.length);
    blob.set(head, 0);
    blob.set(elfBytes, head.length);
    return "v=1&s=" + (await gzip(blob)).toBase64({ alphabet: "base64url", omitPadding: true });
}

// v=1 payload: gzip( JSON header + "\n" + raw ELF ), base64url.
async function decodeV1(s) {
    const blob = await gunzip(Uint8Array.fromBase64(s, { alphabet: "base64url" }));
    const nl = blob.indexOf(0x0a);
    const { cpu, bp, log } = JSON.parse(dec.decode(blob.subarray(0, nl)));
    return { elfBytes: blob.slice(nl + 1), cpu, bp, log };
}

/**
 * A location.hash -> { elfBytes, cpu, bp?, log? }. Returns null when the hash carries
 * no share; throws when it does but the payload is garbled or the spec version
 * is unknown (caller reports).
 */
export async function decodeShareHash(hash) {
    // Our base64url payload has no '+' or '%', so URLSearchParams decoding is a no-op.
    const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
    const s = params.get("s");
    if (!s) return null;
    const v = params.get("v") || "1";
    if (v === "1") return decodeV1(s);
    throw new Error(`unsupported share link version (v=${v})`);
}
