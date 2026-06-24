/*
 * MIPS architecture profile (data-driven). Register/flag names map to Unicorn,
 * Keystone and Capstone constants by convention in the worker/wrappers:
 *   uc['MIPS_REG_' + name], ks['MODE_' + m], cs['MODE_' + m].
 *
 * Four modes: MIPS32/MIPS64, each big- or little-endian (layout `endian`
 * overrides the profile default; an ELF's EI_DATA picks the mode back on load).
 * Branch delay slots: Keystone auto-fills the slot with a nop, so one branch
 * line assembles to 8 bytes; Unicorn executes a branch and its delay slot
 * atomically under an instruction-count budget, and reads PC back stale after
 * an `until` stop, hence `delaySlots` + `pcFixup` (see engine-worker.js).
 *
 * 32-bit modes display o32 ABI names, matching Keystone input and Capstone
 * output. 64-bit modes display numeric R0..R31 instead (via `ucReg`): the n64
 * ABI renames $8-$15 (a4-a7/t0-t3), so Keystone (n64 names in) and Capstone
 * (o32 names out) disagree there and numeric names are the only unambiguous
 * ones. HI/LO hold the multiply/divide result pair (mult/div, read via
 * mfhi/mflo).
 */
import { PROT } from "../core/mem.js";
import { EM } from "../core/elf.js";
import examples from "./examples/mips.js";

const GP32 = [
    "ZERO", "AT", "V0", "V1", "A0", "A1", "A2", "A3",
    "T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7",
    "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7",
    "T8", "T9", "K0", "K1",
];
// $28-$31 keep their names (GP/SP/FP/RA) in every ABI, so the Pointer group
// shows those; only $0-$27 need the ABI-neutral numeric names in 64-bit modes.
const GP64 = Array.from({ length: 28 }, (_, i) => `R${i}`);

function layout(modeId) {
    const bits = modeId.startsWith("64") ? 64 : 32;
    const little = modeId.endsWith("le");
    const regSize = bits / 8;
    return {
        bits,
        endian: little ? "little" : "big",
        ucMode: [bits === 64 ? "MODE_MIPS64" : "MODE_MIPS32", ...(little ? [] : ["MODE_BIG_ENDIAN"])],
        ksMode: [bits === 64 ? "MODE_MIPS64" : "MODE_MIPS32", ...(little ? [] : ["MODE_BIG_ENDIAN"])],
        csMode: [bits === 64 ? "MODE_MIPS64" : "MODE_MIPS32", ...(little ? [] : ["MODE_BIG_ENDIAN"])],
        pcName: "PC",
        spName: "SP",
        regSize,
        groups: [
            { name: "General", regs: bits === 64 ? GP64 : GP32 },
            { name: "Pointer", regs: ["GP", "SP", "FP", "RA", "PC"] },
            { name: "Mult", regs: ["HI", "LO"], collapsed: true },
        ],
    };
}

export default {
    key: "mips",
    label: "MIPS",
    prefix: "MIPS",
    ucArch: "ARCH_MIPS",
    ksArch: "ARCH_MIPS",
    csArch: "ARCH_MIPS",
    endian: "big",
    defaultMode: "32",
    delaySlots: true, // branch delay slots: call return = call + 8, step branches as a pair
    pcFixup: true, // PC reads back stale after an `until` stop (see engine-worker.js)
    modeOptions: [
        { id: "32", label: "32-bit BE" },
        { id: "32le", label: "32-bit LE" },
        { id: "64", label: "64-bit BE" },
        { id: "64le", label: "64-bit LE" },
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
    // All four modes share EM_MIPS; class picks the bit width and EI_DATA the
    // endianness on load (see archForElf).
    elf: {
        machines: [EM.MIPS],
        machineForMode: { "32": EM.MIPS, "32le": EM.MIPS, "64": EM.MIPS, "64le": EM.MIPS },
    },
    // Branch classification patterns, matched against the disassembled text
    // ("mnemonic op_str", lowercase); see core/disassembler.js classify().
    // Precedence (ret > call > jump) keeps the link forms out of the broad b*/j*
    // sets. bgezall/bltzall are the branch-likely-and-link twins of bgezal/
    // bltzal, and jalx the ISA-switch call; all write $ra. bc1t/bc1f (FP
    // condition branches, and their likely bc1tl/bc1fl) are conditional jumps
    // the alpha-only b[a-z]* pattern cannot reach across the digit.
    branchInfo: {
        call: /^(?:jalx?|jalr|bal|bgezall?|bltzall?)(\s|$)/i,
        jump: /^(?:bc1[tf]l?|b[a-z]*|j|jr)(\s|$)/i,
        uncond: /^(?:b|j|jr)(\s|$)/i,
        ret: /^jr\s+\$ra$/i,
    },
    // 64-bit display names R0..R31 -> numeric Unicorn constants (MIPS_REG_12).
    ucReg(name) {
        const m = /^R(\d+)$/.exec(name);
        return m ? m[1] : undefined;
    },
    layoutFor(modeId) {
        return layout(modeId);
    },
    subRegsFor() {
        return {};
    },
    examples,
};
