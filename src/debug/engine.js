/*
 * Debug engine: main-thread orchestrator for the Unicorn worker. Owns the
 * Worker, exposes intent methods (init/run/stepIn/...), and republishes worker
 * messages onto the event bus. The UI talks only to this + the bus, never to
 * Unicorn directly.
 */
import { EV } from "../core/events.js";
import { REQ, RES } from "../core/protocol.js";
import { snapshotRegs, modeNames, endianOf } from "../arch/index.js";
import { asU8 } from "../core/bigint.js";

export class DebugEngine {
    constructor(bus) {
        this.bus = bus;
        this.worker = null;
        this.ready = false;
        this.state = "uninit"; // uninit|paused|running|exited|faulted
        this.pc = null; // BigInt
        this.regs = []; // last snapshot [{name,size,bytes}]
        this._readyResolvers = [];
        this._pendingReads = new Map(); // tag -> resolve, for readMemAsync
        this._readSeq = 0;
    }

    _spawn() {
        if (this.worker) return;
        // engine-worker.js is a sibling entry point in the build output, so this
        // resolves to build/engine-worker.js next to the bundled app at runtime.
        // Append the build id as a cache-buster: the worker is fetched by a fixed
        // name, so a browser/Worker cache would otherwise keep an old engine alive
        // across rebuilds (stale safeRead/fault handling). __BUILD_ID__ is injected
        // by esbuild; it's undefined under plain node, so guard for that.
        const workerUrl = new URL("./engine-worker.js", import.meta.url);
        workerUrl.search = "v=" + (typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev");
        this.worker = new Worker(workerUrl, { type: "module" });
        this.worker.onmessage = (ev) => this._onMessage(ev.data || {});
        this.worker.onerror = (err) =>
            this.bus.emit(EV.CONSOLE, { level: "error", text: "worker error: " + err.message });
    }

    async init(profile, modeId, codeEnd) {
        this._spawn();
        this.ready = false;
        const names = modeNames(profile, modeId);
        const msg = {
            type: REQ.INIT,
            prefix: profile.prefix,
            ucArch: names.ucArch,
            ucMode: names.ucMode,
            regs: snapshotRegs(profile, modeId),
            pcName: profile.layoutFor(modeId).pcName,
            spName: profile.layoutFor(modeId).spName,
            // For evaluating conditional-breakpoint expressions in the worker:
            // the sub-register slicing table + pointer width (see core/expr.js).
            subRegs: profile.subRegsFor(modeId) || {},
            regSize: profile.layoutFor(modeId).regSize,
            bigEndian: endianOf(profile, modeId) === "big",
            // Arch quirks the run/step paths must compensate for (see the
            // pcFixup/delaySlots notes in engine-worker.js).
            pcFixup: !!profile.pcFixup,
            delaySlots: !!profile.delaySlots,
            maps: profile.maps.map((m) => ({
                addr: m.addr.toString(),
                size: m.size.toString(),
                perms: m.perms,
            })),
            stackTop: profile.stackTop.toString(),
            codeBase: profile.codeBase.toString(),
            codeEnd: (codeEnd != null ? codeEnd : profile.codeBase + 0x1000n).toString(),
        };
        this.worker.postMessage(msg);
        return new Promise((res) => this._readyResolvers.push(res));
    }

    writeImage(base, bytes) {
        // isCode tells the worker to advance its code-end / breakpoint-gate to
        // this image (see engine-worker.js setCodeEndFromImage).
        this.worker.postMessage({
            type: REQ.WRITE_MEM,
            addr: base.toString(),
            bytes: Array.from(bytes),
            isCode: true,
        });
    }

    setPC(value) {
        this.worker.postMessage({ type: REQ.SET_PC, value: value.toString() });
    }
    writeReg(name, value) {
        // The worker sizes the write from its own regList (the wire `size` was
        // always redundant), so we only send name + value.
        this.worker.postMessage({ type: REQ.WRITE_REG, name, value: value.toString() });
    }
    readMem(addr, size, tag) {
        this.worker.postMessage({ type: REQ.READ_MEM, addr: addr.toString(), size, tag });
    }
    /**
     * Promise-based read for one-shot consumers (ELF save/share). Uses a private
     * tag and resolves off the shared bus, so it never reaches the memory/stack
     * views. Returns the bytes as a Uint8Array.
     */
    readMemAsync(addr, size, timeoutMs = 5000) {
        const tag = "rd:" + this._readSeq++;
        return new Promise((resolve, reject) => {
            if (!this.worker) return reject(new Error("engine not started"));
            // The worker answers every READ_MEM with RES.MEM (safeRead zero-fills
            // unmapped bytes rather than erroring), so this normally settles. Keep a
            // timeout anyway as a backstop against a dropped/never-answered message
            // leaking the pending entry and hanging the caller (e.g. ELF save/share).
            const timer = setTimeout(() => {
                this._pendingReads.delete(tag);
                reject(new Error(`memory read timed out (0x${BigInt(addr).toString(16)}, ${size} bytes)`));
            }, timeoutMs);
            this._pendingReads.set(tag, (bytes) => {
                clearTimeout(timer);
                resolve(bytes);
            });
            this.worker.postMessage({ type: REQ.READ_MEM, addr: addr.toString(), size, tag });
        });
    }
    writeMem(addr, bytes) {
        this.worker.postMessage({ type: REQ.WRITE_MEM, addr: addr.toString(), bytes: Array.from(bytes) });
    }
    _region(type, addr, size, perms) {
        const msg = { type, addr: addr.toString(), size: size.toString() };
        if (perms != null) msg.perms = Number(perms);
        this.worker.postMessage(msg);
    }
    /** Live-change a mapped region's protection (Memory Maps panel). */
    setProt(addr, size, perms) {
        this._region(REQ.SET_PROT, addr, size, perms);
    }
    /** Live-map a new region (Memory Maps "new"). */
    mapRegion(addr, size, perms) {
        this._region(REQ.MAP, addr, size, perms);
    }
    /** Live-unmap a region (Memory Maps "delete"). */
    unmapRegion(addr, size) {
        this._region(REQ.UNMAP, addr, size);
    }
    snapshot() {
        this.worker.postMessage({ type: REQ.SNAPSHOT });
    }

    setClassMap(map) {
        this.worker.postMessage({ type: REQ.SET_CLASSMAP, map });
    }

    // Normalize {addr:BigInt, cond?} entries to the wire form [{ addr:decstr, cond }].
    _bp(breakpoints) {
        return (breakpoints || []).map((b) => ({ addr: b.addr.toString(), cond: b.cond || null }));
    }
    _exec(type, from, until, breakpoints) {
        this.worker.postMessage({
            type,
            from: from.toString(),
            until: until.toString(),
            breakpoints: this._bp(breakpoints),
        });
    }
    run(from, until, bps) {
        this._exec(REQ.RUN, from, until, bps);
    }
    stepIn(from, until, bps) {
        this._exec(REQ.STEP_IN, from, until, bps);
    }
    stepOver(from, until, bps) {
        this._exec(REQ.STEP_OVER, from, until, bps);
    }
    stepOut(from, until, bps) {
        this._exec(REQ.STEP_OUT, from, until, bps);
    }
    pause() {
        this.worker.postMessage({ type: REQ.PAUSE });
    }
    reset() {
        this.worker.postMessage({ type: REQ.RESET });
    }
    /** Zero the registers (PC->entry, SP->stack top) without touching guest memory. */
    resetRegs() {
        this.worker.postMessage({ type: REQ.RESET_REGS });
    }

    // ---- worker -> bus ----------------------------------------------------
    _onMessage(m) {
        switch (m.type) {
            case RES.READY:
                this.ready = true;
                this.state = "paused";
                this.bus.emit(EV.ENGINE_READY, { version: m.version });
                this._readyResolvers.splice(0).forEach((r) => r());
                break;
            case RES.REGS:
                this.regs = m.regs;
                this.pc = BigInt(m.pc);
                this.bus.emit(EV.REGS, { regs: m.regs, pc: this.pc });
                break;
            case RES.STATE:
                this.state = m.state;
                if (m.pc != null) this.pc = BigInt(m.pc);
                this.bus.emit(EV.STATE, { state: m.state, pc: this.pc, reason: m.reason });
                break;
            case RES.MEM: {
                const pending = this._pendingReads.get(m.tag);
                if (pending) {
                    this._pendingReads.delete(m.tag);
                    pending(asU8(m.bytes));
                } else {
                    this.bus.emit(EV.MEM, { addr: BigInt(m.addr), bytes: m.bytes, valid: m.valid, tag: m.tag });
                }
                break;
            }
            case RES.FAULT:
                this.bus.emit(EV.FAULT, {
                    message: m.message,
                    errno: m.errno,
                    pc: m.pc != null ? BigInt(m.pc) : null,
                });
                this.bus.emit(EV.CONSOLE, { level: "error", text: `fault: ${m.message}` });
                break;
            case RES.LOG:
                this.bus.emit(EV.CONSOLE, { level: m.level, text: m.text });
                break;
            case RES.ERROR:
                this.bus.emit(EV.CONSOLE, { level: "error", text: m.message });
                break;
        }
    }
}
