/*
 * Validates step-over / step-out + the shadow call stack against the REAL
 * Unicorn build (x86), mirroring worker/engine-worker.js's gate ordering and
 * temp-target logic. Program (base 0x10000):
 *
 *   10000 mov rax, 0
 *   10007 call func        -> 0x10018
 *   1000C mov rbx, 1       (return site of `call func`)
 *   10013 jmp end          -> 0x10027
 *   10018 func: add rax,5
 *   1001C       call inner -> 0x10022
 *   10021       ret
 *   10022 inner: add rax,10
 *   10026        ret
 *   10027 end:  nop
 *
 * Run: node test_stepover_node.mjs
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
    const CODE = [
        0x48, 0xc7, 0xc0, 0x00, 0x00, 0x00, 0x00, // 10000 mov rax,0
        0xe8, 0x0c, 0x00, 0x00, 0x00, //             10007 call 10018
        0x48, 0xc7, 0xc3, 0x01, 0x00, 0x00, 0x00, // 1000C mov rbx,1
        0xe9, 0x0f, 0x00, 0x00, 0x00, //             10013 jmp 10027
        0x48, 0x83, 0xc0, 0x05, //                   10018 add rax,5
        0xe8, 0x01, 0x00, 0x00, 0x00, //             1001C call 10022
        0xc3, //                                     10021 ret
        0x48, 0x83, 0xc0, 0x0a, //                   10022 add rax,10
        0xc3, //                                     10026 ret
        0x90, //                                     10027 nop
    ];
    const END = BASE + BigInt(CODE.length); // 0x10028
    const classMap = {
        [0x10007]: { c: true, r: false, sz: 5 },
        [0x1001c]: { c: true, r: false, sz: 5 },
        [0x10021]: { c: false, r: true, sz: 1 },
        [0x10026]: { c: false, r: true, sz: 1 },
    };

    function makeEngine() {
        const e = new uc.Unicorn(uc.ARCH_X86, uc.MODE_64);
        e.mem_map(BASE, 0x10000n, uc.PROT_ALL);
        e.mem_map(0x70000n, 0x10000n, uc.PROT_ALL);
        e.reg_write_i64(uc.X86_REG_RSP, 0x78000n);
        e.mem_write(BASE, CODE);
        return e;
    }
    const rax = (e) => bytesToBig(Uint8Array.from(e.reg_read(uc.X86_REG_RAX, 8)));
    const pcOf = (e) => bytesToBig(Uint8Array.from(e.reg_read(uc.X86_REG_RIP, 8)));
    const spOf = (e) => bytesToBig(Uint8Array.from(e.reg_read(uc.X86_REG_RSP, 8)));

    // Engine state mirroring the worker.
    function attach(e) {
        const st = { shadow: [], tempTarget: null, tempGuard: 0n, hitTemp: false, resumeFrom: -1n, hitBp: null, bp: new Set() };
        e.hook_add(
            uc.HOOK_CODE,
            (h, addr) => {
                const pc = BigInt(addr);
                if (st.tempTarget != null && pc === st.tempTarget && spOf(e) >= st.tempGuard) {
                    st.hitTemp = true;
                    e.emu_stop();
                    return;
                }
                if (pc !== st.resumeFrom && st.bp.has(pc)) {
                    st.hitBp = pc;
                    e.emu_stop();
                    return;
                }
                if (pc === st.resumeFrom) st.resumeFrom = -1n;
                const ci = classMap[pc.toString()];
                if (ci) {
                    if (ci.c) st.shadow.push({ ret: pc + BigInt(ci.sz), sp: spOf(e) });
                    else if (ci.r && st.shadow.length) st.shadow.pop();
                }
            },
            {},
            BASE,
            END
        );
        return st;
    }

    function chunked(e, st, from) {
        st.resumeFrom = BigInt(from);
        st.hitTemp = false;
        st.hitBp = null;
        e.emu_start(BigInt(from), END, 0, 0);
        st.tempTarget = null;
        return pcOf(e);
    }
    function stepInOne(e, st, from) {
        st.resumeFrom = -1n;
        st.tempTarget = null;
        e.emu_start(BigInt(from), END, 0, 1);
        return pcOf(e);
    }
    function stepOver(e, st, from) {
        const ci = classMap[BigInt(from).toString()];
        if (ci && ci.c) {
            st.tempTarget = BigInt(from) + BigInt(ci.sz);
            st.tempGuard = spOf(e);
            return chunked(e, st, from);
        }
        return stepInOne(e, st, from);
    }
    function stepOut(e, st, from) {
        if (!st.shadow.length) return chunked(e, st, from);
        const top = st.shadow[st.shadow.length - 1];
        st.tempTarget = top.ret;
        st.tempGuard = top.sp;
        return chunked(e, st, from);
    }

    // ---- step-over the outer call: should run func+inner fully ----------
    {
        const e = makeEngine();
        const st = attach(e);
        let pc = stepInOne(e, st, BASE); // -> 0x10007 (after mov rax,0)
        eq(pc, 0x10007n, "stepIn: at call func");
        pc = stepOver(e, st, pc); // step over `call func`
        eq(pc, 0x1000cn, "stepOver(call): landed on the instruction after the call");
        eq(rax(e), 15n, "stepOver(call): executed func+inner (rax = 5+10)");
        e.close();
    }

    // ---- step-in to inner, then step-out twice --------------------------
    {
        const e = makeEngine();
        const st = attach(e);
        let pc = stepInOne(e, st, BASE); // 0x10007
        pc = stepInOne(e, st, pc); // enter func -> 0x10018
        eq(pc, 0x10018n, "stepIn entered func");
        eq(st.shadow.length, 1, "shadow has 1 frame after entering func");
        pc = stepInOne(e, st, pc); // add rax,5 -> 0x1001C
        pc = stepInOne(e, st, pc); // enter inner -> 0x10022
        eq(pc, 0x10022n, "stepIn entered inner");
        eq(st.shadow.length, 2, "shadow has 2 frames inside inner");

        pc = stepOut(e, st, pc); // out of inner -> back in func at 0x10021 (ret)
        eq(pc, 0x10021n, "stepOut(inner): returned to func's ret @0x10021");
        eq(rax(e), 15n, "stepOut(inner): inner body executed (rax=15)");
        eq(st.shadow.length, 1, "shadow back to 1 frame (inner frame intact-but-not-prematurely-popped)");

        pc = stepOut(e, st, pc); // out of func -> back to 0x1000C
        eq(pc, 0x1000cn, "stepOut(func): returned to after `call func` @0x1000C");
        e.close();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
});
