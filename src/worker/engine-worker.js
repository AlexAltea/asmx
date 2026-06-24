/*
 * Engine worker (MODULE worker). Hosts the Unicorn engine off the main thread
 * so the synchronous, blocking emu_start never freezes the UI. As a module
 * worker it `import`s the shared helpers and the wire-protocol constants, and
 * lazily loads the all-arch Unicorn build (one dynamic import that esbuild
 * splits into its own on-demand chunk) the first time an engine is created.
 *
 * Supports: init + memory/register I/O + snapshot + run (breakpoint-gated,
 * chunked, pausable, wall-clock guarded) + step in/over/out (shadow call stack)
 * + fault reporting.
 */
import { bytesToBig, bigToBytes, errMsg } from "../core/bigint.js";
import { evaluateSync } from "../core/expr.js";
import { REQ, RES } from "../core/protocol.js";

let uc = null; // Unicorn module (all-arch), instantiated once and reused
let e = null; // Unicorn instance
let cfg = null; // last init config (for reset)
let regList = []; // [{name, id, size, group}]
let regByName = new Map(); // name -> regList entry
let pcId = 0,
    spId = 0,
    pcSize = 8,
    spSize = 8;
let pcName = "", // string register names, for the conditional-breakpoint eval ctx
    spName = "",
    subRegsMap = {}, // arch sub-register slicing table (eax/bx/al...), see core/expr.js
    ptrSize = 8; // pointer width (bytes) used to size derefs in conditions
let codeStart = 0n,
    codeEnd = 0n;
// Thumb keeps its ISA state in bit 0 of the emu_start begin address (Unicorn's
// arm_set_pc convention: an even begin silently drops to ARM state). OR'd into
// every emu_start; everything read back (PC, hook addresses) stays even, so all
// other address bookkeeping lives in plain-address space.
let thumbBit = 0n;
// Arch quirks (from the profile via INIT):
// - pcFixup (MIPS, SPARC): after emu_start stops at `until`, reg_read(PC) returns
//   the LAST EXECUTED instruction's address, not `until`. The gate hook records
//   that address (lastHookPc), so a stop where readPC() === lastHookPc means we
//   ran into `until` (readPC is stale); a genuine mid-stream count stop instead
//   reads the NEXT instruction, and a breakpoint stop never updated lastHookPc.
//   Worse, SPARC64 never stops at `until` at all: it RE-EXECUTES the final
//   instruction until the count budget runs out (side effects repeat). The gate
//   hook detects that respin (the same non-branch address firing twice in a row
//   is impossible in real execution) and stops before the re-execution.
// - delaySlots (MIPS, SPARC): a branch and its delay slot execute as a unit. A
//   lone stepped branch loses its pending target on the next emu_start, and a
//   fixed count=2 overshoots an annulled SPARC slot (which consumes no count
//   unit), so stepping a branch runs under a "fence" that stops at the first
//   instruction outside the {branch, slot} pair (see stepInCore). Resuming from
//   inside a pair backs up to the branch (see resumeBegin).
let pcFixup = false;
let delaySlots = false;
let lastHookPc = -1n; // last address the gate hook let execute (stale-PC + respin detection)
let stepFence = null; // {begin, slot} while fence-stepping a delay-slot branch
const DELAY_STEP_CAP = 4; // instruction budget bounding a fenced branch step (self-branch guard)

let bpSet = new Set(); // breakpoint addresses (BigInt)
let bpCond = new Map(); // addr(string) -> condition expression string
let classMap = {}; // addr(string) -> {c:isCall, r:isRet, sz:size}
let shadow = []; // shadow call stack: [{ret:BigInt, sp:BigInt}]
let codeHook = null;
let faultInfo = null; // {errno, addr?, intr?, pc?} captured by the fault hooks
let running = false;
let pauseRequested = false;
let resumeFrom = -1n; // one-shot: skip the bp under the cursor on resume
let hitBp = null; // breakpoint address that stopped us
let tempTarget = null; // step-over/out: stop when pc hits this...
let tempSpGuard = 0n; // ...and SP has unwound to/above this
let hitTemp = false;

const CHUNK = 200000;
const RUN_GUARD_MS = 5000; // auto-pause guard against runaway loops

// Unicorn memtype (UC_MEM_*) -> error code (UC_ERR_*) for the invalid-access
// hook. Values are stable across builds; hard-coded so we don't depend on the
// uc.ERR_*/uc.MEM_* constants being present at hook time. See core enums:
//   19 READ_UNMAPPED, 20 WRITE_UNMAPPED, 21 FETCH_UNMAPPED,
//   22 WRITE_PROT,    23 READ_PROT,      24 FETCH_PROT.
const MEM_ERR = { 19: 6, 20: 7, 21: 8, 22: 12, 23: 13, 24: 14 };
const ERR_EXCEPTION = 21; // UC_ERR_EXCEPTION (unhandled CPU exception / interrupt)

// ---- tiny helpers -------------------------------------------------------
function post(type, data, transfer) {
    postMessage({ type, ...data }, transfer || []);
}
function log(level, text) {
    post(RES.LOG, { level, text });
}

function readReg(id, size) {
    return e.reg_read(id, size); // Uint8Array, native little-endian
}
function readPC() {
    return bytesToBig(readReg(pcId, pcSize));
}
function readSP() {
    return bytesToBig(readReg(spId, spSize));
}

// ---- engine lifecycle ---------------------------------------------------
// The @alexaltea/unicorn-js package ships a single all-arch build (one file, wasm
// embedded) whose default export is an Emscripten MODULARIZE factory; one
// instantiation covers every architecture the app offers. Dynamic import so
// esbuild splits it into its own on-demand chunk instead of inlining ~9 MB into
// the worker entry (which the ?v= cache-bust would then re-download every build).
async function loadUnicorn() {
    const mod = await import("@alexaltea/unicorn-js");
    return mod.default ?? mod;
}

async function doInit(msg) {
    cfg = msg;
    if (!uc) {
        const factory = await loadUnicorn();
        uc = await factory();
    }

    if (e) {
        try {
            e.close();
        } catch {}
        e = null;
    }
    const arch = uc[msg.ucArch];
    let mode = 0;
    for (const m of msg.ucMode) mode |= uc[m] || 0; // constant names, OR'd (e.g. MODE_MIPS32 | MODE_BIG_ENDIAN)
    thumbBit = msg.ucMode.includes("MODE_THUMB") ? 1n : 0n;
    pcFixup = !!msg.pcFixup;
    delaySlots = !!msg.delaySlots;
    e = new uc.Unicorn(arch, mode);

    // Map guest memory. Re-init (reset / mode switch) closes the old engine and
    // creates a new one, but the underlying wasm heap is reused and NOT zeroed, so
    // explicitly clear each region; otherwise a reset would leave stale bytes
    // (and an ELF save after a reset/load would capture them).
    for (const m of msg.maps) {
        const addr = BigInt(m.addr);
        const size = Number(m.size);
        // perms is a PROT bitmask (see core/mem.js); its values equal Unicorn's
        // PROT_* constants, so pass it straight through.
        e.mem_map(addr, BigInt(size), Number(m.perms));
        e.mem_write(addr, new Uint8Array(size));
    }

    // Resolve register ids by name via the arch prefix; a reg entry's `uc`
    // overrides the constant suffix when it differs from the display name
    // (PPC "R3" -> PPC_REG_3, see arch/index.js snapshotRegs).
    const rid = (name) => uc[`${msg.prefix}_REG_${name}`];
    regList = msg.regs.map((r) => ({ ...r, id: rid(r.uc || r.name) }));
    regByName = new Map(regList.map((r) => [r.name, r]));
    pcId = regByName.get(msg.pcName)?.id ?? rid(msg.pcName);
    spId = regByName.get(msg.spName)?.id ?? rid(msg.spName);
    pcSize = regSizeOf(msg.pcName);
    spSize = regSizeOf(msg.spName);
    pcName = msg.pcName;
    spName = msg.spName;
    subRegsMap = msg.subRegs || {};
    ptrSize = Number(msg.regSize) || pcSize;
    shadow = [];

    codeStart = BigInt(msg.codeBase);
    codeEnd = BigInt(msg.codeEnd != null ? msg.codeEnd : BigInt(msg.codeBase) + 0x1000n);

    // Boot the register file: zero everything, then park SP at the stack top and PC
    // at the entry (code base). Shared with the Registers panel's reset button via
    // resetRegs(), so "reset" means the same thing in both places. A fresh engine
    // already zeroes its registers, so the zeroing here is a harmless no-op; the
    // SP/PC homing is what matters on first init: without the PC write the engine
    // would start at 0 while the disassembly highlights the entry row, and the two
    // must agree. An ELF load later overrides PC with the file's real entry.
    resetRegs();

    installGate();
    installFaultHooks();
    // uc.version() in the prebuilt dist relies on sloppy-mode implicit globals
    // (unicorn-wrapper.js assigns major_ptr/minor_ptr without `var`), which throw
    // under ESM strict mode. It's cosmetic, so guard it rather than abort init.
    let version = 0;
    try {
        version = uc.version ? uc.version() : 0;
    } catch {}
    post(RES.READY, { version });
    snapshot();
}

function regSizeOf(name) {
    return regByName.get(name)?.size ?? (Number(cfg.regSize) || 8);
}

// Reset the register file to its boot state: every register zeroed, then SP parked
// at the stack top and PC at the entry (code base), their "usual" homes. Shared by
// a full reset (doInit) and the Registers panel's reset button (REQ.RESET_REGS),
// which resets registers WITHOUT touching guest memory. Writing 0 to EFLAGS is a
// no-op for its reserved bit (Unicorn reads it back as 0x2) and a null segment
// selector (0) is always accepted, so nothing here throws, but stay defensive.
function resetRegs() {
    for (const r of regList) {
        if (r.id === pcId || r.id === spId) continue;
        try {
            e.reg_write(r.id, Array.from(new Uint8Array(r.size)));
        } catch {}
    }
    if (cfg.stackTop != null) e.reg_write(spId, Array.from(bigToBytes(BigInt(cfg.stackTop), spSize)));
    e.reg_write(pcId, Array.from(bigToBytes(codeStart, pcSize)));
}

function installGate() {
    if (codeHook != null) {
        try {
            e.hook_del(codeHook);
        } catch {}
    }
    codeHook = e.hook_add(
        uc.HOOK_CODE,
        (h, addr, size, ud) => {
            const pc = BigInt(addr);

            // SPARC64 until-respin (see pcFixup above): only an annulled
            // self-branch could legitimately fire the same address twice in a
            // row, and branches are excluded via the classMap, so this firing
            // pattern means the engine ran past `until` and is about to
            // re-execute the final instruction. Stop before it does.
            if (pcFixup && pc === lastHookPc && !(classMap[pc.toString()] || {}).b) {
                e.emu_stop();
                return;
            }

            // Fenced branch step (see stepInCore): the branch and its delay slot
            // have run; the first instruction outside the pair is the landing.
            // Stop before it executes so readPC() reports the landing address.
            if (stepFence && pc !== stepFence.begin && pc !== stepFence.slot) {
                e.emu_stop();
                return;
            }

            // Stop conditions are checked BEFORE shadow maintenance: if we stop on
            // this instruction it does NOT execute, so its call/ret must not mutate
            // the shadow stack (critical when step-out's target IS a `ret`).
            if (tempTarget != null && pc === tempTarget && readSP() >= tempSpGuard) {
                hitTemp = true;
                e.emu_stop();
                return;
            }
            if (pc !== resumeFrom && bpSet.has(pc)) {
                const cond = bpCond.get(pc.toString());
                if (!cond || condStops(cond)) {
                    hitBp = pc;
                    e.emu_stop();
                    return;
                }
                // Conditional breakpoint whose condition is false: don't stop;
                // fall through so this instruction executes (and its call/ret still
                // maintains the shadow stack below).
            }
            if (pc === resumeFrom) resumeFrom = -1n; // one-shot, but still executes

            // This instruction will execute -> remember it for the respin check
            // and maintain the shadow call stack (push the return address on a
            // call, pop on a ret). A stopped instruction must set neither: it
            // has not executed.
            lastHookPc = pc;
            const ci = classMap[pc.toString()];
            if (ci) {
                if (ci.c) shadow.push({ ret: pc + BigInt(ci.sz), sp: readSP() });
                else if (ci.r && shadow.length) shadow.pop();
            }
        },
        {},
        // pcFixup relies on lastHookPc tracking every executed instruction
        // (including the respin), so those arches hook every address (begin >
        // end = unranged); the rest keep the cheaper code-region range.
        pcFixup ? 1n : codeStart,
        pcFixup ? 0n : codeEnd
    );
}

/**
 * Fault-capture hooks. Critical for accurate fault messages: after emu_start
 * faults, uc_errno() reads back UC_ERR_OK(0), and when the fault unwinds through
 * a JS hook frame it surfaces as an OPAQUE wasm trap ("memory access out of
 * bounds") with no parseable code, so neither e.errno() nor the thrown text is
 * reliable. These hooks record the precise reason BEFORE the trap unwinds, into
 * `faultInfo`, which handleFault() then prefers. (UC_HOOK_INSN_INVALID is
 * "Unimplemented" in this build, so bad instructions stay on the thrown-string
 * path, which still carries a clean code on a fresh engine.)
 */
function installFaultHooks() {
    // Fires only on INVALID accesses (unmapped / protection), never valid ones.
    // Returning false = "not handled" -> let it fault as before.
    e.hook_add(
        uc.HOOK_MEM_INVALID,
        (h, type, addr) => {
            faultInfo = { errno: MEM_ERR[type] != null ? MEM_ERR[type] : ERR_EXCEPTION, addr: BigInt(addr) };
            return false;
        },
        {}
    );
    // Software interrupts (int 0x80, int3, ...). No syscalls are emulated, so any
    // interrupt is an unhandled exception: record it and stop cleanly (the
    // run/step loops detect faultInfo after emu_start returns). 64-bit `syscall`
    // is a distinct instruction that does NOT raise INTR, so it still no-ops.
    e.hook_add(
        uc.HOOK_INTR,
        (h, intno) => {
            let pc = 0n;
            try {
                pc = readPC();
            } catch {}
            faultInfo = { errno: ERR_EXCEPTION, intr: Number(intno), pc };
            e.emu_stop();
        },
        {}
    );
}

// ---- snapshots ----------------------------------------------------------
function snapshot() {
    const regs = regList.map((r) => ({
        name: r.name,
        size: r.size,
        bytes: Uint8Array.from(readReg(r.id, r.size)),
    }));
    post(RES.REGS, { regs, pc: readPC().toString() });
}

function setCodeEndFromImage(base, len) {
    codeStart = BigInt(base);
    codeEnd = BigInt(base) + BigInt(len);
}

/**
 * Read a memory window without faulting on gaps. The Memory/Stack virtual bar
 * can scroll across the whole [lowest, highest] mapped span, which includes
 * unmapped holes; a single mem_read over any unmapped byte throws. Returns
 * `{ bytes, valid }` where `valid[i]` is 1 for a mapped byte and 0 for an
 * unmapped one, so the views can render holes as `??` instead of fake zeros.
 * Fast path: the whole read succeeds. Fallback: 16-byte chunks; on a failing
 * chunk, refine byte-by-byte so `valid` stays accurate across a map edge.
 */
function safeRead(addr, size) {
    const bytes = new Uint8Array(size);
    const valid = new Uint8Array(size); // 0 = unmapped
    try {
        bytes.set(Uint8Array.from(e.mem_read(addr, size)));
        valid.fill(1);
        return { bytes, valid };
    } catch {}
    const STEP = 16;
    for (let off = 0; off < size; off += STEP) {
        const n = Math.min(STEP, size - off);
        try {
            bytes.set(Uint8Array.from(e.mem_read(addr + BigInt(off), n)), off);
            valid.fill(1, off, off + n);
        } catch {
            for (let j = 0; j < n; j++) {
                try {
                    bytes.set(Uint8Array.from(e.mem_read(addr + BigInt(off + j), 1)), off + j);
                    valid[off + j] = 1;
                } catch {}
            }
        }
    }
    return { bytes, valid };
}

// ---- run / step ---------------------------------------------------------
// Breakpoints arrive as [{ addr:decstr, cond: null | expr string }] (run-to-cursor
// appends a bare {addr}). Split into the fast address gate (bpSet) and the
// per-address condition table (bpCond), checked only when the gate fires.
function setBreakpoints(msg) {
    if (!msg.breakpoints) return;
    bpSet = new Set();
    bpCond = new Map();
    for (const b of msg.breakpoints) {
        const addr = BigInt(b.addr);
        bpSet.add(addr);
        if (b.cond) bpCond.set(addr.toString(), b.cond);
    }
}

// Evaluation context for conditional-breakpoint expressions, reading the LIVE
// engine state synchronously (we're inside the per-instruction hook, so no async
// round-trip is possible). Mirrors app.js's exprCtx, with blocking memory reads.
function condCtx() {
    return {
        reg: (name) => {
            const r = regByName.get(name);
            return r ? Uint8Array.from(readReg(r.id, r.size)) : undefined;
        },
        readBytes: (addr, size) => {
            const { bytes, valid } = safeRead(addr, size);
            for (let i = 0; i < valid.length; i++) if (!valid[i]) return undefined; // unmapped -> fail the read
            return bytes;
        },
        subRegs: subRegsMap,
        pointerSize: ptrSize,
        pcName,
        spName,
        bigEndian: !!cfg.bigEndian, // guest memory byte order for derefs
    };
}

/**
 * Should a conditional breakpoint at the current PC stop us? Evaluates the
 * expression against live state; non-zero stops. An evaluation error (e.g. a bad
 * register name, or a deref into unmapped memory) stops AND logs, so a broken
 * condition is visible rather than silently swallowing the breakpoint.
 */
function condStops(cond) {
    // A deref into unmapped memory makes safeRead's probe fail; restore faultInfo
    // afterward so the condition's own probing can never be mistaken for a real
    // guest fault by the post-emu_start checks.
    const savedFault = faultInfo;
    try {
        return evaluateSync(cond, condCtx()) !== 0n;
    } catch (err) {
        log("warning", `breakpoint condition error (${cond}): ${errMsg(err)}`);
        return true;
    } finally {
        faultInfo = savedFault;
    }
}

/**
 * The address emu_start should actually begin at when (re)starting at `addr`.
 * A delay-slot arch cannot resume in the middle of a branch+slot pair: the
 * pending branch target is hidden CPU state that emu_start does not restore, so
 * an address sitting in a delay slot backs up to its branch and re-runs the pair
 * (re-running a plain branch is side-effect free; these arches have no runnable
 * calls). A natural landing (any address that is not a branch's slot) is left
 * as-is, so this only fires when resuming from inside a pair.
 */
function resumeBegin(addr) {
    if (!delaySlots) return addr;
    return (classMap[(addr - 4n).toString()] || {}).b ? addr - 4n : addr;
}

/** Chunked, pausable, wall-clock-guarded execution to a stop condition. */
async function chunkedRun(from, until) {
    let pc = BigInt(from);
    const end = BigInt(until);
    resumeFrom = pc; // don't immediately re-break / re-stop where we sit
    hitBp = null;
    hitTemp = false;
    faultInfo = null;
    pauseRequested = false;
    running = true;
    post(RES.STATE, { state: "running", pc: pc.toString() });
    const t0 = Date.now();

    try {
        while (running) {
            lastHookPc = -1n; // a fresh emu_start may legitimately begin at the last-executed address
            e.emu_start(resumeBegin(pc) | thumbBit, end, 0, CHUNK);
            // An interrupt fault stops cleanly (emu_stop) rather than throwing,
            // so check faultInfo BEFORE the bp/step/exit conditions.
            if (faultInfo) {
                running = false;
                handleFault(null);
                break;
            }
            pc = readPC();
            if (hitTemp) {
                running = false;
                post(RES.STATE, { state: "paused", pc: pc.toString(), reason: "step" });
                break;
            }
            if (hitBp != null) {
                running = false;
                post(RES.STATE, { state: "paused", pc: pc.toString(), reason: "breakpoint" });
                break;
            }
            // Stale-PC fixup (see pcFixup above): after an until-stop MIPS/SPARC
            // read PC back as the last EXECUTED instruction (and SPARC64 respins
            // it, caught by the gate hook), so readPC() === lastHookPc means we
            // reached `end`. A genuine mid-stream count stop reads the NEXT
            // instruction (!= lastHookPc), and a tight loop's stale PC never
            // equals its own successor, so neither is teleported.
            if (pcFixup && pc < end && pc === lastHookPc) {
                pc = end;
                e.reg_write(pcId, Array.from(bigToBytes(pc, pcSize)));
            }
            if (pc >= end) {
                running = false;
                post(RES.STATE, { state: "exited", pc: pc.toString() });
                break;
            }
            await new Promise((r) => setTimeout(r, 0)); // let PAUSE drain
            if (pauseRequested) {
                running = false;
                post(RES.STATE, { state: "paused", pc: pc.toString(), reason: "pause" });
                break;
            }
            if (Date.now() - t0 > RUN_GUARD_MS) {
                running = false;
                post(RES.STATE, { state: "paused", pc: pc.toString(), reason: "timeout" });
                log("warning", `auto-paused after ${RUN_GUARD_MS / 1000}s (possible infinite loop)`);
                break;
            }
        }
    } catch (err) {
        running = false;
        handleFault(err);
    }
    tempTarget = null;
    snapshot();
}

function stepInCore(from, until) {
    hitBp = null;
    hitTemp = false;
    faultInfo = null;
    tempTarget = null;
    const stop = BigInt(until);
    // Back up to the branch when stepping from inside a delay-slot pair, so the
    // branch and slot re-run as a unit (a lone stepped slot loses the branch).
    const begin = resumeBegin(BigInt(from));
    resumeFrom = begin; // an explicit step advances past a breakpoint sitting on the stepped line
    const isBranch = delaySlots && !!(classMap[begin.toString()] || {}).b;
    try {
        lastHookPc = -1n;
        if (isBranch) {
            // Fenced branch step (see stepFence in the gate hook): run the branch
            // and its delay slot, stopping at the first instruction outside the
            // pair. Handles taken/not-taken and SPARC annulled slots uniformly,
            // where a fixed count=2 would overshoot an annulled (un-counted) slot.
            stepFence = { begin, slot: begin + 4n };
            try {
                e.emu_start(begin | thumbBit, stop, 0, DELAY_STEP_CAP);
            } finally {
                stepFence = null;
            }
        } else {
            e.emu_start(begin | thumbBit, stop, 0, 1);
        }
        if (faultInfo) {
            handleFault(null);
            snapshot();
            return;
        }
        let pc = readPC();
        // Stale-PC fixup (see pcFixup above), single-step flavor: a stepped
        // straight-line instruction that ran into `until` reads PC back as itself
        // (stale), i.e. readPC() === lastHookPc; a normal step reads the NEXT
        // instruction, and a breakpoint stop never updated lastHookPc. Skip it
        // for branch steps (the fence already lands PC correctly).
        if (pcFixup && !isBranch && hitBp == null && pc < stop && pc === lastHookPc) {
            pc = stop;
            e.reg_write(pcId, Array.from(bigToBytes(pc, pcSize)));
        }
        const reason = hitBp != null ? "breakpoint" : "step";
        const st = pc >= stop ? "exited" : "paused";
        post(RES.STATE, { state: st, pc: pc.toString(), reason });
    } catch (err) {
        handleFault(err);
    }
    snapshot();
}

function run(msg) {
    setBreakpoints(msg);
    tempTarget = null;
    chunkedRun(msg.from, msg.until);
}

function stepIn(msg) {
    setBreakpoints(msg);
    stepInCore(msg.from, msg.until);
}

function stepOver(msg) {
    setBreakpoints(msg);
    const from = BigInt(msg.from);
    const ci = classMap[from.toString()];
    if (ci && ci.c) {
        tempTarget = from + BigInt(ci.sz); // return address (fall-through)
        tempSpGuard = readSP(); // SP before the call
        chunkedRun(from, msg.until);
    } else {
        stepInCore(from, msg.until);
    }
}

function stepOut(msg) {
    setBreakpoints(msg);
    if (shadow.length === 0) {
        tempTarget = null;
        chunkedRun(msg.from, msg.until); // not in a tracked frame: run to end/bp
        return;
    }
    const top = shadow[shadow.length - 1];
    tempTarget = top.ret;
    tempSpGuard = top.sp;
    chunkedRun(msg.from, msg.until);
}

function handleFault(err) {
    // Resolve the real error code from the most reliable source available:
    //   1. faultInfo, set by the fault hooks BEFORE the trap unwound, the only
    //      source that survives an opaque wasm trap ("memory access out of
    //      bounds") on a reused engine, and the only one that knows int N.
    //   2. the code embedded in unicorn-js's thrown string ("...failed with code
    //      N:\n<text>"), present on a fresh-engine fault (incl. bad opcodes,
    //      which have no hook).
    //   3. e.errno(): last resort (reads back UC_ERR_OK(0) after most faults).
    const raw = err == null ? "" : errMsg(err);
    let errno = 0;
    if (faultInfo) errno = faultInfo.errno;
    if (!errno) {
        const m = raw.match(/failed with code (\d+)/);
        if (m) errno = Number(m[1]);
    }
    if (!errno) {
        try {
            errno = e.errno();
        } catch {}
    }
    // Build the message: the canonical strerror text for a real code. NEVER
    // surface strerror(OK) or the raw "Unicorn.js: Function uc_... failed with code"
    // thrown string; both are confusing noise. With no usable code we still show
    // a clean generic. Append the faulting access address (mem hooks) or the
    // interrupt vector when known, so a real fault is actually diagnosable.
    let message;
    if (errno && uc.strerror) {
        try {
            message = uc.strerror(errno);
        } catch {
            message = "Execution fault (code " + errno + ")";
        }
    } else {
        message = "Execution fault";
    }
    if (faultInfo && faultInfo.addr != null) {
        message += ` accessing 0x${faultInfo.addr.toString(16)}`;
    } else if (faultInfo && faultInfo.intr != null) {
        message += ` (interrupt 0x${faultInfo.intr.toString(16)})`;
    }
    let pc = 0n;
    try {
        pc = readPC();
    } catch {
        if (faultInfo && faultInfo.pc != null) pc = faultInfo.pc;
    }
    post(RES.STATE, { state: "faulted", pc: pc.toString(), reason: "fault" });
    post(RES.FAULT, { message, errno, pc: pc.toString() });
    faultInfo = null;
}

// ---- message pump -------------------------------------------------------
onmessage = (ev) => {
    const msg = ev.data || {};
    try {
        switch (msg.type) {
            case REQ.INIT:
                doInit(msg).catch((err) => post(RES.ERROR, { message: "init failed: " + errMsg(err) }));
                break;
            case REQ.WRITE_MEM:
                e.mem_write(BigInt(msg.addr), Array.from(msg.bytes));
                if (msg.isCode) setCodeEndFromImage(msg.addr, msg.bytes.length);
                break;
            case REQ.SET_PROT:
                // Live re-protect of a mapped region (Memory Maps panel toggle).
                e.mem_protect(BigInt(msg.addr), BigInt(msg.size), Number(msg.perms));
                break;
            case REQ.READ_MEM: {
                const { bytes, valid } = safeRead(BigInt(msg.addr), msg.size);
                post(RES.MEM, { addr: String(msg.addr), bytes, valid, tag: msg.tag });
                break;
            }
            case REQ.MAP: {
                // Live-map a new region (Memory Maps "new"); zero it so a later
                // ELF save / read sees defined bytes, mirroring doInit.
                const addr = BigInt(msg.addr);
                const size = Number(msg.size);
                e.mem_map(addr, BigInt(size), Number(msg.perms));
                e.mem_write(addr, new Uint8Array(size));
                break;
            }
            case REQ.UNMAP:
                // Live-unmap a region (Memory Maps "delete").
                e.mem_unmap(BigInt(msg.addr), BigInt(msg.size));
                break;
            case REQ.WRITE_REG: {
                const r = regByName.get(msg.name);
                if (r) e.reg_write(r.id, Array.from(bigToBytes(BigInt(msg.value), r.size)));
                snapshot();
                break;
            }
            case REQ.SET_PC:
                e.reg_write(pcId, Array.from(bigToBytes(BigInt(msg.value), pcSize)));
                snapshot();
                break;
            case REQ.SNAPSHOT:
                snapshot();
                break;
            case REQ.SET_CLASSMAP:
                classMap = msg.map || {};
                shadow = []; // fresh image => frames are invalidated
                break;
            case REQ.RUN:
                run(msg);
                break;
            case REQ.STEP_IN:
                stepIn(msg);
                break;
            case REQ.STEP_OVER:
                stepOver(msg);
                break;
            case REQ.STEP_OUT:
                stepOut(msg);
                break;
            case REQ.PAUSE:
                pauseRequested = true;
                break;
            case REQ.RESET:
                doInit(cfg).catch((err) => post(RES.ERROR, { message: String(err) }));
                break;
            case REQ.RESET_REGS:
                resetRegs(); // registers only; guest memory is left as-is
                snapshot();
                break;
            default:
                post(RES.ERROR, { message: "unknown message: " + msg.type });
        }
    } catch (err) {
        post(RES.ERROR, { message: errMsg(err) });
    }
};
