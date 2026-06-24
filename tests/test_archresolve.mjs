// Unit test for arch/index.js ELF resolution: e_machine/EI_CLASS/EI_DATA ->
// arch + mode (endianness disambiguates MIPS LE/BE), and the identity stamped
// back on save (elfTargetFor). Pure JS, no wasm. Run: node test_archresolve.mjs

import { archForElf, elfTargetFor, getArch, endianOf } from "../src/arch/index.js";
import { EM, ELFCLASS32, ELFCLASS64 } from "../src/core/elf.js";

let pass = 0,
    fail = 0;
const ok = (cond, m) => (cond ? pass++ : (fail++, console.error(`  ✗ ${m}`)));

const resolve = (machine, elfClass, littleEndian) => archForElf({ machine, elfClass, littleEndian, entry: 0n });

// ---- load: machine/class/endianness -> arch + mode -----------------------
const CASES = [
    [EM.X86_64, ELFCLASS64, true, "x86", "64"],
    [EM["386"], ELFCLASS32, true, "x86", "32"],
    [EM.AARCH64, ELFCLASS64, true, "aarch64", "64"],
    [EM.MIPS, ELFCLASS32, false, "mips", "32"],
    [EM.MIPS, ELFCLASS32, true, "mips", "32le"],
    [EM.MIPS, ELFCLASS64, false, "mips", "64"],
    [EM.MIPS, ELFCLASS64, true, "mips", "64le"],
    [EM.PPC, ELFCLASS32, false, "ppc", "32"],
    [EM.SPARC, ELFCLASS32, false, "sparc", "32"],
    [EM.SPARCV9, ELFCLASS64, false, "sparc", "64"],
    [EM.S390, ELFCLASS64, false, "s390x", "64"],
];
for (const [machine, elfClass, le, key, modeId] of CASES) {
    const r = resolve(machine, elfClass, le);
    ok(r && r.key === key && r.modeId === modeId, `resolve(EM ${machine}, class ${elfClass}, ${le ? "LE" : "BE"}) -> ${key}/${modeId} (got ${r && r.key}/${r && r.modeId})`);
}
ok(resolve(0x1234, ELFCLASS64, true) === null, "unknown machine -> null");

// ---- save/load round trip: elfTargetFor identity resolves back -----------
// Expected byte order per key/mode, written out independently of profile data
// so a profile/endianOf regression cannot satisfy its own assertion.
const EXPECT_LE = {
    x86: { 64: true, 32: true },
    arm: { arm: true, thumb: true },
    aarch64: { 64: true },
    mips: { 32: false, "32le": true, 64: false, "64le": true },
    ppc: { 32: false },
    sparc: { 32: false, 64: false },
    s390x: { 64: false },
};
for (const key of Object.keys(EXPECT_LE)) {
    const p = getArch(key);
    ok(p.modeOptions.every((m) => EXPECT_LE[key][m.id] !== undefined), `${key}: expectation table covers every mode`);
    for (const m of p.modeOptions) {
        const t = elfTargetFor(p, m.id);
        ok(t.littleEndian === EXPECT_LE[key][m.id], `${key}/${m.id}: stamped endianness is ${EXPECT_LE[key][m.id] ? "LE" : "BE"}`);
        ok((endianOf(p, m.id) === "big") === !EXPECT_LE[key][m.id], `${key}/${m.id}: endianOf agrees`);
        // ARM resolves by splitEntry, not bits/endian; joinEntry supplies the bit.
        const entry = p.elf.joinEntry ? p.elf.joinEntry(p.codeBase, m.id) : p.codeBase;
        const r = archForElf({ machine: t.machine, elfClass: t.elfClass, littleEndian: t.littleEndian, entry });
        ok(r && r.key === key && r.modeId === m.id, `${key}/${m.id}: save identity resolves back to the same mode (got ${r && r.key}/${r && r.modeId})`);
        // A Thumb e_entry carries bit 0; the resolved entry must be the plain address.
        ok(r && r.entry === p.codeBase, `${key}/${m.id}: resolved entry is the plain address (got 0x${r && r.entry.toString(16)})`);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
