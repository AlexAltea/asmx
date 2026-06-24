/*
 * Run-verifies every profile's example programs against the REAL Keystone +
 * Unicorn builds: each line is assembled at its computed address (mirroring
 * model/document.js layout), the image is executed from codeBase with SP at
 * stackTop, and the program must reach the image end without faulting. Guards
 * the examples' precomputed absolute branch targets (labels can't resolve
 * across lines, so a stale target silently branches somewhere wrong).
 *
 * Run: node test_examples_node.mjs
 */
import { createRequire } from "module";
import { getArch, listArchs } from "../src/arch/index.js";

const require = createRequire(import.meta.url);
const MKeystone = require("@alexaltea/keystone-js");

let pass = 0,
    fail = 0;
const ok = (cond, m) => (cond ? pass++ : (fail++, console.error(`  ✗ ${m}`)));

function bytesToBig(b) {
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
}

const LABEL_RE = /^[A-Za-z_.$][\w.$]*:$/;

/** Assemble example code line-at-address like the document model does. */
function assemble(ks, profile, modeId, code) {
    const L = profile.layoutFor(modeId);
    let mode = 0;
    for (const m of L.ksMode) mode |= ks[m] || 0;
    const k = new ks.Keystone(ks[profile.ksArch], mode);
    if (profile.ksSyntax) k.option(ks.OPT_SYNTAX, ks[profile.ksSyntax]);
    const image = [];
    const errors = [];
    let addr = profile.codeBase;
    for (const raw of code.split("\n")) {
        const t = raw.trim();
        if (!t || t.startsWith(";") || LABEL_RE.test(t)) continue;
        let r = null;
        try {
            r = k.asm(t, addr);
        } catch {}
        if (!r || !r.mc || !r.mc.length) {
            errors.push(t);
            continue;
        }
        image.push(...r.mc);
        addr += BigInt(r.mc.length);
    }
    k.close();
    return { image, end: addr, errors };
}

/** Run an image start-to-end in a fresh engine wired like the worker's doInit. */
function run(uc, profile, modeId, image, end) {
    const L = profile.layoutFor(modeId);
    let mode = 0;
    for (const m of L.ucMode) mode |= uc[m] || 0;
    const e = new uc.Unicorn(uc[profile.ucArch], mode);
    for (const m of profile.maps) {
        e.mem_map(m.addr, m.size, Number(m.perms));
        e.mem_write(m.addr, new Uint8Array(Number(m.size)));
    }
    const ucName = (name) => (profile.ucReg && profile.ucReg(name)) || name;
    const rid = (name) => uc[`${profile.prefix}_REG_${ucName(name)}`];
    const toBytes = (v, n) => Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
    e.reg_write(rid(L.spName), toBytes(profile.stackTop, L.regSize));
    e.mem_write(profile.codeBase, image);
    const thumbBit = L.ucMode.includes("MODE_THUMB") ? 1n : 0n;
    // pcFixup arches (MIPS/SPARC) read PC back stale after an `until` stop: it
    // stays on the last executed instruction, and SPARC64 keeps RE-EXECUTING it
    // until the budget runs out. Mirror the worker's rules exactly (respin stop
    // + "a clean stop that did NOT exhaust the budget means the run reached
    // `end`"); an example that infinite-loops exhausts the budget every chunk
    // and must NOT pass. Examples contain no self-branches, so consecutive
    // fires of one address can only be the respin.
    const CHUNK = 100000;
    let hookCount = 0;
    let lastA = -1;
    if (profile.pcFixup)
        e.hook_add(uc.HOOK_CODE, (h, a) => {
            hookCount++;
            if (a === lastA) e.emu_stop();
            lastA = a;
        }, {}, 1n, 0n);
    let pc = profile.codeBase;
    let fault = null;
    for (let i = 0; i < 50 && pc < end; i++) {
        hookCount = 0;
        lastA = -1;
        try {
            e.emu_start(pc | thumbBit, end, 0, CHUNK);
        } catch (err) {
            fault = String(err);
            break;
        }
        pc = bytesToBig(Uint8Array.from(e.reg_read(rid(L.pcName), L.regSize)));
        if (profile.pcFixup && pc < end && hookCount < CHUNK) pc = end;
    }
    e.close();
    return { pc, fault };
}

(async () => {
    for (const key of listArchs().map((a) => a.key)) {
        // Fresh Keystone module per arch, mirroring the app: applied syntax
        // options (x86 Intel) leak across engine instances within one module.
        const ks = await MKeystone();
        const profile = getArch(key);
        const uc = await require("@alexaltea/unicorn-js")();
        for (const ex of profile.examples) {
            const label = `${key}: ${ex.name}`;
            const modeId = ex.mode || profile.defaultMode;
            const { image, end, errors } = assemble(ks, profile, modeId, ex.code);
            ok(errors.length === 0, `${label}: assembles (failed: ${errors.join(" | ")})`);
            if (errors.length) continue;
            const r = run(uc, profile, modeId, image, end);
            ok(r.fault === null, `${label}: runs without fault (${r.fault})`);
            ok(r.pc === end, `${label}: exits at the image end (pc 0x${r.pc.toString(16)}, end 0x${end.toString(16)})`);
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
