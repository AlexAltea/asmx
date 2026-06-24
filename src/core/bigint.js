/*
 * BigInt / hex helpers. Addresses and register values are BigInt end-to-end
 * (Unicorn returns 64-bit values as BigInt) so nothing overflows Number; the
 * small byte/char helpers below take plain Numbers.
 */

/** Format a value to an unsigned hex string of exactly `digits` nibbles. */
export function toHex(value, digits) {
    const v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    return BigInt.asUintN(digits * 4, v).toString(16).toUpperCase().padStart(digits, "0");
}

/** Hex digits (nibbles) needed to print `bytes` bytes, e.g. toHex(v, hexWidth(size)). */
export const hexWidth = (bytes) => bytes * 2;
/** Unsigned bitmask covering `bytes` bytes, e.g. maskFor(4) === 0xffffffffn. */
export const maskFor = (bytes) => (1n << BigInt(bytes * 8)) - 1n;
/** Bytes spanned by a low byte-aligned mask; inverse of maskFor (0xffffn -> 2). */
export const maskBytes = (mask) => { let n = 0; for (let m = mask; m > 0n; m >>= 8n) n++; return n; };

/** Coerce a byte source (Uint8Array | number[]) to a Uint8Array; no copy when already one. */
export const asU8 = (b) => (b instanceof Uint8Array ? b : Uint8Array.from(b));

/** Bytes (Uint8Array | number[]) -> spaced hex pairs, e.g. "B8 00 00". */
export function bytesToHex(bytes) {
    return Array.from(bytes, (b) => toHex(b, 2)).join(" ");
}

/** Byte array -> BigInt; little-endian unless `bigEndian`. Register bytes from
 *  Unicorn are always host-little-endian; guest MEMORY bytes follow the arch. */
export function bytesToBig(bytes, bigEndian = false) {
    let v = 0n;
    if (bigEndian) {
        for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
    } else {
        for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    }
    return v;
}

/** BigInt -> Uint8Array of `size` bytes; little-endian unless `bigEndian`. */
export function bigToBytes(value, size, bigEndian = false) {
    const out = new Uint8Array(size);
    let v = BigInt(value);
    for (let i = 0; i < size; i++) {
        out[bigEndian ? size - 1 - i : i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

/** Printable ASCII or '.'. */
export function byteToChar(n) {
    return n >= 0x20 && n <= 0x7e ? String.fromCharCode(n) : ".";
}

/**
 * Wrap the leading-zero run of a hex string in <span class="zero">...</span>.
 * Color-dimmed (not opacity / not pseudo-element) so Ctrl+C still copies the
 * full padded hex. Operates on grouped hex too ("00 00 B8" dims "00 00 ").
 * An all-zero value keeps its last digit bright (the dim run never eats it all).
 */
export function dimZeros(hex, { grouped = false } = {}) {
    if (grouped) {
        // Bytes column: dim every whole "00" byte (operand/immediate padding),
        // keeping opcode/data bytes bright. Real text, so copy-paste is intact.
        return hex
            .split(" ")
            .map((p) => (p === "00" ? '<span class="zero">00</span>' : escapeHtml(p)))
            .join(" ");
    }
    // Dim the leading run of '0' nibbles, but never the whole string.
    const m = hex.match(/^0+(?=.)/);
    if (!m) return escapeHtml(hex);
    const run = m[0];
    return `<span class="zero">${run}</span>${escapeHtml(hex.slice(run.length))}`;
}

export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** Error (or anything thrown) -> message string. */
export const errMsg = (e) => (e && e.message ? e.message : String(e));

/** Parse a user-typed hex/decimal value to BigInt (accepts 0x, bare hex). */
export function parseValue(text) {
    const t = String(text).trim();
    if (/^0x/i.test(t)) return BigInt(t);
    if (/^-?\d+$/.test(t)) return BigInt(t);
    return BigInt("0x" + (t || "0"));
}
