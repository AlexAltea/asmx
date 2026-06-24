/*
 * In-house docking layout: a small GoldenLayout-style tiler.
 *
 * The layout is a tree of plain objects:
 *   - box:   { type:"row"|"col", size, children:[node...] }   nested splits
 *   - stack: { type:"stack", size, panels:[id...], active }   a tabbed group (leaf)
 * `size` is a flex-grow weight relative to its siblings, so everything is
 * proportional (survives window resize without px/fr bookkeeping). A registered
 * panel is a detached `.panel-content` element keyed by id; the tree only stores
 * ids, and render() reparents the live elements into the active tab slots, so
 * the views (which bind to element ids) keep working untouched.
 *
 * Interactions: drag a splitter to resize (adjusts only the two neighbours);
 * drag a tab onto a panel's centre to tab-group, onto an edge to split, or onto
 * the tab strip to reorder; click ✕ to close; the + menu reopens closed panels
 * or resets the layout. State persists to localStorage.
 */
import { icon } from "./icons.js";
import { lsGet, lsSet, popover } from "./dom.js";

const MIN = 60; // px; smallest a panel may be dragged to

export class Layout {
    constructor(root, { storageKey } = {}) {
        this.root = root; // #layout-root (position:relative)
        this.key = storageKey || "asmx.layout";
        this.panels = new Map(); // id -> { title, el }
        this.tree = null;
        this._default = null;
        this._menu = null;
        this._menuAnchor = null;
    }

    /** Register a panel: `el` is its `.panel-content` (kept alive, reparented). */
    register(id, title, el) {
        this.panels.set(id, { title, el });
    }

    /** Restore the saved layout (or fall back to `defaultTree`) and render. */
    mount(defaultTree) {
        this._default = defaultTree;
        this.tree = this._load() || structuredClone(defaultTree);
        this.render();
    }

    // ---- rendering -------------------------------------------------------
    render() {
        this._closeMenu();
        this.root.replaceChildren();
        if (!this.tree) {
            this.root.appendChild(this._emptyState());
            return;
        }
        const el = this._renderNode(this.tree);
        el.style.flex = "1 1 0";
        this.root.appendChild(el);
    }

    _renderNode(node) {
        return node.type === "stack" ? this._renderStack(node) : this._renderBox(node);
    }

    _renderBox(node) {
        const box = document.createElement("div");
        box.className = "lm-box " + (node.type === "row" ? "lm-row" : "lm-col");
        box.__node = node;
        const kids = node.children.map((c) => {
            const el = this._renderNode(c);
            setGrow(el, c.size);
            return el;
        });
        kids.forEach((el, i) => {
            if (i > 0) box.appendChild(this._splitter(node, i - 1, kids[i - 1], el));
            box.appendChild(el);
        });
        return box;
    }

    _renderStack(node) {
        const stack = document.createElement("div");
        stack.className = "lm-stack";
        stack.__node = node;
        const tabs = document.createElement("div");
        tabs.className = "lm-tabs";
        const body = document.createElement("div");
        body.className = "lm-body";

        node.panels.forEach((id, idx) => {
            const p = this.panels.get(id);
            const tab = document.createElement("div");
            tab.className = "lm-tab" + (idx === node.active ? " active" : "");
            const title = document.createElement("span");
            title.className = "lm-tab-title";
            title.textContent = p ? p.title : id;
            const close = document.createElement("span");
            close.className = "lm-tab-close";
            close.innerHTML = icon("close");
            tab.append(title, close);
            tab.addEventListener("pointerdown", (e) => this._tabPointerDown(e, node, id));
            tab.addEventListener("click", (e) => {
                // closest(): the close target is the inner <svg>/<path>, not the span.
                if (e.target.closest(".lm-tab-close")) this._close(node, id);
                else this._activate(node, idx);
            });
            tabs.appendChild(tab);
            if (p) {
                p.el.style.display = idx === node.active ? "flex" : "none";
                body.appendChild(p.el);
            }
        });

        const sp = document.createElement("div");
        sp.className = "lm-tabs-sp";
        const add = document.createElement("button");
        add.className = "lm-add";
        add.title = "Add panel";
        add.innerHTML = icon("add");
        add.addEventListener("click", (e) => {
            e.stopPropagation();
            this._openMenu(add, node);
        });
        tabs.append(sp, add);

        // Drop the tab strip's bottom rule when the active panel carries its own
        // toolbar; the toolbar's top edge then reads as the single divider, with
        // the active tab flowing straight into it (no doubled line).
        const activeEl = this.panels.get(node.panels[node.active])?.el;
        if (activeEl && activeEl.querySelector(".panel-toolbar")) tabs.classList.add("with-toolbar");

        stack.append(tabs, body);
        return stack;
    }

    _emptyState() {
        const wrap = document.createElement("div");
        wrap.className = "lm-empty";
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.innerHTML = icon("add") + " Add panel";
        btn.addEventListener("click", () => this._openMenu(btn, null));
        wrap.appendChild(btn);
        return wrap;
    }

    _activate(stack, idx) {
        if (stack.active === idx) return;
        stack.active = idx;
        this.render();
        this._persist();
    }

    // ---- splitter drag ---------------------------------------------------
    _splitter(box, leftIdx, leftEl, rightEl) {
        const s = document.createElement("div");
        s.className = "lm-split " + (box.type === "row" ? "lm-split-v" : "lm-split-h");
        s.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return; // left-drag only; a right-click must not start (and strand) a resize
            e.preventDefault();
            s.setPointerCapture(e.pointerId);
            s.classList.add("dragging");
            const horiz = box.type === "row";
            const a = box.children[leftIdx];
            const b = box.children[leftIdx + 1];
            const ra = leftEl.getBoundingClientRect();
            const rb = rightEl.getBoundingClientRect();
            const total = horiz ? ra.width + rb.width : ra.height + rb.height;
            const totalW = a.size + b.size;
            const startA = horiz ? ra.width : ra.height;
            const origin = horiz ? e.clientX : e.clientY;
            const move = (ev) => {
                const d = (horiz ? ev.clientX : ev.clientY) - origin;
                const pa = Math.max(MIN, Math.min(total - MIN, startA + d));
                a.size = (totalW * pa) / total;
                b.size = totalW - a.size;
                setGrow(leftEl, a.size);
                setGrow(rightEl, b.size);
            };
            const up = () => {
                s.classList.remove("dragging");
                s.removeEventListener("pointermove", move);
                s.removeEventListener("pointerup", up);
                s.removeEventListener("lostpointercapture", up);
                this._persist();
            };
            s.addEventListener("pointermove", move);
            s.addEventListener("pointerup", up);
            // Capture can be yanked away (context menu, devtools, tab switch) without a
            // pointerup; clean up on that too, or the move handler would linger and the
            // panels would keep tracking the bare pointer.
            s.addEventListener("lostpointercapture", up);
        });
        return s;
    }

    // ---- tab drag & drop -------------------------------------------------
    _tabPointerDown(e, srcStack, id) {
        if (e.button !== 0) return;
        if (e.target.closest(".lm-tab-close")) return; // ✕ is a click, not a drag
        e.preventDefault();
        const x0 = e.clientX,
            y0 = e.clientY;
        let dragging = false;
        const move = (ev) => {
            if (!dragging) {
                if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
                dragging = true;
                this._beginDrag(id);
            }
            this._dragMove(ev);
        };
        const up = (ev) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            if (ev.type === "pointercancel") this._drop = null; // interrupted -> abort, don't drop
            if (dragging) this._endDrag(ev, srcStack, id);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        // A cancelled pointer (context menu, devtools, gesture) ends the drag too,
        // so the floating ghost can't be stranded under the cursor.
        window.addEventListener("pointercancel", up);
    }

    _beginDrag(id) {
        document.body.style.userSelect = "none";
        const p = this.panels.get(id);
        this.ghost = document.createElement("div");
        this.ghost.className = "lm-ghost";
        this.ghost.textContent = p ? p.title : id;
        this.indicator = document.createElement("div");
        this.indicator.className = "lm-drop";
        this.indicator.style.display = "none";
        document.body.appendChild(this.ghost);
        this.root.appendChild(this.indicator);
        this._drop = null;
    }

    _dragMove(ev) {
        this.ghost.style.left = ev.clientX + 12 + "px";
        this.ghost.style.top = ev.clientY + 12 + "px";
        const at = document.elementFromPoint(ev.clientX, ev.clientY);
        const stackEl = at && at.closest(".lm-stack");
        if (!stackEl) {
            this._drop = null;
            this.indicator.style.display = "none";
            return;
        }
        const node = stackEl.__node;
        const tabsEl = stackEl.querySelector(".lm-tabs");
        const bodyEl = stackEl.querySelector(".lm-body");
        let zone, index = null, target = bodyEl;
        if (tabsEl.contains(at)) {
            zone = "center";
            index = this._tabIndexAt(tabsEl, ev.clientX);
            target = stackEl;
        } else {
            zone = zoneAt(bodyEl.getBoundingClientRect(), ev.clientX, ev.clientY);
        }
        this._drop = { node, zone, index };
        this._showIndicator(zone, target.getBoundingClientRect());
    }

    _showIndicator(zone, r) {
        const root = this.root.getBoundingClientRect();
        let left = r.left - root.left,
            top = r.top - root.top,
            w = r.width,
            h = r.height;
        if (zone === "left") w /= 2;
        else if (zone === "right") (left += w / 2), (w /= 2);
        else if (zone === "top") h /= 2;
        else if (zone === "bottom") (top += h / 2), (h /= 2);
        Object.assign(this.indicator.style, {
            display: "block",
            left: left + "px",
            top: top + "px",
            width: w + "px",
            height: h + "px",
        });
    }

    _tabIndexAt(tabsEl, x) {
        const tabs = [...tabsEl.querySelectorAll(".lm-tab")];
        for (let i = 0; i < tabs.length; i++) {
            const r = tabs[i].getBoundingClientRect();
            if (x < r.left + r.width / 2) return i;
        }
        return tabs.length;
    }

    _endDrag(ev, srcStack, id) {
        document.body.style.userSelect = "";
        this.ghost.remove();
        this.indicator.remove();
        const drop = this._drop;
        this._drop = this.ghost = this.indicator = null;
        if (!drop) return;
        this._moveTo(srcStack, id, drop);
        this.render();
        this._persist();
    }

    _moveTo(src, id, { node: dst, zone, index }) {
        if (zone === "center") {
            if (dst === src) {
                const from = src.panels.indexOf(id);
                let to = index == null ? src.panels.length : index;
                if (to > from) to--;
                src.panels.splice(from, 1);
                src.panels.splice(to, 0, id);
                src.active = src.panels.indexOf(id);
            } else {
                this._removeFromStack(src, id);
                const at = index == null ? dst.panels.length : index;
                dst.panels.splice(at, 0, id);
                dst.active = dst.panels.indexOf(id);
            }
            return;
        }
        if (dst === src && src.panels.length === 1) return; // splitting a lone panel with itself
        this._removeFromStack(src, id);
        this._splitInto(dst, { type: "stack", size: 1, panels: [id], active: 0 }, zone);
    }

    // Place new stack `ns` beside `target` along `zone`: splice it into the
    // parent box if that box already runs the right way (row/col), otherwise wrap
    // the two in a fresh box of the needed orientation.
    _splitInto(target, ns, zone) {
        const orient = zone === "left" || zone === "right" ? "row" : "col";
        const before = zone === "left" || zone === "top";
        const parent = this._parentOf(target);
        if (parent && parent.type === orient) {
            const idx = parent.children.indexOf(target);
            target.size /= 2;
            ns.size = target.size;
            parent.children.splice(before ? idx : idx + 1, 0, ns);
        } else {
            const box = { type: orient, size: target.size, children: before ? [ns, target] : [target, ns] };
            target.size = ns.size = 1;
            this._replace(target, box);
        }
    }

    // ---- close / open ----------------------------------------------------
    _close(stack, id) {
        this._removeFromStack(stack, id);
        this.render();
        this._persist();
    }

    _removeFromStack(stack, id) {
        const i = stack.panels.indexOf(id);
        if (i < 0) return;
        stack.panels.splice(i, 1);
        if (stack.active >= stack.panels.length) stack.active = Math.max(0, stack.panels.length - 1);
        if (stack.panels.length === 0) this._removeNode(stack);
    }

    _removeNode(node) {
        const parent = this._parentOf(node);
        if (!parent) {
            this.tree = null;
            return;
        }
        parent.children.splice(parent.children.indexOf(node), 1);
        if (parent.children.length === 1) {
            const only = parent.children[0];
            only.size = parent.size;
            this._replace(parent, only);
        } else if (parent.children.length === 0) {
            this._removeNode(parent);
        }
    }

    _replace(oldN, newN) {
        const p = this._parentOf(oldN);
        if (!p) this.tree = newN;
        else p.children[p.children.indexOf(oldN)] = newN;
    }

    _parentOf(node, cur = this.tree) {
        if (!cur || cur.type === "stack") return null;
        for (const c of cur.children) {
            if (c === node) return cur;
            const f = this._parentOf(node, c);
            if (f) return f;
        }
        return null;
    }

    _addPanel(id, stack) {
        if (!this.tree) this.tree = { type: "stack", size: 1, panels: [id], active: 0 };
        else {
            const s = stack || this._firstStack(this.tree);
            s.panels.push(id);
            s.active = s.panels.length - 1;
        }
        this.render();
        this._persist();
    }

    _firstStack(node) {
        return node.type === "stack" ? node : this._firstStack(node.children[0]);
    }

    _inTree(id, cur = this.tree) {
        if (!cur) return false;
        if (cur.type === "stack") return cur.panels.includes(id);
        return cur.children.some((c) => this._inTree(id, c));
    }

    // ---- panels menu (add / reveal panels, reset) -----------------------
    /** Open the panels / reset menu anchored to `anchor` (header UI button). */
    addPanelMenu(anchor) {
        this._openMenu(anchor, null);
    }

    /** Activate the tab of an already-open panel (the menu's "reveal" action). */
    _revealPanel(id) {
        const s = this._stackOf(id);
        if (!s) return;
        s.active = s.panels.indexOf(id);
        this.render();
        this._persist();
    }

    _stackOf(id, cur = this.tree) {
        if (!cur) return null;
        if (cur.type === "stack") return cur.panels.includes(id) ? cur : null;
        for (const c of cur.children) {
            const f = this._stackOf(id, c);
            if (f) return f;
        }
        return null;
    }

    _openMenu(anchor, stack) {
        // Clicking the same anchor that opened the menu toggles it shut.
        const reclick = this._menu && this._menuAnchor === anchor;
        this._closeMenu();
        if (reclick) return;

        const menu = document.createElement("div");
        menu.className = "popover";

        const t = document.createElement("div");
        t.className = "popover-title";
        t.textContent = "Panels";
        menu.appendChild(t);
        // Every registered panel is listed; a check marks the ones already in the
        // layout. Picking a closed panel adds it, an open one reveals its tab, so
        // the list is never empty even when the default layout opens everything.
        for (const [id, p] of this.panels) {
            const open = this._inTree(id);
            const row = document.createElement("div");
            row.className = "popover-row";
            const check = document.createElement("span");
            check.className = "menu-check";
            check.textContent = open ? "✓" : "";
            const label = document.createElement("span");
            label.textContent = p.title;
            row.append(check, label);
            row.addEventListener("click", () => {
                this._closeMenu();
                open ? this._revealPanel(id) : this._addPanel(id, stack);
            });
            menu.appendChild(row);
        }

        const reset = document.createElement("div");
        reset.className = "popover-row";
        reset.textContent = "Reset layout";
        reset.addEventListener("click", () => {
            this._closeMenu();
            this.tree = structuredClone(this._default);
            this.render();
            this._persist();
        });
        menu.appendChild(reset);

        this._menuAnchor = anchor;
        this._menu = popover(menu, anchor, {
            keep: anchor,
            onClose: () => {
                menu.remove();
                this._menu = null;
                this._menuAnchor = null;
            },
        });
    }

    _closeMenu() {
        this._menu?.close();
    }

    // ---- persistence -----------------------------------------------------
    _persist() {
        lsSet(this.key, this.tree);
    }

    _load() {
        const t = lsGet(this.key, null);
        return t ? this._sanitize(t) : null; // drop unknown/empty nodes
    }

    _sanitize(node) {
        if (!node || typeof node !== "object") return null;
        const size = +node.size > 0 ? +node.size : 1;
        if (node.type === "stack") {
            const panels = (node.panels || []).filter((id) => this.panels.has(id));
            if (!panels.length) return null;
            const active = node.active >= 0 && node.active < panels.length ? node.active : 0;
            return { type: "stack", size, panels, active };
        }
        const children = (node.children || []).map((c) => this._sanitize(c)).filter(Boolean);
        if (!children.length) return null;
        if (children.length === 1) {
            children[0].size = size;
            return children[0];
        }
        return { type: node.type === "row" ? "row" : "col", size, children };
    }
}

// flex-grow weight -> flex shorthand (basis 0 so weight fully governs the share).
function setGrow(el, size) {
    el.style.flex = size + " 1 0";
}

// Which drop zone a point falls in, relative to a rect: the central 50% is
// "center" (tab-group); otherwise the nearest edge (split).
function zoneAt(r, x, y) {
    const fl = (x - r.left) / r.width,
        fr = (r.right - x) / r.width,
        ft = (y - r.top) / r.height,
        fb = (r.bottom - y) / r.height;
    const m = Math.min(fl, fr, ft, fb);
    if (m > 0.25) return "center";
    return m === fl ? "left" : m === fr ? "right" : m === ft ? "top" : "bottom";
}
