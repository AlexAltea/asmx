/*
 * Jump-arrow gutter (IDA/Ghidra/x64dbg style). Draws one SVG path per in-listing
 * branch/call edge, routed through packed lanes so overlapping spans don't
 * collide. Lanes are assigned with greedy interval-graph coloring and recomputed
 * only on edit (stable while scrolling). Back-edges (loops) point up, and the
 * edge whose source is the current IP is highlighted amber.
 */
import { DISASM_ROW_H as ROW_H } from "./geometry.js";

const NS = "http://www.w3.org/2000/svg";
const X_LEFT = 38; // bp(22)+ip(16): arrow column starts here
const LANE_W = 10;
const PAD = 8;
const MAX_LANES = 8;
const MIN_LANES = 3; // always reserve this many lanes so the columns don't shift (see width calc)

export class ArrowGutter {
    constructor() {
        this.svg = null;
        this.width = 0;
    }

    /**
     * Recompute edges + lanes and (re)build the SVG. `rowOf(lineId)` returns the
     * line's screen-row index in the current window, clamped to just outside it
     * (-1 / visibleRows) when the line is scrolled out, or null if the line has
     * no row at all; `visibleRows` sizes the overlay. An edge draws whenever its
     * span crosses the window: a clamped endpoint puts the stub/arrowhead past
     * the .ed-rows clip, leaving only the lane line running off the edge.
     */
    update(doc, analysis, ipLineId, rowOf, visibleRows) {
        const edges = [];
        for (const insn of analysis || []) {
            if (!(insn.isJump || insn.isCall) || insn.target == null) continue;
            const srcHit = doc.addrToLine(insn.address);
            const dstHit = doc.addrToLine(insn.target);
            if (!srcHit || !dstHit) continue; // endpoint outside the listing
            const srcIdx = rowOf(srcHit.line.id);
            const dstIdx = rowOf(dstHit.line.id);
            if (srcIdx == null || dstIdx == null || dstIdx === srcIdx) continue;
            if (Math.max(srcIdx, dstIdx) < 0 || Math.min(srcIdx, dstIdx) >= visibleRows) continue;
            edges.push({ srcIdx, dstIdx, srcId: srcHit.line.id });
        }

        const maxLane = packLanes(edges);
        const usedLanes = edges.length ? Math.min(maxLane + 1, MAX_LANES) : 0;
        // Reserve a fixed floor of MIN_LANES so the addr/bytes/asm columns keep their
        // x-position as the on-screen arrow count varies: scrolling a jump out of the
        // window, or two nested loops collapsing to one, no longer nudges the columns
        // sideways. Arrows always fill the lanes nearest the code, so the reserved
        // slack is empty space on the gutter's left; only a rarer pile-up past
        // MIN_LANES widens it. (A wholly empty program zeroes it; see editor.render.)
        const lanes = Math.max(usedLanes, MIN_LANES);
        this.width = lanes * LANE_W + PAD;

        const height = (visibleRows || doc.lines.length) * ROW_H;
        const right = X_LEFT + this.width;
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("class", "arrow-svg");
        svg.setAttribute("width", String(right));
        svg.setAttribute("height", String(height));
        svg.appendChild(marker());

        for (const e of edges) {
            const lane = Math.min(e.lane, MAX_LANES - 1);
            const laneX = right - PAD - lane * LANE_W;
            const sy = e.srcIdx * ROW_H + ROW_H / 2;
            const dy = e.dstIdx * ROW_H + ROW_H / 2;
            const d = `M ${right} ${sy} H ${laneX} V ${dy} H ${right}`;
            const path = document.createElementNS(NS, "path");
            path.setAttribute("class", "arrow");
            path.setAttribute("d", d);
            path.setAttribute("marker-end", "url(#arrowhead)");
            path.dataset.src = e.srcId;
            svg.appendChild(path);
        }

        this.svg = edges.length ? svg : null;
        this.setActive(ipLineId);
    }

    /** Recolor without rebuilding; used after a step changes the IP. */
    setActive(ipLineId) {
        if (!this.svg) return;
        for (const p of this.svg.querySelectorAll("path.arrow")) {
            p.classList.toggle("active", ipLineId != null && +p.dataset.src === ipLineId);
        }
    }
}

/** Greedy interval-graph lane coloring; returns the max lane index used. */
function packLanes(edges) {
    const items = edges.map((e) => ({
        e,
        lo: Math.min(e.srcIdx, e.dstIdx),
        hi: Math.max(e.srcIdx, e.dstIdx),
    }));
    items.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const laneHi = []; // laneHi[j] = highest row occupied in lane j
    for (const it of items) {
        let lane = -1;
        for (let j = 0; j < laneHi.length; j++) {
            if (laneHi[j] < it.lo) {
                lane = j;
                break;
            }
        }
        if (lane < 0) {
            lane = laneHi.length;
            laneHi.push(it.hi);
        } else {
            laneHi[lane] = it.hi;
        }
        it.e.lane = lane;
    }
    return laneHi.length - 1;
}

function marker() {
    const defs = document.createElementNS(NS, "defs");
    const m = document.createElementNS(NS, "marker");
    m.setAttribute("id", "arrowhead");
    m.setAttribute("markerWidth", "6");
    m.setAttribute("markerHeight", "6");
    m.setAttribute("refX", "5");
    m.setAttribute("refY", "3");
    m.setAttribute("orient", "auto");
    m.setAttribute("markerUnits", "userSpaceOnUse");
    const tip = document.createElementNS(NS, "path");
    tip.setAttribute("d", "M0,0 L6,3 L0,6 Z");
    tip.setAttribute("fill", "context-stroke");
    m.appendChild(tip);
    defs.appendChild(m);
    return defs;
}
