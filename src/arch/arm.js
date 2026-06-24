/*
 * ARM (AArch32) architecture profile (data-driven). Register/flag names map to
 * Unicorn, Keystone and Capstone constants by convention in the worker/wrappers:
 *   uc['ARM_REG_' + name], ks['MODE_' + m], cs['MODE_' + m].
 *
 * Two modes: ARM (fixed 4-byte) and Thumb (mixed 2/4-byte, Thumb-2). One ISA
 * state per document; interworking (`blx` into the other state) isn't
 * representable in the listing. The worker keeps Thumb execution state by
 * OR-ing bit 0 into every emu_start begin address (keyed off MODE_THUMB);
 * all stored/displayed addresses stay plain. Big-endian and M-profile modes
 * are deliberately not offered.
 */
import { PROT } from "../core/mem.js";
import { EM } from "../core/elf.js";
import examples from "./examples/arm.js";

const GP = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12"];
const NEON = ["Q0", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10", "Q11", "Q12", "Q13", "Q14", "Q15"];

// CPSR condition flags. The T (Thumb, bit 5) and mode bits are excluded on
// purpose: the Registers panel writes the whole register back when a chip is
// clicked, and flipping T would silently switch ISA state mid-session.
const CPSR_BITS = [
    { name: "N", bit: 31 },
    { name: "Z", bit: 30 },
    { name: "C", bit: 29 },
    { name: "V", bit: 28 },
    { name: "Q", bit: 27 },
];

// Optional condition-code suffix ARM mnemonics carry (bne, blne, popeq, ...) and
// the narrow/wide suffix Capstone appends to Thumb-2 encodings (b.w, pop.w).
const COND = "(?:eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)?";
const WIDE = "(?:\\.w|\\.n)?";

export default {
    key: "arm",
    label: "ARM",
    prefix: "ARM",
    ucArch: "ARCH_ARM",
    ksArch: "ARCH_ARM",
    csArch: "ARCH_ARM",
    endian: "little",
    defaultMode: "arm",
    modeOptions: [
        { id: "arm", label: "ARM" },
        { id: "thumb", label: "Thumb" },
    ],
    // Same guest memory layout as the x86 profile: code (R-X), data scratch
    // (RW-), stack (RW-). Perms are a PROT bitmask (see core/mem.js).
    maps: [
        { addr: 0x10000n, size: 0x10000n, perms: PROT.R | PROT.X, label: "code" },
        { addr: 0x20000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "data" },
        { addr: 0x70000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "stack" },
    ],
    codeBase: 0x10000n,
    stackTop: 0x7ff00n,
    // ARM and Thumb share EM_ARM/ELFCLASS32, so bit width can't pick the mode.
    // Per AAPCS, a Thumb entry point carries bit 0 in e_entry: joinEntry stamps
    // it on save, splitEntry recovers mode + plain address on load.
    elf: {
        machines: [EM.ARM],
        machineForMode: { arm: EM.ARM, thumb: EM.ARM },
        eFlags: 0x05000000, // EF_ARM_EABI_VER5
        joinEntry: (entry, modeId) => (modeId === "thumb" ? entry | 1n : entry),
        splitEntry: (entry) => (entry & 1n ? { modeId: "thumb", entry: entry & ~1n } : { modeId: "arm", entry }),
    },
    // Branch classification patterns, matched against the disassembled text
    // ("mnemonic op_str", lowercase); see core/disassembler.js classify().
    // `ret` covers the idiomatic ARM returns: bx lr, pop/ldm into pc, mov pc,lr.
    branchInfo: {
        call: new RegExp(`^blx?${COND}${WIDE}(\\s|$)`, "i"),
        jump: new RegExp(`^(?:bx?${COND}${WIDE}|cbn?z|tb[bh]${WIDE})(\\s|$)`, "i"),
        uncond: new RegExp(`^(?:b|bx)${WIDE}(\\s|$)`, "i"),
        ret: new RegExp(`^(?:bx${COND}${WIDE}\\s+lr$|(?:pop|ldm(?:ia|fd)?)${COND}${WIDE}\\s.*\\bpc\\b|movs?${COND}\\s+pc,\\s*lr$)`, "i"),
    },
    layoutFor(modeId) {
        const isa = modeId === "thumb" ? "MODE_THUMB" : "MODE_ARM";
        return {
            bits: 32,
            ucMode: [isa],
            ksMode: [isa],
            csMode: [isa],
            pcName: "PC",
            spName: "SP",
            regSize: 4,
            groups: [
                { name: "General", regs: GP },
                { name: "Pointer", regs: ["SP", "LR", "PC"] },
                { name: "Vector", regs: NEON, collapsed: true, size: 16 },
            ],
            flags: { reg: "CPSR", size: 4, bits: CPSR_BITS },
        };
    },
    subRegsFor() {
        return {};
    },
    examples,
};
