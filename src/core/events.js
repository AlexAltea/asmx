/*
 * Minimal synchronous event bus wiring the debug engine's messages to the UI.
 */
export class EventBus {
    constructor() {
        this._map = new Map();
    }
    on(type, fn) {
        if (!this._map.has(type)) this._map.set(type, new Set());
        this._map.get(type).add(fn);
    }
    emit(type, payload) {
        for (const fn of this._map.get(type) || []) {
            try {
                fn(payload);
            } catch (e) {
                console.error(`[bus] handler for "${type}" threw`, e);
            }
        }
    }
}

/** App-wide event names (the note on each line is its payload shape); the
 *  producer is debug/engine.js. */
export const EV = {
    ENGINE_READY: "engine:ready", // {version}
    STATE: "engine:state", // {state, pc, reason}
    REGS: "engine:regs", // {regs:[{name,bytes,size}], pc}
    MEM: "engine:mem", // {addr, bytes, valid, tag}
    FAULT: "engine:fault", // {message, errno, pc}
    CONSOLE: "console:log", // {level, text}
};
