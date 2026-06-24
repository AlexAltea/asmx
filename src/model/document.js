/*
 * The program document: an ordered list of Lines with stable integer ids.
 * Addresses are ALWAYS derived by layout(), never stored on the IP. The
 * instruction pointer tracks `ipLineId` (a line identity) during editing and
 * is reconciled to/from a guest address only at run/step boundaries. This is
 * what makes the IP "stick" to a logical line across inserts/edits/deletes.
 *
 * Pure + DOM-free + assembler-injected, so it is unit-testable in node.
 * `assemble(asmText)` must return { bytes:number[]|Uint8Array } or
 * { error:string }. Labels/comments/blank lines assemble to zero bytes.
 */

import { errMsg } from "../core/bigint.js";

const LABEL_RE = /^([A-Za-z_.$][\w.$]*):\s*(.*)$/;

// Bound on branch-relaxation passes in layout(). Real programs converge in one
// or two; the cap only guards against a pathological oscillation.
const MAX_RELAX_PASSES = 8;

class Line {
    constructor(id, text) {
        this.id = id;
        this.text = text; // raw source
        this.kind = "blank"; // 'instr' | 'label' | 'comment' | 'blank'
        this.asmText = ""; // the part handed to the assembler
        this.label = null; // attached label name, if any
        this.bytes = []; // assembled machine code
        this.size = 0; // byte length used for layout (last-good on error)
        this.addr = 0n; // derived by layout()
        this.error = null; // assembler error string, or null
        this.pos = false; // position-sensitive encoding; see layout()
    }
    get addrBearing() {
        return this.kind === "instr" && !this.error && this.size > 0;
    }
}

export class Document {
    constructor({ base = 0x10000n, assemble, relBranch, positionSensitive } = {}) {
        this.base = BigInt(base);
        this.assemble = assemble || (() => ({ error: "no assembler" }));
        // Predicate marking a line as position-sensitive (relative branches,
        // RIP-relative memory operands, etc.). `relBranch` is kept as the older
        // caller option name; new callers should pass `positionSensitive`.
        this.positionSensitive = positionSensitive || relBranch || (() => false);
        this.lines = [];
        this.byId = new Map();
        this.symbols = new Map(); // label -> addr (resolved in layout)
        this._seq = 1;
        this.ipLineId = null;
        this.ipOffset = 0n;
        this.entryOverrideId = null; // user-set entry point (context menu); null -> first addr-bearing line
    }

    // ---- construction ----------------------------------------------------
    _newLine(text) {
        const ln = new Line(this._seq++, text);
        this._classify(ln);
        this.byId.set(ln.id, ln);
        return ln;
    }

    _classify(ln) {
        const t = ln.text.replace(/\s+$/, "");
        const trimmed = t.trim();
        ln.label = null;
        if (trimmed === "") {
            ln.kind = "blank";
            ln.asmText = "";
        } else if (trimmed[0] === ";") {
            ln.kind = "comment";
            ln.asmText = "";
        } else {
            const m = trimmed.match(LABEL_RE);
            if (m && !m[2]) {
                ln.kind = "label";
                ln.label = m[1];
                ln.asmText = "";
            } else if (m && m[2]) {
                ln.kind = "instr";
                ln.label = m[1];
                ln.asmText = m[2];
            } else {
                ln.kind = "instr";
                ln.asmText = trimmed;
            }
        }
        ln.pos = ln.kind === "instr" && this.positionSensitive(ln.asmText);
        this._assembleLine(ln);
    }

    _assembleLine(ln) {
        if (ln.kind !== "instr") {
            ln.bytes = [];
            ln.size = 0;
            ln.error = null;
            return;
        }
        let res;
        try {
            res = this.assemble(ln.asmText, ln.addr);
        } catch (e) {
            res = { error: errMsg(e) };
        }
        if (res && res.error) {
            ln.error = res.error;
            // Failing-line policy: keep the last-good size so addresses downstream
            // don't thrash on every keystroke. If never assembled, size stays 0.
            ln.bytes = [];
        } else {
            ln.error = null;
            ln.bytes = Array.from(res.bytes || []);
            ln.size = ln.bytes.length;
        }
    }

    // ---- editing ---------------------------------------------------------
    setLines(textBlock) {
        this.lines = [];
        this.byId.clear();
        this._seq = 1;
        this.ipLineId = null;
        this.ipOffset = 0n;
        this.entryOverrideId = null; // a fresh program supersedes any custom entry point
        const parts = String(textBlock).replace(/\r/g, "").split("\n");
        // Trim a single leading/trailing empty line from template literals.
        while (parts.length && parts[0].trim() === "") parts.shift();
        while (parts.length && parts[parts.length - 1].trim() === "") parts.pop();
        for (const p of parts) this.lines.push(this._newLine(p));
        this.layout();
    }

    indexOf(id) {
        return this.lines.findIndex((l) => l.id === id);
    }

    /** Insert a new blank line after `id` (or at start if id == null). Returns id. */
    insertAfter(id, text = "") {
        const ln = this._newLine(text);
        const idx = id == null ? 0 : this.indexOf(id) + 1;
        this.lines.splice(idx, 0, ln);
        this.layout();
        return ln.id;
    }

    setText(id, text) {
        const ln = this.byId.get(id);
        if (!ln) return;
        ln.text = text;
        this._classify(ln);
        // stick-IP: editing the IP line may shrink it; clamp the offset.
        if (id === this.ipLineId) {
            const max = ln.size > 0 ? BigInt(ln.size - 1) : 0n;
            if (this.ipOffset > max) this.ipOffset = max;
        }
        this.layout();
    }

    remove(id) {
        const idx = this.indexOf(id);
        if (idx < 0) return;
        if (id === this.ipLineId) {
            // stick-IP: move to the nearest surviving addr-bearing neighbor,
            // preferring the next instruction, then the previous.
            const after = this._nextAddrBearing(idx + 1, +1);
            const before = this._nextAddrBearing(idx - 1, -1);
            this.ipLineId = (after || before) ? (after || before).id : null;
            this.ipOffset = 0n;
        }
        this.byId.delete(id);
        this.lines.splice(idx, 1);
        this.layout();
    }

    _nextAddrBearing(start, dir) {
        for (let i = start; i >= 0 && i < this.lines.length; i += dir) {
            if (this.lines[i].addrBearing) return this.lines[i];
        }
        return null;
    }

    // ---- layout ----------------------------------------------------------
    /**
     * Recompute every line's addr from sizes and rebuild the symbol table.
     *
     * Addresses come from sizes, but a position-sensitive instruction's size or
     * bytes can come from its address (branch relaxation, RIP-relative memory
     * operands, etc.). Re-encode those lines at their computed address and
     * iterate until sizes stop changing. Position-independent lines are assembled
     * once (on edit) and left alone, so the common case stays a single pass.
     */
    layout() {
        for (let pass = 0; pass < MAX_RELAX_PASSES; pass++) {
            let addr = this.base;
            let changed = false;
            this.symbols.clear();
            for (const ln of this.lines) {
                if (ln.pos && ln.addr !== addr) {
                    ln.addr = addr;
                    const before = ln.size;
                    this._assembleLine(ln); // re-encode against the new origin
                    if (ln.size !== before) changed = true; // sizes shifted; relax again
                } else {
                    ln.addr = addr;
                }
                if (ln.label) this.symbols.set(ln.label, addr);
                addr += BigInt(ln.size);
            }
            if (!changed) break;
        }
    }

    // ---- address <-> line ------------------------------------------------
    lineToAddr(id) {
        const ln = this.byId.get(id);
        return ln ? ln.addr + this.ipOffset : null;
    }

    addrToLine(addr) {
        const a = BigInt(addr);
        for (const ln of this.lines) {
            if (ln.size > 0 && a >= ln.addr && a < ln.addr + BigInt(ln.size)) {
                return { line: ln, offset: a - ln.addr };
            }
        }
        return null;
    }

    /** Reconcile the IP from a live guest PC (on every debugger stop). */
    setIPFromAddr(addr) {
        const hit = this.addrToLine(addr);
        if (hit) {
            this.ipLineId = hit.line.id;
            this.ipOffset = hit.offset;
        } else {
            this.ipLineId = null; // PC outside the listing (exited / jumped away)
            this.ipOffset = 0n;
        }
        return this.ipLineId;
    }

    ipLine() {
        return this.ipLineId == null ? null : this.byId.get(this.ipLineId);
    }

    ipAddress() {
        return this.ipLineId == null ? null : this.lineToAddr(this.ipLineId);
    }

    /** The entry point's line: the user-set override if it's still a valid
     *  addr-bearing line, else the first addr-bearing line (or null). */
    entryLine() {
        if (this.entryOverrideId != null) {
            const ln = this.byId.get(this.entryOverrideId);
            if (ln && ln.addrBearing) return ln;
        }
        return this._nextAddrBearing(0, +1);
    }

    /** Entry point address. */
    entryAddr() {
        const ln = this.entryLine();
        return ln ? ln.addr : this.base;
    }

    /** Id of the entry point's line (or null). */
    entryLineId() {
        const ln = this.entryLine();
        return ln ? ln.id : null;
    }

    /** Pin the entry point to line `id` (context menu). Returns false if the line
     *  can't hold one (blank / comment / label / errored). */
    setEntryLine(id) {
        const ln = this.byId.get(id);
        if (!ln || !ln.addrBearing) return false;
        this.entryOverrideId = id;
        return true;
    }

    /** End address (exclusive) of the assembled image. */
    endAddr() {
        let addr = this.base;
        for (const ln of this.lines) addr += BigInt(ln.size);
        return addr;
    }

    // ---- guest image -----------------------------------------------------
    /** Flat machine-code image to write into guest memory before running. */
    image() {
        const bytes = [];
        for (const ln of this.lines) for (const b of ln.bytes) bytes.push(b);
        return { base: this.base, bytes: Uint8Array.from(bytes) };
    }

    /** Lines whose last assembly failed. */
    errors() {
        return this.lines.filter((l) => l.error);
    }

    isRunnable() {
        return this.errors().length === 0 && this.lines.some((l) => l.addrBearing);
    }
}
