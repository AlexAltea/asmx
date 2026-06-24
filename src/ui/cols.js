/*
 * Shared column header for every table/listing panel (Disassembly, Memory, Stack,
 * Breakpoints, Memory Maps): one look, one behaviour. The header owns the grid
 * template, published as `--cols` on a host element; the header row AND every data
 * row read `grid-template-columns: var(--cols)`, so dragging a boundary reflows the
 * whole table at once. The panel keeps its own sort state + click handling (it just
 * passes the state to render() so the active column shows an arrow).
 *
 * Resizable columns are dragged via full-height divider lines (.col-guide) that span
 * the whole listing: a faint 1px separator at each boundary, grabbable from any
 * row, not just the header. The guides live in an absolute overlay over a positioned
 * `container`; they're positioned by measuring the rendered header cells, so they
 * track the columns for free as widths (or the disassembly's dynamic arrow gutter)
 * change. Resizable widths persist per panel under `asmx.cols.<id>`.
 */
import { icon } from "./icons.js";
import { el, lsGet, lsSet } from "./dom.js";

const PAD = 8; // the padding (px) every cell keeps on each side of its text (see app.css)

export class ColumnHeader {
    /**
     * @param {Element} host  element that receives the `--cols` var (an ancestor of
     *   both the header and the data rows, so both inherit the template).
     * @param {object}  opts
     * @param {string}  opts.id       persistence key + identity
     * @param {boolean} opts.bare     no container padding/gap (cells carry their own
     *   inset), the disassembly's gutter-aligned model; default is the padded/gapped
     *   table model used by the list panels.
     * @param {boolean} opts.mono     render the labels in the monospace font, so the
     *   header's `ch`-based tracks line up with monospace data (Memory / Stack).
     * @param {Array}   opts.columns  ordered tracks, each:
     *   { key, label?, html?, sort?, w, min?, max?, align? }
     *     - w:    number -> a fixed px track; "1fr" / "minmax(...)" / "auto" / a var()
     *             expression -> verbatim
     *     - min & max present -> the track is drag-resizable (w is its default px).
     *       Resizable tracks MUST precede the flexible (1fr/minmax/auto) track: a
     *       guide is measured from the full-width header, while scrolling rows lose
     *       the scrollbar's width, so only boundaries left of the flex track stay
     *       aligned in both.
     *     - clip:true -> exempt from the content-fit resize floor: this column may be
     *       dragged narrower than its content (which then truncates, e.g. the byte
     *       dumps' CSS ellipsis) instead of clamping. Others stop at content + 2*PAD.
     *     - label / html -> header content (omit for the icon gutters); `sort` makes
     *       the column clickable (the panel reads data-sort in its own handler)
     *     - align:"right" -> right-justify the header label
     * @param {boolean} opts.cell  put the 8px inter-column padding inside each header
     *   cell (the table model, matching per-cell-padded rows) instead of the shared
     *   column gap, so a resize divider always lands between two padded cells.
     * @param {string}  opts.rowSel  selector for the panel's data rows (grid rows whose
     *   children line up 1:1 with `columns`); enables the content-fit resize floor.
     */
    constructor(host, { id, columns, bare = false, mono = false, cell = false, rowSel = null } = {}) {
        this.host = host;
        this.id = id;
        this.bare = bare;
        this.rowSel = rowSel;
        this.columns = columns;
        this.w = {};
        this.headEl = el("div", "col-head" + (bare ? " col-head-bare" : "") + (mono ? " col-head-mono" : "") + (cell ? " col-head-cells" : ""));
        this.guidesEl = null;
        this.container = null;
        this._guides = [];
        this._loadWidths();
        this.apply();
    }

    _loadWidths() {
        const saved = load(this.id);
        this.w = {};
        for (const c of this.columns) if (c.min != null) this.w[c.key] = clampW(c, saved[c.key] ?? c.w);
    }

    /** Swap the column set (disassembly split toggle, stack word-size change). */
    setColumns(columns) {
        this.columns = columns;
        this._loadWidths();
        this.apply();
        if (this.guidesEl) this._buildGuides();
    }

    /** Publish the grid template the header + the rows both consume. */
    apply() {
        const tracks = this.columns.map((c) => (c.min != null ? this.w[c.key] + "px" : track(c.w)));
        this.host.style.setProperty("--cols", tracks.join(" "));
    }

    /** (Re)build the header cells for the current sort state ({key,dir}); returns the
     *  (persistent) header element. Repositions the guides afterwards. */
    render(sort) {
        const cells = [];
        for (const c of this.columns) {
            const cell = el("div", "col" + (c.align === "right" ? " col-r" : ""));
            cell.dataset.col = c.key; // boundary measurement target for the guides
            // data-sort on the whole cell -> a click anywhere in the header sorts (the
            // resize guides live in a separate overlay, so a guide drag never sorts).
            if (c.sort) cell.dataset.sort = c.key;
            if (c.label != null) {
                const lab = el("span", "col-label");
                lab.textContent = c.label;
                cell.appendChild(lab);
                // Active-sort caret: a sibling of the label (never inside its line box,
                // so toggling direction can't reflow the text); up asc, down desc.
                if (c.sort && sort && sort.key === c.key)
                    cell.insertAdjacentHTML("beforeend", icon(sort.dir > 0 ? "chevron-up" : "chevron-down", { size: 12 }));
            } else if (c.html != null) {
                cell.innerHTML = c.html; // custom content (e.g. the maps R/W/X chips)
            }
            cells.push(cell);
        }
        this.headEl.replaceChildren(...cells);
        this.layoutGuides();
        return this.headEl;
    }

    /** Create the full-height resize dividers inside `container` (a positioned box
     *  spanning the header + the rows). Call once; render()/resize reposition them. */
    mountGuides(container) {
        this.container = container;
        this.guidesEl = el("div", "col-guides");
        this._buildGuides();
        container.appendChild(this.guidesEl);
        this._ro = new ResizeObserver(() => this.layoutGuides());
        this._ro.observe(container);
        return this.guidesEl;
    }

    _buildGuides() {
        this._guides = [];
        const nodes = [];
        for (const c of this.columns) {
            if (c.min == null) continue;
            const g = el("div", "col-guide");
            this._initGuide(g, c);
            nodes.push(g);
            this._guides.push({ el: g, key: c.key });
        }
        this.guidesEl.replaceChildren(...nodes);
        this.layoutGuides();
    }

    /** Place each divider at its column's right edge, measured from the live header
     *  cells (robust to padding, gaps, fonts, and the dynamic arrow gutter). */
    layoutGuides() {
        if (!this.guidesEl || !this.container) return;
        const box = this.container.getBoundingClientRect();
        if (!box.width) return; // hidden tab (display:none) -> don't strand guides at -4px; the ResizeObserver re-runs on show
        const base = box.left;
        for (const g of this._guides) {
            const cell = this.headEl.querySelector(`[data-col="${g.key}"]`);
            if (!cell) continue;
            const right = cell.getBoundingClientRect().right;
            g.el.style.left = right - base - 4 + "px"; // 4 = half the 9px hit area
        }
    }

    _initGuide(g, c) {
        g.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            g.setPointerCapture(e.pointerId);
            g.classList.add("dragging");
            // Content can't change mid-drag, so measure the floor once up front.
            const floor = this._contentMin(c);
            const x0 = e.clientX,
                w0 = this.w[c.key];
            const move = (ev) => {
                this.w[c.key] = clampW(c, w0 + (ev.clientX - x0), floor);
                this.apply();
                this.layoutGuides();
            };
            const up = () => {
                g.classList.remove("dragging");
                g.removeEventListener("pointermove", move);
                g.removeEventListener("pointerup", up);
                g.removeEventListener("pointercancel", up);
                save(this.id, this.w);
            };
            g.addEventListener("pointermove", move);
            g.addEventListener("pointerup", up);
            g.addEventListener("pointercancel", up); // capture loss / touch interrupt
        });
        // Double-click resets to the default width (raised to the content floor if the
        // default itself would crowd a row).
        g.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            this.w[c.key] = clampW(c, c.w, this._contentMin(c));
            this.apply();
            this.layoutGuides();
            save(this.id, this.w);
        });
    }

    /** The smallest width column `c` may be dragged to: the widest text among its
     *  live cells (header label + every data row) plus PAD on each side, so no row
     *  ever loses its padding. `clip` columns are exempt (they truncate instead).
     *
     *  A Range around each cell's contents reports the text's true width regardless
     *  of the current track width (nowrap text lays out at full width even when the
     *  cell clips it), so no reflow/measure hack is needed. */
    _contentMin(c) {
        if (c.clip) return c.min;
        const idx = this.columns.indexOf(c);
        let content = 0;
        const measure = (host) => {
            const target = host && host.children[idx];
            if (!target) return;
            const r = document.createRange();
            r.selectNodeContents(target);
            content = Math.max(content, r.getBoundingClientRect().width);
        };
        measure(this.headEl);
        if (this.rowSel && this.container)
            for (const row of this.container.querySelectorAll(this.rowSel)) measure(row);
        return Math.min(c.max, Math.max(c.min, Math.ceil(content) + 2 * PAD));
    }
}

/** Header-click sort toggle: same key flips direction, a new key sorts ascending. */
export const toggleSort = (sort, key) => (sort.key === key ? { key, dir: -sort.dir } : { key, dir: 1 });

/** Three-way comparator for <>-comparable values (BigInt-safe). */
export const cmpVals = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function track(w) {
    return typeof w === "number" ? w + "px" : w;
}
function clampW(c, v, floor) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return c.w;
    const lo = floor != null ? floor : c.min;
    return Math.max(lo, Math.min(c.max, n));
}
const load = (id) => lsGet("asmx.cols." + id, {});
const save = (id, w) => lsSet("asmx.cols." + id, w);
