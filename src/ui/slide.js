/*
 * Cosmetic "catch-up" slide for the virtualized listings (disasm / memory / stack).
 *
 * Those views have no real scroll element: render() rebuilds exactly the rows in
 * view, so a wheel notch or a scrollbar-arrow click would otherwise SNAP to the
 * new window. To make a discrete scroll read like a real browser, the caller:
 *   1. re-renders the destination window (with a few hidden OVERSCAN rows on each
 *      side) and snaps the wrapper's transform to its resting offset,
 *   2. moves the scrollbar thumb immediately (so the bar leads),
 *   3. calls slideRows() to play the old->new pixel delta as a ~110ms translateY
 *      that eases back to rest. The overscan rows cover the strip that the
 *      translate exposes at the leading edge, so nothing flashes blank.
 *
 * `fromPx`/`toPx` are wrapper translateY values; `toPx` is the resting offset the
 * destination render already set, `fromPx` is that plus the gesture's pixel delta
 * (so the content starts where it visually was, then slides to rest). Big jumps
 * (drag/goto) and prefers-reduced-motion snap; they never call slideRows, and as
 * a backstop slideRows itself snaps anything past `maxPx`.
 *
 * The tween is a single Web Animations API animation playing ON TOP of the inline
 * resting transform (a running animation overrides style), so cancelling at any
 * point simply reveals the resting transform, never a mid-tween position.
 */
const DUR = 110; // ms; a quick, browser-like catch-up
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)"; // ease-out: fast start, soft stop
const DEFAULT_MAX_PX = 400; // backstop: deltas larger than this snap instead of flying in

// Honor the OS "reduce motion" setting (cached; the value is stable per session).
const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Finalize any in-flight slide on `wrap` WITHOUT running its onDone (it's stale). */
export function slideCancel(wrap) {
    const anim = wrap && wrap._slide;
    if (!anim) return;
    wrap._slide = null;
    anim.cancel(); // drops the tween's transform; the inline resting transform stands
}

/**
 * Animate `wrap`'s translateY from `fromPx` to `toPx` over ~110ms.
 * @param {HTMLElement} wrap   the inner rows wrapper to transform
 * @param {number} fromPx      starting translateY (px)
 * @param {number} toPx        resting translateY (px), already applied by render()
 * @param {{onDone?: () => void, maxPx?: number}} [opts]
 */
export function slideRows(wrap, fromPx, toPx, opts = {}) {
    if (!wrap) return;
    slideCancel(wrap); // a new notch supersedes the previous tween; never stack transforms
    const { onDone, maxPx = DEFAULT_MAX_PX } = opts;
    const dy = fromPx - toPx;
    wrap.style.transform = `translateY(${toPx}px)`; // rest; the tween plays on top
    if (reduce || !dy || Math.abs(dy) > maxPx) {
        onDone && onDone(); // snap
        return;
    }
    const anim = wrap.animate(
        { transform: [`translateY(${fromPx}px)`, `translateY(${toPx}px)`] },
        { duration: DUR, easing: EASE }
    );
    wrap._slide = anim;
    anim.finished.then(
        () => {
            if (wrap._slide !== anim) return; // superseded
            wrap._slide = null;
            onDone && onDone();
        },
        () => {} // cancel() rejects `finished`; a cancelled tween just goes quiet
    );
}
