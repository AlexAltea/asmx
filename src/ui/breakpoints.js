/*
 * Breakpoints panel: a flat list of every breakpoint, manageable WITHOUT going
 * to the Disassembly view. Each row carries an enable checkbox, the SVG marker
 * (red disc; "+" when conditional), the resolved address + instruction text, a
 * sortable Condition column, and a remove button. The toolbar adds a breakpoint
 * by address/expression; the trash button clears them all.
 *
 * A conditional breakpoint is one expression (same grammar as the goto /
 * inspector fields plus the comparison operators, parsed by core/expr.js); it
 * stops when the expression evaluates non-zero. The Condition cell shows a
 * "+ condition" button until clicked, then an inline input group: a field welded
 * to an icon that reads as a check while an unsaved expression is typed
 * (clickable only once it parses) and flips to a cross that clears the condition
 * once one is applied. Enter applies a valid expression or flags the field red;
 * blur cancels an uncommitted edit. All state lives in the shared
 * BreakpointStore; this view just renders it and re-renders on change.
 */
import { toHex, dimZeros, errMsg } from "../core/bigint.js";
import { parse } from "../core/expr.js";
import { icon } from "./icons.js";
import { ColumnHeader, toggleSort, cmpVals } from "./cols.js";
import { el } from "./dom.js";

export class BreakpointsView {
    constructor(root, { store, evalAddr, toast, addInput, addBtn } = {}) {
        this.root = root;
        this.store = store;
        this.evalAddr = evalAddr || (async () => { throw new Error("no evaluator"); });
        this.toast = toast || (() => {});
        this._open = new Set(); // addresses with an open, not-yet-applied condition editor
        this.sort = { key: "addr", dir: 1 }; // sortable Address / Instruction columns
        // Shared header + full-height resize dividers (the grid template lives in
        // --cols, consumed by both the header and every .bp-head row below). Address
        // is the one resizable data column; Instruction flexes to fill what's left.
        root.classList.add("col-host");
        this.cols = new ColumnHeader(root, {
            id: "bp",
            rowSel: ".bp-head",
            columns: [
                { key: "chk", w: 16 }, // enable checkbox gutter
                { key: "mark", w: 16 }, // breakpoint marker gutter
                { key: "addr", label: "Address", sort: true, w: 96, min: 64, max: 220 },
                { key: "text", label: "Instruction", sort: true, w: "minmax(0,1fr)" },
                { key: "cond", label: "Condition", sort: true, w: 150 }, // "+ condition" button or inline editor
                { key: "pin", w: 20 }, // stick/pin (follow instruction vs fixed address)
                { key: "del", w: 20 }, // remove-button gutter
            ],
        });
        // Non-scrolling host = [ fixed header | scrolling rows | resize-divider overlay ].
        this.scroll = document.createElement("div");
        this.scroll.className = "col-scroll";
        root.replaceChildren(this.cols.render(this.sort), this.scroll);
        this.cols.mountGuides(root);
        root.addEventListener("click", (e) => this._onClick(e));

        if (addInput && addBtn) {
            this.addInput = addInput;
            addBtn.addEventListener("click", () => this._add());
            addInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") this._add();
            });
        }
        this.render();
    }

    // ---- add (toolbar) ---------------------------------------------------
    async _add() {
        const src = this.addInput.value.trim();
        if (!src) return;
        let addr;
        try {
            addr = await this.evalAddr(src);
        } catch (e) {
            return this.toast("Bad address: " + errMsg(e), { err: true });
        }
        const snapped = this.store.snapAddr(addr);
        if (snapped == null) return this.toast(`No instruction at 0x${toHex(addr, 8)}.`, { err: true });
        this.store.add(snapped); // emits -> render
        this.addInput.value = "";
    }

    // ---- render ----------------------------------------------------------
    render() {
        this.cols.render(this.sort); // refresh the (persistent) header's sort arrows
        const items = this._sorted(this.store.list());
        this.root.classList.toggle("empty", !items.length); // hide the column guides over the placeholder
        if (!items.length) {
            this.scroll.innerHTML =
                '<div class="inspect-hint">No breakpoints. Click the gutter in the Disassembly view, or add one above by address.</div>';
            return;
        }
        this.scroll.replaceChildren(...items.map((it) => this._item(it)));
    }

    /** Apply the current Address / Instruction column sort to the store's list. */
    _sorted(items) {
        const { key, dir } = this.sort;
        return items.slice().sort((a, b) => dir * cmpBp(a, b, key));
    }

    _item(it) {
        const item = el("div", "bp-item");
        item.dataset.addr = it.addr.toString();
        if (!it.enabled) item.classList.add("disabled");

        const head = el("div", "bp-head");

        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.className = "bp-enable";
        chk.checked = it.enabled;
        chk.title = it.enabled ? "Disable breakpoint" : "Enable breakpoint";
        chk.addEventListener("change", () => this.store.setEnabled(it.addr, chk.checked));

        const mark = el("span", "bp-mark");
        mark.innerHTML = icon(it.cond ? "breakpoint-conditional" : "breakpoint", { size: 14 });

        const addr = el("span", "bp-addr mono");
        addr.innerHTML = dimZeros(toHex(it.addr, 8));

        const text = el("span", "bp-text mono");
        text.textContent = it.ln ? it.ln.asmText || it.ln.text || "" : "(no instruction)";

        const cond = this._condCell(it);

        // Stick/pin toggle: sticky (default) follows the instruction as code
        // reflows; pinned stays at this fixed address. Active (accent) = pinned.
        const pin = el("button", "bp-pin");
        pin.dataset.act = "toggle-stick";
        if (it.stick) {
            pin.innerHTML = icon("pin", { size: 14 });
            pin.title = "Following the instruction; click to pin to this address";
        } else {
            pin.classList.add("active");
            pin.innerHTML = icon("pinned", { size: 14 });
            pin.title = "Pinned to this address; click to follow the instruction";
        }

        const rm = el("button", "bp-del");
        rm.dataset.act = "remove";
        rm.title = "Remove breakpoint";
        rm.innerHTML = icon("close");

        head.append(chk, mark, addr, text, cond, pin, rm);
        item.append(head);
        return item;
    }

    /** The Condition cell: a "+ condition" affordance until there's a condition or
     *  an open editor, then an inline input group [ expression | apply-or-clear ]. */
    _condCell(it) {
        if (!it.cond && !this._open.has(it.addr)) {
            const btn = el("button", "bp-cond-btn");
            btn.type = "button";
            btn.dataset.act = "edit-cond";
            btn.textContent = "+ condition";
            btn.title = "Add a condition";
            return btn;
        }

        const group = el("div", "bp-cond-group");
        const input = document.createElement("input");
        input.className = "select goto bp-expr";
        input.value = it.cond || "";
        input.placeholder = "e.g. rax == 10";
        input.spellcheck = false;

        // The welded icon: a check that applies the typed expression (clickable only
        // while it parses), or a cross that clears an already-applied condition.
        const btn = el("button", "bp-cond-icon");
        btn.type = "button";
        const sync = () => this._syncCondIcon(input, btn, it.cond);
        sync();

        input.addEventListener("input", () => {
            input.classList.remove("err"); // typing clears a prior submit error
            sync();
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this._submitCond(it, input);
            } else if (e.key === "Escape") {
                e.preventDefault();
                input.blur(); // cancel the edit (see _cancelCond)
            }
        });
        input.addEventListener("blur", () => this._cancelCond(it, input));

        // mousedown + preventDefault so the click doesn't first blur-cancel the
        // field, re-rendering this button out from under the pending click.
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            if (btn.dataset.mode === "clear") {
                this._open.delete(it.addr);
                this.store.setCondition(it.addr, null); // emits -> re-render to "+ condition"
            } else if (!btn.disabled) {
                this._submitCond(it, input);
            }
        });

        group.append(input, btn);
        return group;
    }

    /** Point the welded icon at the right action for the field's current text:
     *  clear (cross) while it still equals the applied condition, else apply
     *  (check); clickable only when the expression parses. */
    _syncCondIcon(input, btn, applied) {
        const cur = input.value.trim();
        if (applied && cur === applied) {
            btn.dataset.mode = "clear";
            btn.disabled = false;
            btn.title = "Remove condition";
            btn.innerHTML = icon("close");
        } else {
            btn.dataset.mode = "apply";
            const ok = isValidExpr(cur);
            btn.disabled = !ok;
            btn.title = ok ? "Apply condition" : "Enter a valid expression";
            btn.innerHTML = icon("check");
        }
    }

    /** Apply the typed expression to the breakpoint, or flag the field red on a
     *  parse error. A blank field on a never-applied editor just collapses it. */
    _submitCond(it, input) {
        const src = input.value.trim();
        if (!src && !it.cond) {
            this._open.delete(it.addr);
            this.render();
            return;
        }
        if (!validateExpr(input)) return; // invalid: red border, stay open
        this._open.delete(it.addr);
        this.store.setCondition(it.addr, src); // emits -> re-render (icon becomes the clear cross)
    }

    /** Drop an uncommitted edit on blur: collapse a never-applied editor back to
     *  the "+ condition" button, or restore an applied one to its saved text. */
    _cancelCond(it, input) {
        if (!input.isConnected) return; // detached by our own re-render, not a real blur
        if (!it.cond) {
            if (this._open.delete(it.addr)) this.render();
        } else if (input.value.trim() !== it.cond) {
            this.render();
        }
    }

    // ---- interaction -----------------------------------------------------
    _onClick(e) {
        if (e.target.closest(".bp-enable")) return; // handled by its own change listener
        const sortEl = e.target.closest("[data-sort]");
        if (sortEl) {
            this.sort = toggleSort(this.sort, sortEl.dataset.sort);
            this.render();
            return;
        }
        const item = e.target.closest(".bp-item");
        if (!item) return;
        const addr = BigInt(item.dataset.addr);
        const actEl = e.target.closest("[data-act]");
        if (!actEl) return;
        if (actEl.dataset.act === "remove") {
            this._open.delete(addr);
            this.store.remove(addr);
        } else if (actEl.dataset.act === "edit-cond") {
            this._open.add(addr);
            this.render();
            // Focus the freshly-rendered field so the user can type immediately.
            const inp = this.scroll.querySelector(`.bp-item[data-addr="${addr}"] .bp-expr`);
            if (inp) inp.focus();
        } else if (actEl.dataset.act === "toggle-stick") {
            const bp = this.store.get(addr);
            if (bp) this.store.setStick(addr, !bp.stick); // emits -> re-render
        }
    }
}

// ---- helpers ------------------------------------------------------------
/** Comparator for the Address / Instruction / Condition columns. */
function cmpBp(a, b, key) {
    if (key === "text") {
        return String(a.ln ? a.ln.asmText : "").localeCompare(String(b.ln ? b.ln.asmText : ""));
    }
    if (key === "cond") {
        return String(a.cond || "").localeCompare(String(b.cond || ""));
    }
    return cmpVals(a.addr, b.addr);
}

/** True when `v` is a parseable expression (empty is not). parse() is pure + sync. */
function isValidExpr(v) {
    if (!v) return false;
    try {
        parse(v);
        return true;
    } catch {
        return false;
    }
}

/** Flag an expression input valid/invalid (red border); return true when it parses. */
function validateExpr(inputEl) {
    const ok = isValidExpr(inputEl.value.trim());
    inputEl.classList.toggle("err", !ok);
    return ok;
}
