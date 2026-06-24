/*
 * Snapshot helpers: turn the live engine state into an ELF image of the guest's
 * non-stack memory plus a CPU register map, and the small pure bits that loading
 * one back needs. DOM-free; the side-effectful wiring (touching the document,
 * switching arch, updating panels) stays in app.js.
 */
import { writeElf, trimZeros, PF_R, PF_W, PF_X } from "../core/elf.js";
import { elfTargetFor } from "../arch/index.js";
import { bytesToBig } from "../core/bigint.js";
import { PROT } from "../core/mem.js";

/** The map containing the stack pointer's home (stackTop), if any. */
function stackMap(profile) {
    return profile.maps.find((m) => profile.stackTop >= m.addr && profile.stackTop < m.addr + m.size);
}

/** Mapped regions that are NOT the stack: the memory we serialize. */
export function nonStackMaps(profile) {
    const stack = stackMap(profile);
    return profile.maps.filter((m) => m !== stack);
}

/** PROT bitmask -> ELF p_flags (the two bit orders differ, so map explicitly). */
function permFlags(perms) {
    if (perms == null) return PF_R | PF_W | PF_X;
    let f = 0;
    if (perms & PROT.R) f |= PF_R;
    if (perms & PROT.W) f |= PF_W;
    if (perms & PROT.X) f |= PF_X;
    return f || PF_R;
}

/**
 * Read every non-stack region from the engine and emit an ELF executable. Each
 * region becomes a PT_LOAD; trailing zeros are dropped from p_filesz while
 * p_memsz keeps the full region size (the rest is BSS). `liveMaps` (the Memory
 * Maps view's current perms, keyed by addr) overrides the profile defaults so a
 * saved/shared image reflects any live R/W/X toggles; absent, profile perms win.
 * @returns {Promise<Uint8Array>}
 */
export async function buildElf({ engine, profile, modeId, entry, liveMaps }) {
    const live = new Map((liveMaps || []).map((m) => [BigInt(m.addr).toString(), Number(m.perms)]));
    const segments = [];
    for (const m of nonStackMaps(profile)) {
        const raw = await engine.readMemAsync(m.addr, Number(m.size));
        const perms = live.has(m.addr.toString()) ? live.get(m.addr.toString()) : m.perms;
        segments.push({
            vaddr: m.addr,
            bytes: Uint8Array.from(trimZeros(raw)),
            memsz: m.size,
            flags: permFlags(perms),
        });
    }
    const t = elfTargetFor(profile, modeId);
    // Mode-dependent entry encoding (ARM stamps the AAPCS Thumb bit into e_entry
    // so a save/share round-trips back into Thumb mode).
    const e = profile.elf.joinEntry ? profile.elf.joinEntry(BigInt(entry), modeId) : BigInt(entry);
    return writeElf({
        machine: t.machine,
        elfClass: t.elfClass,
        littleEndian: t.littleEndian,
        eFlags: t.eFlags,
        entry: e,
        segments,
    });
}

// Widest register that round-trips as a scalar hex value; vector regs (XMM, 16
// bytes) are wider and are skipped.
const MAX_SCALAR_BYTES = 8;

/**
 * Live scalar register file as { NAME: hexvalue }, trimmed for a share link:
 *  - vector regs (XMM, 16 bytes) are skipped: too wide to round-trip as a scalar;
 *  - zero-valued regs are omitted: the engine zero-initializes every register when
 *    it's instantiated (Unicorn resets the CPU on each open; verified for x86, incl.
 *    across the worker's reused wasm heap), so an absent reg restores to the same 0.
 *    EFLAGS reads back as 0x2 (reserved bit), so it's never zero and always travels;
 *  - the program counter is dropped when it equals `entry`: share restore falls back
 *    to the ELF's entry address whenever the PC reg is absent (see applyElf in app.js),
 *    so storing it would be redundant in the common case (PC parked at the entry).
 * Pass `{ pcName, entry }` to enable the PC drop; omit them to keep every non-zero reg.
 */
export function captureCpu(engine, { pcName, entry } = {}) {
    const cpu = {};
    const entryBig = entry != null ? BigInt(entry) : null;
    for (const r of engine.regs) {
        if (!r.bytes || r.size > MAX_SCALAR_BYTES) continue;
        const value = bytesToBig(r.bytes);
        if (value === 0n) continue; // engine default is 0; restore re-zeroes an omitted reg
        if (entryBig != null && r.name === pcName && value === entryBig) continue;
        cpu[r.name] = value.toString(16).toUpperCase();
    }
    return cpu;
}

/** Choose the segment to disassemble into the editor: prefer executable+entry. */
export function pickCodeSegment(parsed) {
    const segs = parsed.segments;
    if (!segs.length) return null;
    const hasEntry = (s) => parsed.entry >= s.vaddr && parsed.entry < s.vaddr + s.memsz;
    return (
        segs.find((s) => s.flags & PF_X && hasEntry(s)) ||
        segs.find((s) => hasEntry(s)) ||
        segs.find((s) => s.flags & PF_X) ||
        segs[0]
    );
}

export function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
