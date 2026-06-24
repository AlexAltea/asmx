/*
 * Memory view: an editable hex dump that fills the panel height. It renders as
 * many rows as fit (recomputed on resize), reads that window from the engine on
 * every stop, dims zero bytes, shows ASCII, feeds the type-inspector on hover,
 * and writes edits back. A virtual scrollbar (ui/vbar.js) spans the whole mapped
 * address range; `goto`/drag jump anywhere within it, and the bar's end-arrows (or
 * a wheel notch) step it one row at a time with a brief ~110ms slide.
 *
 * To make that slide possible the view over-reads a few hidden OVERSCAN rows on
 * each side of the viewport: `base` is the first VISIBLE address, while `winBase`
 * is the address of `bytes[0]` (= base - OVERSCAN rows). A row step re-renders the
 * destination optimistically from the cached bytes, slides the wrapper, and only
 * re-reads from the engine afterwards, so the async reply never interrupts the
 * animation.
 */
import { toHex, dimZeros, byteToChar, parseValue, escapeHtml, asU8 } from "../core/bigint.js";
import { mapsExtent } from "../core/mem.js";
import { inlineEdit } from "./dom.js";
import { VBar } from "./vbar.js";
import { ColumnHeader } from "./cols.js";
import { slideRows, slideCancel } from "./slide.js";
import { HEX_ROW_H as ROW_H, MONO_CH } from "./geometry.js";

const OVER = 8; // hidden overscan rows each side (covers a wheel notch's worth of slide)

export class MemoryView {
    constructor(root, { engine, onInspect, evalAddr, onPinChange }) {
        this.root = root;
        this.engine = engine;
        this.onInspect = onInspect || (() => {});
        this.evalAddr = evalAddr || (async () => { throw new Error("no evaluator"); });
        this.onPinChange = onPinChange || (() => {});
        this.base = 0x10000n; // address of the first VISIBLE row
        this.winBase = null; // address of bytes[0] (= base - OVER rows); null until first read
        this.cols = 16;
        this.rows = 8; // recomputed by _fit() to fill the panel height
        this.bytes = null;
        this.valid = null; // per-byte map: 1 = mapped, 0 = unmapped (render as ??)
        this.memLo = 0n;
        this.memHi = 0n;
        this.gotoEl = null; // goto input; holds the user's EXPRESSION (not the live address)
        this.expr = ""; // pinned / last-entered expression; "" = none
        this.pinned = false; // when set, re-evaluate `expr` and follow it on every stop
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
        // panels): Address and Bytes are resizable, ASCII flexes to fill. Cell model:
        // the 8px insets live inside each cell, so a divider always lands between two
        // padded cells. Defaults fit the content: Address = 8 hex chars, Bytes =
        // "NN " x 16 (47ch) + the per-byte .mb 1px insets (32px); +16px cell insets.
        root.classList.add("col-host");
        this.colHead = new ColumnHeader(root, {
            id: "mem",
            cell: true,
            rowSel: ".hex-row",
            columns: [
                { key: "addr", label: "Address", w: Math.ceil(8 * MONO_CH) + 16, min: 56, max: 200 },
                { key: "bytes", label: "Bytes", w: Math.ceil(47 * MONO_CH + 32) + 16, min: 60, max: 560, clip: true },
                { key: "ascii", label: "ASCII", w: "minmax(0,1fr)" },
            ],
        });
        root.replaceChildren(this.colHead.render(), this.bodyEl);
        this.colHead.mountGuides(root);

        this.slideEl.addEventListener("mouseover", (e) => this._hover(e));
        this.slideEl.addEventListener("dblclick", (e) => this._edit(e));
        root.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
        this._ro = new ResizeObserver(() => this._fit());
        this._ro.observe(root);
    }

    /** Seed the virtual bar's extents from the guest memory map. */
    setMaps(maps) {
        ({ lo: this.memLo, hi: this.memHi } = mapsExtent(maps));
        this.vbar.setRange(this.memLo, this.memHi);
        this.render();
    }

    setBase(addr) {
        slideCancel(this.slideEl); // a deliberate jump cancels any in-flight slide
        this.base = BigInt(addr);
        this.refresh();
    }

    /** goto field (Enter): adopt the typed expression and jump to its value. */
    goto(text) {
        this.expr = String(text).trim();
        this.applyExpr();
    }

    /** Mode switch / fresh engine: drop any pinned expression and unmark errors. */
    clearExpr() {
        this._exprGen++; // cancel any in-flight eval from the previous engine/mode
        this.expr = "";
        this.pinned = false;
        this.onPinChange(false);
        this._markErr(false);
        this._syncGoto();
    }

    /** Toolbar pin toggle: follow `expr` on every stop. Returns the new state. */
    togglePin() {
        this.pinned = !this.pinned;
        this.onPinChange(this.pinned);
        if (this.pinned) this.applyExpr();
        return this.pinned;
    }

    /** On a stop: follow the pinned expression, else just refresh in place. */
    onStop() {
        if (this.pinned) this.applyExpr();
        else this.refresh();
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
        this._seek(v); // a jump: setBase slideCancels, so this snaps (never slides)
    }

    _markErr(on) {
        if (this.gotoEl) this.gotoEl.classList.toggle("err", on);
    }

    /** Wheel: small notches slide one row at a time; large flings snap. */
    _onWheel(e) {
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= ROW_H; // delta in lines -> px
        else if (e.deltaMode === 2) dy *= this.rows * ROW_H; // delta in pages -> px
        this._wheelAcc += dy;
        const rows = (this._wheelAcc / ROW_H) | 0; // whole rows, truncated toward zero
        if (!rows) return;
        this._wheelAcc -= rows * ROW_H;
        if (Math.abs(rows) <= OVER) this._stepRows(rows);
        else this._seek(this.base + BigInt(rows * this.cols));
    }

    /** Reflect the current expression into the goto field (unless the user is typing). */
    _syncGoto() {
        if (!this.gotoEl || document.activeElement === this.gotoEl) return;
        this.gotoEl.value = this.expr;
    }

    /** Bar seek: snap to a column boundary, keep the window within the span. */
    _seek(addr) {
        this.setBase(this._clampBase(BigInt(addr)));
    }

    /** Column-align an address and keep the window inside [memLo, memHi). */
    _clampBase(a) {
        a = a & ~BigInt(this.cols - 1);
        const win = BigInt(this.rows * this.cols);
        if (this.memHi > this.memLo) {
            const maxBase = this.memHi > win ? this.memHi - win : this.memLo;
            if (a > maxBase) a = maxBase;
            if (a < this.memLo) a = this.memLo;
            a = a & ~BigInt(this.cols - 1);
        }
        return a;
    }

    /** Arrow / wheel step by `dr` whole rows, with a ~110ms catch-up slide. */
    _stepRows(dr) {
        if (!dr) return;
        const nb = this._clampBase(this.base + BigInt(dr * this.cols));
        if (nb === this.base) return; // at the edge; nothing moved
        if (this._editing()) return this.setBase(nb); // active input: snap
        this.base = nb;
        this.vbar.layout(this.base, this.rows * this.cols); // thumb leads
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
        let dispLo = this.base - BigInt(OVER * this.cols);
        if (dispLo < this.memLo) dispLo = this.memLo;
        const leadRows = Number((this.base - dispLo) / BigInt(this.cols));
        if (dr > 0 && leadRows < dr) return false; // not enough overscan above to slide down
        if (dr < 0) {
            // Up-slide exposes the bottom; it must be covered by trailing overscan
            // rows. +1 covers the partial row that floor()-ing the visible count
            // leaves at the clip's bottom edge.
            let trailRows = OVER;
            if (this.memHi > this.memLo) {
                const avail = Number((this.memHi - (this.base + BigInt(this.rows * this.cols))) / BigInt(this.cols));
                trailRows = Math.max(0, Math.min(OVER, avail));
            }
            if (trailRows < n + 1) return false;
        }
        const lo = Number(this.base - this.winBase); // visible window must be in cache
        return lo >= 0 && lo + this.rows * this.cols <= this.bytes.length;
    }

    _editing() {
        const a = document.activeElement;
        return a && a.tagName === "INPUT" && this.slideEl.contains(a);
    }

    /** Recompute the visible row count to fill the panel; re-read if it changed. */
    _fit() {
        const avail = this.rowsEl.clientHeight;
        const rows = Math.max(1, Math.floor((avail - 4) / ROW_H)); // 4 = .hex-rows top padding
        if (rows !== this.rows) {
            this.rows = rows;
            slideCancel(this.slideEl);
            this.refresh();
        }
        this.vbar.layout(this.base, this.rows * this.cols);
    }

    refresh() {
        if (this.engine && this.engine.ready) {
            let lo = this.base - BigInt(OVER * this.cols);
            if (lo < this.memLo) lo = this.memLo;
            let hi = this.base + BigInt((this.rows + OVER) * this.cols);
            if (this.memHi > this.memLo && hi > this.memHi) hi = this.memHi;
            this.engine.readMem(lo, Number(hi - lo), "mem");
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
            this.slideEl.innerHTML = '<div class="inspect-hint">No data. Run or goto an address.</div>';
            this.vbar.layout(this.base, this.rows * this.cols);
            return;
        }
        const cols = this.cols;
        let dispLo = this.base - BigInt(OVER * cols); // first rendered (overscan) row
        if (dispLo < this.memLo) dispLo = this.memLo;
        const leadRows = Number((this.base - dispLo) / BigInt(cols));
        this._restY = -leadRows * ROW_H;
        const total = leadRows + this.rows + OVER; // lead + visible + trail
        let html = "";
        for (let r = 0; r < total; r++) {
            const rowAddr = dispLo + BigInt(r * cols);
            if (this.memHi > this.memLo && rowAddr >= this.memHi) break;
            const byteBase = Number(rowAddr - this.winBase); // offset into this.bytes
            let hex = "";
            let ascii = "";
            for (let c = 0; c < cols; c++) {
                const i = byteBase + c;
                const inb = i >= 0 && i < this.bytes.length;
                const b = inb ? this.bytes[i] : 0;
                const unmapped = !inb || (this.valid ? !this.valid[i] : false);
                if (unmapped) {
                    hex += `<span class="mb unmapped" data-off="${i}">??</span> `;
                    ascii += '<span class="unmapped">?</span>'; // muted, like the ?? bytes
                } else {
                    const cell = `<span class="mb" data-off="${i}">${toHex(b, 2)}</span>`;
                    hex += (b === 0 ? `<span class="zero">${cell}</span>` : cell) + " ";
                    ascii += escapeHtml(byteToChar(b));
                }
            }
            html += `<div class="hex-row"><span class="addr">${dimZeros(toHex(rowAddr, 8))}</span><span class="mbytes">${hex.trimEnd()}</span><span class="ascii">${ascii}</span></div>`;
        }
        this.slideEl.innerHTML = html;
        // Leave the transform alone while a slide is mid-flight (it's heading to _restY).
        if (!this.slideEl._slide) {
            this.slideEl.style.transform = this._restY ? `translateY(${this._restY}px)` : "";
        }
        this.vbar.layout(this.base, this.rows * this.cols);
    }

    _addrOf(off) {
        return this.winBase + BigInt(off);
    }

    _hover(e) {
        const mb = e.target.closest(".mb");
        if (!mb || !this.bytes) return;
        const off = +mb.dataset.off;
        if (off < 0 || off >= this.bytes.length) return;
        const slice = this.bytes.slice(off, off + 8);
        const padded = new Uint8Array(8);
        padded.set(slice);
        const at = "[0x" + toHex(this._addrOf(off), 8) + "]";
        this.onInspect({ label: at, expr: at, bytes: padded, size: Math.min(8, this.bytes.length - off) || 1 });
    }

    _edit(e) {
        const mb = e.target.closest(".mb");
        if (!mb) return;
        const off = +mb.dataset.off;
        if (off < 0 || off >= this.bytes.length) return;
        if (this.valid && !this.valid[off]) return; // can't edit unmapped bytes

        const addr = this._addrOf(off);
        inlineEdit(mb, toHex(this.bytes[off], 2), {
            width: "2.4em",
            onCommit: (v) => {
                try {
                    this.engine.writeMem(addr, [Number(parseValue(v) & 0xffn)]);
                    setTimeout(() => this.refresh(), 0);
                } catch {
                    this.render();
                }
            },
            onDone: () => this.render(),
        });
    }
}
