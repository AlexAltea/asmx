/*
 * AArch64 architecture profile (data-driven). Register/flag names map to
 * Unicorn, Keystone and Capstone constants by convention in the worker/wrappers;
 * note all three call the arch "ARM64" while the app key/label is "aarch64":
 * uc['ARM64_REG_' + name], ks['ARCH_ARM64'], cs['ARCH_ARM64'].
 */
import { PROT } from "../core/mem.js";
import { EM } from "../core/elf.js";
import examples from "./examples/aarch64.js";

const GP64 = [
    "X0", "X1", "X2", "X3", "X4", "X5", "X6", "X7",
    "X8", "X9", "X10", "X11", "X12", "X13", "X14", "X15",
    "X16", "X17", "X18", "X19", "X20", "X21", "X22", "X23",
    "X24", "X25", "X26", "X27", "X28", "X29", "X30",
];
const SIMD = [
    "V0", "V1", "V2", "V3", "V4", "V5", "V6", "V7",
    "V8", "V9", "V10", "V11", "V12", "V13", "V14", "V15",
    "V16", "V17", "V18", "V19", "V20", "V21", "V22", "V23",
    "V24", "V25", "V26", "V27", "V28", "V29", "V30", "V31",
];

// Sub-registers for the expression evaluator: 32-bit W views of the X
// registers, plus the ABI aliases (FP=X29, LR=X30) as full-width views.
const SUBREGS = {
    W0:  { parent: "X0",  off: 0, mask: 0xffffffffn },
    W1:  { parent: "X1",  off: 0, mask: 0xffffffffn },
    W2:  { parent: "X2",  off: 0, mask: 0xffffffffn },
    W3:  { parent: "X3",  off: 0, mask: 0xffffffffn },
    W4:  { parent: "X4",  off: 0, mask: 0xffffffffn },
    W5:  { parent: "X5",  off: 0, mask: 0xffffffffn },
    W6:  { parent: "X6",  off: 0, mask: 0xffffffffn },
    W7:  { parent: "X7",  off: 0, mask: 0xffffffffn },
    W8:  { parent: "X8",  off: 0, mask: 0xffffffffn },
    W9:  { parent: "X9",  off: 0, mask: 0xffffffffn },
    W10: { parent: "X10", off: 0, mask: 0xffffffffn },
    W11: { parent: "X11", off: 0, mask: 0xffffffffn },
    W12: { parent: "X12", off: 0, mask: 0xffffffffn },
    W13: { parent: "X13", off: 0, mask: 0xffffffffn },
    W14: { parent: "X14", off: 0, mask: 0xffffffffn },
    W15: { parent: "X15", off: 0, mask: 0xffffffffn },
    W16: { parent: "X16", off: 0, mask: 0xffffffffn },
    W17: { parent: "X17", off: 0, mask: 0xffffffffn },
    W18: { parent: "X18", off: 0, mask: 0xffffffffn },
    W19: { parent: "X19", off: 0, mask: 0xffffffffn },
    W20: { parent: "X20", off: 0, mask: 0xffffffffn },
    W21: { parent: "X21", off: 0, mask: 0xffffffffn },
    W22: { parent: "X22", off: 0, mask: 0xffffffffn },
    W23: { parent: "X23", off: 0, mask: 0xffffffffn },
    W24: { parent: "X24", off: 0, mask: 0xffffffffn },
    W25: { parent: "X25", off: 0, mask: 0xffffffffn },
    W26: { parent: "X26", off: 0, mask: 0xffffffffn },
    W27: { parent: "X27", off: 0, mask: 0xffffffffn },
    W28: { parent: "X28", off: 0, mask: 0xffffffffn },
    W29: { parent: "X29", off: 0, mask: 0xffffffffn },
    W30: { parent: "X30", off: 0, mask: 0xffffffffn },
    FP:  { parent: "X29", off: 0, mask: 0xffffffffffffffffn },
    LR:  { parent: "X30", off: 0, mask: 0xffffffffffffffffn },
};

const NZCV_BITS = [
    { name: "N", bit: 31 },
    { name: "Z", bit: 30 },
    { name: "C", bit: 29 },
    { name: "V", bit: 28 },
];

const LAYOUT = {
    bits: 64,
    ucMode: ["MODE_LITTLE_ENDIAN"],
    ksMode: ["MODE_LITTLE_ENDIAN"],
    csMode: ["MODE_LITTLE_ENDIAN"],
    pcName: "PC",
    spName: "SP",
    regSize: 8,
    groups: [
        { name: "General", regs: GP64 },
        { name: "Pointer", regs: ["SP", "PC"] },
        { name: "Vector", regs: SIMD, collapsed: true, size: 16 },
    ],
    flags: { reg: "NZCV", size: 4, bits: NZCV_BITS },
};

export default {
    key: "aarch64",
    label: "AArch64",
    prefix: "ARM64",
    ucArch: "ARCH_ARM64",
    ksArch: "ARCH_ARM64",
    csArch: "ARCH_ARM64",
    endian: "little",
    defaultMode: "64",
    modeOptions: [{ id: "64", label: "64-bit" }],
    // Same guest memory layout as the x86 profile: code (R-X), data scratch
    // (RW-), stack (RW-). Kept below 4 GiB so the fixed-width address rendering
    // in the views stays exact. stackTop is 16-byte aligned (SP alignment).
    maps: [
        { addr: 0x10000n, size: 0x10000n, perms: PROT.R | PROT.X, label: "code" },
        { addr: 0x20000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "data" },
        { addr: 0x70000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "stack" },
    ],
    codeBase: 0x10000n,
    stackTop: 0x7ff00n,
    elf: { machines: [EM.AARCH64], machineForMode: { "64": EM.AARCH64 } },
    // Branch classification patterns, matched against the disassembled text
    // ("mnemonic op_str", lowercase); see core/disassembler.js classify().
    branchInfo: {
        call: /^blr?(\s|$)/i,
        jump: /^(?:b(?:\.[a-z]+)?|br|cbn?z|tbn?z)(\s|$)/i,
        uncond: /^br?(\s|$)/i,
        ret: /^(?:ret|retaa|retab|eret)(\s|$)/i,
    },
    layoutFor() {
        return LAYOUT;
    },
    subRegsFor() {
        return SUBREGS;
    },
    examples,
};
