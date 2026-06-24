/*
 * Tiny shared DOM helpers used across the UI panels.
 */
import { icon } from "./icons.js";

/** document.getElementById shorthand. */
export const $ = (id) => document.getElementById(id);

/** createElement(tag) with an optional class. */
export function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
}

/** Wire `btn` to toggle a popover menu (clicking it again closes). `build(menu,
 *  close)` fills a fresh .popover element on every open, so the content always
 *  reflects live state; `opts` is forwarded to popover() (e.g. align). */
export function menuButton(btn, build, opts = {}) {
    let open = null;
    btn.onclick = () => {
        if (open) return open.close();
        const menu = el("div", "popover drop-menu");
        build(menu, () => open.close());
        open = popover(menu, btn, {
            ...opts,
            keep: btn,
            onClose: () => {
                menu.remove();
                open = null;
            },
        });
    };
}

/** localStorage JSON read; `fallback` on missing/garbled/blocked storage. */
export function lsGet(key, fallback) {
    try {
        return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
        return fallback;
    }
}

/** localStorage JSON write; silently ignores blocked storage. */
export function lsSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {}
}

/** Download `data` (Uint8Array | string) as a file named `filename`. */
export function downloadBlob(data, filename) {
    const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy `text` to the clipboard; on success flash `btn` to a ✓ for 1.2s.
 *  Returns false when the clipboard is unavailable. */
export async function copyWithCheck(btn, text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        return false;
    }
    btn.innerHTML = icon("check");
    btn.classList.add("ok");
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
        btn.innerHTML = icon("copy");
        btn.classList.remove("ok");
    }, 1200);
    return true;
}

/** One-field-one-button filter wiring: the input filters live; the button clears
 *  the query when one is active and focuses the field when empty. */
export function bindFilter(input, btn, apply) {
    if (!input) return;
    input.addEventListener("input", apply);
    btn?.addEventListener("click", () => {
        input.value = "";
        input.focus();
        apply();
    });
}

/** Flip a filter button between its "filter" and "clear" (✕) roles. */
export function setFilterBtn(btn, active, what) {
    if (!btn) return;
    btn.innerHTML = icon(active ? "close" : "filter");
    btn.title = active ? "Clear filter" : "Filter " + what;
}

/**
 * Open `el` as a body-level popover near `at`, an anchor Element (placed under
 * it, `align`ed "left"/"right"/"center" to it) or an {x, y} point, clamped to
 * the viewport on both axes. Dismissed by an outside pointerdown or Escape;
 * the listeners go in a tick late so the gesture that opened the popover can't
 * immediately close it, and hits on `keep` (the toggle button) never count as
 * outside. `onClose` runs exactly once on any dismissal path and owns hiding
 * or removing `el`. Returns { close, place }; call place() again after the
 * popover's content (and so its size) changes.
 */
export function popover(el, at, { align = "left", gap = 4, keep = null, onClose = null } = {}) {
    if (!el.isConnected) document.body.appendChild(el);
    el.hidden = false;
    const place = () => {
        const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, bottom: at.y, width: 0 };
        const left =
            align === "right" ? r.right - el.offsetWidth :
            align === "center" ? r.left + r.width / 2 - el.offsetWidth / 2 :
            r.left;
        el.style.left = Math.max(8, Math.min(left, window.innerWidth - el.offsetWidth - 8)) + "px";
        el.style.top = Math.max(8, Math.min(r.bottom + gap, window.innerHeight - el.offsetHeight - 8)) + "px";
    };
    place();
    const onDown = (e) => {
        if (!el.contains(e.target) && !keep?.contains(e.target)) close();
    };
    const onKey = (e) => {
        if (e.key === "Escape") close();
    };
    const timer = setTimeout(() => {
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("keydown", onKey);
    });
    function close() {
        clearTimeout(timer);
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("keydown", onKey);
        onClose?.();
    }
    return { close, place };
}

/** Swap `host`'s content for an inline edit input, focused and selected.
 *  Enter -> onCommit(value); Escape / blur -> onDone() (revert display). */
export function inlineEdit(host, value, { width, onCommit, onDone }) {
    const input = el("input", "inline-edit mono");
    if (width) input.style.width = width;
    input.value = value;
    host.replaceChildren(input);
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") onCommit(input.value);
        else if (e.key === "Escape") onDone();
    });
    input.addEventListener("blur", onDone);
}
