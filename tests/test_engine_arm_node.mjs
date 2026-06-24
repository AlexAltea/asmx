/*
 * Validates the ARM/Thumb Unicorn behavior the worker depends on, against the
 * REAL Unicorn build (ARM):
 *  - ARM-mode execution and 4-byte register I/O
 *  - the Thumb emu_start convention: begin address needs bit 0 OR'd in to keep
 *    Thumb state (an even begin silently executes as ARM), while PC reads and
 *    HOOK_CODE addresses stay bit-0-clear (the worker's thumbBit contract)
 *  - Thumb breakpoint gate + resume in plain-address space
 *  - bl/bx lr round trip (LR carries the Thumb bit; the return lands on pc+sz)
 *
 * Run: node test_engine_arm_node.mjs
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
    const reg = (e, id) => bytesToBig(Uint8Array.from(e.reg_read(id, 4)));

    function makeEngine(mode, code) {
        const e = new uc.Unicorn(uc.ARCH_ARM, mode);
        e.mem_map(BASE, 0x10000n, uc.PROT_ALL);
        e.mem_map(0x70000n, 0x10000n, uc.PROT_ALL);
        e.reg_write(uc.ARM_REG_SP, [0x00, 0xff, 0x07, 0x00]);
        e.mem_write(BASE, code);
        return e;
    }

    // ---- ARM mode: fixed 4-byte execution --------------------------------
    {
        const e = makeEngine(uc.MODE_ARM, [
            0x05, 0x00, 0xa0, 0xe3, // 10000 mov r0, #5
            0x03, 0x00, 0x80, 0xe2, // 10004 add r0, r0, #3
        ]);
        e.emu_start(BASE, BASE + 8n, 0, 0);
        eq(reg(e, uc.ARM_REG_R0), 8n, "arm: r0 = 5 + 3");
        eq(reg(e, uc.ARM_REG_PC), 0x10008n, "arm: pc at end");
        e.close();
    }

    // ---- Thumb: begin bit 0 keeps Thumb state; PC reads back even ---------
    {
        const CODE = [
            0x05, 0x20, // 10000 movs r0, #5
            0x03, 0x30, // 10002 adds r0, #3
        ];
        // Even begin drops to ARM state: the 2-byte pairs decode as garbage ARM,
        // so r0 never becomes 8. This asserts the convention is REQUIRED.
        const e1 = makeEngine(uc.MODE_THUMB, CODE);
        try {
            e1.emu_start(BASE, BASE + 4n, 0, 2);
        } catch {}
        eq(reg(e1, uc.ARM_REG_R0) === 8n, false, "thumb: even begin does NOT execute as Thumb");
        e1.close();

        const e2 = makeEngine(uc.MODE_THUMB, CODE);
        e2.emu_start(BASE | 1n, BASE + 4n, 0, 0);
        eq(reg(e2, uc.ARM_REG_R0), 8n, "thumb: odd begin executes as Thumb");
        eq(reg(e2, uc.ARM_REG_PC), 0x10004n, "thumb: pc reads back even");
        e2.close();
    }

    // ---- Thumb: hook addresses are even; breakpoint gate + resume ---------
    {
        const e = makeEngine(uc.MODE_THUMB, [
            0x05, 0x20, // 10000 movs r0, #5
            0x03, 0x30, // 10002 adds r0, #3
            0x01, 0x31, // 10004 adds r1, #1
        ]);
        const bp = 0x10002n;
        let resumeFrom = -1n,
            hit = null;
        e.hook_add(
            uc.HOOK_CODE,
            (h, addr) => {
                const pc = BigInt(addr);
                if (pc !== resumeFrom && pc === bp) {
                    hit = pc;
                    e.emu_stop();
                    return;
                }
                if (pc === resumeFrom) resumeFrom = -1n;
            },
            {},
            BASE,
            BASE + 6n
        );
        e.emu_start(BASE | 1n, BASE + 6n, 0, 0);
        eq(hit, bp, "thumb: breakpoint hit at the even document address");
        eq(reg(e, uc.ARM_REG_PC), bp, "thumb: stopped PC is even");
        resumeFrom = bp;
        hit = null;
        e.emu_start(reg(e, uc.ARM_REG_PC) | 1n, BASE + 6n, 0, 0); // resume: re-OR bit 0
        eq(reg(e, uc.ARM_REG_R0), 8n, "thumb: resumed in Thumb state (r0 = 8)");
        eq(reg(e, uc.ARM_REG_R1), 1n, "thumb: ran to end after resume");
        e.close();
    }

    // ---- Thumb: bl/bx lr; return lands on pc+sz (the shadow-stack rule) ---
    {
        const e = makeEngine(uc.MODE_THUMB, [
            0x00, 0xf0, 0x02, 0xf8, // 10000 bl 0x10008 (4 bytes)
            0x01, 0x20, //             10004 movs r0, #1  (return site)
            0x00, 0xbf, //             10006 nop
            0x05, 0x21, //             10008 movs r1, #5
            0x70, 0x47, //             1000a bx lr
        ]);
        e.emu_start(BASE | 1n, BASE + 6n, 0, 2); // bl + movs r1
        eq(reg(e, uc.ARM_REG_LR), 0x10005n, "thumb: bl stamps the Thumb bit into LR");
        e.emu_start(reg(e, uc.ARM_REG_PC) | 1n, BASE + 6n, 0, 0); // bx lr, then fall to end
        eq(reg(e, uc.ARM_REG_PC), 0x10006n, "thumb: returned to pc+sz and ran to end");
        eq(reg(e, uc.ARM_REG_R0), 1n, "thumb: return-site instruction executed");
        e.close();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
});
