/*
 * Built browser harness for the ELF save / load / share paths. Exercises the
 * pieces that only work in the real browser worker: engine.readMemAsync against
 * live guest memory, buildElf over it, captureCpu, and gzip+base64 share
 * encode/decode via the platform CompressionStream. Built with
 * `node build.mjs --elf-test`, loaded by tests/build_elf.html, POSTs to /report.
 */
import MKeystone from "@alexaltea/keystone-js";
import ksWasmUrl from "@alexaltea/keystone-js/dist/keystone.wasm";
import { EventBus, EV } from "../src/core/events.js";
import { getArch } from "../src/arch/index.js";
import { DebugEngine } from "../src/debug/engine.js";
import { Assembler } from "../src/core/assembler.js";
import { bytesToBig } from "../src/core/bigint.js";
import { parseElf, trimZeros, EM, ELFCLASS64, PF_X } from "../src/core/elf.js";
import { buildElf, captureCpu } from "../src/debug/snapshot.js";
import { encodeShareHash, decodeShareHash } from "../src/core/share.js";

const out = [];
const consoleBuf = [];
let pass = 0,
    fail = 0;
let done = false;
let shareHash = "";
const ok = (c, m) => (c ? (pass++, out.push("✓ " + m)) : (fail++, out.push("✗ " + m)));
let progress = "start";
const mark = (p) => (progress = p);
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

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
    const line = `ELF: ${pass} pass ${fail} fail` + (fail ? " FAILED" : " OK");
    document.title = line;
    const body = line + "\n" + out.join("\n") + "\nSHARE_HASH=" + shareHash;
    const el = document.getElementById("result");
    if (el) el.textContent = body;
    try {
        fetch("/report", { method: "POST", body });
    } catch {}
}

const waitRegs = (bus) => new Promise((res) => { const off = bus.on(EV.REGS, () => { off(); res(); }); });

(async () => {
    try {
        const profile = getArch("x86");
        const END = profile.codeBase + profile.maps[0].size;

        const ks = await MKeystone({ locateFile: () => new URL(ksWasmUrl, import.meta.url).href });
        const asm = new Assembler(ks);
        asm.configure({ ksArch: "ARCH_X86", ksMode: ["MODE_64"] });
        const r = asm.asm("mov rax, 0x1234\nmov rbx, 0x1111\nadd rax, rbx");
        ok(!r.error && r.bytes.length > 0, "assembled program (" + (r.bytes || []).length + " bytes)");
        const expectCode = trimZeros(Uint8Array.from(r.bytes));

        const bus = new EventBus();
        bus.on(EV.CONSOLE, ({ level, text }) => consoleBuf.push(level + ": " + text));
        const engine = new DebugEngine(bus);
        const rax = () => {
            const x = engine.regs.find((g) => g.name === "RAX");
            return x ? bytesToBig(Uint8Array.from(x.bytes)) : null;
        };

        mark("engine.init");
        await engine.init(profile, "64", END);
        await waitRegs(bus);
        engine.writeImage(profile.codeBase, r.bytes, profile.codeBase + BigInt(r.bytes.length));

        // Run so the CPU state is non-trivial (RAX = 0x2345).
        mark("run");
        const ran = new Promise((res) => {
            const off = bus.on(EV.STATE, (s) => { if (s.state !== "running") { off(); res(s); } });
        });
        engine.run(profile.codeBase, profile.codeBase + BigInt(r.bytes.length), []);
        await ran;
        await waitRegs(bus);
        ok(rax() === 0x2345n, "ran program (RAX=0x" + (rax() ?? 0n).toString(16) + ")");

        // --- buildElf over live guest memory (uses readMemAsync) ---
        mark("buildElf");
        const elf = await buildElf({ engine, profile, modeId: "64", entry: profile.codeBase });
        const p = parseElf(elf);
        ok(p.elfClass === ELFCLASS64, "ELF class 64");
        ok(p.machine === EM.X86_64, "ELF machine x86-64");
        ok(p.entry === profile.codeBase, "ELF entry = codeBase");
        // One PT_LOAD per non-stack region: the code region + the data region.
        ok(p.segments.length === 2, "two PT_LOADs (code + data non-stack regions)");
        ok(p.segments[0].vaddr === profile.codeBase, "segment vaddr = codeBase");
        ok((p.segments[0].flags & PF_X) !== 0, "code segment executable");
        ok(bytesEq(p.segments[0].bytes, expectCode), "segment == live code bytes (readMemAsync OK)");
        ok(p.segments[0].memsz === profile.maps[0].size, "segment memsz = region size");
        ok(p.segments[1].vaddr === profile.maps[1].addr, "second segment = data region vaddr");
        ok((p.segments[1].flags & PF_X) === 0, "data segment not executable");

        // --- captureCpu ---
        const cpu = captureCpu(engine);
        ok(cpu.RAX === "2345", "captureCpu RAX=2345 (got " + cpu.RAX + ")");
        ok(cpu.RIP != null, "captureCpu includes RIP");
        ok(cpu.XMM0 === undefined, "captureCpu skips vector regs");

        // --- share encode/decode in-browser (CompressionStream) ---
        mark("share");
        shareHash = await encodeShareHash({ elfBytes: elf, cpu });
        ok(shareHash.length < elf.length, "share gzip shrank the ELF");
        const back = await decodeShareHash("#" + shareHash);
        ok(bytesEq(back.elfBytes, elf), "share ELF round-trip");
        ok(JSON.stringify(back.cpu) === JSON.stringify(cpu), "share cpu round-trip");

        // --- write-back + readMemAsync (the path applyElf relies on) ---
        mark("reset+writeback");
        engine.reset();
        await waitRegs(bus);
        const blank = await engine.readMemAsync(profile.codeBase, expectCode.length);
        ok(blank.every((b) => b === 0), "reset cleared guest memory");
        engine.writeMem(profile.codeBase, p.segments[0].bytes);
        const reread = await engine.readMemAsync(profile.codeBase, expectCode.length);
        ok(bytesEq(reread, expectCode), "writeMem + readMemAsync round-trip");

        // --- applyCpu-style register restore ---
        engine.writeReg("RAX", BigInt("0x" + cpu.RAX), 8);
        await waitRegs(bus);
        ok(rax() === 0x2345n, "register restore via writeReg (RAX=0x" + (rax() ?? 0n).toString(16) + ")");

        finish();
    } catch (e) {
        out.push("EXCEPTION: " + (e && e.stack ? e.stack : e));
        fail++;
        finish();
    }
})();
