/*
 * Validates AArch64 behavior the worker depends on, against the REAL Unicorn
 * build (AArch64): execution + 8-byte register I/O, NZCV read/write at size 4
 * (the Registers panel flag chips), PC writes (SET_PC), and a bl/ret round trip
 * with a real stp/ldp stack frame.
 *
 * Run: node test_engine_aarch64_node.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const MUnicorn = require("@alexaltea/unicorn-js");

let pass = 0,
    fail = 0;
const eq = (a, b, m) => (a === b ? pass++ : (fail++, console.error(`  ✗ ${m} (got ${a}, want ${b})`)));

function bytesToBig(b) {
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
}

MUnicorn().then((uc) => {
    const BASE = 0x10000n;
    const reg = (e, id, size = 8) => bytesToBig(Uint8Array.from(e.reg_read(id, size)));

    function makeEngine(code) {
        const e = new uc.Unicorn(uc.ARCH_ARM64, 0);
        e.mem_map(BASE, 0x10000n, uc.PROT_ALL);
        e.mem_map(0x70000n, 0x10000n, uc.PROT_ALL);
        e.reg_write(uc.ARM64_REG_SP, [0x00, 0xff, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00]);
        e.mem_write(BASE, code);
        return e;
    }

    // ---- basic execution + NZCV flags -------------------------------------
    {
        const e = makeEngine([
            0xa0, 0x00, 0x80, 0xd2, // 10000 mov x0, #5
            0x00, 0x0c, 0x00, 0x91, // 10004 add x0, x0, #3
            0x01, 0x00, 0x00, 0xeb, // 10008 subs x1, x0, x0
        ]);
        e.emu_start(BASE, BASE + 12n, 0, 0);
        eq(reg(e, uc.ARM64_REG_X0), 8n, "a64: x0 = 5 + 3");
        eq(reg(e, uc.ARM64_REG_PC), 0x1000cn, "a64: pc at end");
        // subs x-x sets Z and C: NZCV reads 0x60000000 at the panel's 4-byte size.
        eq(reg(e, uc.ARM64_REG_NZCV, 4), 0x60000000n, "a64: NZCV Z+C after subs x, x");
        // Flag-chip write path: set N, clear the rest.
        e.reg_write(uc.ARM64_REG_NZCV, [0x00, 0x00, 0x00, 0x80]);
        eq(reg(e, uc.ARM64_REG_NZCV, 4), 0x80000000n, "a64: NZCV whole-register write");
        // SET_PC path.
        e.reg_write(uc.ARM64_REG_PC, [0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
        eq(reg(e, uc.ARM64_REG_PC), 0x10000n, "a64: PC write");
        e.close();
    }

    // ---- bl/ret with a stp/ldp frame ---------------------------------------
    {
        const e = makeEngine([
            0xa0, 0x00, 0x80, 0xd2, // 10000 mov x0, #5
            0x03, 0x00, 0x00, 0x94, // 10004 bl 0x10010
            0x01, 0x04, 0x00, 0x91, // 10008 add x1, x0, #1  (return site)
            0x05, 0x00, 0x00, 0x14, // 1000c b 0x10020      (skip over the subroutine)
            0xfd, 0x7b, 0xbf, 0xa9, // 10010 stp x29, x30, [sp, #-16]!
            0x00, 0x7c, 0x00, 0x9b, // 10014 mul x0, x0, x0
            0xfd, 0x7b, 0xc1, 0xa8, // 10018 ldp x29, x30, [sp], #16
            0xc0, 0x03, 0x5f, 0xd6, // 1001c ret
        ]);
        const spBefore = reg(e, uc.ARM64_REG_SP);
        e.emu_start(BASE, BASE + 32n, 0, 0);
        eq(reg(e, uc.ARM64_REG_X0), 25n, "a64: subroutine squared x0");
        eq(reg(e, uc.ARM64_REG_X1), 26n, "a64: returned to bl+4 and continued");
        eq(reg(e, uc.ARM64_REG_LR), 0x10008n, "a64: bl set LR to the return site");
        eq(reg(e, uc.ARM64_REG_SP), spBefore, "a64: frame balanced (ldp restored SP)");
        e.close();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
});
