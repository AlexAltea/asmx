/*
 * Pure navigation for the windowed Disassembly listing. The view spans the whole
 * mapped range [memLo, memHi) and is rendered one viewport at a time (no giant
 * sizer), so the only things it needs are: given an anchor position, what is the
 * next/previous row, and what address does it sit at. That makes variable-length
 * ISAs (x86) tractable: we never need a global address-to-row table, only local
 * forward/backward steps.
 *
 * A *position* is either:
 *   - a number  -> an index into the document's editable lines (these can be
 *     zero-byte: blank/comment lines share the next instruction's address, so
 *     they must be line-indexed, not address-indexed), or
 *   - a bigint  -> a guest address, for everything outside the document.
 *
 * Each address belongs to one segment:
 *   DOC  the editable assembled code, [base, end)
 *   PAD  the executable region's zero padding past the code, decoded uniformly
 *   MEM  any other mapped region (data/stack), disassembled from live bytes
 *   GAP  unmapped, shown as `??`, one byte per row (uc_err_read_unmapped)
 *
 * `ctx` is a plain snapshot the caller rebuilds per render:
 *   { base, end, memLo, memHi,        // bigint bounds (memHi may be lowered by a
 *                                     //   view filter to drop the non-exec tail)
 *     hide: {lo,hi}|null,             // an interior interval to skip over (hidden
 *                                     //   zero-padding); null when nothing is hidden
 *     lineCount, lineAddr(i),         // document line access
 *     maps: [{addr,size}],            // mapped regions (bigint)
 *     exec: {addr,end}|null,          // executable region (holds the document)
 *     padStride: bigint|null,         // size of the zero-padding instruction
 *     decode(addr): {size:bigint}|null } // one-instruction size, null if bytes
 *                                        // aren't cached yet (treated as 1 byte)
 */

export const PAD = "pad";
export const MEM = "mem";
export const GAP = "gap";

const BACK = 64n; // how far to rewind to re-synchronize x86 back-disassembly
const RESYNC_MAX = 512; // cap on instructions decoded while re-syncing (loop guard)

export function mappedRegion(ctx, a) {
    for (const m of ctx.maps) if (a >= m.addr && a < m.addr + m.size) return m;
    return null;
}

/** Segment of address `a` (only meaningful for non-document addresses). */
export function segAt(ctx, a) {
    if (ctx.exec && ctx.padStride != null && a >= ctx.end && a < ctx.exec.end) return PAD;
    return mappedRegion(ctx, a) ? MEM : GAP;
}

/** Byte length of the row starting at non-document address `a` (>= 1). */
export function sizeAt(ctx, a) {
    const s = segAt(ctx, a);
    if (s === GAP) return 1n;
    if (s === PAD) {
        const sz = a + ctx.padStride > ctx.exec.end ? ctx.exec.end - a : ctx.padStride;
        return sz < 1n ? 1n : sz;
    }
    // MEM: trust the decoder, but never let one row straddle a segment edge.
    const region = mappedRegion(ctx, a);
    const hi = region ? region.addr + region.size : ctx.memHi;
    const d = ctx.decode(a);
    let sz = d && d.size > 0n ? d.size : 1n;
    if (a < ctx.base && a + sz > ctx.base) sz = ctx.base - a; // don't run into the document
    if (a + sz > hi) sz = hi - a;
    return sz < 1n ? 1n : sz;
}

/** Index of the first document line at or after address `a`. */
export function docIndexAt(ctx, a) {
    for (let i = 0; i < ctx.lineCount; i++) if (ctx.lineAddr(i) >= a) return i;
    return ctx.lineCount ? ctx.lineCount - 1 : 0;
}

// ---- view filters -------------------------------------------------------
// `ctx.hide = {lo,hi}` removes an interior interval from the navigable space (the
// executable region's zero-padding, hidden via the disassembly view options). The
// listing jumps across it so the rows on either side become adjacent. A lowered
// `ctx.memHi` separately trims the non-executable tail (data/stack/gaps).
function inHidden(ctx, a) {
    return ctx.hide && a >= ctx.hide.lo && a < ctx.hide.hi;
}
/** Forward: jump to the first visible byte after the hidden interval if `a` is in it. */
function skipFwd(ctx, a) {
    return inHidden(ctx, a) ? ctx.hide.hi : a;
}
/** Backward: jump to the last visible byte before the hidden interval if `a` is in it. */
function skipBack(ctx, a) {
    return inHidden(ctx, a) ? ctx.hide.lo - 1n : a;
}
/** Address -> position: a document line index when in [base,end), else the address. */
function addrToPos(ctx, a) {
    if (ctx.lineCount && a >= ctx.base && a < ctx.end) return docIndexAt(ctx, a);
    return a;
}
/** First visible row past the document (skips a hidden padding interval at `end`). */
function tailStart(ctx) {
    return skipFwd(ctx, ctx.end);
}

/** Start address of the row immediately before the one starting at `a`. */
export function prevAddr(ctx, a) {
    const s = segAt(ctx, a - 1n);
    if (s === GAP) return a - 1n;
    if (s === PAD) {
        // Padding rows tile [end, exec.end) by padStride; the last one may be
        // short. Snap to the tile that contains byte a-1 (handles both cases).
        return ctx.end + ((a - 1n - ctx.end) / ctx.padStride) * ctx.padStride;
    }
    // MEM: re-synchronize by decoding forward from a little before `a`; the
    // boundary whose instruction covers byte a-1 is the predecessor.
    const region = mappedRegion(ctx, a - 1n);
    const regLo = region ? region.addr : ctx.memLo;
    let start = a - BACK;
    if (start < regLo) start = regLo;
    let cur = start;
    for (let guard = 0; guard < RESYNC_MAX && cur < a; guard++) {
        const sz = sizeAt(ctx, cur);
        if (cur + sz >= a) return cur;
        cur += sz;
    }
    return a - 1n;
}

/** The first (top) position of the listing, or null if the range is empty. */
export function firstPos(ctx) {
    if (ctx.memHi <= ctx.memLo) return ctx.lineCount ? 0 : null;
    if (ctx.lineCount && ctx.memLo >= ctx.base && ctx.memLo < ctx.end) return docIndexAt(ctx, ctx.memLo);
    return ctx.memLo;
}

/** Position after `pos`, or null at the end of the range. */
export function nextPos(ctx, pos) {
    if (typeof pos === "number") {
        if (pos + 1 < ctx.lineCount) return pos + 1;
        const a = tailStart(ctx); // fall off the document into the (possibly filtered) tail
        return a < ctx.memHi ? addrToPos(ctx, a) : null;
    }
    const a2 = skipFwd(ctx, pos + sizeAt(ctx, pos));
    if (a2 >= ctx.memHi) return null;
    return addrToPos(ctx, a2);
}

/** Position before `pos`, or null at the top of the range. */
export function prevPos(ctx, pos) {
    if (typeof pos === "number") {
        if (pos > 0) return pos - 1;
        if (ctx.base > ctx.memLo) return prevAddr(ctx, ctx.base); // executable bytes before the code
        return null;
    }
    if (pos <= ctx.memLo) return null;
    if (ctx.lineCount && pos === tailStart(ctx)) return ctx.lineCount - 1; // first tail row -> last code line
    const ap = skipBack(ctx, prevAddr(ctx, pos));
    return addrToPos(ctx, ap);
}

/** Guest address of a position. */
export function posAddr(ctx, pos) {
    if (typeof pos === "number") {
        if (!ctx.lineCount) return ctx.memLo;
        return ctx.lineAddr(Math.max(0, Math.min(ctx.lineCount - 1, pos)));
    }
    return pos;
}

/** Coerce an arbitrary/stale position into a valid one for this ctx. */
export function clampPos(ctx, pos) {
    if (pos == null) return firstPos(ctx);
    if (typeof pos === "number") {
        if (!ctx.lineCount) return firstPos(ctx);
        return Math.max(0, Math.min(ctx.lineCount - 1, pos));
    }
    if (pos < ctx.memLo) return firstPos(ctx);
    if (pos >= ctx.memHi) {
        if (ctx.memHi <= ctx.memLo) return firstPos(ctx);
        pos = ctx.memHi - 1n;
    }
    pos = skipBack(ctx, pos); // a stale anchor inside hidden padding -> last visible code byte
    if (pos < ctx.memLo) return firstPos(ctx);
    return addrToPos(ctx, pos);
}
