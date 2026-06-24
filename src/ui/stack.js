/*
 * Stack view: a word-granular window that fills the panel height. It re-anchors
 * to SP on every stop, marks the SP row, and annotates words that point into the
 * code region as likely return addresses. A virtual scrollbar (ui/vbar.js) spans
 * the whole mapped range; goto/drag jump anywhere and the bar's end-arrows (or a
 * wheel notch) step it one word at a time with a brief ~110ms slide (a manual
 * jump/step is temporary; the next stop re-anchors to SP). Hovering a word feeds
 * the type-inspector.
 *
 * Like the Memory view, it over-reads a few hidden OVERSCAN rows on each side so a
 * step can slide: `base` is the first VISIBLE word, `winBase` is the address of
 * bytes[0] (= base - OVERSCAN words).
 */
import { toHex, dimZeros, bytesToBig, bigToBytes, hexWidth, parseValue, asU8 } from "../core/bigint.js";
import { mapsExtent } from "../core/mem.js";
import { inlineEdit } from "./dom.js";
import { codeRegion, endianOf } from "../arch/index.js";
import { VBar } from "./vbar.js";
import { ColumnHeader } from "./cols.js";
import { icon } from "./icons.js";
import { slideRows, slideCancel } from "./slide.js";
import { HEX_ROW_H as ROW_H, MONO_CH } from "./geometry.js";

/** Stack columns: Address | Value (default width follows the word size) |
 *  annotations. Address and Value are resizable; +16px = the cell insets. */
function stackColumns(wordSize) {
    return [
        { key: "addr", label: "Address", w: Math.ceil(8 * MONO_CH) + 16, min: 56, max: 200 },
        { key: "value", label: "Value", w: Math.ceil(hexWidth(wordSize) * MONO_CH) + 16, min: 48, max: 280 },
        { key: "marks", w: "minmax(0,1fr)" },
    ];
}

const OVER = 8; // hidden overscan rows each side (covers a wheel notch's worth of slide)

export class StackView {
    constructor(root, { engine, onInspect, evalAddr, onPinChange }) {
        this.root = root;
        this.engine = engine;
        this.onInspect = onInspect || (() => {});
        this.evalAddr = evalAddr || (async () => { throw new Error("no evaluator"); });
        this.onPinChange = onPinChange || (() => {});
        this.spName = "RSP";
        this.wordSize = 8;
        this.count = 16; // recomputed by _fit() to fill the panel height
        this.codeLo = 0n;
        this.codeHi = 0n;
        this.memLo = 0n;
        this.memHi = 0n;
        this.sp = 0n;
        this.base = 0n; // address of the first VISIBLE row
        this.winBase = null; // address of bytes[0] (= base - OVER rows); null until first read
        this.bytes = null;
        this.valid = null; // per-byte map: 1 = mapped, 0 = unmapped (render as ??)
        this.gotoEl = null; // goto input; holds the user's EXPRESSION (not the live address)
        this.expr = "rsp"; // default: follow the stack pointer (re-targeted by setMode)
        this.pinned = true; // the stack tracks SP by default (today's behaviour)
        this._exprGen = 0; // generation guard against out-of-order async applyExpr
        this._wheelAcc = 0; // sub-row wheel-delta accumulator
        this._restY = 0; // current resting transform (px) = -leadRows*ROW_H

        // DOM: the panel body is a .col-host column: the shared header over the
        // .hex body [ .hex-rows (clip) > .hex-slide (rows; what slides) | .vbar ],
        // plus the full-height resize-divider overlay on top.
        this.rowsEl = document.createElement("div");
        this.rowsEl.className = "hex-rows";
        this.slideEl = document.createElement("div");
        this.slideEl.className = "hex-slide";
        this.rowsEl.appendChild(this.slideEl);
        this.vbar = new VBar({ onSeek: (a) => this._seek(a), onStep: (d) => this._stepRows(d) });
        this.bodyEl = document.createElement("div");
        this.bodyEl.className = "hex";
        this.bodyEl.append(this.rowsEl, this.vbar.el);

        // Shared column header + resize dividers (same component as the other table
        // panels): Address and Value are resizable, the annotations flex. Cell model:
        // the 8px insets live inside each cell, so a divider always lands between two
        // padded cells. The Value default width tracks the mode's word size (setMode).
        root.classList.add("col-host");
        this.cols = new ColumnHeader(root, {
            id: "stack",
            cell: true,
            rowSel: ".hex-row",
            columns: stackColumns(this.wordSize),
        });
        root.replaceChildren(this.cols.render(), this.bodyEl);
        this.cols.mountGuides(root);

        this.slideEl.addEventListener("mouseover", (e) => this._hover(e));
        this.slideEl.addEventListener("dblclick", (e) => this._edit(e));
        root.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
        this._ro = new ResizeObserver(() => this._fit());
        this._ro.observe(root);
    }

    setMode(profile, modeId) {
        const L = profile.layoutFor(modeId);
        this.spName = L.spName;
        this.wordSize = L.regSize;
        this.bigEndian = endianOf(profile, modeId) === "big"; // word decode order (guest memory)
        this.cols.setColumns(stackColumns(this.wordSize)); // Value column width follows the word size
        const code = codeRegion(profile);
        this.codeLo = code.base;
        this.codeHi = code.end;
        // Re-target the default "follow SP" pin to this mode's SP register
        // (e.g. RSP->ESP on a 64->32 switch) so it never points at a dead name.
        this._exprGen++; // cancel any in-flight eval from the previous mode
        this.expr = this.spName.toLowerCase();
        this.pinned = true;
        this.onPinChange(true);
        this._syncGoto();
    }

    /** Seed the virtual bar's extents from the guest memory map. */
    setMaps(maps) {
        ({ lo: this.memLo, hi: this.memHi } = mapsExtent(maps));
        this.vbar.setRange(this.memLo, this.memHi);
        this.render();
    }

    /** On every register snapshot: refresh the SP marker, then follow the pinned
     *  expression (default SP) or just refresh the current window. */
    onStop(regs) {
        const sp = regs && regs.find((r) => r.name === this.spName);
        if (sp) this.sp = bytesToBig(asU8(sp.bytes));
        if (this.pinned) this.applyExpr();
        else this.refresh();
    }

    /** goto field (Enter): adopt the typed expression and jump to its value. */
    goto(text) {
        this.expr = String(text).trim();
        this.applyExpr();
    }

    /** Toolbar pin toggle: follow `expr` on every stop. Returns the new state. */
    togglePin() {
        this.pinned = !this.pinned;
        this.onPinChange(this.pinned);
        if (this.pinned) this.applyExpr();
        return this.pinned;
    }

    /** Evaluate `expr` (async; a deref reads memory) and seek to it. Gen-guarded. */
    async applyExpr() {
        if (!this.expr) return this.refresh();
        const g = ++this._exprGen;
        let v;
        try {
            v = await this.evalAddr(this.expr);
        } catch {
            if (g === this._exprGen) {
                this._markErr(true);
                this.refresh(); // keep the visible window current even with a bad expr
            }
            return; // (guarded: a superseded eval must not flag the live view red)
        }
        if (g !== this._exprGen) return; // a newer stop/goto superseded this one
        this._markErr(false);
        this._seek(v); // a jump: _seek slideCancels, so this snaps (never slides)
    }

    _markErr(on) {
        if (this.gotoEl) this.gotoEl.classList.toggle("err", on);
    }

    /** Toolbar "SP" button: (re-)pin to the stack pointer and jump to it. */
    gotoSP() {
        this.expr = this.spName.toLowerCase();
        if (!this.pinned) {
            this.pinned = true;
            this.onPinChange(true);
        }
        this._syncGoto();
        this.applyExpr();
    }

    /** Wheel: small notches slide one row at a time; large flings snap. */
    _onWheel(e) {
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= ROW_H; // delta in lines -> px
        else if (e.deltaMode === 2) dy *= this.count * ROW_H; // delta in pages -> px
        this._wheelAcc += dy;
        const rows = (this._wheelAcc / ROW_H) | 0; // whole rows, truncated toward zero
        if (!rows) return;
        this._wheelAcc -= rows * ROW_H;
        if (Math.abs(rows) <= OVER) this._stepRows(rows);
        else this._seek(this.base + BigInt(rows * this.wordSize));
    }

    /** Reflect the current expression into the goto field (unless the user is typing). */
    _syncGoto() {
        if (!this.gotoEl || document.activeElement === this.gotoEl) return;
        this.gotoEl.value = this.expr;
    }

    /** Bar/goto seek: snap to a word boundary, keep the window within the span. */
    _seek(addr) {
        slideCancel(this.slideEl);
        this.base = this._clampBase(BigInt(addr));
        this.refresh();
    }

    /** Word-align an address and keep the window inside [memLo, memHi). */
    _clampBase(a) {
        const ws = BigInt(this.wordSize);
        a = (a / ws) * ws;
        const win = BigInt(this.count * this.wordSize);
        if (this.memHi > this.memLo) {
            const maxBase = this.memHi > win ? this.memHi - win : this.memLo;
            if (a > maxBase) a = maxBase;
            if (a < this.memLo) a = this.memLo;
            a = (a / ws) * ws;
        }
        return a;
    }

    /** Arrow / wheel step by `dr` whole words, with a ~110ms catch-up slide. */
    _stepRows(dr) {
        if (!dr) return;
        const nb = this._clampBase(this.base + BigInt(dr * this.wordSize));
        if (nb === this.base) return; // at the edge; nothing moved
        this.base = nb;
        this.vbar.layout(this.base, this.count * this.wordSize); // thumb leads
        this.render(); // optimistic paint from the cached bytes
        if (this._canSlide(dr)) {
            slideRows(this.slideEl, this._restY + dr * ROW_H, this._restY, { maxPx: (OVER + 1) * ROW_H });
        } else {
            slideCancel(this.slideEl);
            this.slideEl.style.transform = this._restY ? `translateY(${this._restY}px)` : "";
        }
        this.refresh(); // re-center the cached window; onData repaints without halting the slide
    }

    /** Can we animate a `dr`-row step from the bytes we already hold? */
    _canSlide(dr) {
        if (!this.bytes || this.winBase == null) return false;
        const n = Math.abs(dr);
        if (n > OVER) return false;
        let dispLo = this.base - BigInt(OVER * this.wordSize);
        if (dispLo < this.memLo) dispLo = this.memLo;
        const leadRows = Number((this.base - dispLo) / BigInt(this.wordSize));
        if (dr > 0 && leadRows < dr) return false; // not enough overscan above to slide down
        if (dr < 0) {
            // Up-slide exposes the bottom; it must be covered by trailing overscan
            // rows (+1 for the partial row left at the clip's bottom edge).
            let trailRows = OVER;
            if (this.memHi > this.memLo) {
                const avail = Number((this.memHi - (this.base + BigInt(this.count * this.wordSize))) / BigInt(this.wordSize));
                trailRows = Math.max(0, Math.min(OVER, avail));
            }
            if (trailRows < n + 1) return false;
        }
        const lo = Number(this.base - this.winBase); // visible window must be in cache
        return lo >= 0 && lo + this.count * this.wordSize <= this.bytes.length;
    }

    _fit() {
        const avail = this.rowsEl.clientHeight;
        const count = Math.max(1, Math.floor((avail - 4) / ROW_H)); // 4 = .hex-rows top padding
        if (count !== this.count) {
            this.count = count;
            slideCancel(this.slideEl);
            this.refresh();
        }
        this.vbar.layout(this.base, this.count * this.wordSize);
    }

    refresh() {
        if (this.engine && this.engine.ready && this.base > 0n) {
            let lo = this.base - BigInt(OVER * this.wordSize);
            if (lo < this.memLo) lo = this.memLo;
            let hi = this.base + BigInt((this.count + OVER) * this.wordSize);
            if (this.memHi > this.memLo && hi > this.memHi) hi = this.memHi;
            this.engine.readMem(lo, Number(hi - lo), "stack");
        } else {
            this.render();
        }
    }

    onData(addr, bytes, valid) {
        this.winBase = BigInt(addr);
        this.bytes = asU8(bytes);
        this.valid = valid ? asU8(valid) : null;
        this.render();
    }

    render() {
        // .empty hides the column dividers so they don't strike through the hint.
        this.root.classList.toggle("empty", !this.bytes || this.winBase == null);
        if (!this.bytes || this.winBase == null) {
            this._restY = 0;
            if (!this.slideEl._slide) this.slideEl.style.transform = "";
            this.slideEl.innerHTML = '<div class="inspect-hint">No stack yet. Run the program.</div>';
            this.vbar.layout(this.base, this.count * this.wordSize);
            return;
        }
        const ws = this.wordSize;
        let dispLo = this.base - BigInt(OVER * ws); // first rendered (overscan) row
        if (dispLo < this.memLo) dispLo = this.memLo;
        const leadRows = Number((this.base - dispLo) / BigInt(ws));
        this._restY = -leadRows * ROW_H;
        const total = leadRows + this.count + OVER; // lead + visible + trail
        let html = "";
        for (let i = 0; i < total; i++) {
            const addr = dispLo + BigInt(i * ws);
            if (this.memHi > this.memLo && addr >= this.memHi) break;
            const off = Number(addr - this.winBase); // offset into this.bytes
            const isSP = addr === this.sp;
            const mark = isSP ? `<span class="sp-mark">${icon("pointer", { size: 14 })}sp</span>` : ""; // amber ◂ (flipped) at SP
            // A word outside the cache or with any unmapped byte has no defined
            // value: show ?? and skip the ret annotation.
            let bad = off < 0 || off + ws > this.bytes.length;
            if (!bad && this.valid) for (let j = 0; j < ws; j++) if (!this.valid[off + j]) { bad = true; break; }
            if (bad) {
                html += `<div class="hex-row${isSP ? " sp" : ""}" data-off="${off}"><span class="addr">${dimZeros(toHex(addr, 8))}</span><span class="mono unmapped">${"??".repeat(ws)}</span><span class="hex-marks">${mark}</span></div>`;
                continue;
            }
            const val = bytesToBig(this.bytes.slice(off, off + ws), this.bigEndian);
            const isRet = val >= this.codeLo && val < this.codeHi;
            const ann = isRet ? `<span class="ret-mark">→ ret 0x${toHex(val, 8)}</span>` : "";
            html += `<div class="hex-row${isSP ? " sp" : ""}" data-off="${off}"><span class="addr">${dimZeros(toHex(addr, 8))}</span><span class="mono">${dimZeros(toHex(val, hexWidth(ws)))}</span><span class="hex-marks">${mark}${ann}</span></div>`;
        }
        this.slideEl.innerHTML = html;
        // Leave the transform alone while a slide is mid-flight (it's heading to _restY).
        if (!this.slideEl._slide) {
            this.slideEl.style.transform = this._restY ? `translateY(${this._restY}px)` : "";
        }
        this.vbar.layout(this.base, this.count * this.wordSize);
    }

    _hover(e) {
        const row = e.target.closest(".hex-row");
        if (!row || !this.bytes) return;
        const off = +row.dataset.off;
        if (off < 0 || off + this.wordSize > this.bytes.length) return;
        const slice = this.bytes.slice(off, off + this.wordSize);
        const addr = this.winBase + BigInt(off);
        this.onInspect({ label: "stack[0x" + toHex(addr, 8) + "]", expr: "[0x" + toHex(addr, 8) + "]", bytes: slice, size: this.wordSize });
    }

    /** Double-click a word value to edit it (like the register / memory views):
     *  an inline hex input that writes the whole word back to guest memory. */
    _edit(e) {
        const valEl = e.target.closest(".mono");
        const row = e.target.closest(".hex-row");
        if (!valEl || !row || !this.bytes || !this.engine || !this.engine.ready) return;
        const off = +row.dataset.off;
        const ws = this.wordSize;
        if (off < 0 || off + ws > this.bytes.length) return; // unmapped / out-of-cache word
        if (this.valid) for (let j = 0; j < ws; j++) if (!this.valid[off + j]) return;

        const addr = this.winBase + BigInt(off);
        inlineEdit(valEl, toHex(bytesToBig(this.bytes.slice(off, off + ws), this.bigEndian), hexWidth(ws)), {
            width: "100%",
            onCommit: (v) => {
                try {
                    this.engine.writeMem(addr, bigToBytes(parseValue(v), ws, this.bigEndian));
                    setTimeout(() => this.refresh(), 0);
                } catch {
                    this.render();
                }
            },
            onDone: () => this.render(),
        });
    }
}
