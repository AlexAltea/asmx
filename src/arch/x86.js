/*
 * x86 architecture profile (data-driven). Register/flag names map to Unicorn,
 * Keystone and Capstone constants by convention in the worker/wrappers:
 *   uc['X86_REG_' + name], ks['MODE_' + m], cs['MODE_' + m].
 */
import { PROT } from "../core/mem.js";
import { EM } from "../core/elf.js";
import examples from "./examples/x86.js";

// General-purpose registers per width, shown as one "General" group (RAX..RSP
// then the R8..R15 extended set in 64-bit).
const GP64 = ["RAX", "RBX", "RCX", "RDX", "RSI", "RDI", "RBP", "RSP", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15"];
const GP32 = ["EAX", "EBX", "ECX", "EDX", "ESI", "EDI", "EBP", "ESP"];
const SEG = ["CS", "DS", "ES", "FS", "GS", "SS"];
const XMM = ["XMM0", "XMM1", "XMM2", "XMM3", "XMM4", "XMM5", "XMM6", "XMM7", "XMM8", "XMM9", "XMM10", "XMM11", "XMM12", "XMM13", "XMM14", "XMM15"];

// Subregisters
const SUBREGS_64 = {
    /* 32-bit subregisters */
    EAX:  { parent: "RAX", off: 0, mask: 0xffffffffn },
    EBX:  { parent: "RBX", off: 0, mask: 0xffffffffn },
    ECX:  { parent: "RCX", off: 0, mask: 0xffffffffn },
    EDX:  { parent: "RDX", off: 0, mask: 0xffffffffn },
    ESI:  { parent: "RSI", off: 0, mask: 0xffffffffn },
    EDI:  { parent: "RDI", off: 0, mask: 0xffffffffn },
    EBP:  { parent: "RBP", off: 0, mask: 0xffffffffn },
    ESP:  { parent: "RSP", off: 0, mask: 0xffffffffn },
    R8D:  { parent: "R8",  off: 0, mask: 0xffffffffn },
    R9D:  { parent: "R9",  off: 0, mask: 0xffffffffn },
    R10D: { parent: "R10", off: 0, mask: 0xffffffffn },
    R11D: { parent: "R11", off: 0, mask: 0xffffffffn },
    R12D: { parent: "R12", off: 0, mask: 0xffffffffn },
    R13D: { parent: "R13", off: 0, mask: 0xffffffffn },
    R14D: { parent: "R14", off: 0, mask: 0xffffffffn },
    R15D: { parent: "R15", off: 0, mask: 0xffffffffn },
    /* 16-bit subregisters */
    AX:   { parent: "RAX", off: 0, mask: 0xffffn },
    BX:   { parent: "RBX", off: 0, mask: 0xffffn },
    CX:   { parent: "RCX", off: 0, mask: 0xffffn },
    DX:   { parent: "RDX", off: 0, mask: 0xffffn },
    SI:   { parent: "RSI", off: 0, mask: 0xffffn },
    DI:   { parent: "RDI", off: 0, mask: 0xffffn },
    BP:   { parent: "RBP", off: 0, mask: 0xffffn },
    SP:   { parent: "RSP", off: 0, mask: 0xffffn },
    R8W:  { parent: "R8",  off: 0, mask: 0xffffn },
    R9W:  { parent: "R9",  off: 0, mask: 0xffffn },
    R10W: { parent: "R10", off: 0, mask: 0xffffn },
    R11W: { parent: "R11", off: 0, mask: 0xffffn },
    R12W: { parent: "R12", off: 0, mask: 0xffffn },
    R13W: { parent: "R13", off: 0, mask: 0xffffn },
    R14W: { parent: "R14", off: 0, mask: 0xffffn },
    R15W: { parent: "R15", off: 0, mask: 0xffffn },
    /* 8-bit subregisters (high) */
    AH:   { parent: "RAX", off: 8, mask: 0xffn },
    BH:   { parent: "RBX", off: 8, mask: 0xffn },
    CH:   { parent: "RCX", off: 8, mask: 0xffn },
    DH:   { parent: "RDX", off: 8, mask: 0xffn },
    /* 8-bit subregisters (low) */
    AL:   { parent: "RAX", off: 0, mask: 0xffn },
    BL:   { parent: "RBX", off: 0, mask: 0xffn },
    CL:   { parent: "RCX", off: 0, mask: 0xffn },
    DL:   { parent: "RDX", off: 0, mask: 0xffn },
    SIL:  { parent: "RSI", off: 0, mask: 0xffn },
    DIL:  { parent: "RDI", off: 0, mask: 0xffn },
    BPL:  { parent: "RBP", off: 0, mask: 0xffn },
    SPL:  { parent: "RSP", off: 0, mask: 0xffn },
    R8B:  { parent: "R8",  off: 0, mask: 0xffn },
    R9B:  { parent: "R9",  off: 0, mask: 0xffn },
    R10B: { parent: "R10", off: 0, mask: 0xffn },
    R11B: { parent: "R11", off: 0, mask: 0xffn },
    R12B: { parent: "R12", off: 0, mask: 0xffn },
    R13B: { parent: "R13", off: 0, mask: 0xffn },
    R14B: { parent: "R14", off: 0, mask: 0xffn },
    R15B: { parent: "R15", off: 0, mask: 0xffn },
};

const SUBREGS_32 = {
    /* 16-bit subregisters */
    AX:   { parent: "EAX", off: 0, mask: 0xffffn },
    BX:   { parent: "EBX", off: 0, mask: 0xffffn },
    CX:   { parent: "ECX", off: 0, mask: 0xffffn },
    DX:   { parent: "EDX", off: 0, mask: 0xffffn },
    SI:   { parent: "ESI", off: 0, mask: 0xffffn },
    DI:   { parent: "EDI", off: 0, mask: 0xffffn },
    BP:   { parent: "EBP", off: 0, mask: 0xffffn },
    SP:   { parent: "ESP", off: 0, mask: 0xffffn },
    /* 8-bit subregisters (high) */
    AH:   { parent: "EAX", off: 8, mask: 0xffn },
    BH:   { parent: "EBX", off: 8, mask: 0xffn },
    CH:   { parent: "ECX", off: 8, mask: 0xffn },
    DH:   { parent: "EDX", off: 8, mask: 0xffn },
    /* 8-bit subregisters (low) */
    AL:   { parent: "EAX", off: 0, mask: 0xffn },
    BL:   { parent: "EBX", off: 0, mask: 0xffn },
    CL:   { parent: "ECX", off: 0, mask: 0xffn },
    DL:   { parent: "EDX", off: 0, mask: 0xffn },
    SIL:  { parent: "ESI", off: 0, mask: 0xffn },
    DIL:  { parent: "EDI", off: 0, mask: 0xffn },
    BPL:  { parent: "EBP", off: 0, mask: 0xffn },
    SPL:  { parent: "ESP", off: 0, mask: 0xffn },
};

const EFLAGS_BITS = [
    { name: "CF", bit: 0 },
    { name: "PF", bit: 2 },
    { name: "AF", bit: 4 },
    { name: "ZF", bit: 6 },
    { name: "SF", bit: 7 },
    { name: "TF", bit: 8 },
    { name: "IF", bit: 9 },
    { name: "DF", bit: 10 },
    { name: "OF", bit: 11 },
];

function layout(bits) {
    if (bits === 64) {
        return {
            bits: 64,
            ucMode: ["MODE_64"],
            ksMode: ["MODE_64"],
            csMode: ["MODE_64"],
            pcName: "RIP",
            spName: "RSP",
            regSize: 8,
            groups: [
                { name: "General", regs: GP64 },
                { name: "Pointer", regs: ["RIP"] },
                { name: "Segment", regs: SEG, collapsed: true, size: 2 },
                { name: "Vector", regs: XMM, collapsed: true, size: 16 },
            ],
            flags: { reg: "EFLAGS", size: 8, bits: EFLAGS_BITS },
        };
    }
    // 32-bit, the only other mode offered (see modeOptions).
    return {
        bits: 32,
        ucMode: ["MODE_32"],
        ksMode: ["MODE_32"],
        csMode: ["MODE_32"],
        pcName: "EIP",
        spName: "ESP",
        regSize: 4,
        groups: [
            { name: "General", regs: GP32 },
            { name: "Pointer", regs: ["EIP"] },
            { name: "Segment", regs: SEG, collapsed: true, size: 2 },
            { name: "Vector", regs: XMM, collapsed: true, size: 16 },
        ],
        flags: { reg: "EFLAGS", size: 4, bits: EFLAGS_BITS },
    };
}

export default {
    key: "x86",
    label: "x86",
    prefix: "X86",
    ucArch: "ARCH_X86",
    ksArch: "ARCH_X86",
    ksSyntax: "OPT_SYNTAX_INTEL", // in-app default; non-x86 arches reject syntax options
    csArch: "ARCH_X86",
    endian: "little",
    defaultMode: "64",
    // Exposes the two flat modes; 16-bit real-mode segmented addressing doesn't
    // fit the flat memory map used here, so it isn't offered.
    modeOptions: [
        { id: "64", label: "64-bit" },
        { id: "32", label: "32-bit" },
    ],
    // Default guest memory map: an executable code region (R-X), a writable data
    // scratch region (RW-), and the stack (RW-). Perms are a PROT bitmask the
    // Memory Maps panel can toggle live (see core/mem.js + ui/maps.js).
    maps: [
        { addr: 0x10000n, size: 0x10000n, perms: PROT.R | PROT.X, label: "code" },
        { addr: 0x20000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "data" },
        { addr: 0x70000n, size: 0x10000n, perms: PROT.R | PROT.W, label: "stack" },
    ],
    codeBase: 0x10000n,
    stackTop: 0x7ff00n,
    // ELF identity: e_machine values claimed on load, and the machine emitted per
    // mode on save. Class/endianness come from the bit width + `endian` (see
    // arch/index.js).
    elf: { machines: [EM["386"], EM.X86_64], machineForMode: { "32": EM["386"], "64": EM.X86_64 } },
    // Branch classification patterns, matched against the disassembled text
    // ("mnemonic op_str", lowercase); see core/disassembler.js classify().
    // They drive the arrows gutter, the call/ret class map behind step-over/
    // step-out, and the conditional/unconditional split.
    branchInfo: {
        call: /^(?:call|lcall)(\s|$)/i,
        jump: /^(?:jmp|ljmp|j[a-z]+|loop(?:e|ne)?|jcxz|jecxz|jrcxz)(\s|$)/i,
        uncond: /^(?:jmp|ljmp)(\s|$)/i,
        ret: /^(?:ret[fn]?|iret[dq]?)(\s|$)/i,
    },
    layoutFor(modeId) {
        return layout(parseInt(modeId, 10));
    },
    subRegsFor(modeId) {
        return parseInt(modeId, 10) === 64 ? SUBREGS_64 : SUBREGS_32;
    },
    examples,
};
