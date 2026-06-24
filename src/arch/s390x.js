/*
 * S390X (z/Architecture, big-endian) profile (data-driven). Register names map
 * to constants by convention in the worker/wrappers; the three libraries name
 * the arch differently: uc ARCH_S390X, ks ARCH_SYSTEMZ, cs ARCH_SYSZ.
 *
 * Instructions are 2/4/6 bytes. The code region sits BELOW 0x10000 on purpose:
 * Keystone's SystemZ 16-bit-relative branch fixups (j/brc/brct) range-check the
 * absolute target against base 0, so short branches only assemble while every
 * code address fits in 16 bits; the 32-bit-relative forms (jg*, brasl, larl)
 * work anywhere. Calls are brasl %r14 / basr %r14 and return via br %r14.
 */
import { PROT } from "../core/mem.js";
import { EM } from "../core/elf.js";
import examples from "./examples/s390x.js";

const GP = [
    "R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7",
    "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15",
];

const LAYOUT = {
    bits: 64,
    ucMode: ["MODE_BIG_ENDIAN"],
    ksMode: ["MODE_BIG_ENDIAN"],
    csMode: ["MODE_BIG_ENDIAN"],
    pcName: "PC", // the PSW address; Unicorn exposes it as S390X_REG_PC
    spName: "R15", // no architectural SP; the ABI stack pointer is r15
    regSize: 8,
    groups: [
        { name: "General", regs: GP },
        { name: "Pointer", regs: ["PC"] },
    ],
};

export default {
    key: "s390x",
    label: "S390X",
    prefix: "S390X",
    ucArch: "ARCH_S390X",
    ksArch: "ARCH_SYSTEMZ",
    csArch: "ARCH_SYSZ",
    endian: "big",
    defaultMode: "64",
    modeOptions: [{ id: "64", label: "64-bit" }],
    // Code below 0x10000 (see header); data and stack match the other profiles.
    // The code map keeps W: Unicorn's s390x MMU raises a protection exception
    // on ANY access to a page mapped without PROT_WRITE (R-X faults at the
    // first fetch), so the usual read-execute mapping is not available here.
    maps: [
        { addr: 0x8000n, size: 0x8000n, perms: PROT.R | PROT.W | PROT.X, label: "code" },
        { addr: 0x20000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "data" },
        { addr: 0x70000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "stack" },
    ],
    codeBase: 0x8000n,
    stackTop: 0x7ff00n,
    elf: { machines: [EM.S390], machineForMode: { "64": EM.S390 } },
    // Branch classification patterns, matched against the disassembled text
    // ("mnemonic op_str", lowercase); see core/disassembler.js classify().
    // j<cond>/jg<cond> are the BRC/BRCL extended mnemonics Capstone prints;
    // `br %r14` is the ABI return, other `br %rN` are plain indirect jumps.
    branchInfo: {
        call: /^(?:brasl?|basr|balr|bal)(\s|$)/i,
        jump: /^(?:j[a-z]*|br|bc|bcr|brcl?|brctg?|b)(\s|$)/i,
        uncond: /^(?:j|jg|br|b)(\s|$)/i,
        ret: /^br\s+%r14$/i,
    },
    layoutFor() {
        return LAYOUT;
    },
    subRegsFor() {
        return {};
    },
    examples,
};
