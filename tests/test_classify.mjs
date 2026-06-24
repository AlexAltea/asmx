/*
 * Validates branch classification (core/disassembler.js classify) against the
 * REAL Capstone build for every registered profile. Classification is driven by
 * the profile branchInfo patterns matched on disassembled text, NOT Capstone's
 * detail groups, which are broken in capstone-js 5.0.9 (the wrapper reads
 * cs_detail at v4 offsets, so detail.groups is always empty). This is the
 * regression net for the arrows gutter, step-over/step-out call/ret class map,
 * and the conditional/unconditional split.
 *
 * Run: node test_classify.mjs
 */
import { createRequire } from "module";
import { Disassembler } from "../src/core/disassembler.js";
import x86 from "../src/arch/x86.js";
import arm from "../src/arch/arm.js";
import aarch64 from "../src/arch/aarch64.js";

const require = createRequire(import.meta.url);
const MCapstone = require("@alexaltea/capstone-js");

let pass = 0,
    fail = 0;
const eq = (a, b, m) => (a === b ? pass++ : (fail++, console.error(`  ✗ ${m} (got ${a}, want ${b})`)));

MCapstone().then((cs) => {
    const d = new Disassembler(cs);

    // Each case: bytes at 0x10000 -> expected {kind, cond?, target?}. `kind` is
    // one of call|ret|jump|none; cond/target only checked when given.
    const check = (profile, modeId, cases) => {
        const L = profile.layoutFor(modeId);
        d.configure({ csArch: profile.csArch, csMode: L.csMode, branchInfo: profile.branchInfo });
        for (const c of cases) {
            const insn = d.one(c.bytes, 0x10000n);
            const label = `${profile.key}/${modeId} ${c.name}`;
            if (!insn) {
                fail++;
                console.error(`  ✗ ${label}: undecodable`);
                continue;
            }
            const r = d.classify(insn);
            const kind = r.isCall ? "call" : r.isRet ? "ret" : r.isJump ? "jump" : "none";
            eq(kind, c.kind, `${label}: kind`);
            if (c.cond != null) eq(r.isCond, c.cond, `${label}: isCond`);
            if (c.target !== undefined) eq(r.target, c.target, `${label}: target`);
        }
    };

    check(x86, "64", [
        { name: "call rel32", bytes: [0xe8, 0x10, 0x00, 0x00, 0x00], kind: "call", target: 0x10015n },
        { name: "call rax", bytes: [0xff, 0xd0], kind: "call", target: null },
        { name: "ret", bytes: [0xc3], kind: "ret" },
        { name: "jne", bytes: [0x75, 0x10], kind: "jump", cond: true, target: 0x10012n },
        { name: "jmp rel32", bytes: [0xe9, 0x0f, 0x00, 0x00, 0x00], kind: "jump", cond: false, target: 0x10014n },
        { name: "jmp rax", bytes: [0xff, 0xe0], kind: "jump", cond: false, target: null },
        { name: "mov", bytes: [0x48, 0xc7, 0xc0, 0x05, 0x00, 0x00, 0x00], kind: "none" },
    ]);

    check(arm, "arm", [
        { name: "bl", bytes: [0x02, 0x00, 0x00, 0xeb], kind: "call", target: 0x10010n },
        { name: "blne", bytes: [0x02, 0x00, 0x00, 0x1b], kind: "call" },
        { name: "blx r3", bytes: [0x33, 0xff, 0x2f, 0xe1], kind: "call", target: null },
        { name: "bx lr", bytes: [0x1e, 0xff, 0x2f, 0xe1], kind: "ret" },
        { name: "bxne lr", bytes: [0x1e, 0xff, 0x2f, 0x11], kind: "ret" },
        { name: "pop {pc}", bytes: [0x04, 0xf0, 0x9d, 0xe4], kind: "ret" },
        { name: "popeq {r4,pc}", bytes: [0x10, 0x80, 0xbd, 0x08], kind: "ret" },
        { name: "b", bytes: [0x02, 0x00, 0x00, 0xea], kind: "jump", cond: false, target: 0x10010n },
        { name: "bne", bytes: [0x02, 0x00, 0x00, 0x1a], kind: "jump", cond: true, target: 0x10010n },
        { name: "bx r3", bytes: [0x13, 0xff, 0x2f, 0xe1], kind: "jump", cond: false, target: null },
        { name: "ble (b + cond, not bl)", bytes: [0x02, 0x00, 0x00, 0xda], kind: "jump", cond: true },
        { name: "mov", bytes: [0x05, 0x00, 0xa0, 0xe3], kind: "none" },
        { name: "bic (not a branch)", bytes: [0x01, 0x20, 0xc3, 0xe3], kind: "none" },
    ]);

    check(arm, "thumb", [
        { name: "bl", bytes: [0x00, 0xf0, 0x06, 0xf8], kind: "call", target: 0x10010n },
        { name: "bx lr", bytes: [0x70, 0x47], kind: "ret" },
        { name: "pop {r4,pc}", bytes: [0x10, 0xbd], kind: "ret" },
        { name: "pop.w {r4,pc}", bytes: [0xbd, 0xe8, 0x10, 0x80], kind: "ret" },
        { name: "b (narrow)", bytes: [0x06, 0xe0], kind: "jump", cond: false },
        { name: "bne (narrow)", bytes: [0x06, 0xd1], kind: "jump", cond: true },
        { name: "b.w", bytes: [0xff, 0xf7, 0xfe, 0xbf], kind: "jump", cond: false },
        { name: "beq.w", bytes: [0x3f, 0xf4, 0xfe, 0xaf], kind: "jump", cond: true },
        { name: "cbz", bytes: [0x18, 0xb1], kind: "jump", cond: true },
        { name: "movs", bytes: [0x05, 0x20], kind: "none" },
    ]);

    check(aarch64, "64", [
        { name: "bl", bytes: [0x04, 0x00, 0x00, 0x94], kind: "call", target: 0x10010n },
        { name: "blr x0", bytes: [0x00, 0x00, 0x3f, 0xd6], kind: "call", target: null },
        { name: "ret", bytes: [0xc0, 0x03, 0x5f, 0xd6], kind: "ret" },
        { name: "b", bytes: [0x04, 0x00, 0x00, 0x14], kind: "jump", cond: false, target: 0x10010n },
        { name: "b.ne", bytes: [0x61, 0x00, 0x00, 0x54], kind: "jump", cond: true, target: 0x1000cn },
        { name: "br x0", bytes: [0x00, 0x00, 0x1f, 0xd6], kind: "jump", cond: false, target: null },
        { name: "cbz", bytes: [0x60, 0x00, 0x00, 0xb4], kind: "jump", cond: true, target: 0x1000cn },
        // tbz's target is the LAST operand ("x0, #0x3e, #0xfffc"); regression
        // net for the trailing-operand target extraction.
        { name: "tbz", bytes: [0xe0, 0xff, 0xf7, 0xb6], kind: "jump", cond: true, target: 0xfffcn },
        { name: "mov", bytes: [0xa0, 0x00, 0x80, 0xd2], kind: "none" },
    ]);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
});
