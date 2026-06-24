/*
 * Disassembly view: a windowed listing over the whole mapped range [memLo,memHi).
 * Only the rows currently in the viewport are materialized (no giant spacer), so
 * variable-length ISAs work without an address-to-row table; navigation steps one
 * instruction at a time via ui/disasm_nav.js. Rows come from four sources:
 *   - the editable document (assembled code): text-editor-style inline editing,
 *   - the executable region's zero padding past the code (decoded, muted),
 *   - any other mapped region (data/stack): disassembled from live guest bytes,
 *   - unmapped gaps: shown as `??` (uc_err_read_unmapped), like the hex views.
 *
 * Row columns: [bp gutter][ip gutter][arrow gutter][address][bytes][asm].
 * Scrolling is instruction-granular (wheel / the VBar), not pixel-native: the
 * anchor `this.top` is a position (a document line index, or a guest address).
 */
import { toHex, bytesToHex, dimZeros, escapeHtml, parseValue, asU8 } from "../core/bigint.js";
import { PROT, mapsExtent } from "../core/mem.js";
import { highlightAsmParts } from "./syntax.js";
import { icon } from "./icons.js";
import { VBar } from "./vbar.js";
import { ColumnHeader } from "./cols.js";
import * as nav from "./disasm_nav.js";
import { slideRows, slideCancel } from "./slide.js";
import { DISASM_ROW_H as ROW_H } from "./geometry.js";
import { el, lsGet, lsSet, popover } from "./dom.js";

const MAX_INSN = 16; // bytes fetched per instruction decode (x86 worst case = 15)
const OVER = 6; // hidden overscan rows each side, so a wheel/arrow slide never flashes blank

const LS_PREFS = "asmx.disasm"; // view options (split / hidePad / hideNonExec); widths live in the shared ColumnHeader

/**
 * The shared --cols template for the listing (gutters + data columns), passed to
 * the ColumnHeader. The bp(22)+ip(16)=38px gutters are fixed (ui/arrows.js hardcodes
 * that offset); the arrow gutter rides the live --arrow-w var. addr/bytes (and the
 * split-mode mnemonic) are the resizable columns; the trailing column flexes.
 */
function editorColumns(split) {
    const cols = [
        { key: "bp", w: 22 },
        { key: "ip", w: 16 },
        { key: "arrow", w: "var(--arrow-w, 0px)" },
        { key: "addr", label: "Address", w: 102, min: 56, max: 260 },
        // clip: the byte dump may be dragged past its content, truncating with a CSS
        // ellipsis (see .c-bytes) rather than clamping at content width.
        { key: "bytes", label: "Bytes", w: 166, min: 60, max: 480, clip: true },
    ];
    if (split) {
        cols.push({ key: "mnem", label: "Mnemonic", w: 108, min: 44, max: 240 });
        cols.push({ key: "ops", label: "Operands", w: "minmax(0,1fr)" });
    } else {
        cols.push({ key: "asm", label: "Disassembly", w: "minmax(0,1fr)" });
    }
    return cols;
}

export class Editor {
    constructor(root, { doc, onChange, breakpoints, onRunToCursor, onSetIP, onSetEntry, onInspect, engine, disassembler }) {
        this.root = root;
        this.doc = doc;
        this.onChange = onChange || (() => {});
        this.onRunToCursor = onRunToCursor || (() => {});
        this.onSetIP = onSetIP || (() => {}); // context menu: move the instruction pointer to a line
        this.onSetEntry = onSetEntry || (() => {}); // context menu: pin the entry point to a line
        this.onInspect = onInspect || (() => {}); // operand-register hover -> inspector (expr string)
        this.engine = engine || null; // for reading data/stack bytes (set by app)
        this.disassembler = disassembler || null; // decodes mapped non-code bytes
        // Breakpoints live in a shared store (gutter + Breakpoints panel + app's
        // run/step all read it). Re-render whenever it changes: a gutter click,
        // or the panel adding/removing/editing a condition, both flow through here.
        this.breakpoints = breakpoints;
        this.breakpoints.onChange(() => this.render());
        this.editingId = null;
        this._programmatic = false;
        this.arrows = null; // optional ArrowGutter (set by app)
        this.analysis = []; // branch analysis for arrows (set by app on change)
        this.gotoEl = null; // optional goto input mirroring the top visible address
        this.maps = []; // mapped regions {addr,size,perms}
        this._padInsn = null; // {size,text} that all-zero bytes decode to (per arch)
        this.memLo = 0n;
        this.memHi = 0n;
        this.top = 0; // anchor position: a doc line index (number) or address (bigint)
        this.mem = null; // cached byte window from the engine: {base, bytes}
        this._memReq = null; // last requested window, to dedupe reads
        this._wheelAcc = 0;
        this._hoverReg = null; // last operand register hovered (dedupes inspector calls)
        this._ctxMenu = null; // open right-click menu (a popover handle), if any
        this._ctxLineId = null; // row the open menu targets (stays highlighted until close)
        root.classList.add("editor");

        // Column layout: persisted split mode (per-column widths live in the shared
        // ColumnHeader, keyed "disasm").
        const prefs = loadPrefs();
        this.split = !!prefs.split; // false: one asm column; true: mnemonic | operands
        this.hidePad = !!prefs.hidePad; // view option: hide the zero-padding tail
        this.hideNonExec = !!prefs.hideNonExec; // view option: hide data/stack/gaps
        root.classList.toggle("split", this.split);

        // DOM: .ed-main = the shared .col-head stacked over .ed-body ( .ed-rows
        // (windowed listing) | .vbar ). The header spans the full width so its
        // columns line up with the rows; the VBar sits beside the rows only, so its
        // thumb tracks the listing (not the header). The native scrollbar is gone;
        // the list never overflows; wheel + the VBar re-anchor `this.top`.
        this.rowsHost = document.createElement("div");
        this.rowsHost.className = "ed-rows";
        // Inner wrapper that holds the rows (and the arrow overlay). The host stays
        // put as the clip; this element is what slides during a wheel/arrow scroll.
        this.slideEl = document.createElement("div");
        this.slideEl.className = "ed-slide";
        this.rowsHost.appendChild(this.slideEl);
        this._restY = 0; // current resting transform (px) = -leadCount*ROW_H
        this._leadCount = 0; // hidden overscan rows above the viewport
        this._trailCount = 0; // hidden overscan rows below the viewport
        this.vbar = new VBar({ onSeek: (a) => this._seek(a), onStep: (d) => this._scrollRows(d) });
        this.bodyEl = document.createElement("div");
        this.bodyEl.className = "ed-body";
        this.bodyEl.append(this.rowsHost, this.vbar.el);
        this.mainEl = document.createElement("div");
        this.mainEl.className = "ed-main";
        // Shared header + full-height resize dividers (same component as the other
        // panels); bare model so the gutter cells (not a container) set the origin.
        this.cols = new ColumnHeader(root, { id: "disasm", bare: true, columns: editorColumns(this.split), rowSel: ".ed-row" });
        this.mainEl.append(this.cols.render(), this.bodyEl);
        root.append(this.mainEl);
        this.cols.mountGuides(this.mainEl);

        root.addEventListener("click", (e) => this._onClick(e));
        root.addEventListener("dblclick", (e) => this._onDblClick(e));
        // Operand-register hover: delegated (rows re-render constantly). mouseover
        // bubbles; mouseout resets the dedupe so re-entering the same token re-fires.
        this.rowsHost.addEventListener("mouseover", (e) => this._onRegHover(e));
        this.rowsHost.addEventListener("mouseout", (e) => {
            if (e.target.closest(".t-reg")) this._hoverReg = null;
        });
        root.addEventListener("contextmenu", (e) => {
            const row = e.target.closest(".ed-row");
            if (!row || !row.dataset.id) return; // read-only rows have no line id
            e.preventDefault();
            this._openCtxMenu(e.clientX, e.clientY, +row.dataset.id);
        });
        root.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
        this._ro = new ResizeObserver(() => this.render());
        this._ro.observe(this.rowsHost);
    }

    // ---- right-click menu ------------------------------------------------
    /** Open the disassembly context menu at the cursor. A single "Execute until
     *  here..." action (formerly fired directly on right-click). Reuses the shared
     *  .popover / .popover-row look (see ui/layout.js's panels menu). */
    _openCtxMenu(x, y, lineId) {
        this._closeCtxMenu();
        // Keep the targeted row visibly selected while the menu is open (re-renders
        // re-apply the class via _docRowEl, since _ctxLineId outlives this DOM).
        this._ctxLineId = lineId;
        // .ctx-open freezes the row highlight to the target row (CSS) so hovering
        // other rows while the menu is up doesn't light them up.
        this.root.classList.add("ctx-open");
        this.rowsHost.querySelector(`.ed-row[data-id="${lineId}"]`)?.classList.add("ctx-target");
        const menu = el("div", "popover ctx-menu");
        const addItem = (label, act) => {
            const item = el("div", "popover-row");
            item.textContent = label;
            item.addEventListener("click", () => {
                this._closeCtxMenu();
                act(lineId);
            });
            menu.appendChild(item);
        };
        addItem("Execute until here...", (id) => this.onRunToCursor(id));
        addItem("Set instruction pointer here", (id) => this.onSetIP(id));
        addItem("Set original entry point here", (id) => this.onSetEntry(id));
        this._ctxMenu = popover(menu, { x, y }, {
            gap: 0, // open from the cursor itself
            onClose: () => {
                menu.remove();
                this._ctxMenu = null;
                this._ctxLineId = null;
                this.root.classList.remove("ctx-open");
                for (const r of this.rowsHost.querySelectorAll(".ed-row.ctx-target")) r.classList.remove("ctx-target");
            },
        });
    }

    _closeCtxMenu() {
        this._ctxMenu?.close();
    }

    // ---- configuration ---------------------------------------------------
    /** Seed the address range (and keep the maps for segment classification). */
    setMaps(maps) {
        this.maps = (maps || []).map((m) => ({
            addr: BigInt(m.addr),
            size: BigInt(m.size),
            perms: Number(m.perms),
        }));
        ({ lo: this.memLo, hi: this.memHi } = mapsExtent(this.maps));
        this._syncBar(); // sets the bar range from the effective (filtered) extent
    }

    /**
     * The instruction that an all-zero byte run disassembles to (e.g. x86
     * `add byte ptr [rax], al`) + its size: the unit the executable region's
     * zero padding is shown as. `{size,text}` or null. Set on arch/mode change.
     */
    setPadding(insn) {
        this._padInsn = insn && insn.size ? insn : null;
    }

    setAnalysis(info) {
        this.analysis = info || [];
    }

    /** The executable region holding the document, or null. */
    _execRegion() {
        const base = this.doc.base;
        for (const m of this.maps) {
            if (m.perms & PROT.X && base >= m.addr && base < m.addr + m.size) {
                return { addr: m.addr, end: m.addr + m.size };
            }
        }
        return null;
    }

    /**
     * Effective top of the listing under the view filters: `hideNonExec` trims the
     * range to the executable region; `hidePad` (when the whole tail past the code
     * is also gone) pulls it down to the document's end. Drives both nav + the bar.
     */
    _effHi() {
        const exec = this._execRegion();
        const end = this.doc.endAddr();
        let hi = this.memHi;
        if (exec) {
            if (this.hideNonExec && exec.end < hi) hi = exec.end;
            if (this.hidePad && this._padInsn && end < exec.end && hi <= exec.end) hi = end;
        }
        return hi;
    }

    /** Snapshot of everything ui/disasm_nav.js needs for this render. */
    _ctx() {
        const exec = this._execRegion();
        const end = this.doc.endAddr();
        // hidePad hides the executable region's zero-padding tail [end, exec.end) by
        // marking it as an interior interval the navigation skips over.
        const hide = exec && this.hidePad && this._padInsn && end < exec.end ? { lo: end, hi: exec.end } : null;
        return {
            base: this.doc.base,
            end,
            memLo: this.memLo,
            memHi: this._effHi(),
            hide,
            lineCount: this.doc.lines.length,
            lineAddr: (i) => this.doc.lines[i].addr,
            maps: this.maps,
            exec,
            padStride: this._padInsn && exec ? BigInt(this._padInsn.size) : null,
            decode: (a) => this._navDecode(a),
        };
    }

    /** View-options toggle (settings popover): hidePad / hideNonExec. */
    setFilter(key, value) {
        if (key !== "hidePad" && key !== "hideNonExec") return;
        this[key] = !!value;
        savePrefs(this);
        this.render(); // re-render + re-sync the bar range (via _syncBar)
    }

    _visibleRows() {
        const h = this.rowsHost.clientHeight;
        return h > 0 ? Math.ceil(h / ROW_H) + 1 : 40; // +1 so the last partial row fills
    }

    // ---- rendering -------------------------------------------------------
    render() {
        slideCancel(this.slideEl); // a fresh render supersedes any in-flight slide
        const doc = this.doc;
        this._entryLineId = doc.entryLineId(); // marks the original entry point in the g-ip gutter
        if (!doc.lines.length) {
            this.mem = null;
            this._restY = this._leadCount = this._trailCount = 0;
            this.root.style.setProperty("--arrow-w", "0px"); // no arrows, no reserved gutter (header too)
            this.slideEl.style.transform = "";
            this.slideEl.innerHTML =
                '<div class="ed-empty">Empty program. Click <b>+ line</b> to start typing assembly.</div>';
            this.cols.layoutGuides(); // arrow gutter just changed; reposition the dividers
            this._syncBar();
            return;
        }
        const ctx = this._ctx();
        const vis = this._visibleRows();
        const { top, positions } = this._collect(ctx, nav.clampPos(ctx, this.top), vis);
        this.top = top;

        // Hidden overscan rows above/below the viewport, so a scroll-slide that
        // momentarily shifts the wrapper by a few rows never reveals a blank strip.
        const lead = [];
        for (let p = nav.prevPos(ctx, top); p != null && lead.length < OVER; p = nav.prevPos(ctx, p)) lead.push(p);
        lead.reverse();
        const last = positions.length ? positions[positions.length - 1] : top;
        const trail = [];
        for (let p = nav.nextPos(ctx, last); p != null && trail.length < OVER; p = nav.nextPos(ctx, p)) trail.push(p);
        const all = [...lead, ...positions, ...trail];
        this._leadCount = lead.length;
        this._trailCount = trail.length;
        this._restY = -lead.length * ROW_H;

        const descs = all.map((pos) => this._rowDesc(ctx, pos));
        const frag = document.createDocumentFragment();
        const rowOf = new Map(); // line id -> screen row index (for the arrow gutter)
        descs.forEach((desc, idx) => {
            if (desc.type === "doc") {
                rowOf.set(desc.ln.id, idx);
                frag.appendChild(this._docRowEl(desc.ln));
            } else if (desc.type === "gap") {
                frag.appendChild(this._gapRowEl(desc.addr));
            } else {
                frag.appendChild(this._roRowEl(desc));
            }
        });
        this.slideEl.replaceChildren(frag);
        this.slideEl.style.transform = this._restY ? `translateY(${this._restY}px)` : "";

        if (this.arrows) {
            // Scrolled-out lines clamp to a virtual row just outside the window, so
            // a jump whose span crosses the viewport still draws its lane line.
            const firstDoc = descs.find((d) => d.type === "doc");
            const rowFor = (id) => {
                if (rowOf.has(id)) return rowOf.get(id);
                if (!firstDoc) return null;
                return doc.byId.get(id).addr < firstDoc.ln.addr ? -1 : descs.length;
            };
            this.arrows.update(doc, this.analysis, doc.ipLineId, rowFor, descs.length);
            // On the editor root so both the header and the rows pick up the gutter width.
            this.root.style.setProperty("--arrow-w", this.arrows.width + "px");
            if (this.arrows.svg) this.slideEl.insertBefore(this.arrows.svg, this.slideEl.firstChild);
        }
        this.cols.layoutGuides(); // arrow gutter width may have changed; reposition the dividers
        if (this.editingId != null && rowOf.has(this.editingId)) this._mountInput(this.editingId);
        this._ensureMem(descs);
        this._syncBar();
    }

    /**
     * Forward-fill `vis` positions from `start`; if we run past the end before
     * filling the viewport, back-fill from above so the last page isn't half-empty.
     * Returns the true visible top (used by the scrollbar/goto) and the positions.
     */
    _collect(ctx, start, vis) {
        const fwd = [];
        for (let pos = start; pos != null && fwd.length < vis; pos = nav.nextPos(ctx, pos)) fwd.push(pos);
        const pre = [];
        for (let pos = nav.prevPos(ctx, start); pos != null && pre.length + fwd.length < vis; pos = nav.prevPos(ctx, pos)) {
            pre.push(pos);
        }
        pre.reverse();
        const positions = [...pre, ...fwd].slice(0, vis);
        return { top: positions.length ? positions[0] : start, positions };
    }

    _rowDesc(ctx, pos) {
        if (typeof pos === "number") return { type: "doc", ln: this.doc.lines[pos] };
        const seg = nav.segAt(ctx, pos);
        if (seg === nav.GAP) return { type: "gap", addr: pos };
        if (seg === nav.PAD) {
            const [mnem, ops] = splitMnemonic(this._padInsn.text);
            return { type: "ro", addr: pos, bytesHex: Array(this._padInsn.size).fill("00").join(" "), mnem: escapeHtml(mnem), ops: escapeHtml(ops) };
        }
        const dec = this._decodeFull(pos);
        if (!dec) return { type: "ro", addr: pos, bytesHex: "··", mnem: "", ops: "" }; // bytes not fetched yet
        return { type: "ro", addr: pos, bytesHex: dec.bytesHex, mnem: dec.mnem, ops: dec.ops };
    }

    // ---- byte cache + decoding (data/stack regions) ----------------------
    _bytes(a, n) {
        const m = this.mem;
        if (!m) return null;
        const off = Number(a - m.base);
        if (off < 0 || off >= m.bytes.length) return null;
        return m.bytes.subarray(off, Math.min(m.bytes.length, off + n));
    }

    /** One-instruction size at `a` for navigation (null bytes count as 1). */
    _navDecode(a) {
        const b = this._bytes(a, MAX_INSN);
        if (!b) return null;
        const insn = this.disassembler.one(b, a);
        return { size: insn ? BigInt(insn.size) : 1n };
    }

    /** Full decode (size + mnemonic + operands + bytes) for a visible mem row, or null. */
    _decodeFull(a) {
        const b = this._bytes(a, MAX_INSN);
        if (!b) return null;
        const insn = this.disassembler.one(b, a);
        if (!insn) return { bytesHex: toHex(b[0], 2), mnem: "", ops: "" }; // undecodable byte
        return {
            bytesHex: bytesToHex(b.subarray(0, insn.size)),
            mnem: escapeHtml(insn.mnemonic),
            ops: escapeHtml(insn.op_str || ""),
        };
    }

    _memCovers(lo, hi) {
        const m = this.mem;
        return m && m.base <= lo && hi <= m.base + BigInt(m.bytes.length);
    }

    /** Fetch the byte window the visible mapped (non-code) rows need. */
    _ensureMem(rows) {
        const exec = this._execRegion();
        const end = this.doc.endAddr();
        let first = null,
            count = 0;
        for (const d of rows) {
            if (d.type !== "ro") continue;
            // padding is synthetic; only data/stack rows actually need live bytes.
            if (this._padInsn && exec && d.addr >= end && d.addr < exec.end) continue;
            if (first === null || d.addr < first) first = d.addr;
            count++;
        }
        if (first === null) return;
        // Worst case each visible row is a full-length instruction; fetch that
        // much (plus back-slack for scroll-up) so one read settles the window.
        let lo = first - BigInt(MAX_INSN * 4);
        let hi = first + BigInt((count + 1) * MAX_INSN);
        if (lo < this.memLo) lo = this.memLo;
        if (hi > this.memHi) hi = this.memHi;
        if (this._memCovers(lo, hi)) return;
        if (this._memReq && this._memReq.lo === lo && this._memReq.hi === hi) return; // in flight
        if (!this.engine || !this.engine.ready) return;
        this._memReq = { lo, hi };
        this.engine.readMem(lo, Number(hi - lo), "disasm");
    }

    /** Engine reply for our private "disasm" read (routed by app.js). */
    onDisasmData(addr, bytes) {
        this.mem = { base: BigInt(addr), bytes: asU8(bytes) };
        this._memReq = null;
        this.render();
    }

    // ---- row elements ----------------------------------------------------
    _docRowEl(ln) {
        const row = el("div", "ed-row");
        row.dataset.id = ln.id;
        if (ln.id === this.doc.ipLineId) row.classList.add("ip");
        if (ln.id === this._ctxLineId) row.classList.add("ctx-target"); // right-click menu target
        if (ln.error) row.classList.add("error");

        const bp = el("div", "g-bp");
        // Breakpoints are keyed by address, so only an addr-bearing row can hold
        // one; its address is the gutter click target (stored as a decimal string,
        // read back with BigInt in _onClick).
        const bpRec = ln.addrBearing ? this.breakpoints.get(ln.addr) : null;
        if (ln.addrBearing) bp.dataset.bp = ln.addr;
        // Render the breakpoint marker as an SVG: a red disc, plus a "+" when the
        // breakpoint is conditional. Disabled breakpoints render dimmed (CSS).
        if (bpRec) {
            row.classList.add("bp-row");
            if (!bpRec.enabled) row.classList.add("bp-off");
            bp.innerHTML = icon(bpRec.cond ? "breakpoint-conditional" : "breakpoint", { size: 14 });
            bp.title = bpRec.cond ? "Conditional breakpoint; click to remove" : "Breakpoint; click to remove";
        } else {
            bp.title = ln.error || "Toggle breakpoint";
        }

        const addr = el("div", "c-addr mono");
        addr.innerHTML = ln.kind === "blank" ? "" : dimZeros(toHex(ln.addr, 8));

        const bytes = el("div", "c-bytes mono");
        bytes.innerHTML = ln.error
            ? '<span class="zero">??</span>'
            : ln.bytes.length
            ? escapeHtml(bytesToHex(ln.bytes)) // every byte at full brightness (00s are not dimmed)
            : "";

        const ipCell = el("div", "g-ip");
        // Second gutter column: the IP pointer, plus a permanent marker on the
        // original entry point (a dimmed ring). When the IP is resting on the entry
        // (fresh load, or after a reset) the two merge into one play-circle.
        const isIP = ln.id === this.doc.ipLineId;
        const isEntry = ln.id === this._entryLineId;
        if (isIP && isEntry) {
            ipCell.innerHTML = icon("play-circle", { size: 14 });
        } else if (isIP) {
            ipCell.innerHTML = icon("pointer", { size: 14 }); // amber pointer at the IP
        } else if (isEntry) {
            ipCell.classList.add("entry");
            ipCell.innerHTML = icon("circle-large", { size: 14 });
        }
        row.append(bp, ipCell, el("div", "g-arrow"), addr, bytes);
        // The row being edited always uses one wide (spanning) asm cell so the
        // single inline <input> covers the whole disassembly area in both modes.
        const blank = ln.text.trim() === "";
        const parts = blank ? null : highlightAsmParts(ln.text);
        if (this.split && ln.id !== this.editingId) {
            const mnem = el("div", "c-mnem mono");
            const ops = el("div", "c-ops mono");
            mnem.dataset.asm = ops.dataset.asm = ln.id;
            if (parts) {
                mnem.innerHTML = parts.label + parts.mnem;
                ops.innerHTML = parts.ops + parts.comment;
            }
            row.append(mnem, ops);
        } else {
            const asm = el("div", "c-asm mono");
            asm.dataset.asm = ln.id;
            if (this.split) asm.classList.add("wide"); // span mnemonic + operands tracks
            if (parts) asm.innerHTML = parts.label + parts.mnem + parts.ops + parts.comment;
            row.append(asm);
        }
        return row;
    }

    /** Read-only muted row (zero padding, or a disassembled data/stack byte run). */
    _roRowEl(desc) {
        const row = el("div", "ed-row ro");
        row.append(
            el("div", "g-bp"),
            el("div", "g-ip"),
            el("div", "g-arrow"),
            html(el("div", "c-addr mono"), dimZeros(toHex(desc.addr, 8))),
            html(el("div", "c-bytes mono"), desc.bytesHex),
            ...this._asmCells(desc.mnem, desc.ops)
        );
        return row;
    }

    /** Unmapped byte: `??`, no instruction (mirrors the Memory/Stack views). */
    _gapRowEl(addr) {
        const row = el("div", "ed-row ro gap");
        row.append(
            el("div", "g-bp"),
            el("div", "g-ip"),
            el("div", "g-arrow"),
            html(el("div", "c-addr mono"), dimZeros(toHex(addr, 8))),
            html(el("div", "c-bytes mono"), "??"),
            ...this._asmCells("", "")
        );
        return row;
    }

    /** The asm cell(s) for a read-only row: one `.c-asm` (joined) or, in split
     *  mode, separate `.c-mnem` + `.c-ops`. `mnem`/`ops` are already HTML-escaped. */
    _asmCells(mnem, ops) {
        if (this.split) return [html(el("div", "c-mnem mono"), mnem), html(el("div", "c-ops mono"), ops)];
        return [html(el("div", "c-asm mono"), mnem + (ops ? " " + ops : ""))];
    }

    /** Cheap IP/breakpoint refresh after a step: re-read mem + keep the IP in view. */
    refresh() {
        if (this.editingId != null) return; // don't clobber an active input
        this.mem = null; // guest memory may have changed; re-read on render
        const ip = this.doc.ipLine();
        if (ip) this._ensureVisibleLine(ip.id);
        this.render();
    }

    // ---- navigation / scrolling ------------------------------------------
    /** Position the bar thumb + goto field for the rows currently in view. The bar's
     *  extent tracks the (possibly filtered) visible range, so its thumb fills it. */
    _syncBar() {
        this.vbar.setRange(this.memLo, this._effHi());
        if (!this.doc.lines.length) {
            this.vbar.layout(this.memLo, 0n);
            this._setGoto(this.memLo, false);
            return;
        }
        const ctx = this._ctx();
        const top = nav.clampPos(ctx, this.top);
        const firstAddr = nav.posAddr(ctx, top);
        let pos = top;
        for (let i = 0, vis = this._visibleRows(); i < vis && pos != null; i++) pos = nav.nextPos(ctx, pos);
        const lastAddr = pos == null ? ctx.memHi : nav.posAddr(ctx, pos);
        let span = lastAddr - firstAddr;
        if (span <= 0n) span = 1n;
        this.vbar.layout(firstAddr, span);
        this._setGoto(firstAddr, true);
    }

    _setGoto(addr, real) {
        if (!this.gotoEl || document.activeElement === this.gotoEl) return;
        this.gotoEl.value = real ? "0x" + toHex(addr, 8) : "";
    }
    /** Kept for app.setupGotos(): refresh the goto field from the current top. */
    _syncGoto() {
        this._syncBar();
    }

    /** Wheel: re-anchor by whole instructions; sub-row deltas accumulate. */
    _onWheel(e) {
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= ROW_H;
        else if (e.deltaMode === 2) dy *= this._visibleRows() * ROW_H;
        this._wheelAcc += dy;
        const rows = (this._wheelAcc / ROW_H) | 0;
        if (!rows) return;
        this._wheelAcc -= rows * ROW_H;
        this._scrollRows(rows);
    }

    _scrollRows(delta) {
        const ctx = this._ctx();
        let pos = nav.clampPos(ctx, this.top);
        const step = delta > 0 ? nav.nextPos : nav.prevPos;
        let moved = 0;
        for (let i = 0; i < Math.abs(delta) && pos != null; i++) {
            const n = step(ctx, pos);
            if (n == null) break;
            pos = n;
            moved++;
        }
        if (!moved) return; // already at the listing edge
        const want = pos;
        this.top = pos;
        this.render(); // re-render the destination window + snap the transform to rest
        // Slide the fresh content in from where it visually was. Skip the animation
        // when it can't be done cleanly: while editing, when a near-bottom back-fill
        // re-anchored us, or when the step is larger than the overscan can cover.
        if (this.editingId != null) return;
        if (this.top !== want) return;
        if (moved > Math.min(this._leadCount, this._trailCount)) return;
        const signed = delta > 0 ? moved : -moved;
        slideRows(this.slideEl, this._restY + signed * ROW_H, this._restY, { maxPx: (OVER + 1) * ROW_H });
    }

    /** Toolbar "goto 0x...": anchor the listing at the nearest row. */
    goto(text) {
        try {
            this._seek(parseValue(text));
        } catch {}
    }

    /** VBar seek / goto: anchor the top of the view at `addr`. */
    _seek(addr) {
        const ctx = this._ctx();
        this.top = nav.clampPos(ctx, BigInt(addr));
        this.render();
    }

    /** Toolbar "IP": center the instruction-pointer line in the view. */
    gotoIP() {
        const ip = this.doc.ipLine();
        if (!ip) return;
        const qi = this.doc.indexOf(ip.id);
        if (qi < 0) return;
        this.top = Math.max(0, qi - (this._visibleRows() >> 1));
        this.render();
    }

    /** Anchor so document line `id` is on screen (re-centers if it's off). */
    _ensureVisibleLine(id) {
        const qi = this.doc.indexOf(id);
        if (qi < 0) return;
        const vis = this._visibleRows();
        const ti = typeof this.top === "number" ? this.top : null;
        if (ti != null && qi >= ti + 1 && qi <= ti + vis - 2) return; // already comfortably visible
        this.top = Math.max(0, qi - (vis >> 1));
    }

    // ---- interaction -----------------------------------------------------
    _onClick(e) {
        const bp = e.target.closest(".g-bp");
        if (bp && bp.dataset.bp) this.breakpoints.toggle(BigInt(bp.dataset.bp));
    }

    /** Double-click an asm cell (single, or mnemonic/operands in split mode) opens
     *  the inline editor; read-only rows carry no data-asm so they stay inert. */
    _onDblClick(e) {
        const cell = e.target.closest(".c-asm, .c-mnem, .c-ops");
        if (cell && cell.dataset.asm) {
            e.preventDefault(); // suppress the default word-selection before the input mounts
            this.edit(+cell.dataset.asm);
        }
    }

    /** Hover an operand register: show it in the Inspector (deduped per token). */
    _onRegHover(e) {
        const tok = e.target.closest(".t-reg");
        if (!tok) return;
        const name = tok.textContent.trim();
        if (!name || name === this._hoverReg) return;
        this._hoverReg = name;
        this.onInspect(name);
    }

    // ---- column header + resizing ----------------------------------------
    /** Toolbar toggle: single asm column vs. mnemonic | operands. Swaps the column set
     *  (header labels + the mnemonic resize boundary) on the shared ColumnHeader. */
    toggleSplit() {
        this.split = !this.split;
        this.root.classList.toggle("split", this.split);
        this.cols.setColumns(editorColumns(this.split));
        this.cols.render();
        savePrefs(this);
        this.render();
        return this.split;
    }

    appendAndEdit() {
        const lastId = this.doc.lines.length ? this.doc.lines[this.doc.lines.length - 1].id : null;
        const id = this.doc.insertAfter(lastId, "");
        this.onChange();
        this.editingId = id;
        this._ensureVisibleLine(id);
        this.render();
        this._focus();
    }

    edit(id) {
        if (this.editingId === id) return;
        this._commitIfEditing();
        this.editingId = id;
        this._ensureVisibleLine(id);
        this.render();
        this._focus();
    }

    _mountInput(id) {
        const row = this.rowsHost.querySelector(`.ed-row[data-id="${id}"]`);
        if (!row) return;
        const cell = row.querySelector(".c-asm");
        const ln = this.doc.byId.get(id);
        const input = document.createElement("input");
        input.className = "ed-input mono";
        input.value = ln ? ln.text : "";
        input.spellcheck = false;
        input.autocapitalize = "off";
        input.setAttribute("autocomplete", "off");
        cell.replaceChildren(input);
        input.addEventListener("keydown", (e) => this._onKey(e, id, input));
        input.addEventListener("blur", () => {
            if (this._programmatic) return;
            this._commit(id, input.value);
            this.editingId = null;
            this.render();
        });
        this._activeInput = input;
    }

    _focus() {
        if (this._activeInput) {
            this._activeInput.focus();
            this._activeInput.select();
        }
    }

    _onKey(e, id, input) {
        switch (e.key) {
            case "Enter":
                e.preventDefault();
                this._programmatic = true;
                this._commit(id, input.value);
                if (e.shiftKey) {
                    this.editingId = null;
                    this.render();
                } else {
                    const newId = this.doc.insertAfter(id, "");
                    this.editingId = newId;
                    this.onChange();
                    this._ensureVisibleLine(newId);
                    this.render();
                    this._focus();
                }
                this._programmatic = false;
                break;
            case "Escape":
                e.preventDefault();
                this._programmatic = true;
                this.editingId = null;
                this.render();
                this._programmatic = false;
                this.root.focus?.();
                break;
            case "ArrowUp":
            case "ArrowDown": {
                e.preventDefault();
                const idx = this.doc.indexOf(id);
                const nIdx = idx + (e.key === "ArrowDown" ? 1 : -1);
                if (nIdx < 0 || nIdx >= this.doc.lines.length) break;
                this._programmatic = true;
                this._commit(id, input.value);
                this.editingId = this.doc.lines[nIdx].id;
                this._ensureVisibleLine(this.editingId);
                this.render();
                this._focus();
                this._programmatic = false;
                break;
            }
            case "Backspace":
                if (input.value === "") {
                    e.preventDefault();
                    const idx = this.doc.indexOf(id);
                    const prev = idx > 0 ? this.doc.lines[idx - 1].id : null;
                    this._programmatic = true;
                    this.doc.remove(id);
                    this.onChange();
                    this.editingId = prev;
                    if (prev != null) this._ensureVisibleLine(prev);
                    this.render();
                    if (prev != null) this._focus();
                    this._programmatic = false;
                }
                break;
        }
    }

    _commitIfEditing() {
        if (this.editingId != null && this._activeInput) {
            this._programmatic = true;
            this._commit(this.editingId, this._activeInput.value);
            this.editingId = null;
            this._programmatic = false;
        }
    }

    _commit(id, value) {
        const ln = this.doc.byId.get(id);
        if (!ln || ln.text === value) return;
        this.doc.setText(id, value);
        this.onChange();
    }
}

function html(node, markup) {
    node.innerHTML = markup;
    return node;
}

// Split a decoded instruction's text into [mnemonic, operands] on the first run
// of whitespace (used for read-only rows, whose text isn't tokenized/highlighted).
function splitMnemonic(text) {
    const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text || "");
    return m ? [m[1], m[2] || ""] : ["", ""];
}

// ---- view-option persistence (split mode + the listing filters) -----------
// (Per-column widths persist separately, inside the shared ColumnHeader.)
const loadPrefs = () => lsGet(LS_PREFS, {});
const savePrefs = (ed) => lsSet(LS_PREFS, { split: ed.split, hidePad: ed.hidePad, hideNonExec: ed.hideNonExec });
