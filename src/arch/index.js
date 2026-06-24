/*
 * Architecture registry: maps an arch key to its profile, and resolves an ELF's
 * (machine, class) to a registered arch + mode. Adding an architecture is just
 * registering another profile of the same shape; nothing downstream changes.
 */
import x86 from "./x86.js";
import arm from "./arm.js";
import aarch64 from "./aarch64.js";
import mips from "./mips.js";
import ppc from "./ppc.js";
import sparc from "./sparc.js";
import s390x from "./s390x.js";
import { ELFCLASS32, ELFCLASS64 } from "../core/elf.js";

const REGISTRY = { x86, arm, aarch64, mips, ppc, sparc, s390x };

export function listArchs() {
    return Object.values(REGISTRY).map((a) => ({ key: a.key, label: a.label }));
}

export function getArch(key) {
    return REGISTRY[key] || REGISTRY.x86;
}

/** The profile's executable code region (the map labelled "code", else the
 *  first map) as {base, end}. Avoids assuming maps[0] is the code region. */
export function codeRegion(profile) {
    const m = profile.maps.find((r) => r.label === "code") || profile.maps[0];
    return { base: m.addr, end: m.addr + m.size };
}

/** Guest memory byte order for `profile`@`modeId`: a layout-level `endian`
 *  (bi-endian arches like MIPS pick it per mode) overrides the profile's. */
export function endianOf(profile, modeId) {
    return profile.layoutFor(modeId).endian || profile.endian;
}

/**
 * Flat register list for a worker INIT / snapshot: every non-lazy register
 * across the display groups, plus PC and the flags register, de-duplicated.
 * Each entry is { name, size, group }. The worker resolves name -> reg id via
 * uc[`${prefix}_REG_${name}`].
 */
export function snapshotRegs(profile, modeId) {
    const L = profile.layoutFor(modeId);
    const seen = new Set();
    const out = [];
    // `uc` carries the Unicorn constant suffix when it differs from the display
    // name (PPC shows "R3" but the constant is PPC_REG_3); see profile.ucReg.
    const add = (name, size, group) => {
        if (seen.has(name)) return;
        seen.add(name);
        const uc = profile.ucReg ? profile.ucReg(name) : undefined;
        out.push(uc && uc !== name ? { name, size, group, uc } : { name, size, group });
    };
    for (const g of L.groups) {
        const size = g.size || L.regSize;
        for (const r of g.regs) add(r, size, g.name);
    }
    if (L.flags) add(L.flags.reg, L.flags.size, "Flags");
    add(L.pcName, L.regSize, "Pointer");
    return out;
}

/**
 * Resolve an ELF's (e_machine, EI_CLASS, EI_DATA, e_entry) to a registered arch
 * + mode + usable entry address, or null if no profile claims that machine.
 * Bit width selects the mode; among same-width modes, endianness breaks the tie
 * (MIPS32 LE vs BE differ only in EI_DATA). Alternatively the profile can
 * disambiguate through the entry address (ARM vs Thumb via the AAPCS e_entry
 * bit 0; splitEntry also strips that bit, so the returned entry is always a
 * plain instruction address).
 */
export function archForElf({ machine, elfClass, littleEndian = true, entry = 0n }) {
    const wantBits = elfClass === ELFCLASS64 ? 64 : 32;
    const wantEndian = littleEndian ? "little" : "big";
    for (const a of Object.values(REGISTRY)) {
        if (!a.elf || !a.elf.machines.includes(machine)) continue;
        if (a.elf.splitEntry) {
            const s = a.elf.splitEntry(entry);
            return { key: a.key, modeId: s.modeId, entry: s.entry };
        }
        const sameBits = a.modeOptions.filter((m) => a.layoutFor(m.id).bits === wantBits);
        const mode = sameBits.find((m) => endianOf(a, m.id) === wantEndian) || sameBits[0];
        return { key: a.key, modeId: mode ? mode.id : a.defaultMode, entry };
    }
    return null;
}

/** ELF identity (machine/class/endianness/e_flags) to stamp when saving `profile`@`modeId`. */
export function elfTargetFor(profile, modeId) {
    const bits = profile.layoutFor(modeId).bits;
    const machine = (profile.elf && (profile.elf.machineForMode[modeId] ?? profile.elf.machines[0])) || 0;
    return {
        machine,
        elfClass: bits === 64 ? ELFCLASS64 : ELFCLASS32,
        littleEndian: endianOf(profile, modeId) !== "big",
        eFlags: (profile.elf && profile.elf.eFlags) || 0,
    };
}

/** Resolve KS/CS mode arrays + arch names into the constant *names* to OR. */
export function modeNames(profile, modeId) {
    const L = profile.layoutFor(modeId);
    return {
        ucArch: profile.ucArch,
        ucMode: L.ucMode,
        ksArch: profile.ksArch,
        ksMode: L.ksMode,
        ksSyntax: profile.ksSyntax,
        csArch: profile.csArch,
        csMode: L.csMode,
    };
}
