/*
 * PowerPC (32-bit, big-endian) architecture profile (data-driven). Register
 * names map to constants by convention in the worker/wrappers; the Unicorn
 * constants are numeric (PPC_REG_3), so `ucReg` strips the display "R" prefix.
 *
 * Keystone only accepts numeric register operands ("li 3, 5", not "li r3, 5");
 * Capstone prints them as r3. PPC64 is deliberately not offered: Unicorn's
 * PPC64 executes but faults on basic integer ops (upstream
 * https://github.com/unicorn-engine/unicorn/issues/1779).
 */
import { PROT } from "../core/mem.js";
import { EM } from "../core/elf.js";
import examples from "./examples/ppc.js";

const GP = Array.from({ length: 32 }, (_, i) => `R${i}`);

// CR0, the condition field integer compares / dotted ops set (bits 31..28 of
// the whole CR). The other seven CR fields are left to the hex value.
const CR_BITS = [
    { name: "LT", bit: 31 },
    { name: "GT", bit: 30 },
    { name: "EQ", bit: 29 },
    { name: "SO", bit: 28 },
];

const LAYOUT = {
    bits: 32,
    ucMode: ["MODE_PPC32", "MODE_BIG_ENDIAN"],
    ksMode: ["MODE_PPC32", "MODE_BIG_ENDIAN"],
    csMode: ["MODE_32", "MODE_BIG_ENDIAN"],
    pcName: "PC",
    spName: "R1", // no architectural SP; the ABI stack pointer is r1
    regSize: 4,
    groups: [
        { name: "General", regs: GP },
        { name: "Pointer", regs: ["LR", "CTR", "PC"] },
        { name: "Status", regs: ["XER"], collapsed: true },
    ],
    flags: { reg: "CR", size: 4, bits: CR_BITS },
};

export default {
    key: "ppc",
    label: "PowerPC",
    prefix: "PPC",
    ucArch: "ARCH_PPC",
    ksArch: "ARCH_PPC",
    csArch: "ARCH_PPC",
    endian: "big",
    defaultMode: "32",
    modeOptions: [{ id: "32", label: "32-bit" }],
    // Same guest memory layout as the x86 profile: code (R-X), data scratch
    // (RW-), stack (RW-). Perms are a PROT bitmask (see core/mem.js).
    maps: [
        { addr: 0x10000n, size: 0x10000n, perms: PROT.R | PROT.X, label: "code" },
        { addr: 0x20000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "data" },
        { addr: 0x70000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "stack" },
    ],
    codeBase: 0x10000n,
    stackTop: 0x7ff00n,
    elf: { machines: [EM.PPC], machineForMode: { "32": EM.PPC } },
    // Branch classification patterns, matched against the disassembled text
    // ("mnemonic op_str", lowercase); see core/disassembler.js classify().
    // A PPC branch sets the link register (a call) iff its mnemonic ends in the
    // link suffix l/la: bl/bla/bctrl/blrl and the conditional beql/bnel/bltl/
    // bdnzl/... A branch-to-link-register (blr, b<cond>lr, ending in lr) is a
    // return. Everything else on b* is a jump. Precedence ret > call > jump
    // (see classify) resolves the overlaps; the jump set stays the broad b*
    // family (incl. Capstone's +/- hint suffixes).
    branchInfo: {
        call: /^b[a-z]*l[a]?(\s|$)/i,
        jump: /^b[a-z+-]*(\s|$)/i,
        uncond: /^(?:b|ba|bctr)(\s|$)/i,
        ret: /^b[a-z]*lr(\s|$)/i,
    },
    // Display names R0..R31 -> numeric Unicorn constants (PPC_REG_3).
    ucReg(name) {
        const m = /^R(\d+)$/.exec(name);
        return m ? m[1] : undefined;
    },
    layoutFor() {
        return LAYOUT;
    },
    subRegsFor() {
        return {};
    },
    examples,
};
