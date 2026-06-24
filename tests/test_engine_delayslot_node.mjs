/*
 * Delay-slot + stale-PC semantics for the MIPS/SPARC profiles, against the REAL
 * Unicorn/Keystone builds. Mirrors the worker's compensation rules
 * (engine-worker.js pcFixup/delaySlots):
 *   - run-to-until: PC reads back as the last executed instruction, so a clean
 *     stop that did not exhaust the instruction budget means PC := until;
 *   - a tight loop exhausts the budget and must NOT be teleported to the end;
 *   - single-step: a stepped straight-line instruction whose PC reads back
 *     unchanged ran into `until`;
 *   - SPARC branches lose their pending target if stepped alone (count=1) and
 *     take it when stepped with their delay slot (count=2);
 *   - step-over/shadow return addresses are call + 8 (past the delay slot).
 *
 * Run: node test_engine_delayslot_node.mjs
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const MKeystone = require("@alexaltea/keystone-js");

let pass = 0,
    fail = 0;
const ok = (cond, m) => (cond ? pass++ : (fail++, console.error(`  ✗ ${m}`)));

const CODE = 0x10000n;
const toBytes = (v, n) => Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
const fromLE = (b) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };

async function assemble(ksArch, ksModes, lines) {
    const ks = await MKeystone();
    let mode = 0;
    for (const m of ksModes) mode |= ks[m];
    const k = new ks.Keystone(ks[ksArch], mode);
    const image = [];
    let addr = CODE;
    for (const line of lines) {
        const r = k.asm(line, addr);
        if (!r || !r.mc || !r.mc.length) throw new Error(`assemble failed: ${line}`);
        image.push(...r.mc);
        addr += BigInt(r.mc.length);
    }
    k.close();
    return { image, end: addr };
}

/** Fresh engine with the standard code/data/stack maps and the image loaded. */
function boot(uc, ucArch, ucModes, image) {
    let mode = 0;
    for (const m of ucModes) mode |= uc[m] || 0;
    const e = new uc.Unicorn(uc[ucArch], mode);
    e.mem_map(CODE, 0x10000n, 5);
    e.mem_map(0x20000n, 0x10000n, 3);
    e.mem_map(0x70000n, 0x10000n, 3);
    e.mem_write(CODE, Uint8Array.from(image));
    return e;
}

// These two helpers faithfully mirror engine-worker.js's chunkedRun / stepInCore
// stale-PC rules (readPC === lastHookPc means we reached `until`; a step skips a
// breakpoint sitting on the stepped line). They must be kept in step with the
// worker; the assertions below pin concrete PC/register values a wrong rule
// would violate, which is what makes them regression tests rather than tautologies.
const HOOK_CODE = 4; // uc.HOOK_CODE

/** Mirror chunkedRun: run to `end` in CHUNK-sized budgets applying the stale-PC rule. */
function runToEndMirror(e, pcId, regSize, end, CHUNK, maxIters = 10) {
    const rd = () => { const b = Uint8Array.from(e.reg_read(pcId, regSize)); let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
    let lastHookPc = -1n;
    e.hook_add(HOOK_CODE, (h, a) => { lastHookPc = BigInt(a); }, {}, 1n, 0n);
    let pc = CODE;
    let iters = 0;
    for (; iters < maxIters && pc < end; iters++) {
        lastHookPc = -1n;
        e.emu_start(pc, end, 0, CHUNK);
        pc = rd();
        if (pc < end && pc === lastHookPc) pc = end; // the stale-PC rule
    }
    return { pc, iters };
}

/** Mirror stepInCore (non-branch, single instruction): skip a breakpoint on the
 *  stepped line, then apply the stale-PC rule. */
function stepMirror(e, pcId, regSize, from, until, bpSet) {
    const rd = () => { const b = Uint8Array.from(e.reg_read(pcId, regSize)); let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
    const begin = BigInt(from);
    let hitBp = null, lastHookPc = -1n, resumeFrom = begin;
    const h = e.hook_add(HOOK_CODE, (hh, a) => {
        const pc = BigInt(a);
        if (pc !== resumeFrom && bpSet.has(pc)) { hitBp = pc; e.emu_stop(); return; }
        if (pc === resumeFrom) resumeFrom = -1n;
        lastHookPc = pc;
    }, {}, 1n, 0n);
    e.emu_start(begin, BigInt(until), 0, 1);
    e.hook_del(h);
    let pc = rd();
    if (hitBp == null && pc < BigInt(until) && pc === lastHookPc) pc = BigInt(until); // stale-PC fixup
    return { pc, hitBp };
}

// ---- MIPS32: run-to-end exits at end; tight loop is not teleported --------
{
    const uc = await require("@alexaltea/unicorn-js")();
    const M = ["MODE_MIPS32", "MODE_BIG_ENDIAN"];
    const { image, end } = await assemble("ARCH_MIPS", M, [
        "ori $t0, $zero, 0",
        "ori $t1, $zero, 5",
        "addu $t0, $t0, $t1",
        "addiu $t1, $t1, -1",
        "bne $t1, $zero, 0x10008", // 8 bytes: Keystone fills the delay slot
        "nop",
    ]);

    // The normal loop exits in one chunk via the stale-PC rule.
    const e = boot(uc, "ARCH_MIPS", M, image);
    const r = runToEndMirror(e, uc.MIPS_REG_PC, 4, end, 1000);
    ok(r.pc === end && r.iters === 1, `mips: run reaches end in one chunk (pc 0x${r.pc.toString(16)}, iters ${r.iters})`);
    ok(fromLE(Uint8Array.from(e.reg_read(uc.MIPS_REG_T0, 4))) === 15n, "mips: loop summed 5..1 correctly");
    e.close();

    // Tight loop ("b ." with its delay slot): the stale PC stays IN the loop and
    // is never teleported to end (a wrong rule that always teleports would fail
    // this by reporting pc === end).
    const tight = await assemble("ARCH_MIPS", M, ["b 0x10000"]);
    const e2 = boot(uc, "ARCH_MIPS", M, tight.image);
    const rt = runToEndMirror(e2, uc.MIPS_REG_PC, 4, tight.end, 1000, 3);
    ok(rt.pc < tight.end && rt.pc >= CODE, `mips: tight loop is NOT teleported to end (pc 0x${rt.pc.toString(16)})`);
    e2.close();

    // Chunk-boundary coincidence (the finding-3 regression): a program that
    // reaches `end` on exactly the CHUNK-th executed instruction. The OLD rule
    // (skip the fixup when hookCount === CHUNK) left PC stale and re-executed the
    // final instruction on the next chunk, double-incrementing $t3. The stale-PC
    // rule (readPC === lastHookPc) teleports to end and increments it once.
    {
        // Executed count = 3 setup + 3*N loop (addiu + bne + auto-nop) + 1 tail.
        // Tune N so the total is exactly CHUNK, i.e. the tail is the CHUNK-th insn.
        const CH = 1000;
        const N = (CH - 4) / 3; // 3N + 4 == CH
        ok(Number.isInteger(N), `mips: coincidence trip count is integral (N=${N})`);
        const co = await assemble("ARCH_MIPS", M, [
            "ori $t3, $zero, 0", // 0x10000
            "ori $t4, $zero, 0", // 0x10004
            "ori $t5, $zero, " + N, // 0x10008 counter
            "addiu $t5, $t5, -1", // 0x1000c loop top
            "bne $t5, $zero, 0x1000c", // 0x10010, 8 bytes (branch + auto nop) = 2 insns/iter
            "addiu $t3, $t3, 1", // 0x10018 tail: must run exactly once
        ]);
        const ec = boot(uc, "ARCH_MIPS", M, co.image);
        const rc = runToEndMirror(ec, uc.MIPS_REG_PC, 4, co.end, CH);
        ok(rc.pc === co.end, `mips: coincidence run exits at end (pc 0x${rc.pc.toString(16)})`);
        ok(fromLE(Uint8Array.from(ec.reg_read(uc.MIPS_REG_T3, 4))) === 1n, "mips: final instruction ran exactly once (no chunk-boundary double-exec)");
        ec.close();
    }

    // Step + breakpoint on the stepped line (the finding-1 regression): the step
    // must skip the breakpoint under the cursor and EXECUTE the instruction, not
    // teleport PC to `end`. The OLD rule stopped before executing and, seeing
    // readPC === begin, teleported to end with the instruction never run.
    {
        const lin = await assemble("ARCH_MIPS", M, ["ori $t6, $zero, 7", "ori $t7, $zero, 9"]);
        const es = boot(uc, "ARCH_MIPS", M, lin.image);
        const s = stepMirror(es, uc.MIPS_REG_PC, 4, CODE, lin.end, new Set([CODE])); // breakpoint ON the stepped line
        ok(s.pc === CODE + 4n, `mips: step past a breakpointed line advances one insn (pc 0x${s.pc.toString(16)})`);
        ok(fromLE(Uint8Array.from(es.reg_read(uc.MIPS_REG_T6, 4))) === 7n, "mips: the stepped (breakpointed) instruction actually executed");
        es.close();
    }

    // A single step that runs into `end` reads PC back stale and the rule
    // resolves it to `until`.
    {
        const lin = await assemble("ARCH_MIPS", M, ["ori $t0, $zero, 1", "ori $t1, $zero, 2"]);
        const es = boot(uc, "ARCH_MIPS", M, lin.image);
        const s1 = stepMirror(es, uc.MIPS_REG_PC, 4, CODE, lin.end, new Set());
        ok(s1.pc === CODE + 4n, "mips: mid-code step lands on the next instruction");
        const s2 = stepMirror(es, uc.MIPS_REG_PC, 4, s1.pc, lin.end, new Set());
        ok(s2.pc === lin.end, `mips: step of the final instruction resolves to end (pc 0x${s2.pc.toString(16)})`);
        es.close();
    }
}

/** Mirror stepInCore's fenced branch step: run the branch and its delay slot,
 *  stopping at the first instruction outside the {begin, slot} pair. */
function fenceStepMirror(e, pcId, regSize, begin, until, cap = 4) {
    const rd = () => { const b = Uint8Array.from(e.reg_read(pcId, regSize)); let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
    const slot = begin + 4n;
    const h = e.hook_add(HOOK_CODE, (hh, a) => {
        const pc = BigInt(a);
        if (pc !== begin && pc !== slot) e.emu_stop();
    }, {}, 1n, 0n);
    e.emu_start(begin, BigInt(until), 0, cap);
    e.hook_del(h);
    return rd();
}

// ---- SPARC32: fenced branch stepping (delay slot + annulled slot) ----------
{
    const uc = await require("@alexaltea/unicorn-js")();
    const M = ["MODE_SPARC32", "MODE_BIG_ENDIAN"];

    // Taken branch: the pending target survives because branch+slot run under one
    // emu_start (count-stepping the branch alone would drop it), landing on the
    // target with the fall-through code skipped.
    {
        const { image, end } = await assemble("ARCH_SPARC", M, ["ba 0x10010", "nop", "mov 2, %g2", "nop", "mov 3, %g3"]);
        const e = boot(uc, "ARCH_SPARC", M, image);
        const pc = fenceStepMirror(e, uc.SPARC_REG_PC, 4, CODE, end);
        ok(pc === 0x10010n, `sparc: fenced branch step lands on the target (pc 0x${pc.toString(16)})`);
        ok(fromLE(Uint8Array.from(e.reg_read(uc.SPARC_REG_G2, 4))) === 0n, "sparc: fenced branch step skipped the fall-through code");
        e.close();
    }

    // Annulled branch (the finding-4 regression): `ba,a` squashes its delay slot,
    // which consumes NO count unit, so a fixed count=2 would execute the branch
    // TARGET too (overshoot). The fence stops at the target before it runs, so
    // g3 (set by the instruction AFTER the target) stays 0.
    {
        const { image, end } = await assemble("ARCH_SPARC", M, ["ba,a 0x10010", "nop", "mov 2, %g2", "nop", "mov 3, %g3"]);
        const e = boot(uc, "ARCH_SPARC", M, image);
        const pc = fenceStepMirror(e, uc.SPARC_REG_PC, 4, CODE, end);
        ok(pc === 0x10010n, `sparc: annulled (ba,a) branch step lands on the target, no overshoot (pc 0x${pc.toString(16)})`);
        ok(fromLE(Uint8Array.from(e.reg_read(uc.SPARC_REG_G3, 4))) === 0n, "sparc: annulled branch step did not execute past the target");
        e.close();
    }
}

// ---- SPARC64: `until` never stops; the final insn respins ------------------
// Unicorn SPARC64 runs past `until` and re-executes the LAST instruction until
// the count budget is exhausted (side effects repeat). The worker detects the
// respin in its gate hook: the same non-branch address firing twice in a row
// cannot happen in real execution, so it stops before the re-execution.
{
    const uc = await require("@alexaltea/unicorn-js")();
    const M = ["MODE_SPARC64", "MODE_BIG_ENDIAN"];
    // g6 counts executions of the FINAL instruction: it must end up exactly 1.
    const { image, end } = await assemble("ARCH_SPARC", M, [
        "mov 0, %g2",
        "mov 3, %g4",
        "add %g2, 1, %g2",
        "subcc %g4, 1, %g4",
        "bne 0x10008",
        "nop",
        "add %g6, 1, %g6",
    ]);
    const e = boot(uc, "ARCH_SPARC", M, image);
    const CHUNK = 2000;
    let hookCount = 0;
    let last = -1n;
    e.hook_add(uc.HOOK_CODE, (h, addr) => {
        hookCount++;
        const pc = BigInt(addr);
        if (pc === last) {
            e.emu_stop();
            return;
        }
        last = pc;
    }, {}, 1n, 0n);
    let pc = CODE;
    let iters = 0;
    for (; iters < 10 && pc < end; iters++) {
        hookCount = 0;
        last = -1n;
        e.emu_start(pc, end, 0, CHUNK);
        pc = fromLE(Uint8Array.from(e.reg_read(uc.SPARC_REG_PC, 8)));
        if (pc < end && hookCount < CHUNK) pc = end;
    }
    ok(pc === end && iters === 1, `sparc64: run exits at end in one chunk despite the until-respin (pc 0x${pc.toString(16)}, iters ${iters})`);
    ok(fromLE(Uint8Array.from(e.reg_read(uc.SPARC_REG_G6, 8))) === 1n, "sparc64: the final instruction executed exactly once");
    ok(fromLE(Uint8Array.from(e.reg_read(uc.SPARC_REG_G2, 8))) === 3n, "sparc64: loop body ran the expected 3 times");
    e.close();
}

// ---- SPARC: the jmpl family faults (documents WHY subroutines are off) ----
{
    const uc = await require("@alexaltea/unicorn-js")();
    const M = ["MODE_SPARC32", "MODE_BIG_ENDIAN"];
    const { image, end } = await assemble("ARCH_SPARC", M, ["set 0x10010, %g1", "jmp %g1", "nop", "nop", "mov 7, %g3"]);
    const e = boot(uc, "ARCH_SPARC", M, image);
    let threw = false;
    try {
        e.emu_start(CODE, end, 0, 20);
    } catch {
        threw = true;
    }
    ok(threw, "sparc: jmpl-family transfers fault in this Unicorn build (profile keeps subroutines out)");
    e.close();
}

// ---- MIPS32: jal returns past the delay slot (call + 8); step-over --------
{
    const uc = await require("@alexaltea/unicorn-js")();
    const M = ["MODE_MIPS32", "MODE_BIG_ENDIAN"];
    const { image, end } = await assemble("ARCH_MIPS", M, [
        "ori $a0, $zero, 5", // 0x10000
        "jal 0x10020",       // 0x10004 (8 bytes: jal + auto delay nop) -> ra = 0x1000c
        "ori $t1, $v0, 0",   // 0x1000c  <- step-over target (call + 8)
        "b 0x10030",         // 0x10010 (8 bytes) hop over the callee to the end
        "nop",               // 0x10018
        "nop",               // 0x1001c
        "mult $a0, $a0",     // 0x10020  callee
        "mflo $v0",          // 0x10024
        "jr $ra",            // 0x10028 (8 bytes: jr + auto delay nop)
    ]);
    ok(end === 0x10030n, `mips: layout as annotated (end 0x${end.toString(16)})`);

    // Whole run: through the call and back, exits at end (with the pcFixup rule).
    const e = boot(uc, "ARCH_MIPS", M, image);
    let hookCount = 0;
    e.hook_add(uc.HOOK_CODE, () => { hookCount++; }, {}, 1n, 0n);
    let pc = CODE;
    for (let i = 0; i < 10 && pc < end; i++) {
        hookCount = 0;
        e.emu_start(pc, end, 0, 1000);
        pc = fromLE(Uint8Array.from(e.reg_read(uc.MIPS_REG_PC, 4)));
        if (pc < end && hookCount < 1000) pc = end;
    }
    ok(pc === end, "mips: call/ret program runs to the end");
    ok(fromLE(Uint8Array.from(e.reg_read(uc.MIPS_REG_T1, 4))) === 25n, "mips: callee result came back (5*5)");
    e.close();

    // Step-over: temp target at jal + 8 (the worker's classMap sz = size + slot).
    const e2 = boot(uc, "ARCH_MIPS", M, image);
    const retTarget = 0x10004n + 8n;
    let stopped = null;
    e2.hook_add(uc.HOOK_CODE, (h, addr) => {
        if (BigInt(addr) === retTarget) {
            stopped = BigInt(addr);
            e2.emu_stop();
        }
    }, {}, 1n, 0n);
    e2.emu_start(CODE, end, 0, 10000);
    ok(stopped === retTarget, `mips: step-over stops at jal+8 (stopped at 0x${(stopped ?? 0n).toString(16)})`);
    ok(fromLE(Uint8Array.from(e2.reg_read(uc.MIPS_REG_V0, 4))) === 25n, "mips: callee executed under step-over");
    e2.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
