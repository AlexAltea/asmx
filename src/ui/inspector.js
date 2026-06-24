/*
 * Inspector: the hover type-preview. Reinterprets a register's (or memory
 * selection's) raw little-endian bytes via one DataView as
 * u8/i8, u16/i16, u32/i32, u64/i64, f32, f64, plus ASCII and binary, in both
 * native-LE and byte-swapped-BE columns. Sticks to the last hovered value so it
 * doesn't flicker; pin to freeze while stepping.
 */
import { toHex, byteToChar, escapeHtml, bytesToBig } from "../core/bigint.js";

export class Inspector {
    constructor(root, { evalInspect } = {}) {
        this.root = root;
        this.evalInspect = evalInspect || (async () => { throw new Error("no evaluator"); });
        this.pinned = false;
        this.last = null; // last hovered source (drives the unpinned / empty-pin display)
        this.expr = ""; // pinned expression; "" = freeze the last hovered value
        this.exprEl = null; // expression input (wired by app.js; lives in the toolbar)
        this._gen = 0; // gen-guard: bumping _gen supersedes in-flight async evals, so a
        //               stale result (fast stepping / unpin) can never paint over a newer one
        this.renderHint();
    }

    /** Wire the toolbar's expression input. Enter evaluates the typed expression;
     *  while pinned it also re-targets the pin to the new expression. */
    bindExprInput(el) {
        this.exprEl = el;
        el.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            const src = el.value.trim();
            if (this.pinned) this.expr = src;
            this._evalAndRender(src);
        });
    }

    renderHint() {
        // pc / [sp] resolve on every arch via the expression evaluator's aliases.
        this.root.innerHTML =
            '<div class="inspect-hint">Hover a register or memory byte, or type an expression (e.g. pc, [sp]) and pin it.</div>';
    }

    /** Hover: when unpinned, track the hovered value and mirror its expression. */
    show(src) {
        if (this.pinned) return; // frozen; ignore hovers
        this._gen++; // gen-guard: supersede any in-flight hover
        this.last = src;
        this._render(src);
        if (this.exprEl && document.activeElement !== this.exprEl) this.exprEl.value = src.expr ?? "";
    }

    /** Hover over an expression token (e.g. an operand register in the disassembly).
     *  Unpinned only: evaluate it and show it like any other hover, mirroring it
     *  into the field. Unknown registers / non-register words are silently ignored
     *  so sweeping the mouse across operands never flashes an error. */
    async hoverExpr(expr) {
        if (this.pinned || !expr) return;
        const g = ++this._gen;
        let r;
        try {
            r = await this.evalInspect(expr);
        } catch {
            return; // not a resolvable register/expression; leave the last value
        }
        if (g !== this._gen || this.pinned) return; // superseded, or pinned meanwhile
        this.last = { ...r, expr };
        this._render(this.last);
        if (this.exprEl && document.activeElement !== this.exprEl) this.exprEl.value = expr;
    }

    /** Header pin button: freeze on the field's expression (empty = freeze the last
     *  hovered value). Returns the new pinned state. */
    togglePin() {
        this.pinned = !this.pinned;
        if (this.pinned) {
            this.expr = this.exprEl ? this.exprEl.value.trim() : "";
            if (this.expr) this._evalAndRender(this.expr); // else leave the last value frozen
        } else {
            this._gen++; // gen-guard: cancel any in-flight eval
            this.expr = "";
            this.last ? this._render(this.last) : this.renderHint();
        }
        return this.pinned;
    }

    /** On a stop: re-evaluate the pinned expression (regs/memory have changed). */
    onStop() {
        if (this.pinned && this.expr) this._evalAndRender(this.expr);
    }

    /** Evaluate `src` and render its bytes (gen-guarded; see _gen). */
    async _evalAndRender(src) {
        if (!src) return;
        const g = ++this._gen;
        let r;
        try {
            r = await this.evalInspect(src);
        } catch (e) {
            if (g === this._gen) this._renderError(e.message || String(e));
            return;
        }
        if (g === this._gen) this._render(r);
    }

    _renderError(msg) {
        this.root.innerHTML = `<div class="inspect-hint err">${escapeHtml(msg)}</div>`;
    }

    _render({ bytes, size }) {
        const hexAll = Array.from(bytes.slice(0, size), (b) => toHex(b, 2)).join(" ");
        const ascii = Array.from(bytes.slice(0, size), byteToChar).join("");
        // No title row; the toolbar's expression field already names the source,
        // and its pin button shows the pinned state.
        let html = "";

        if (size > 8) {
            // Vector register: lane decomposition (SIMD).
            html += '<div class="inspect-grid lane-table">';
            for (const r of laneRows(bytes, size)) {
                html += `<div class="k">${r.type}</div><div class="v" style="grid-column: span 2">${escapeHtml(
                    r.lanes.join("  ")
                )}</div>`;
            }
            html += "</div>";
        } else {
            const rows = reinterpret(bytes, size);
            html += '<div class="inspect-grid">';
            html += '<div class="h"></div><div class="h">LE</div><div class="h">BE</div>';
            for (const r of rows) {
                html += `<div class="k">${r.type}</div><div class="v">${escapeHtml(
                    r.le
                )}</div><div class="v">${r.be == null ? "·" : escapeHtml(r.be)}</div>`;
            }
            html += "</div>";
        }

        html += `<div class="inspect-grid raw">
      <div class="k">hex</div><div class="v" style="grid-column: span 2; word-break: break-all">${hexAll}</div>
      <div class="k">char</div><div class="v" style="grid-column: span 2">${escapeHtml(ascii)}</div>
    </div>`;
        // Wrap in `.inspect` so the panel gets monospace values + consistent
        // padding (without the wrapper the grid inherits the sans-serif UI font).
        this.root.innerHTML = `<div class="inspect">${html}</div>`;
    }
}

function laneRows(bytes, size) {
    const buf = new ArrayBuffer(size);
    new Uint8Array(buf).set(bytes.slice(0, size));
    const dv = new DataView(buf);
    const rows = [];
    if (size % 4 === 0)
        rows.push({ type: `u32×${size / 4}`, lanes: range(size / 4).map((i) => dv.getUint32(i * 4, true) >>> 0) });
    if (size % 8 === 0)
        rows.push({ type: `u64×${size / 8}`, lanes: range(size / 8).map((i) => dv.getBigUint64(i * 8, true)) });
    if (size % 4 === 0)
        rows.push({ type: `f32×${size / 4}`, lanes: range(size / 4).map((i) => fmtFloat(dv.getFloat32(i * 4, true))) });
    if (size % 8 === 0)
        rows.push({ type: `f64×${size / 8}`, lanes: range(size / 8).map((i) => fmtFloat(dv.getFloat64(i * 8, true))) });
    return rows;
}
function range(n) {
    return Array.from({ length: n }, (_, i) => i);
}

function fmtFloat(v) {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "+Inf" : "-Inf";
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 1e-4 && a < 1e16) {
        const s = v.toPrecision(9);
        return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
    }
    return v.toExponential(6);
}

function reinterpret(bytes, size) {
    const buf = new ArrayBuffer(8);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < Math.min(size, 8); i++) u8[i] = bytes[i];
    const dv = new DataView(buf);
    const rows = [];
    const add = (type, le, be) => rows.push({ type, le: String(le), be: be == null ? null : String(be) });

    if (size >= 1) {
        add("u8", bytes[0], null);
        add("i8", dv.getInt8(0), null);
    }
    if (size >= 2) {
        add("u16", dv.getUint16(0, true), dv.getUint16(0, false));
        add("i16", dv.getInt16(0, true), dv.getInt16(0, false));
    }
    if (size >= 4) {
        add("u32", dv.getUint32(0, true) >>> 0, dv.getUint32(0, false) >>> 0);
        add("i32", dv.getInt32(0, true), dv.getInt32(0, false));
        add("f32", fmtFloat(dv.getFloat32(0, true)), fmtFloat(dv.getFloat32(0, false)));
    }
    if (size >= 8) {
        add("u64", dv.getBigUint64(0, true), dv.getBigUint64(0, false));
        add("i64", dv.getBigInt64(0, true), dv.getBigInt64(0, false));
        add("f64", fmtFloat(dv.getFloat64(0, true)), fmtFloat(dv.getFloat64(0, false)));
    }
    // Compact binary only for narrow values (keeps the panel tidy).
    if (size <= 2) {
        add("bin", bytesToBig(bytes.slice(0, size)).toString(2).padStart(size * 8, "0"), null);
    }
    return rows;
}
