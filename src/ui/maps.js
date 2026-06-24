/*
 * Memory Maps view: the guest's mapped regions as a R/W/X permission table.
 * Each row shows the address range, RWX chips, size (hex bytes), and a name.
 * Double-click a chip to toggle that permission live (mem_protect). Rows are
 * selectable (Windows-style: click / Ctrl+click / Shift+click), the toolbar's
 * new/delete buttons live-map / live-unmap regions via the engine, and the
 * column headers sort the table. The view owns the canonical perms + map list on
 * the main thread; reinit/reset re-seed it from the profile defaults (which is
 * also what the worker re-maps to), so live add/delete/toggle reset with it.
 */
import { toHex, dimZeros, escapeHtml } from "../core/bigint.js";
import { PROT } from "../core/mem.js";
import { ColumnHeader, toggleSort, cmpVals } from "./cols.js";

const BITS = [
    ["R", PROT.R, "Read"],
    ["W", PROT.W, "Write"],
    ["X", PROT.X, "Execute"],
];
const PAGE = 0x1000n;

export class MapsView {
    constructor(root, { engine } = {}) {
        this.root = root;
        this.engine = engine;
        this.maps = [];
        this._idSeq = 1;
        this.selected = new Set(); // map ids
        this.anchor = null; // last clicked id, for Shift-range selection
        this.sort = { key: "addr", dir: 1 }; // dir: 1 asc, -1 desc
        // Shared header + full-height resize dividers (same component as every other
        // table panel). range / size / flags are resizable (each gets a divider);
        // name flexes to fill the rest. Every column sorts; size by its byte count.
        root.classList.add("col-host");
        this.cols = new ColumnHeader(root, {
            id: "maps",
            cell: true, // 8px padding inside each cell (see .map-* rows), not a column gap
            rowSel: ".map-row",
            columns: [
                { key: "addr", label: "range", sort: true, w: 150, min: 96, max: 280 },
                { key: "size", label: "size", sort: true, align: "right", w: 88, min: 56, max: 160 },
                { key: "perms", label: "flags", sort: true, w: 76, min: 58, max: 120 },
                { key: "label", label: "name", sort: true, w: "minmax(0,1fr)" },
            ],
        });
        // Non-scrolling host = [ fixed header | scrolling rows | resize-divider overlay ].
        this.scroll = document.createElement("div");
        this.scroll.className = "col-scroll map-table";
        root.replaceChildren(this.cols.render(this.sort), this.scroll);
        this.cols.mountGuides(root);
        root.addEventListener("click", (e) => this._onClick(e));
        root.addEventListener("dblclick", (e) => this._toggle(e));
    }

    /** Seed (or re-seed) from a profile's maps; clones so toggles don't mutate it. */
    setMaps(maps) {
        this._idSeq = 1;
        this.maps = (maps || []).map((m) => ({
            id: this._idSeq++,
            addr: BigInt(m.addr),
            size: BigInt(m.size),
            perms: Number(m.perms),
            label: m.label || "",
        }));
        this.selected = new Set();
        this.anchor = null;
        this.render();
    }

    /** Current display order (sorted copy; Array.sort is stable). */
    _ordered() {
        const { key, dir } = this.sort;
        return this.maps.slice().sort((x, y) => dir * cmp(x, y, key));
    }

    render() {
        this.cols.render(this.sort); // refresh the (persistent) header's sort arrows
        this.root.classList.toggle("empty", !this.maps.length); // hide the column guides over the placeholder
        if (!this.maps.length) {
            this.scroll.innerHTML = '<div class="inspect-hint">No mapped regions.</div>';
            return;
        }
        let rows = "";
        for (const m of this._ordered()) {
            const end = m.addr + m.size - 1n;
            const range = `${dimZeros(toHex(m.addr, 8))}<span class="map-dash">-</span>${dimZeros(toHex(end, 8))}`;
            const size = "0x" + m.size.toString(16).toUpperCase();
            let chips = "";
            for (const [letter, bit, name] of BITS) {
                const on = (m.perms & bit) !== 0;
                chips += `<span class="map-perm${on ? " on" : ""}" data-id="${m.id}" data-bit="${bit}" title="${name} permission.\nDouble-click to toggle flag">${letter}</span>`;
            }
            const sel = this.selected.has(m.id) ? " selected" : "";
            rows += `<div class="map-row${sel}" data-id="${m.id}">
                <span class="map-range">${range}</span>
                <span class="map-size">${size}</span>
                <span class="map-perms">${chips}</span>
                <span class="map-label">${escapeHtml(m.label)}</span>
            </div>`;
        }
        this.scroll.innerHTML = rows;
    }

    // ---- interaction ------------------------------------------------------
    _onClick(e) {
        const sortEl = e.target.closest("[data-sort]");
        if (sortEl) return this._sort(sortEl.dataset.sort);
        const row = e.target.closest(".map-row");
        if (!row) return;
        this._select(+row.dataset.id, e);
    }

    _sort(key) {
        this.sort = toggleSort(this.sort, key);
        this.render();
    }

    /** Windows-style selection: plain = single, Ctrl = toggle, Shift = range. */
    _select(id, e) {
        if (e.shiftKey && this.anchor != null) {
            const ids = this._ordered().map((m) => m.id);
            const a = ids.indexOf(this.anchor);
            const b = ids.indexOf(id);
            if (a >= 0 && b >= 0) {
                this.selected = new Set();
                const [lo, hi] = a <= b ? [a, b] : [b, a];
                for (let i = lo; i <= hi; i++) this.selected.add(ids[i]);
            }
        } else if (e.ctrlKey || e.metaKey) {
            if (this.selected.has(id)) this.selected.delete(id);
            else this.selected.add(id);
            this.anchor = id;
        } else {
            this.selected = new Set([id]);
            this.anchor = id;
        }
        // Update classes in place (no innerHTML rebuild) so a following
        // double-click on a perm chip still registers.
        this._applySelection();
    }

    _applySelection() {
        for (const row of this.root.querySelectorAll(".map-row[data-id]")) {
            row.classList.toggle("selected", this.selected.has(+row.dataset.id));
        }
    }

    _toggle(e) {
        const chip = e.target.closest(".map-perm");
        if (!chip) return;
        // Only toggle when we can actually deliver it to the engine: there's no
        // replay path, so flipping the chip while not-ready would leave the panel
        // showing a permission the guest memory doesn't have (init/reset re-map
        // from the profile defaults, not from this view).
        if (!this.engine || !this.engine.ready) return;
        const id = +chip.dataset.id;
        const bit = +chip.dataset.bit;
        const m = this.maps.find((x) => x.id === id);
        if (!m) return;
        m.perms ^= bit;
        this.engine.setProt(m.addr, m.size, m.perms);
        this.render();
    }

    // ---- toolbar: new / delete -------------------------------------------
    /** Map a fresh RW region on the next free page above the highest map. */
    addRegion() {
        if (!this.engine || !this.engine.ready) return;
        let hi = 0n;
        for (const m of this.maps) {
            const end = m.addr + m.size;
            if (end > hi) hi = end;
        }
        const addr = hi > 0n ? ((hi + PAGE - 1n) / PAGE) * PAGE : 0x10000n;
        const size = PAGE;
        const perms = PROT.R | PROT.W;
        const m = { id: this._idSeq++, addr, size, perms, label: "new" };
        this.maps.push(m);
        this.engine.mapRegion(addr, size, perms);
        this.selected = new Set([m.id]);
        this.anchor = m.id;
        this.render();
    }

    /** Unmap every selected region. */
    deleteSelected() {
        if (!this.engine || !this.engine.ready || !this.selected.size) return;
        for (const m of this.maps) {
            if (this.selected.has(m.id)) this.engine.unmapRegion(m.addr, m.size);
        }
        this.maps = this.maps.filter((m) => !this.selected.has(m.id));
        this.selected = new Set();
        this.anchor = null;
        this.render();
    }
}

/** Stable comparator for the sortable columns. */
function cmp(x, y, key) {
    if (key === "addr" || key === "size") return cmpVals(x[key], y[key]);
    if (key === "perms") return x.perms - y.perms;
    return String(x.label).localeCompare(String(y.label));
}
