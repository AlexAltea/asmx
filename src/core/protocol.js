/*
 * Worker message contract (main thread <-> engine worker).
 *
 * The engine worker is a MODULE worker, so both sides `import` these constants;
 * this file is the single source of truth for the wire protocol (no hand-synced
 * string literals).
 *
 * Addresses and register values cross as DECIMAL STRINGS, converted inline with
 * BigInt()/.toString() at each boundary, so nothing relies on BigInt structured
 * cloning. Bytes cross as arrays: a request sends a plain Array (WRITE_MEM), a
 * response a cloned Uint8Array (RES.MEM / RES.REGS).
 */

// main -> worker
export const REQ = {
    INIT: "init", // {prefix, ucArch, ucMode, regs:[{name,size,group}], pcName, spName, maps:[{addr,size,perms(int)}], stackTop?, codeBase, codeEnd}; ucMode "MODE_THUMB" makes the worker OR bit 0 into emu_start begins (ISA state); all wire addresses stay plain
    WRITE_MEM: "write_mem", // {addr, bytes, isCode?}
    READ_MEM: "read_mem", // {addr, size, tag?}
    WRITE_REG: "write_reg", // {name, value(dec str)}; size comes from the worker's regList
    SNAPSHOT: "snapshot", // {}
    SET_PC: "set_pc", // {value(dec str)}
    SET_PROT: "set_prot", // {addr, size, perms(int PROT mask)}; live mem_protect
    MAP: "map", // {addr, size, perms(int PROT mask)}; live mem_map (Memory Maps "new")
    UNMAP: "unmap", // {addr, size}; live mem_unmap (Memory Maps "delete")
    SET_CLASSMAP: "set_classmap", // {map: {addr(str): {c(call),r(ret),b(any branch),sz}}}; sz spans the delay slot on delay-slot arches
    RUN: "run", // {from, until, breakpoints:[{addr(dec str), cond: null|expr string}]}
    STEP_IN: "step_in", // {from, until, breakpoints?}
    STEP_OVER: "step_over", // {from, until, breakpoints?}
    STEP_OUT: "step_out", // {from, until, breakpoints?}
    PAUSE: "pause", // {}
    RESET: "reset", // {} re-create engine + remap (memory + registers)
    RESET_REGS: "reset_regs", // {} zero every register except PC/SP; SP->stackTop, PC->entry; memory untouched
};

// worker -> main
export const RES = {
    READY: "ready", // {version}
    REGS: "regs", // {regs:[{name,bytes,size}], pc(dec str)}
    MEM: "mem", // {addr(dec str), bytes, valid(Uint8Array 1=mapped), tag?}
    STATE: "state", // {state:'paused'|'running'|'exited'|'faulted', pc, reason?}
    FAULT: "fault", // {message, errno, pc?(dec str)}
    LOG: "log", // {level, text}
    ERROR: "error", // {message}
};
