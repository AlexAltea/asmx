/*
 * Virtual scrollbar for the Disassembly / Memory / Stack panels. Its extents span
 * the whole mapped address range [lo, hi); the thumb shows where the current
 * window sits within that span, and dragging / clicking the track seeks. A
 * chevron button at each end steps the view by one row (one instruction / word /
 * hex line) via `onStep(dir)`, with press-and-hold auto-repeat like a native
 * scrollbar. Address math is BigInt; only the pixel ratios go through Number.
 *
 * DOM: .vbar (flex column) = [ .vbar-arrow.up | .vbar-track (holds the thumb) |
 * .vbar-arrow.down ]. All seek geometry lives on the inner .vbar-track, so its
 * box already excludes the arrows and the thumb math needs no arrow offsets.
 */
import { icon } from "./icons.js";

const MIN_THUMB = 16;
const REPEAT_DELAY = 300; // ms before press-and-hold starts repeating
const REPEAT_RATE = 60; // ms between repeats while held
const ARROW_ICON_PX = 10; // chevron glyph size (== the .vbar width; the wide, shallow codicon reads clearly without overflowing the 10px bar)

export class VBar {
    constructor({ onSeek, onStep } = {}) {
        this.onSeek = onSeek || (() => {});
        this.onStep = onStep || (() => {});
        this.lo = 0n;
        this.hi = 0n;

        this.el = document.createElement("div");
        this.el.className = "vbar";

        this.up = arrowBtn("up", "chevron-up");
        this.track = document.createElement("div");
        this.track.className = "vbar-track";
        this.down = arrowBtn("down", "chevron-down");

        this.thumb = document.createElement("div");
        this.thumb.className = "vbar-thumb";
        this.track.appendChild(this.thumb);
        this.el.append(this.up, this.track, this.down);

        this._dragging = false;
        this.track.addEventListener("pointerdown", (e) => this._down(e));
        this._bindArrow(this.up, -1);
        this._bindArrow(this.down, +1);
    }

    setRange(lo, hi) {
        this.lo = BigInt(lo);
        this.hi = BigInt(hi);
    }

    /** Position the thumb for a window [base, base+size) within [lo, hi). */
    layout(base, size) {
        const span = this.hi - this.lo;
        const track = this.track.clientHeight;
        if (span <= 0n || track <= 0) {
            this.thumb.style.display = "none";
            return;
        }
        this.thumb.style.display = "";
        const spanN = Number(span);
        const b = clampBig(BigInt(base), this.lo, this.hi);
        const frac = Number(b - this.lo) / spanN;
        const h = Math.max(MIN_THUMB, Math.min(1, Number(BigInt(size)) / spanN) * track);
        const top = Math.min(track - h, Math.max(0, frac * track));
        this.thumb.style.top = top + "px";
        this.thumb.style.height = h + "px";
    }

    _seekFromY(clientY) {
        const rect = this.track.getBoundingClientRect();
        if (rect.height <= 0 || this.hi <= this.lo) return;
        let frac = (clientY - rect.top) / rect.height;
        frac = Math.min(1, Math.max(0, frac));
        const span = this.hi - this.lo;
        this.onSeek(this.lo + BigInt(Math.round(frac * Number(span))));
    }

    _down(e) {
        e.preventDefault();
        this._dragging = true;
        this.el.classList.add("dragging");
        try {
            this.track.setPointerCapture(e.pointerId);
        } catch {}
        this._seekFromY(e.clientY);
        const move = (ev) => {
            if (this._dragging) this._seekFromY(ev.clientY);
        };
        const up = () => {
            this._dragging = false;
            this.el.classList.remove("dragging");
            this.track.removeEventListener("pointermove", move);
            this.track.removeEventListener("pointerup", up);
            this.track.removeEventListener("pointercancel", up);
        };
        this.track.addEventListener("pointermove", move);
        this.track.addEventListener("pointerup", up);
        this.track.addEventListener("pointercancel", up);
    }

    /** End-arrow: step once on press, then auto-repeat while held. */
    _bindArrow(btn, dir) {
        let delay = 0,
            timer = 0;
        const stop = () => {
            clearTimeout(delay);
            clearInterval(timer);
            delay = timer = 0;
            window.removeEventListener("pointerup", stop);
            btn.removeEventListener("pointerleave", stop);
            btn.removeEventListener("pointercancel", stop);
        };
        btn.addEventListener("pointerdown", (e) => {
            // Sibling of the track, so this can't reach the track's seek; guard anyway.
            e.preventDefault();
            e.stopPropagation();
            if (e.button != null && e.button !== 0) return;
            this.onStep(dir);
            delay = setTimeout(() => {
                timer = setInterval(() => this.onStep(dir), REPEAT_RATE);
            }, REPEAT_DELAY);
            window.addEventListener("pointerup", stop);
            btn.addEventListener("pointerleave", stop);
            btn.addEventListener("pointercancel", stop);
        });
    }
}

function arrowBtn(cls, iconName) {
    const b = document.createElement("div");
    b.className = "vbar-arrow " + cls;
    b.innerHTML = icon(iconName, { size: ARROW_ICON_PX });
    return b;
}

function clampBig(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}
