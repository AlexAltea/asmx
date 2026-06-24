/*
 * Breakpoint store: the single source of truth for the debugger's breakpoints,
 * shared by the Disassembly gutter (ui/editor.js) and the Breakpoints panel
 * (ui/breakpoints.js), and read by app.js when launching a run/step.
 *
 * Breakpoints are keyed by ADDRESS (a BigInt): the address IS the identity, and
 * there is at most one breakpoint at any given address. The Disassembly view owns
 * the address-to-row mapping (it renders one address per row and asks the store
 * whether a breakpoint sits there), so the store never deals in document lines
 * except to resolve an address back to its instruction for display.
 *
 * Each entry is `{ enabled, cond, stick, lineId }`. `cond` is either null
 * (unconditional: stop whenever the address is reached) or a single expression
 * string (core/expr.js grammar, comparisons included): the breakpoint stops when
 * it evaluates non-zero. It is evaluated in the engine worker, where
 * register/memory access is synchronous (see worker + expr's evaluateSync).
 * `lineId` records the document line the breakpoint was placed on; a *sticky*
 * breakpoint (the default) re-anchors its address key to that line as edits
 * above it reflow the layout (see reconcile()), so it follows its instruction
 * the way the old line-id keying did, while a non-sticky one stays pinned to the
 * fixed address. Listeners (onChange) re-render the gutter and the panel.
 *
 * Pure + DOM-free (only needs the Document to resolve address/line).
 */

export class BreakpointStore {
    constructor(doc) {
        this.doc = doc;
        this.map = new Map(); // addr:BigInt -> { enabled, cond, stick, lineId }
        this._listeners = new Set();
    }

    /** Document line id whose instruction covers `addr` (for sticky re-anchoring), or null. */
    _lineIdAt(addr) {
        const hit = this.doc.addrToLine(addr);
        return hit ? hit.line.id : null;
    }

    onChange(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }
    _emit() {
        for (const fn of this._listeners) fn();
    }

    has(addr) {
        return this.map.has(addr);
    }
    get(addr) {
        return this.map.get(addr) || null;
    }

    /** Gutter click: add an unconditional breakpoint, or remove the existing one. */
    toggle(addr) {
        if (this.map.has(addr)) this.map.delete(addr);
        else this.map.set(addr, { enabled: true, cond: null, stick: true, lineId: this._lineIdAt(addr) });
        this._emit();
    }
    add(addr, { cond = null, enabled = true, stick = true } = {}) {
        this.map.set(addr, { enabled, cond, stick, lineId: this._lineIdAt(addr) });
        this._emit();
    }
    remove(addr) {
        if (this.map.delete(addr)) this._emit();
    }
    setEnabled(addr, on) {
        const bp = this.map.get(addr);
        if (bp) {
            bp.enabled = !!on;
            this._emit();
        }
    }
    setCondition(addr, cond) {
        const bp = this.map.get(addr);
        if (bp) {
            bp.cond = cond || null;
            this._emit();
        }
    }
    /** Toggle whether a breakpoint follows its instruction (stick) or stays pinned
     *  to its fixed address. Re-anchors to the instruction currently at `addr`. */
    setStick(addr, on) {
        const bp = this.map.get(addr);
        if (bp) {
            bp.stick = !!on;
            if (bp.stick) bp.lineId = this._lineIdAt(addr);
            this._emit();
        }
    }
    clear() {
        if (this.map.size) {
            this.map.clear();
            this._emit();
        }
    }

    /** All breakpoints, address-sorted, each resolved against the live document to
     *  the instruction currently at its address (`ln` is null when a non-sticky
     *  breakpoint's address no longer starts an instruction), for the panel. */
    list() {
        const out = [];
        for (const [addr, bp] of this.map) {
            const hit = this.doc.addrToLine(addr);
            out.push({ addr, ln: hit ? hit.line : null, enabled: bp.enabled, cond: bp.cond, stick: bp.stick });
        }
        out.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
        return out;
    }

    /** Re-anchor sticky breakpoints after a document edit reflows the layout: move
     *  each to its line's current address, and drop those whose line was deleted.
     *  Non-sticky breakpoints keep their fixed address. Call after doc mutation,
     *  before repainting. Returns true when anything changed. */
    reconcile() {
        const moves = []; // [oldAddr, newAddr, entry]
        const drops = [];
        for (const [addr, bp] of this.map) {
            if (!bp.stick) continue; // pinned to a fixed address; never follows
            const ln = bp.lineId != null ? this.doc.byId.get(bp.lineId) : null;
            if (!ln) drops.push(addr); // line deleted -> drop (matches the old prune)
            else if (ln.addr !== addr) moves.push([addr, ln.addr, bp]);
        }
        if (!moves.length && !drops.length) return false;
        // Clear every vacated key before re-inserting, so a move can't land on a
        // slot another move is still vacating (addresses stay unique per line).
        for (const addr of drops) this.map.delete(addr);
        for (const [from] of moves) this.map.delete(from);
        for (const [, to, bp] of moves) this.map.set(to, bp);
        this._emit();
        return true;
    }

    /** Enabled breakpoints as the worker payload: [{ addr:BigInt, cond }]. */
    active() {
        const out = [];
        for (const [addr, bp] of this.map) {
            if (bp.enabled) out.push({ addr, cond: bp.cond });
        }
        return out;
    }

    /** Snap an arbitrary address (panel "add by address" / share restore) to the
     *  start of the instruction covering it (the address a gutter click would use),
     *  or null when nothing addressable is there. */
    snapAddr(addr) {
        const hit = this.doc.addrToLine(addr);
        return hit && hit.line.addrBearing ? hit.line.addr : null;
    }
}
