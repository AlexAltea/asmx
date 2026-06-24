/*
 * Integration test: validates the engine worker's algorithm (mem map, image
 * write, HOOK_CODE breakpoint-gate, resume one-shot, step-in, raw-byte register
 * snapshots) against the REAL Unicorn build (x86) in node. Mirrors the logic in
 * worker/engine-worker.js. Run: node test_engine_node.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const MUnicorn = require("@alexaltea/unicorn-js");

let pass = 0,
    fail = 0;
const eq = (a, b, m) => (a === b ? pass++ : (fail++, console.error(`  ✗ ${m} (got ${a}, want ${b})`)));

function bytesToBig(bytes) {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    return v;
}

MUnicorn().then((uc) => {
    const BASE = 0x10000n;
    // mov rcx,3 ; mov rax,0 ; add rax,rcx ; loop add   (sums 3+2+1 = 6)
    const CODE = [
        0x48, 0xc7, 0xc1, 0x03, 0x00, 0x00, 0x00, // 10000 mov rcx, 3
        0x48, 0xc7, 0xc0, 0x00, 0x00, 0x00, 0x00, // 10007 mov rax, 0
        0x48, 0x01, 0xc8, //                          1000E add rax, rcx
        0xe2, 0xfb, //                                10011 loop 1000E
    ];
    const END = BASE + BigInt(CODE.length); // 0x10013
    const ADD = 0x1000en;

    const e = new uc.Unicorn(uc.ARCH_X86, uc.MODE_64);
    e.mem_map(BASE, 0x10000n, uc.PROT_ALL);
    e.mem_map(0x70000n, 0x10000n, uc.PROT_ALL);
    e.reg_write_i64(uc.X86_REG_RSP, 0x78000n);

    const readReg = (id, size) => Uint8Array.from(e.reg_read(id, size));
    const readPC = () => bytesToBig(readReg(uc.X86_REG_RIP, 8));
    const readRAX = () => bytesToBig(readReg(uc.X86_REG_RAX, 8));
    const readRCX = () => bytesToBig(readReg(uc.X86_REG_RCX, 8));

    // ---- breakpoint gate (mirrors the worker) --------------------------
    let bpSet = new Set();
    let resumeFrom = -1n;
    let hitBp = null;
    e.hook_add(
        uc.HOOK_CODE,
        (h, addr, size, ud) => {
            const pc = BigInt(addr);
            if (pc === resumeFrom) {
                resumeFrom = -1n;
                return;
            }
            if (bpSet.has(pc)) {
                hitBp = pc;
                e.emu_stop();
            }
        },
        {},
        BASE,
        END
    );

    function runTo(from) {
        resumeFrom = BigInt(from);
        hitBp = null;
        e.emu_start(BigInt(from), END, 0, 0);
        return { pc: readPC(), stoppedAtBp: hitBp != null };
    }

    // image write
    e.mem_write(BASE, CODE);

    // --- run to first breakpoint (add not yet executed) -----------------
    bpSet = new Set([ADD]);
    let r = runTo(BASE);
    eq(r.pc, ADD, "run: stops at breakpoint (add)");
    eq(r.stoppedAtBp, true, "run: reported breakpoint stop");
    eq(readRAX(), 0n, "run: rax still 0 (add not executed)");
    eq(readRCX(), 3n, "run: rcx == 3");

    // --- continue across the bp three times -----------------------------
    r = runTo(r.pc);
    eq(readRAX(), 3n, "continue 1: rax == 3");
    eq(r.pc, ADD, "continue 1: looped back to add");
    r = runTo(r.pc);
    eq(readRAX(), 5n, "continue 2: rax == 5");
    r = runTo(r.pc);
    eq(readRAX(), 6n, "continue 3: rax == 6 (last add), then loop falls through");
    eq(r.pc, END, "continue 3: ran to program end");
    eq(readRCX(), 0n, "continue 3: rcx drained to 0");

    // --- fresh instance: step-in granularity ----------------------------
    const e2 = new uc.Unicorn(uc.ARCH_X86, uc.MODE_64);
    e2.mem_map(BASE, 0x10000n, uc.PROT_ALL);
    e2.mem_write(BASE, CODE);
    const pc2 = () => bytesToBig(Uint8Array.from(e2.reg_read(uc.X86_REG_RIP, 8)));
    e2.emu_start(BASE, END, 0, 1);
    eq(pc2(), 0x10007n, "step-in 1: pc -> 0x10007");
    e2.emu_start(pc2(), END, 0, 1);
    eq(pc2(), ADD, "step-in 2: pc -> 0x1000E (add)");
    e2.emu_start(pc2(), END, 0, 1);
    eq(bytesToBig(Uint8Array.from(e2.reg_read(uc.X86_REG_RAX, 8))), 3n, "step-in 3: add executed, rax == 3");

    e.close();
    e2.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
});
