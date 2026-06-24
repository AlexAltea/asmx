/*
 * Console panel: the app's log stream plus a toolbar (filter / copy / clear /
 * download). Lines render as "YYYY-MM-DD HH:MM:SS.sss | [L] | message" where L
 * is the level's initial (trace/debug/info/warning/error). Each entry keeps its
 * rendered text so the substring filter can hide the non-matching rows and
 * underline the matches, the same one-field-one-button filter model as the
 * Registers panel (ui/registers.js).
 */
import { escapeHtml } from "../core/bigint.js";
import { bindFilter, setFilterBtn, downloadBlob, copyWithCheck } from "./dom.js";

const CAP = 250; // keep the last N lines; older ones drop off the top

const LEVELS = { trace: "T", debug: "D", info: "I", warning: "W", error: "E" };

/** "YYYY-MM-DD HH:MM:SS.sss" in local time. */
function stamp(ts) {
    const d = new Date(ts);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return (
        `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
    );
}

export class Console {
    constructor(root, { filterInput, filterBtn, copyBtn, clearBtn, downloadBtn } = {}) {
        this.root = root;
        this.entries = []; // [{ level, ts, msg, text, el }]
        this.filterInput = filterInput || null;
        this.filterBtn = filterBtn || null;
        bindFilter(this.filterInput, this.filterBtn, () => this._applyFilter());
        copyBtn?.addEventListener("click", () => this._copy(copyBtn));
        clearBtn?.addEventListener("click", () => this.clear());
        downloadBtn?.addEventListener("click", () => this._download());
    }

    /** Append a "trace"|"debug"|"info"|"warning"|"error" line. `ts` (epoch ms)
     *  defaults to now; a share restore replays lines with their original time. */
    log(level, msg, ts = Date.now()) {
        if (!(level in LEVELS)) level = "info";
        msg = String(msg);
        const el = document.createElement("div");
        el.className = "line " + level;
        const entry = { level, ts, msg, text: `${stamp(ts)} | [${LEVELS[level]}] | ${msg}`, el };
        this.entries.push(entry);
        this._paint(entry);
        this.root.appendChild(el);
        while (this.entries.length > CAP) this.entries.shift().el.remove();
        this.root.scrollTop = this.root.scrollHeight;
    }

    /** The buffered lines as [ts, level, message] triples (the share-link payload). */
    export() {
        return this.entries.map((e) => [e.ts, e.level, e.msg]);
    }

    clear() {
        this.entries = [];
        this.root.replaceChildren();
    }

    _filter() {
        return this.filterInput ? this.filterInput.value.trim().toLowerCase() : "";
    }

    /** Hide the non-matching rows and underline the matches. */
    _applyFilter() {
        for (const e of this.entries) this._paint(e);
        setFilterBtn(this.filterBtn, !!this._filter(), "log");
    }

    /** Render one entry against the current filter: hidden if it doesn't contain the
     *  query, otherwise shown with every match wrapped in an underlined <span>. */
    _paint(entry) {
        const f = this._filter();
        if (!f) {
            entry.el.hidden = false;
            entry.el.textContent = entry.text;
            return;
        }
        const lower = entry.text.toLowerCase();
        if (!lower.includes(f)) {
            entry.el.hidden = true;
            return;
        }
        entry.el.hidden = false;
        let html = "";
        let i = 0;
        for (let at = lower.indexOf(f); at !== -1; at = lower.indexOf(f, at + f.length)) {
            html += escapeHtml(entry.text.slice(i, at)) + '<span class="match">' + escapeHtml(entry.text.slice(at, at + f.length)) + "</span>";
            i = at + f.length;
        }
        entry.el.innerHTML = html + escapeHtml(entry.text.slice(i));
    }

    /** Text of the currently-visible (filtered) lines. */
    _visibleText() {
        return this.entries.filter((e) => !e.el.hidden).map((e) => e.text).join("\n");
    }

    _copy(btn) {
        const text = this._visibleText();
        if (text) copyWithCheck(btn, text);
    }

    _download() {
        const text = this.entries.map((e) => e.text).join("\n") + "\n";
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        downloadBlob(text, `asmx-console-${ts}.log`);
    }
}
