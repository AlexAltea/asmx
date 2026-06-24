/*
 * SPARC (big-endian) architecture profile (data-driven). Register names map to
 * Unicorn, Keystone and Capstone constants by convention in the worker/wrappers:
 *   uc['SPARC_REG_' + name], ks['MODE_' + m], cs['MODE_' + m].
 *
 * Two modes: 32-bit (V8) and 64-bit (V9), both big-endian only (matching the
 * Unicorn/Keystone builds). Branch delay slots are NOT auto-filled by Keystone
 * (unlike MIPS) so branches need an explicit trailing nop; `delaySlots` makes
 * the worker step a branch together with its slot (a lone stepped branch loses
 * its pending target on the next emu_start) and sizes call returns as call+8.
 *
 * Subroutines are NOT runnable on this stack: Keystone mis-encodes a direct
 * `call <addr>` (the disp30 fixup misses the /4 word scaling) and Unicorn
 * raises UC_ERR_EXCEPTION on the whole jmpl family (`jmp %reg`, `call %reg`,
 * `ret`, `retl`), so both call avenues and all returns fault. Direct Bicc
 * branches assemble and execute correctly; the call/ret classification below
 * is kept for listing display only. A conditional annulled-not-taken branch
 * (`b<cond>,a`) also faults in this Unicorn build regardless of stepping.
 *
 * Because SPARC delay slots are real source lines (unlike MIPS, where Keystone
 * folds the slot into the branch's 8-byte line), a breakpoint or manual PC set
 * can land inside a branch+slot pair; the worker backs such a start address up
 * to its branch (engine-worker.js resumeBegin) so the pending target is not
 * lost when execution resumes.
 */
import { PROT } from "../core/mem.js";
import { EM } from "../core/elf.js";
import examples from "./examples/sparc.js";

const GP = [
    "G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7",
    "O0", "O1", "O2", "O3", "O4", "O5", "O6", "O7",
    "L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7",
    "I0", "I1", "I2", "I3", "I4", "I5", "I6", "I7",
];

function layout(bits) {
    return {
        bits,
        ucMode: [bits === 64 ? "MODE_SPARC64" : "MODE_SPARC32", "MODE_BIG_ENDIAN"],
        ksMode: [bits === 64 ? "MODE_SPARC64" : "MODE_SPARC32", "MODE_BIG_ENDIAN"],
        csMode: bits === 64 ? ["MODE_BIG_ENDIAN", "MODE_V9"] : ["MODE_BIG_ENDIAN"],
        pcName: "PC",
        spName: "SP",
        regSize: bits / 8,
        groups: [
            { name: "General", regs: GP },
            // SP/FP alias O6/I6; shown under Pointer too so the stack view and
            // conditions have them by their common names.
            { name: "Pointer", regs: ["SP", "FP", "PC"] },
        ],
    };
}

export default {
    key: "sparc",
    label: "SPARC",
    prefix: "SPARC",
    ucArch: "ARCH_SPARC",
    ksArch: "ARCH_SPARC",
    csArch: "ARCH_SPARC",
    endian: "big",
    defaultMode: "32",
    delaySlots: true, // branch delay slots: call return = call + 8, step branches as a pair
    pcFixup: true, // 64-bit PC reads back stale after an `until` stop (see engine-worker.js)
    modeOptions: [
        { id: "32", label: "32-bit" },
        { id: "64", label: "64-bit" },
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
    elf: {
        machines: [EM.SPARC, EM.SPARCV9],
        machineForMode: { "32": EM.SPARC, "64": EM.SPARCV9 },
    },
    // Branch classification patterns, matched against the disassembled text
    // ("mnemonic op_str", lowercase); see core/disassembler.js classify().
    // Capstone prints `jmpl %i7+8, %g0` as "ret" and `jmp %o7+8` as "retl";
    // annulled branches carry a ",a" mnemonic suffix.
    branchInfo: {
        call: /^call(\s|$)/i,
        jump: /^(?:b[a-z]*(?:,a)?|jmp|jmpl)(\s|$)/i,
        uncond: /^(?:ba?(?:,a)?|jmp|jmpl)(\s|$)/i,
        ret: /^(?:ret|retl)(\s|$)/i,
    },
    layoutFor(modeId) {
        return layout(parseInt(modeId, 10));
    },
    subRegsFor() {
        return {};
    },
    examples,
};
