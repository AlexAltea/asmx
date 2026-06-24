// Pure unit test for the ELF reader/writer. Run: node test_elf.mjs
import {
    writeElf,
    parseElf,
    trimZeros,
    machineName,
    EM,
    ELFCLASS32,
    ELFCLASS64,
    PF_R,
    PF_W,
    PF_X,
} from "../src/core/elf.js";

let pass = 0,
    fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else {
        fail++;
        console.error("  ✗ " + msg);
    }
}
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${a}, want ${b})`);
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// --- 64-bit round-trip ------------------------------------------------
{
    const body = Uint8Array.from([0xb8, 0x34, 0x12, 0, 0, 0xc3]); // mov eax,0x1234; ret
    const elf = writeElf({
        machine: EM.X86_64,
        elfClass: ELFCLASS64,
        littleEndian: true,
        entry: 0x10000n,
        segments: [{ vaddr: 0x10000n, bytes: body, memsz: 0x10000n, flags: PF_R | PF_W | PF_X }],
    });
    const p = parseElf(elf);
    eq(p.elfClass, ELFCLASS64, "64: class");
    eq(p.littleEndian, true, "64: LE");
    eq(p.machine, EM.X86_64, "64: machine");
    eq(p.entry, 0x10000n, "64: entry");
    eq(p.segments.length, 1, "64: one PT_LOAD");
    eq(p.segments[0].vaddr, 0x10000n, "64: seg vaddr");
    eq(p.segments[0].memsz, 0x10000n, "64: seg memsz");
    ok(bytesEq(p.segments[0].bytes, body), "64: seg bytes round-trip");
    ok((p.segments[0].flags & PF_X) !== 0, "64: seg is executable");
    // congruent file offset: p_offset == p_vaddr (mod page); verify via raw header
    const dv = new DataView(elf.buffer);
    const phoff = Number(dv.getBigUint64(32, true));
    const off = Number(dv.getBigUint64(phoff + 8, true));
    eq(off % 0x1000, Number(0x10000n % 0x1000n), "64: file offset page-congruent");
}

// --- 32-bit round-trip (Phdr field order differs) ---------------------
{
    const body = Uint8Array.from([0x90, 0x90, 0xcc]);
    const elf = writeElf({
        machine: EM["386"],
        elfClass: ELFCLASS32,
        littleEndian: true,
        entry: 0x8048n,
        segments: [{ vaddr: 0x8000n, bytes: body, memsz: 0x1000n, flags: PF_R | PF_X }],
    });
    const p = parseElf(elf);
    eq(p.elfClass, ELFCLASS32, "32: class");
    eq(p.machine, EM["386"], "32: machine");
    eq(p.entry, 0x8048n, "32: entry");
    eq(p.segments[0].vaddr, 0x8000n, "32: seg vaddr");
    ok(bytesEq(p.segments[0].bytes, body), "32: seg bytes round-trip");
    eq(p.segments[0].flags, PF_R | PF_X, "32: flags decoded from right offset");
    ok((p.segments[0].flags & PF_W) === 0, "32: not writable");
}

// --- big-endian round-trip --------------------------------------------
{
    const body = Uint8Array.from([1, 2, 3, 4]);
    const elf = writeElf({
        machine: EM.PPC,
        elfClass: ELFCLASS64,
        littleEndian: false,
        entry: 0x10000n,
        segments: [{ vaddr: 0x10000n, bytes: body, memsz: 0x10000n }],
    });
    const p = parseElf(elf);
    eq(p.littleEndian, false, "BE: flagged big-endian");
    eq(p.machine, EM.PPC, "BE: machine decoded with BE byte order");
    eq(p.entry, 0x10000n, "BE: entry decoded with BE byte order");
    ok(bytesEq(p.segments[0].bytes, body), "BE: seg bytes round-trip");
}

// --- trimZeros + filesz/memsz split -----------------------------------
{
    const raw = new Uint8Array(64);
    raw.set([0xde, 0xad, 0xbe, 0xef], 0); // 4 meaningful bytes then zeros
    const trimmed = trimZeros(raw);
    eq(trimmed.length, 4, "trim: drops trailing zeros");
    const elf = writeElf({
        machine: EM.X86_64,
        elfClass: ELFCLASS64,
        entry: 0x10000n,
        segments: [{ vaddr: 0x10000n, bytes: Uint8Array.from(trimmed), memsz: 64 }],
    });
    const p = parseElf(elf);
    eq(p.segments[0].filesz, 4, "trim: filesz is trimmed length");
    eq(p.segments[0].memsz, 64n, "trim: memsz keeps full region (BSS tail)");
}

// --- multi-segment ----------------------------------------------------
{
    const a = Uint8Array.from([1, 1, 1]);
    const b = Uint8Array.from([2, 2]);
    const elf = writeElf({
        machine: EM.X86_64,
        elfClass: ELFCLASS64,
        entry: 0x10000n,
        segments: [
            { vaddr: 0x10000n, bytes: a, memsz: 0x1000n },
            { vaddr: 0x20000n, bytes: b, memsz: 0x1000n },
        ],
    });
    const p = parseElf(elf);
    eq(p.segments.length, 2, "multi: both PT_LOADs parsed");
    ok(bytesEq(p.segments[0].bytes, a) && bytesEq(p.segments[1].bytes, b), "multi: both segments intact");
    eq(p.segments[1].vaddr, 0x20000n, "multi: second vaddr");
}

// --- rejects non-ELF --------------------------------------------------
{
    let threw = false;
    try {
        parseElf(new Uint8Array(64));
    } catch {
        threw = true;
    }
    ok(threw, "rejects bad magic");
    eq(machineName(EM.X86_64), "EM_X86_64", "machineName names X86_64");
}

// --- truncated header throws a clean Error (not a raw RangeError) ------
{
    const full = writeElf({
        machine: EM.X86_64,
        elfClass: ELFCLASS64,
        entry: 0x10000n,
        segments: [{ vaddr: 0x10000n, bytes: Uint8Array.from([0x90]), memsz: 0x1000n }],
    });
    for (const len of [20, 40, 57]) {
        let err = null;
        try {
            parseElf(full.slice(0, len));
        } catch (e) {
            err = e;
        }
        ok(err instanceof Error && /truncated/.test(err.message), `truncated@${len} -> clean Error`);
    }
}

console.log(`test_elf: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
