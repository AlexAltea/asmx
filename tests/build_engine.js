/*
 * Built browser smoke test. Exercises the two browser-only pieces the esbuild
 * migration introduced (Keystone wasm loaded via locateFile, and the module
 * worker loading its all-arch Unicorn chunk + embedded wasm) end to end:
 * assemble -> init worker -> run -> step -> read registers. Built via
 * `node build.mjs --with-tests` and loaded by tests/build_engine.html, which
 * POSTs results to the /report beacon (snap-confined Chromium has a private
 * /tmp, so results come back over HTTP).
 */
import MKeystone from "@alexaltea/keystone-js";
import ksWasmUrl from "@alexaltea/keystone-js/dist/keystone.wasm";
import { EventBus, EV } from "../src/core/events.js";
import { getArch } from "../src/arch/index.js";
import { DebugEngine } from "../src/debug/engine.js";
import { Assembler } from "../src/core/assembler.js";
import { bytesToBig } from "../src/core/bigint.js";

const out = [];
const consoleBuf = [];
let pass = 0,
    fail = 0;
let done = false;
const ok = (c, m) => (c ? (pass++, out.push("✓ " + m)) : (fail++, out.push("✗ " + m)));
let progress = "start";
const mark = (p) => (progress = p);
// Watchdog: if something hangs (e.g. worker init never resolves), beacon what
// we have so the headless harness gets a signal instead of timing out blind.
setTimeout(() => {
    if (done) return;
    out.push("WATCHDOG: hung at '" + progress + "'");
    if (consoleBuf.length) out.push("  engine console: " + consoleBuf.slice(-6).join(" | "));
    fail++;
    finish();
}, 20000);
function finish() {
    if (done) return;
    done = true;
    const line = `BUILD: ${pass} pass ${fail} fail` + (fail ? " FAILED" : " OK");
    document.title = line;
    const el = document.getElementById("result");
    if (el) el.textContent = line + "\n" + out.join("\n");
    try {
        fetch("/report", { method: "POST", body: line + "\n" + out.join("\n") });
    } catch {}
}

(async () => {
    try {
        const profile = getArch("x86");
        const END = profile.codeBase + profile.maps[0].size;

        // 1) Keystone wasm via locateFile (this is the new bundling path).
        mark("keystone-init (wasm=" + new URL(ksWasmUrl, import.meta.url).href + ")");
        const ks = await MKeystone({ locateFile: () => new URL(ksWasmUrl, import.meta.url).href });
        ok(!!ks && !!ks.Keystone, "Keystone wasm initialized (locateFile asset)");
        const asm = new Assembler(ks);
        asm.configure({ ksArch: "ARCH_X86", ksMode: ["MODE_64"] });
        const r = asm.asm("mov rax, 0x1234\nmov rbx, 0x1111\nadd rax, rbx");
        ok(!r.error && r.bytes.length > 0, "assembled x86-64 program (" + (r.bytes || []).length + " bytes)");

        // 2) Module worker: init loads the x86 chunk + embedded Unicorn wasm.
        const bus = new EventBus();
        bus.on(EV.CONSOLE, ({ level, text }) => consoleBuf.push(level + ": " + text));
        const engine = new DebugEngine(bus);
        const rax = () => {
            const x = engine.regs.find((r) => r.name === "RAX");
            return x ? bytesToBig(Uint8Array.from(x.bytes)) : null;
        };
        const waitRegs = () => new Promise((res) => { const off = bus.on(EV.REGS, () => { off(); res(); }); });

        mark("engine.init (spawn worker + load unicorn chunk)");
        await engine.init(profile, "64", END);
        ok(engine.ready, "worker ready (engine-worker.js + unicorn chunk loaded)");
        await waitRegs(); // drain the init snapshot

        engine.writeImage(profile.codeBase, r.bytes, profile.codeBase + BigInt(r.bytes.length));

        // 3) Run to the end of the image; RAX should be 0x1234 + 0x1111 = 0x2345.
        const ran = new Promise((res) => {
            const off = bus.on(EV.STATE, (s) => { if (s.state !== "running") { off(); res(s); } });
        });
        engine.run(profile.codeBase, profile.codeBase + BigInt(r.bytes.length), []);
        const st = await ran;
        await waitRegs();
        ok(st.state === "exited", "run reached program end (state=" + st.state + ")");
        ok(rax() === 0x2345n, "Unicorn executed the program (RAX=0x" + (rax() ?? 0n).toString(16) + ", want 0x2345)");

        // 4) Reset + single step lands one instruction in. Reset remaps fresh guest
        //    memory, so re-arm the image (the real app does this via imageDirty).
        mark("reset + re-arm + stepIn");
        engine.reset();
        await waitRegs();
        engine.writeImage(profile.codeBase, r.bytes, profile.codeBase + BigInt(r.bytes.length));
        const stepped = new Promise((res) => {
            const off = bus.on(EV.STATE, (s) => { if (s.reason === "step") { off(); res(s); } });
        });
        engine.stepIn(profile.codeBase, profile.codeBase + BigInt(r.bytes.length), []);
        await stepped;
        await waitRegs();
        ok(rax() === 0x1234n, "stepIn executed one instruction (RAX=0x" + (rax() ?? 0n).toString(16) + ")");

        finish();
    } catch (e) {
        out.push("EXCEPTION: " + (e && e.stack ? e.stack : e));
        fail++;
        finish();
    }
})();
