/*
 * Guest memory permission bits. A map's `perms` is a small bitmask using these
 * flags; the values match Unicorn's PROT_* constants (PROT_READ=1, WRITE=2,
 * EXEC=4), so the worker passes the mask straight to mem_map / mem_protect.
 * Single source of truth for arch profiles, the engine wire-format, and the
 * Memory Maps panel. (Note: ELF p_flags order R/W/X differs; see snapshot.js.)
 */
export const PROT = {
    R: 1,
    W: 2,
    X: 4,
};

/** Lowest/highest mapped address across `maps`, as {lo, hi} ({0n, 0n} when empty). */
export function mapsExtent(maps) {
    let lo = null,
        hi = null;
    for (const m of maps || []) {
        const a = BigInt(m.addr);
        const end = a + BigInt(m.size);
        if (lo === null || a < lo) lo = a;
        if (hi === null || end > hi) hi = end;
    }
    return { lo: lo ?? 0n, hi: hi ?? 0n };
}
