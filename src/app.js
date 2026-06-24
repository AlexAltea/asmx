/*
 * ASMX controller: wires the document model, the Unicorn worker engine,
 * and the UI panels together.
 */
// Assembler/disassembler come from npm and are bundled in; their separate wasm
// is emitted as an asset (esbuild file loader) and located via Module.locateFile.
import MKeystone from "@alexaltea/keystone-js";
import ksWasmUrl from "@alexaltea/keystone-js/dist/keystone.wasm";
import MCapstone from "@alexaltea/capstone-js";
import csWasmUrl from "@alexaltea/capstone-js/dist/capstone.wasm";
import "./styles/tokens.css";
import "./styles/app.css";

import { EventBus, EV } from "./core/events.js";
import { toHex, asU8, errMsg } from "./core/bigint.js";
import { evaluate, evaluateInspect, ptrMask } from "./core/expr.js";
import { Document } from "./model/document.js";
import { Assembler } from "./core/assembler.js";
import { Disassembler, formatInsn } from "./core/disassembler.js";
import { getArch, listArchs, modeNames, archForElf, snapshotRegs, codeRegion, endianOf } from "./arch/index.js";
import { parseElf, machineName } from "./core/elf.js";
import { buildElf, captureCpu, pickCodeSegment, bytesEqual } from "./debug/snapshot.js";
import { encodeShareHash, decodeShareHash } from "./core/share.js";
import { DebugEngine } from "./debug/engine.js";
import { BreakpointStore } from "./debug/breakpoints.js";
import { Editor } from "./ui/editor.js";
import { BreakpointsView } from "./ui/breakpoints.js";
import { ArrowGutter } from "./ui/arrows.js";
import { Registers } from "./ui/registers.js";
import { Console } from "./ui/console.js";
import { Inspector } from "./ui/inspector.js";
import { MemoryView } from "./ui/memory.js";
import { StackView } from "./ui/stack.js";
import { MapsView } from "./ui/maps.js";
import { Layout } from "./ui/layout.js";
import { initTheme, toggleTheme } from "./ui/theme.js";
import { initConsent } from "./ui/consent.js";
import { bindTransport } from "./ui/toolbar.js";
import { applyIcons, icon } from "./ui/icons.js";
import { $, el, menuButton, downloadBlob, copyWithCheck, popover } from "./ui/dom.js";

// Default docking layout; reproduces the classic fixed arrangement: a top row
// (Disassembly | Registers | Inspector) over a bottom deck (Console | Memory |
// Stack | Maps). `size` is a relative flex weight, so the proportions hold as
// the window resizes. Built fresh each call (used as the reset target too).
function defaultLayout() {
    const stack = (id, size) => ({ type: "stack", size, panels: [id], active: 0 });
    return {
        type: "col",
        size: 1,
        children: [
            { type: "row", size: 1, children: [stack("editor", 56), stack("registers", 24), stack("inspector", 20)] },
            { type: "row", size: 0.34, children: [stack("console", 1.4), stack("memory", 1.4), stack("stack", 1), stack("breakpoints", 1.1), stack("maps", 1.2)] },
        ],
    };
}

function setupLayout() {
    const layout = new Layout($("layout-root"), { storageKey: "asmx.layout.v2" });
    for (const el of document.querySelectorAll("#panels-src > [data-panel]"))
        layout.register(el.dataset.panel, el.dataset.title, el);
    layout.mount(defaultLayout());
    return layout;
}

const state = {
    profile: null,
    modeId: null,
    imageDirty: true,
    dataSegments: [], // non-code PT_LOADs from a loaded ELF, re-applied on each image sync
};

let bus, engine, assembler, disassembler, doc, editor, registers, consoleView, inspector, memory, stack, mapsView;
let bpStore, breakpointsView;

// ---- console + toasts ---------------------------------------------------
function log(level, text) {
    consoleView?.log(level, text);
}

function toast(text, { err = false } = {}) {
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.textContent = text;
    $("toasts").appendChild(t);
    setTimeout(() => t.remove(), 4000);
}

// ---- expression evaluator (Memory/Stack goto + Inspector) ---------------
// One context, rebuilt per call so it always reflects the live register snapshot
// and the current arch/mode. Registers resolve (case-insensitively) off the
// engine's last snapshot; a deref goes through the worker's promise-based read.
function exprCtx() {
    const L = state.profile.layoutFor(state.modeId);
    return {
        reg: (name) => {
            const r = engine.regs.find((x) => x.name === name);
            return r ? asU8(r.bytes) : undefined;
        },
        readBytes: (addr, size) => engine.readMemAsync(addr, size),
        subRegs: state.profile.subRegsFor(state.modeId),
        pointerSize: L.regSize,
        pcName: L.pcName,
        spName: L.spName,
        bigEndian: endianOf(state.profile, state.modeId) === "big",
    };
}
async function evalAddr(src) {
    const c = exprCtx();
    const v = await evaluate(src, c);
    return v & ptrMask(c); // unsigned pointer-width address
}
function evalInspect(src) {
    return evaluateInspect(src, exprCtx());
}
function setPinBtn(btn, pinned) {
    if (!btn) return;
    btn.style.color = pinned ? "var(--accent)" : "";
    btn.innerHTML = icon(pinned ? "pinned" : "pin");
}

// ---- tools / arch -------------------------------------------------------
// locateFile points Emscripten at the wasm asset esbuild emitted next to us.
const loadKeystone = () => MKeystone({ locateFile: () => new URL(ksWasmUrl, import.meta.url).href });

async function configureTools(modeId) {
    const n = modeNames(state.profile, modeId);
    // Keystone leaks applied syntax options across engine instances within one
    // wasm module: once x86 sets Intel syntax, a later AArch64 engine rejects
    // stp/ldp bracket offsets. An arch switch therefore rebuilds the assembler
    // from a fresh module (arch switches are rare; the cost is a one-off load).
    if (state.ksArchKey && state.ksArchKey !== state.profile.key) {
        assembler = new Assembler(await loadKeystone());
    }
    state.ksArchKey = state.profile.key;
    assembler.configure({ ksArch: n.ksArch, ksMode: n.ksMode, ksSyntax: n.ksSyntax });
    disassembler.configure({
        csArch: n.csArch,
        csMode: n.csMode,
        branchInfo: state.profile.branchInfo,
    });
    if (editor) editor.setPadding(paddingInsn());
}

/**
 * What a run of zero bytes disassembles to in the current arch/mode (e.g. x86
 * `add byte ptr [rax], al`, 2 bytes). The editor repeats this, muted, across
 * the executable region past the assembled code, so the listing shows the zero
 * padding decoded. Null when the zero bytes don't decode (the tail is omitted).
 */
function paddingInsn() {
    const insn = disassembler.one([0, 0, 0, 0], state.profile.codeBase);
    if (!insn) return null;
    return { size: insn.size, text: formatInsn(insn) };
}

// Every line is treated as position-sensitive: PC/IP-relative encodings are
// pervasive (x86-64 RIP-relative memory operands, ARM/AArch64 branches and
// adr/adrp/literal loads, Thumb narrow/wide branch relaxation), re-assembling a
// position-independent line at its true address is a no-op, and the documents
// are small enough that per-mnemonic filtering isn't worth its false negatives.
const isPositionSensitive = () => true;
const currentText = () => doc.lines.map((l) => l.text).join("\n");

function computeAnalysis() {
    const img = doc.image();
    try {
        return disassembler.analyze(img.bytes, img.base);
    } catch {
        return [];
    }
}
function refreshAnalysis() {
    editor.setAnalysis(computeAnalysis());
}

// Keep breakpoints coherent after an in-place document edit: re-anchor the sticky
// ones to their instructions' new addresses (dropping any whose line was deleted),
// then refresh the panel so resolved addresses / instruction text reflect the new
// layout. A program reload instead drops them all via bpStore.clear().
function syncBreakpoints() {
    bpStore.reconcile();
    breakpointsView.render();
}

/**
 * Switch the active arch/mode and re-create the engine (fresh memory map),
 * without touching the document. Shared by mode changes and ELF loads.
 */
async function reinit(profile, modeId) {
    state.profile = profile;
    state.modeId = modeId;
    state.dataSegments = []; // a fresh engine has no loaded data; ELF load resets this after
    doc.base = profile.codeBase;
    await configureTools(modeId);
    registers.setMode(profile, modeId);
    if (stack) {
        stack.setMode(profile, modeId);
        stack.setMaps(profile.maps);
    }
    if (memory) {
        memory.clearExpr(); // a fresh engine / mode switch drops any pinned expression
        memory.base = profile.codeBase;
        memory.setMaps(profile.maps);
    }
    if (mapsView) mapsView.setMaps(profile.maps);
    if (editor) editor.setMaps(profile.maps);
    updateArchLabel();
    await engine.init(profile, modeId, codeRegion(profile).end);
}

async function applyMode(modeId, code) {
    await reinit(state.profile, modeId);
    doc.setLines(code != null ? code : currentText());
    doc.setIPFromAddr(doc.entryAddr());
    refreshAnalysis();
    editor.render();
    bpStore.clear(); // a new program replaces the listing; drop stale breakpoints
    state.imageDirty = true;
    const opt = state.profile.modeOptions.find((m) => m.id === modeId);
    log("debug", `mode: ${opt ? opt.label : modeId}`);
    syncImage();
}

/** Switch architectures: fresh engine + one of that arch's examples (the first
 *  one written for the chosen mode) as the program. */
async function applyArch(key, modeId) {
    state.profile = getArch(key);
    const ex = state.profile.examples.find((e) => e.mode === modeId) || state.profile.examples[0];
    await applyMode(ex.mode, ex.code);
    log("debug", `arch: ${state.profile.label}`);
}

// ---- image sync + transport ----------------------------------------------
function buildClassMap(img) {
    const map = {};
    // On delay-slot arches (MIPS/SPARC) the slot belongs to the transfer: a
    // call returns PAST it (call + 8), and the worker steps the pair together,
    // so every control transfer gets an entry (b) with the slot in its size.
    const slot = state.profile.delaySlots ? 4 : 0;
    for (const i of disassembler.analyze(img.bytes, img.base)) {
        if (!(i.isCall || i.isRet || i.isJump)) continue;
        map[i.address.toString()] = { c: i.isCall, r: i.isRet, b: true, sz: i.size + slot };
    }
    return map;
}

function syncImage() {
    if (!state.imageDirty) return;
    const img = doc.image();
    engine.writeImage(img.base, img.bytes);
    engine.setClassMap(buildClassMap(img)); // call/ret map for shadow stack + step-over
    for (const s of state.dataSegments) engine.writeMem(s.vaddr, s.bytes); // loaded data
    state.imageDirty = false;
}

function reportErrors() {
    const errs = doc.errors();
    for (const ln of errs.slice(0, 4)) {
        log("error", `asm error: "${ln.asmText}" (${ln.error})`);
    }
    toast(`${errs.length} assembly error${errs.length > 1 ? "s" : ""}; fix before running`, {
        err: true,
    });
}

function run() {
    if (engine.state === "running") return;
    if (!doc.isRunnable()) return reportErrors();
    syncImage();
    const from = doc.ipAddress() ?? doc.entryAddr();
    const until = doc.endAddr();
    if (from >= until) return toast("IP is at the end. Press Reset to restart.");
    engine.run(from, until, bpStore.active());
}

function stepIn() {
    stepDispatch((from, until, bps) => engine.stepIn(from, until, bps));
}
function stepOver() {
    stepDispatch((from, until, bps) => engine.stepOver(from, until, bps));
}
function stepOut() {
    stepDispatch((from, until, bps) => engine.stepOut(from, until, bps), { allowAtEnd: true });
}
function stepDispatch(send, { allowAtEnd = false } = {}) {
    if (engine.state === "running") return;
    if (!doc.isRunnable()) return reportErrors();
    syncImage();
    const from = doc.ipAddress() ?? doc.entryAddr();
    const until = doc.endAddr();
    if (from >= until && !allowAtEnd) return toast("Reached the end. Press Reset to restart.");
    send(from, until, bpStore.active());
}

function runToCursor(lineId) {
    if (engine.state === "running") return;
    const ln = doc.byId.get(lineId);
    if (!ln || !ln.addrBearing) return;
    if (!doc.isRunnable()) return reportErrors();
    syncImage();
    const from = doc.ipAddress() ?? doc.entryAddr();
    const until = doc.endAddr();
    engine.run(from, until, [...bpStore.active(), { addr: doc.lineToAddr(lineId) }]);
}

/** Context menu "Set instruction pointer here": move the IP (and the guest PC, so
 *  run/step resume from there) to `lineId`. Ignored mid-run or on a non-code line. */
function setInstructionPointer(lineId) {
    if (engine.state === "running") return;
    const ln = doc.byId.get(lineId);
    if (!ln || !ln.addrBearing) return;
    doc.setIPFromAddr(ln.addr);
    if (engine.ready) {
        engine.setPC(ln.addr);
        engine.snapshot(); // re-read registers so the Registers panel shows the new PC
    }
    editor.refresh();
    log("debug", `IP set to 0x${toHex(ln.addr, 8)}`);
}

/** Context menu "Set original entry point here": pin the entry point (the marker,
 *  and where Reset / run-from-start go) to `lineId`. Ignored on a non-code line. */
function setEntryPoint(lineId) {
    const ln = doc.byId.get(lineId);
    if (!doc.setEntryLine(lineId)) return;
    editor.refresh(); // repaint the entry marker on its new line
    log("debug", `entry point set to 0x${toHex(ln.addr, 8)}`);
}

function resetExec() {
    engine.reset(); // full re-init: re-zeroes memory AND the registers (worker resetRegs)
    state.imageDirty = true;
    // Re-sync the image right away: the reset snapshot makes the hex views
    // re-read, and they must see the program bytes, not the zeroed region. Safe
    // to queue behind RESET; the worker re-inits synchronously (the Unicorn
    // build is unchanged), so these writes land on the fresh engine.
    syncImage();
    const entry = doc.entryAddr();
    doc.setIPFromAddr(entry);
    // The worker's reset homes PC to the code base; re-point it at the entry so a
    // custom entry point (context menu) actually lands in RIP, then re-read regs.
    engine.setPC(entry);
    engine.snapshot();
    editor.refresh();
    if (mapsView) mapsView.setMaps(state.profile.maps); // reset re-maps to default perms
    log("debug", "reset");
}

/** Registers-only reset (Registers panel button): zero every register and re-home
 *  PC/SP without disturbing guest memory. Shares the worker's resetRegs() with the
 *  full reset above (engine.reset() -> doInit -> resetRegs), so both agree on what a
 *  reset register file is. */
function resetRegs() {
    if (!engine.ready) return;
    engine.resetRegs();
    const entry = doc.entryAddr();
    doc.setIPFromAddr(entry); // PC returned to the entry; move the IP marker with it
    engine.setPC(entry); // resetRegs homes PC to the code base; honor a custom entry point
    engine.snapshot(); // re-read so the Registers panel shows the entry RIP
    editor.refresh();
    log("debug", "registers reset");
}

// ---- ELF load / save / share --------------------------------------------
/** Save current non-stack guest memory as an ELF download. */
async function doSave() {
    if (!engine.ready) return toast("Engine isn't ready yet.");
    syncImage(); // sync the document into guest memory if it was edited
    const entry = engine.pc != null ? engine.pc : doc.entryAddr();
    try {
        const elf = await buildElf({
            engine,
            profile: state.profile,
            modeId: state.modeId,
            entry,
            liveMaps: mapsView && mapsView.maps,
        });
        downloadBlob(elf, `asmx-${state.profile.key}-${state.modeId}.elf`);
        log("info", `saved ${elf.length}-byte ELF of non-stack memory`);
    } catch (e) {
        toast("Save failed: " + errMsg(e), { err: true });
    }
}

/** Breakpoints as a terse share payload: [{ a:hexAddr, e?:0, s?:0, c?:cond }]. Defaults
 *  are dropped to keep the URL short (enabled + sticky + unconditional are implied). */
function captureBreakpoints() {
    const out = [];
    for (const b of bpStore.list()) {
        const e = { a: b.addr.toString(16) };
        if (!b.enabled) e.e = 0;
        if (!b.stick) e.s = 0; // sticky is the default; only record a pinned (fixed-addr) one
        if (b.cond) e.c = b.cond;
        out.push(e);
    }
    return out;
}

/** Re-create shared breakpoints once the new listing exists, snapping each saved
 *  address to the instruction covering it in the freshly laid-out document. */
function applyBreakpoints(bps) {
    if (!Array.isArray(bps)) return;
    for (const b of bps) {
        if (!b || typeof b.a !== "string") continue;
        let addr;
        try {
            addr = bpStore.snapAddr(BigInt("0x" + b.a));
        } catch {
            continue;
        }
        // cond must be an expression string; a pre-rework {lhs,op,rhs} triple from
        // an old link is dropped (the breakpoint itself survives, unconditional).
        const cond = typeof b.c === "string" ? b.c : null;
        if (addr != null) bpStore.add(addr, { enabled: b.e !== 0, cond, stick: b.s !== 0 });
    }
}

function openElfFile(file) {
    file
        .arrayBuffer()
        .then((buf) => applyElf(parseElf(new Uint8Array(buf))))
        .then((ok) => ok && log("info", `loaded ${file.name}`))
        .catch((e) => toast("Failed to load ELF: " + errMsg(e), { err: true }));
}

/** Write the saved scalar registers back (used by share restore). */
function applyCpu(cpu, profile, modeId) {
    const known = new Set(snapshotRegs(profile, modeId).map((r) => r.name));
    for (const [name, hex] of Object.entries(cpu)) {
        if (known.has(name)) engine.writeReg(name, BigInt("0x" + hex));
    }
}

/**
 * Load a parsed ELF: detect arch/bits/endian, switch to it, write the PT_LOAD
 * segments into guest memory, rebuild the editable listing from the executable
 * segment, and set the instruction pointer. `opts.cpu` (share restore) also
 * applies the saved register file, which drives the PC.
 */
async function applyElf(parsed, opts = {}) {
    // archForElf also normalizes the entry (a Thumb ELF carries bit 0 in
    // e_entry, which selects the mode but isn't part of the address).
    const target = archForElf({
        machine: parsed.machine,
        elfClass: parsed.elfClass,
        littleEndian: parsed.littleEndian,
        entry: parsed.entry,
    });
    if (!target) {
        toast(`Unsupported ELF architecture (${machineName(parsed.machine)}).`, { err: true });
        return false;
    }
    if (!parsed.segments.length) {
        toast("ELF has no PT_LOAD segments to load.", { err: true });
        return false;
    }
    const profile = getArch(target.key);
    const fits = (vaddr, size) =>
        profile.maps.some((m) => vaddr >= m.addr && vaddr + BigInt(size) <= m.addr + m.size);
    for (const s of parsed.segments) {
        if (!fits(s.vaddr, Number(s.memsz))) {
            toast(
                `ELF segment @ 0x${toHex(s.vaddr, 8)} (0x${s.memsz.toString(16)} bytes) doesn't fit this playground's fixed memory layout.`,
                { err: true }
            );
            return false;
        }
    }

    await reinit(profile, target.modeId);

    const code = pickCodeSegment(parsed);
    // Non-code segments go straight to memory; the code segment is written via
    // writeImage so the engine's bp-gate range follows it. Persist the non-code
    // ones so they survive Reset / image re-sync (the document only models the code).
    state.dataSegments = parsed.segments.filter((s) => s !== code && s.bytes.length);
    for (const s of state.dataSegments) engine.writeMem(s.vaddr, s.bytes);
    let asm = "";
    if (code && code.bytes.length) {
        asm = disassembler
            .disasm(code.bytes, code.vaddr)
            .map(formatInsn)
            .join("\n");
    }
    doc.base = code ? code.vaddr : profile.codeBase;
    doc.setLines(asm);

    if (code && code.bytes.length) {
        if (!bytesEqual(doc.image().bytes, code.bytes)) {
            log("warning", "loaded binary differs from its reassembled listing; disassembly may be imperfect");
        }
        engine.writeImage(code.vaddr, code.bytes);
        engine.setClassMap(buildClassMap({ base: code.vaddr, bytes: code.bytes }));
    }
    state.imageDirty = false; // guest memory already holds the exact loaded bytes

    const pcName = profile.layoutFor(target.modeId).pcName;
    let pc = target.entry;
    if (opts.cpu) {
        applyCpu(opts.cpu, profile, target.modeId);
        if (opts.cpu[pcName]) pc = BigInt("0x" + opts.cpu[pcName]);
    }
    // Always pin the engine PC to the highlighted IP; idempotent with the cpu's
    // RIP write when present, corrective when a (partial) share omits it.
    engine.setPC(pc);
    doc.setIPFromAddr(pc);
    refreshAnalysis();
    editor.render();
    bpStore.clear(); // loaded program replaces the listing; drop stale breakpoints
    if (opts.bp) applyBreakpoints(opts.bp); // re-anchor shared breakpoints (store.onChange repaints)
    engine.snapshot();
    return true;
}

/** Replay shared console lines ([ts, level, message] triples) with their
 *  original timestamps; malformed entries are skipped. */
function replayLog(lines) {
    if (!Array.isArray(lines)) return;
    for (const e of lines) {
        if (!Array.isArray(e) || e.length < 3 || !Number.isFinite(e[0])) continue;
        consoleView.log(String(e[1]), String(e[2]), e[0]);
    }
}

async function restoreShare(hash) {
    try {
        const snap = await decodeShareHash(hash); // null: no share in the URL
        if (!snap) return;
        if (!(await applyElf(parseElf(snap.elfBytes), { cpu: snap.cpu, bp: snap.bp }))) return;
        replayLog(snap.log);
        log("info", "restored shared snapshot from URL");
    } catch (e) {
        toast("Couldn't restore the shared snapshot: " + errMsg(e), { err: true });
    }
}

// ---- header menus ---------------------------------------------------------
/** Swap the listing in place for a fresh program (empty or example code). */
function resetProgram(code) {
    state.dataSegments = []; // a fresh program supersedes any loaded ELF data
    doc.base = state.profile.codeBase;
    doc.setLines(code);
    doc.setIPFromAddr(doc.entryAddr());
    refreshAnalysis();
    editor.render();
    bpStore.clear(); // a fresh program supersedes the listing; drop stale breakpoints
    state.imageDirty = true;
    syncImage();
}

/** Load an example: a mode change reinits; same-mode swaps the listing in place. */
async function loadExample(ex) {
    if (ex.mode !== state.modeId) {
        await applyMode(ex.mode, ex.code);
    } else {
        resetProgram(ex.code);
    }
    log("debug", `loaded example: ${ex.name}`);
}

/** The arch/mode button label, e.g. "x86 | 64-bit"; refreshed on every reinit. */
function updateArchLabel() {
    const m = state.profile.modeOptions.find((o) => o.id === state.modeId);
    $("arch-label").textContent = `${state.profile.label} | ${m ? m.label : state.modeId}`;
}

/** Header dropdowns: the arch/mode menu (architectures as groups, one row per
 *  mode, ✓ on the active one) and the Examples menu (the current arch's list).
 *  Both are built fresh on every open, so they always reflect the live state. */
function setupMenus() {
    menuButton($("arch-btn"), (menu, close) => {
        for (const a of listArchs()) {
            const title = el("div", "popover-title");
            title.textContent = a.label;
            menu.appendChild(title);
            for (const m of getArch(a.key).modeOptions) {
                const on = a.key === state.profile.key && m.id === state.modeId;
                const row = el("div", "popover-row");
                const check = el("span", "menu-check");
                check.textContent = on ? "✓" : "";
                row.append(check, m.label);
                row.onclick = () => {
                    close();
                    if (on) return;
                    a.key === state.profile.key ? applyMode(m.id) : applyArch(a.key, m.id);
                };
                menu.appendChild(row);
            }
        }
    });
    menuButton($("example-btn"), (menu, close) => {
        menu.classList.add("ex-menu");
        const title = el("div", "popover-title");
        title.textContent = "Examples";
        const search = el("input", "select goto ex-search");
        search.placeholder = "search";
        const list = el("div", "ex-list");
        for (const ex of state.profile.examples) {
            const row = el("div", "popover-row");
            row.textContent = ex.name;
            row.onclick = () => {
                close();
                loadExample(ex);
            };
            list.appendChild(row);
        }
        search.addEventListener("input", () => {
            const q = search.value.trim().toLowerCase();
            for (const row of list.children) row.hidden = !!q && !row.textContent.toLowerCase().includes(q);
        });
        menu.append(title, search, list);
        setTimeout(() => search.focus()); // after popover() connects the menu
    });
}

function setupGotos() {
    const wire = (id, view) => {
        const el = $(id);
        if (!el) return;
        view.gotoEl = el; // the view mirrors its top visible address into this field, live
        el.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                view.goto(el.value);
                el.blur(); // commit + let the field fall back to the live address
            }
        });
        el.addEventListener("blur", () => view._syncGoto());
        view._syncGoto();
    };
    wire("ed-goto", editor);
    wire("mem-goto", memory);
    wire("stack-goto", stack);
}

function setupAbout() {
    const modal = $("about-modal");
    const close = () => (modal.hidden = true);
    $("btn-about").onclick = () => (modal.hidden = false);
    $("about-close").onclick = close;
    modal.addEventListener("click", (e) => {
        if (e.target === modal) close(); // backdrop click
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !modal.hidden) close();
    });
}

/** Disassembly "view options" gear: a small popover toggling the editor's row
 *  filters (hide zero padding / hide non-executable regions). */
function setupViewSettings() {
    const btn = $("ed-view");
    if (!btn) return;
    menuButton(btn, (menu) => {
        menu.innerHTML =
            '<div class="popover-title">Disassembly view</div>' +
            '<label class="popover-row"><input type="checkbox" data-filter="hidePad" /> Hide zero padding</label>' +
            '<label class="popover-row"><input type="checkbox" data-filter="hideNonExec" /> Hide non-executable regions</label>';
        for (const b of menu.querySelectorAll("input[data-filter]")) {
            b.checked = !!editor[b.dataset.filter]; // reflect live state
            b.addEventListener("change", () => editor.setFilter(b.dataset.filter, b.checked));
        }
    }, { align: "right" });
}

/** Share popover (header): builds a permalink encoding memory + CPU (both always
 *  included) and, optionally, the breakpoints and console logs. The link is shown
 *  in a read-only field with a copy button and a live character count. The ELF
 *  snapshot is built once on open; toggling an option re-encodes it (one small gzip). */
function setupShare() {
    const btn = $("btn-share");
    if (!btn) return;
    const pop = document.createElement("div");
    pop.className = "popover share-pop";
    pop.hidden = true;
    pop.innerHTML =
        '<div class="popover-title">Share snapshot</div>' +
        '<div class="input-group share-url">' +
        '<input class="select share-field" type="text" readonly spellcheck="false" placeholder="building link..." />' +
        `<button class="btn icon-only share-copy" title="Copy link" disabled>${icon("copy")}</button>` +
        "</div>" +
        '<div class="share-count">&nbsp;</div>' +
        '<div class="share-opts">' +
        '<label class="popover-row"><input type="checkbox" data-part="memory" checked disabled /> Memory state</label>' +
        '<label class="popover-row"><input type="checkbox" data-part="cpu" checked disabled /> CPU state</label>' +
        '<label class="popover-row"><input type="checkbox" data-part="bp" /> Breakpoints</label>' +
        '<label class="popover-row"><input type="checkbox" data-part="log" /> Console logs</label>' +
        "</div>";

    const field = pop.querySelector(".share-field");
    const copyBtn = pop.querySelector(".share-copy");
    const count = pop.querySelector(".share-count");
    const bpBox = pop.querySelector('input[data-part="bp"]');
    const logBox = pop.querySelector('input[data-part="log"]');

    let snap = null; // cached { elfBytes, cpu } (the expensive ELF build), null until built
    let bpData = []; // breakpoints captured at open
    let logData = []; // console lines captured at open
    let renderSeq = 0;

    // Re-encode the URL from the cached snapshot (one small gzip); runs on open
    // and on every option toggle. The seq guard drops a stale encode that resolves
    // after a newer toggle, or after the card was dismissed.
    async function render() {
        if (!snap) return;
        const seq = ++renderSeq;
        const hash = await encodeShareHash({
            ...snap,
            bp: bpBox.checked ? bpData : null,
            log: logBox.checked ? logData : null,
        });
        if (seq !== renderSeq || !card) return;
        const url = location.origin + location.pathname + "#" + hash;
        field.value = url;
        count.textContent = `${url.length.toLocaleString()} characters`;
        copyBtn.disabled = false;
    }

    bpBox.addEventListener("change", render);
    logBox.addEventListener("change", render);

    copyBtn.addEventListener("click", async () => {
        if (!field.value) return;
        field.select();
        if (!(await copyWithCheck(copyBtn, field.value))) toast("Clipboard unavailable. Select and copy manually.");
    });

    // Centered under the share button (gap 9 leaves room for the caret pointing up
    // at it). The caret's x is tracked separately (--caret-x) so it keeps pointing
    // at the button even when the card is shifted to stay on-screen; it's measured
    // from the card's padding box (the abs-positioning origin), so subtract the
    // card's left border (clientLeft), and clamp to keep it within the card.
    let card = null; // popover handle, null when closed
    function place() {
        card.place();
        const center = btn.getBoundingClientRect().left + btn.offsetWidth / 2;
        const caretX = center - pop.getBoundingClientRect().left - pop.clientLeft;
        pop.style.setProperty("--caret-x", Math.max(14, Math.min(caretX, pop.clientWidth - 14)) + "px");
    }

    async function open() {
        snap = null;
        bpData = [];
        logData = [];
        bpBox.checked = false; // the optional parts default to off on every open
        logBox.checked = false;
        field.value = "";
        copyBtn.disabled = true;
        copyBtn.innerHTML = icon("copy");
        copyBtn.classList.remove("ok");
        count.textContent = "building link...";
        card = popover(pop, btn, {
            align: "center",
            gap: 9,
            keep: btn,
            onClose: () => {
                pop.hidden = true;
                card = null;
            },
        });
        place();

        if (!engine.ready) {
            count.textContent = "engine isn't ready yet";
            return;
        }
        syncImage(); // fold any pending edits into guest memory before snapshotting it
        const entry = engine.pc != null ? engine.pc : doc.entryAddr();
        try {
            const elfBytes = await buildElf({
                engine,
                profile: state.profile,
                modeId: state.modeId,
                entry,
                liveMaps: mapsView && mapsView.maps,
            });
            const pcName = state.profile.layoutFor(state.modeId).pcName;
            snap = { elfBytes, cpu: captureCpu(engine, { pcName, entry }) };
            bpData = captureBreakpoints();
            logData = consoleView.export();
        } catch (e) {
            count.textContent = "share failed";
            return toast("Share failed: " + errMsg(e), { err: true });
        }
        await render();
        if (card) place(); // the field now has content; re-clamp against its real height
    }

    btn.onclick = () => (card ? card.close() : open());
}

// ---- bus wiring ---------------------------------------------------------
function wireBus() {
    bus.on(EV.REGS, ({ regs }) => {
        // Isolate each panel: a throw in one must not skip the others.
        const safe = (fn) => {
            try {
                fn();
            } catch (e) {
                console.error("[regs] panel update failed", e);
            }
        };
        safe(() => registers.update(regs));
        safe(() => stack.onStop(regs)); // refreshes the SP marker, then follows the pin (default SP)
        safe(() => memory.onStop());
        safe(() => inspector.onStop());
    });

    bus.on(EV.MEM, ({ addr, bytes, valid, tag }) => {
        if (tag === "stack") stack.onData(addr, bytes, valid);
        else if (tag === "disasm") editor.onDisasmData(addr, bytes);
        else memory.onData(addr, bytes, valid);
    });

    bus.on(EV.STATE, ({ state: st, pc, reason }) => {
        if (pc != null && (st === "paused" || st === "exited" || st === "faulted")) {
            doc.setIPFromAddr(pc);
            editor.refresh();
        }
        if (reason === "breakpoint") log("info", `breakpoint hit @ 0x${toHex(pc, 8)}`);
        if (reason === "timeout") toast("Auto-paused after 5s (possible infinite loop).");
        if (st === "exited") log("info", `program exited @ 0x${toHex(pc, 8)}`);
    });

    // The IP marker was already repositioned by the preceding STATE("faulted").
    bus.on(EV.FAULT, ({ message }) => toast(message, { err: true }));

    bus.on(EV.CONSOLE, ({ level, text }) => log(level, text));
}

// ---- boot ---------------------------------------------------------------
async function boot() {
    initTheme();
    initConsent(); // cookie-consent banner; independent of the rest of boot
    applyIcons(); // inflate the <i data-icon> placeholders in index.html to SVG
    const layout = setupLayout(); // tile the panel sources into #layout-root before views attach
    bus = new EventBus();
    // The console view backs log(); build it first so the boot messages land in it.
    consoleView = new Console($("console"), {
        filterInput: $("con-filter"),
        filterBtn: $("con-filter-btn"),
        copyBtn: $("con-copy"),
        clearBtn: $("con-clear"),
        downloadBtn: $("con-download"),
    });

    log("debug", "loading Keystone + Capstone...");
    // Both are hard dependencies: a load failure rejects boot() and is reported
    // by the boot().catch handler. There is no tool-less degraded mode.
    const ksMod = await loadKeystone();
    const csMod = await MCapstone({ locateFile: () => new URL(csWasmUrl, import.meta.url).href });
    assembler = new Assembler(ksMod);
    disassembler = new Disassembler(csMod);

    state.profile = getArch("x86");
    state.modeId = state.profile.defaultMode;
    await configureTools(state.modeId);

    doc = new Document({
        base: state.profile.codeBase,
        assemble: (t, addr) => assembler.asm(t, addr),
        positionSensitive: isPositionSensitive,
    });
    bpStore = new BreakpointStore(doc);
    editor = new Editor($("editor"), {
        doc,
        disassembler, // decodes the mapped data/stack regions shown past the code
        onChange: () => {
            state.imageDirty = true;
            refreshAnalysis();
            syncBreakpoints(); // addresses reflow; refresh the panel (breakpoints stay keyed by addr)
        },
        breakpoints: bpStore,
        onRunToCursor: (lineId) => runToCursor(lineId),
        onSetIP: (lineId) => setInstructionPointer(lineId),
        onSetEntry: (lineId) => setEntryPoint(lineId),
        onInspect: (expr) => inspector.hoverExpr(expr), // hover an operand register
    });
    editor.arrows = new ArrowGutter();
    registers = new Registers($("registers"), {
        onWriteReg: (name, value) => engine.writeReg(name, value),
        onInspect: (src) => inspector.show(src),
        filterInput: $("reg-filter"),
        filterBtn: $("reg-filter-btn"),
    });
    inspector = new Inspector($("inspector"), { evalInspect });
    inspector.bindExprInput($("inspect-expr"));
    registers.setMode(state.profile, state.modeId);

    // Load the default example.
    const ex0 = state.profile.examples[0];
    doc.setLines(ex0.code);
    doc.setIPFromAddr(doc.entryAddr());
    editor.setMaps(state.profile.maps); // exec-region bounds for the padding tail
    editor.setPadding(paddingInsn()); // what the zero padding decodes to
    refreshAnalysis();
    editor.render();

    // Controls.
    setupMenus();
    updateArchLabel();
    bindTransport(
        { run, pause: () => engine.pause(), stepIn, stepOver, stepOut, reset: resetExec },
        bus
    );
    $("btn-addline").onclick = () => editor.appendAndEdit();
    $("btn-add-panel").onclick = (e) => layout.addPanelMenu(e.currentTarget);
    $("btn-theme").onclick = () => toggleTheme();
    $("btn-pin").onclick = (e) => setPinBtn(e.currentTarget, inspector.togglePin());
    $("btn-new").onclick = () => {
        resetProgram("");
        log("debug", "new file");
    };
    $("btn-open").onclick = () => $("file-elf").click();
    $("file-elf").onchange = (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) openElfFile(f);
        e.target.value = ""; // let the same file be reopened
    };
    $("btn-save").onclick = () => doSave();
    document.addEventListener("keydown", (e) => {
        const editing = document.activeElement && document.activeElement.tagName === "INPUT";
        if (editing) return;
        if (e.key === "F5") {
            e.preventDefault();
            run();
        } else if (e.key === "F10") {
            e.preventDefault();
            stepOver();
        } else if (e.key === "F11") {
            e.preventDefault();
            e.shiftKey ? stepOut() : stepIn();
        }
    });

    // Engine + bottom-deck panels.
    engine = new DebugEngine(bus);
    editor.engine = engine; // lets the Disassembly view read live data/stack bytes
    memory = new MemoryView($("memory"), {
        engine,
        onInspect: (s) => inspector.show(s),
        evalAddr,
        onPinChange: (p) => setPinBtn($("mem-pin"), p),
    });
    memory.base = state.profile.codeBase;
    memory.setMaps(state.profile.maps);
    stack = new StackView($("stack"), {
        engine,
        onInspect: (s) => inspector.show(s),
        evalAddr,
        onPinChange: (p) => setPinBtn($("stack-pin"), p),
    });
    stack.setMode(state.profile, state.modeId);
    stack.setMaps(state.profile.maps);
    mapsView = new MapsView($("maps"), { engine });
    mapsView.setMaps(state.profile.maps);
    editor.setMaps(state.profile.maps);

    // Breakpoints panel: create/remove/condition-edit without the Disassembly view.
    // The editor already re-renders its gutter on store change (it subscribes
    // itself); here we keep the panel in sync with the same store.
    breakpointsView = new BreakpointsView($("breakpoints"), {
        store: bpStore,
        evalAddr,
        toast,
        addInput: $("bp-add-expr"),
        addBtn: $("bp-add"),
    });
    bpStore.onChange(() => breakpointsView.render());
    $("bp-clear").onclick = () => bpStore.clear();

    setupGotos();
    setupAbout();
    setupViewSettings();
    setupShare();
    $("reg-reset").onclick = () => resetRegs();
    $("stack-sp").onclick = () => stack.gotoSP();
    $("mem-pin").onclick = () => memory.togglePin();
    $("stack-pin").onclick = () => stack.togglePin();
    $("ed-ip").onclick = () => editor.gotoIP();
    const paintSplit = () => ($("ed-split").style.color = editor.split ? "var(--accent)" : "");
    $("ed-split").onclick = () => {
        editor.toggleSplit();
        paintSplit();
    };
    paintSplit(); // reflect the persisted split mode on load
    $("map-new").onclick = () => mapsView.addRegion();
    $("map-del").onclick = () => mapsView.deleteSelected();
    wireBus();
    log("debug", "starting Unicorn worker...");
    await engine.init(state.profile, state.modeId, codeRegion(state.profile).end);
    syncImage();
    log("info", "ready; press Run or Step into (F11).");

    // A shared snapshot in the URL takes over the freshly-booted state.
    await restoreShare(location.hash);
}

boot().catch((e) => {
    console.error(e);
    log("error", "boot failed: " + errMsg(e));
});
