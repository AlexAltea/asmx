/*
 * Minimal ELF reader/writer: pure, DOM-free, BigInt-addressed (node-testable).
 * Scope is deliberately small: executable images made of PT_LOAD segments, which
 * is all the playground needs to round-trip guest memory. No sections, no
 * dynamic info. Handles ELFCLASS32/64 and either endianness; note the program
 * header field *order* differs between the two classes (p_flags moves), which is
 * the easy thing to get wrong.
 */

// e_ident
const MAG = [0x7f, 0x45, 0x4c, 0x46]; // \x7f E L F
export const ELFCLASS32 = 1;
export const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;

const EV_CURRENT = 1;
const ET_EXEC = 2;
const PT_LOAD = 1;

// p_flags
export const PF_X = 1;
export const PF_W = 2;
export const PF_R = 4;

// e_machine values for the Tier-A architectures (only those with a profile are
// actually loadable today; the rest are here so detection can name them).
export const EM = {
    M32: 1,
    SPARC: 2,
    386: 3,
    MIPS: 8,
    PPC: 20,
    PPC64: 21,
    S390: 22,
    ARM: 40,
    SPARCV9: 43,
    X86_64: 62,
    AARCH64: 183,
};
const EM_NAME = Object.fromEntries(Object.entries(EM).map(([k, v]) => [v, "EM_" + k]));

/** Human-readable e_machine name (for error messages). */
export function machineName(machine) {
    return EM_NAME[machine] || `0x${machine.toString(16)}`;
}

const PAGE = 0x1000;
const alignUp = (n, a) => Math.ceil(n / a) * a;

// ELF header (e_ehsize) and program-header (e_phentsize) sizes in bytes, per
// class. Used by both writeElf and parseElf, so they live here once.
const EH_SIZE_32 = 52, EH_SIZE_64 = 64;
const PH_SIZE_32 = 32, PH_SIZE_64 = 56;

/**
 * Build an ELF executable image from PT_LOAD segments.
 *
 * @param {object} o
 * @param {number} o.machine       e_machine
 * @param {number} o.elfClass      ELFCLASS32 | ELFCLASS64
 * @param {boolean} o.littleEndian
 * @param {bigint} o.entry         e_entry
 * @param {number} o.eFlags        e_flags (ABI marker, e.g. ARM EABI version)
 * @param {Array<{vaddr: bigint, bytes: Uint8Array, memsz?: bigint|number, flags?: number}>} o.segments
 * @returns {Uint8Array}
 */
export function writeElf({ machine, elfClass = ELFCLASS64, littleEndian = true, entry = 0n, eFlags = 0, segments = [] }) {
    const is64 = elfClass === ELFCLASS64;
    const ehSize = is64 ? EH_SIZE_64 : EH_SIZE_32;
    const phSize = is64 ? PH_SIZE_64 : PH_SIZE_32;
    const phoff = ehSize;
    const N = segments.length;

    // Lay segment data out after the program headers, each at a file offset that
    // is congruent to its p_vaddr modulo the page size (what real loaders expect).
    let cursor = phoff + phSize * N;
    const placed = segments.map((s) => {
        const filesz = s.bytes.length;
        const vlow = Number(((s.vaddr % BigInt(PAGE)) + BigInt(PAGE)) % BigInt(PAGE));
        const offset = alignUp(cursor, PAGE) + vlow;
        cursor = offset + filesz;
        return { ...s, filesz, offset, memsz: BigInt(s.memsz != null ? s.memsz : filesz) };
    });

    const buf = new ArrayBuffer(cursor);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const le = littleEndian;
    const w64 = (off, v) => dv.setBigUint64(off, BigInt(v), le);
    const w32 = (off, v) => dv.setUint32(off, Number(v) >>> 0, le);
    const w16 = (off, v) => dv.setUint16(off, v, le);

    // ---- ELF header ----
    u8.set(MAG, 0);
    u8[4] = elfClass;
    u8[5] = littleEndian ? ELFDATA2LSB : ELFDATA2MSB;
    u8[6] = EV_CURRENT;
    w16(16, ET_EXEC);
    w16(18, machine);
    w32(20, EV_CURRENT);
    if (is64) {
        w64(24, entry);
        w64(32, phoff);
        w64(40, 0); // e_shoff
        w32(48, eFlags);
        w16(52, ehSize);
        w16(54, phSize);
        w16(56, N);
    } else {
        w32(24, entry);
        w32(28, phoff);
        w32(32, 0); // e_shoff
        w32(36, eFlags);
        w16(40, ehSize);
        w16(42, phSize);
        w16(44, N);
    }

    // ---- program headers + data ----
    placed.forEach((s, i) => {
        const p = phoff + i * phSize;
        const flags = s.flags != null ? s.flags : PF_R | PF_W | PF_X;
        if (is64) {
            w32(p, PT_LOAD);
            w32(p + 4, flags);
            w64(p + 8, s.offset);
            w64(p + 16, s.vaddr);
            w64(p + 24, s.vaddr); // p_paddr
            w64(p + 32, s.filesz);
            w64(p + 40, s.memsz);
            w64(p + 48, PAGE); // p_align
        } else {
            w32(p, PT_LOAD);
            w32(p + 4, s.offset);
            w32(p + 8, s.vaddr);
            w32(p + 12, s.vaddr);
            w32(p + 16, s.filesz);
            w32(p + 20, s.memsz);
            w32(p + 24, flags);
            w32(p + 28, PAGE);
        }
        u8.set(s.bytes, s.offset);
    });

    return u8;
}

/**
 * Parse an ELF image, returning its class/endianness/machine/entry and PT_LOAD
 * segments only (each with its file bytes sliced out). Throws on a bad header.
 * @param {Uint8Array} bytes
 */
export function parseElf(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = Uint8Array.from(bytes);
    if (bytes.length < 16 || bytes[0] !== MAG[0] || bytes[1] !== MAG[1] || bytes[2] !== MAG[2] || bytes[3] !== MAG[3]) {
        throw new Error("not an ELF file (bad magic)");
    }
    const elfClass = bytes[4];
    if (elfClass !== ELFCLASS32 && elfClass !== ELFCLASS64) throw new Error("unsupported ELF class");
    const data = bytes[5];
    const littleEndian = data !== ELFDATA2MSB;
    const is64 = elfClass === ELFCLASS64;
    if (bytes.length < (is64 ? EH_SIZE_64 : EH_SIZE_32)) throw new Error("truncated ELF header");
    const le = littleEndian;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const machine = dv.getUint16(18, le);
    let entry, phoff, phentsize, phnum;
    if (is64) {
        entry = dv.getBigUint64(24, le);
        phoff = Number(dv.getBigUint64(32, le));
        phentsize = dv.getUint16(54, le);
        phnum = dv.getUint16(56, le);
    } else {
        entry = BigInt(dv.getUint32(24, le));
        phoff = dv.getUint32(28, le);
        phentsize = dv.getUint16(42, le);
        phnum = dv.getUint16(44, le);
    }

    const segments = [];
    for (let i = 0; i < phnum; i++) {
        const p = phoff + i * phentsize;
        if (p + (is64 ? PH_SIZE_64 : PH_SIZE_32) > bytes.length) break;
        if (dv.getUint32(p, le) !== PT_LOAD) continue;
        let offset, vaddr, filesz, memsz, flags;
        if (is64) {
            flags = dv.getUint32(p + 4, le);
            offset = Number(dv.getBigUint64(p + 8, le));
            vaddr = dv.getBigUint64(p + 16, le);
            filesz = Number(dv.getBigUint64(p + 32, le));
            memsz = dv.getBigUint64(p + 40, le);
        } else {
            offset = dv.getUint32(p + 4, le);
            vaddr = BigInt(dv.getUint32(p + 8, le));
            filesz = dv.getUint32(p + 16, le);
            memsz = BigInt(dv.getUint32(p + 20, le));
            flags = dv.getUint32(p + 24, le);
        }
        const end = Math.min(offset + filesz, bytes.length);
        segments.push({ vaddr, filesz, memsz, flags, bytes: bytes.slice(offset, end) });
    }

    return { elfClass, littleEndian, machine, entry, segments };
}

/** Trim a trailing run of zero bytes (so p_filesz stays small; rest is BSS). */
export function trimZeros(bytes) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return bytes.subarray(0, end);
}
