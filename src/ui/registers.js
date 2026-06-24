/*
 * Registers panel: grouped, collapsible register rows + a flags strip.
 * - changed-value highlight diffs RAW BYTES against the previous snapshot.
 * - hovering a register emits its raw bytes to the inspector (type-preview).
 * - double-click a value to edit; click a flag chip to flip the bit.
 */
import { toHex, bytesToBig, dimZeros, parseValue, hexWidth, asU8 } from "../core/bigint.js";
import { bindFilter, setFilterBtn, inlineEdit } from "./dom.js";

export class Registers {
    constructor(root, { onWriteReg, onInspect, filterInput, filterBtn } = {}) {
        this.root = root;
        this.onWriteReg = onWriteReg || (() => {});
        this.onInspect = onInspect || (() => {});
        this.rows = new Map(); // name -> {el, valEl, size, bytes}
        this.prev = new Map(); // name -> hex string (for diff)
        this.flags = null; // {reg,size,bits}
        this.flagsBytes = null;
        this.flagChips = new Map();
        // Name filter (toolbar). Each section tracks its rows + default open state
        // so a query can show only matching registers (forcing sections open) and
        // restore the original collapse when cleared.
        this.groups = []; // [{det, defaultOpen, rows: [{el, name}]}]
        this.flagsSection = null; // {det, defaultOpen, search}; filtered as one unit
        this.filterInput = filterInput || null;
        this.filterBtn = filterBtn || null;
        bindFilter(this.filterInput, this.filterBtn, () => this._applyFilter());
    }

    setMode(profile, modeId) {
        const L = profile.layoutFor(modeId);
        this.flags = L.flags;
        this.rows.clear();
        this.prev.clear();
        this.flagChips.clear();
        this.groups = [];
        this.flagsSection = null;
        this.root.replaceChildren();

        // Register groups.
        for (const g of L.groups) {
            const size = g.size || L.regSize;
            const det = document.createElement("details");
            det.className = "reg-group";
            det.open = !g.collapsed;
            const sum = document.createElement("summary");
            sum.textContent = g.name;
            det.appendChild(sum);
            const rows = [];
            for (const name of g.regs) {
                const row = this._regRow(name, size);
                det.appendChild(row);
                rows.push({ el: row, name: name.toLowerCase() });
            }
            this.root.appendChild(det);
            this.groups.push({ det, defaultOpen: !g.collapsed, rows });
        }

        // Flags: their own collapsible section (after the register groups); the
        // whole status register as an editable hex row, then the per-bit chips.
        if (L.flags) {
            const det = document.createElement("details");
            det.className = "reg-group";
            det.open = true;
            const sum = document.createElement("summary");
            sum.textContent = "Flags";
            det.append(sum, this._regRow(L.flags.reg, L.flags.size));
            const strip = document.createElement("div");
            strip.className = "flags-strip";
            for (const f of L.flags.bits) {
                const chip = document.createElement("span");
                chip.className = "flag-chip";
                chip.textContent = f.name;
                chip.title = `${f.name} (bit ${f.bit})`;
                chip.onclick = () => this._flipFlag(f.bit);
                strip.appendChild(chip);
                this.flagChips.set(f.bit, chip);
            }
            det.appendChild(strip);
            this.root.appendChild(det);
            const search = `${L.flags.reg} ${L.flags.bits.map((b) => b.name).join(" ")}`.toLowerCase();
            this.flagsSection = { det, defaultOpen: true, search };
        }

        this._applyFilter(); // re-apply any active query to the freshly built rows
    }

    /** Filter rows by name substring; matching sections are forced open (and empty
     *  ones hidden) while a query is active, then restored when it's cleared. */
    _applyFilter() {
        const f = this.filterInput ? this.filterInput.value.trim().toLowerCase() : "";
        for (const g of this.groups) {
            let any = false;
            for (const r of g.rows) {
                const show = !f || r.name.includes(f);
                r.el.hidden = !show;
                any = any || show;
            }
            g.det.hidden = !!f && !any;
            g.det.open = f ? any : g.defaultOpen;
        }
        if (this.flagsSection) {
            const match = !f || this.flagsSection.search.includes(f);
            this.flagsSection.det.hidden = !!f && !match;
            this.flagsSection.det.open = f ? match : this.flagsSection.defaultOpen;
        }
        setFilterBtn(this.filterBtn, !!f, "registers");
    }

    _regRow(name, size) {
        const row = document.createElement("div");
        row.className = "reg-row";
        const nameEl = document.createElement("span");
        nameEl.className = "reg-name";
        nameEl.textContent = name.toLowerCase();
        const valEl = document.createElement("span");
        valEl.className = "reg-val mono";
        valEl.innerHTML = dimZeros(toHex(0n, hexWidth(size)));
        row.append(nameEl, valEl);

        const rec = { el: row, valEl, size, bytes: new Uint8Array(size) };
        this.rows.set(name, rec);

        row.addEventListener("mouseenter", () =>
            this.onInspect({ label: name.toLowerCase(), expr: name.toLowerCase(), bytes: rec.bytes, size: rec.size })
        );
        valEl.addEventListener("dblclick", () => this._editReg(name, rec));
        row.addEventListener("animationend", () => row.classList.remove("flash"));
        return row;
    }

    update(regs) {
        const map = new Map(regs.map((r) => [r.name, r]));
        for (const [name, rec] of this.rows) {
            const r = map.get(name);
            if (!r) continue;
            const bytes = asU8(r.bytes);
            rec.bytes = bytes;
            const hex = toHex(bytesToBig(bytes), hexWidth(rec.size));
            rec.valEl.innerHTML = dimZeros(hex);
            const prev = this.prev.get(name);
            if (prev !== undefined && prev !== hex) {
                rec.el.classList.add("changed");
                rec.el.classList.remove("flash");
                void rec.el.offsetWidth; // restart the flash animation
                rec.el.classList.add("flash");
            } else if (prev === hex) {
                rec.el.classList.remove("changed");
            }
            this.prev.set(name, hex);
        }
        if (this.flags) {
            const fr = map.get(this.flags.reg);
            if (fr) {
                this.flagsBytes = asU8(fr.bytes);
                const val = bytesToBig(this.flagsBytes);
                for (const f of this.flags.bits) {
                    this.flagChips.get(f.bit).classList.toggle("on", ((val >> BigInt(f.bit)) & 1n) === 1n);
                }
            }
        }
    }

    _editReg(name, rec) {
        const cur = toHex(bytesToBig(rec.bytes), hexWidth(rec.size));
        const done = () => (rec.valEl.innerHTML = dimZeros(cur)); // next snapshot repaints
        inlineEdit(rec.valEl, cur, {
            onCommit: (v) => {
                try {
                    this.onWriteReg(name, parseValue(v));
                } catch {}
                done();
            },
            onDone: done,
        });
    }

    _flipFlag(bit) {
        if (!this.flagsBytes) return;
        let val = bytesToBig(this.flagsBytes);
        val ^= 1n << BigInt(bit);
        this.onWriteReg(this.flags.reg, val);
    }
}
