// Pure unit test for the windowed-disassembly navigation. Run: node test_disasm_nav.mjs
import {
    PAD, MEM, GAP,
    segAt, sizeAt, prevAddr, firstPos, nextPos, prevPos, posAddr, clampPos,
} from "../src/ui/disasm_nav.js";

let pass = 0,
    fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else {
        fail++;
        console.error("  ✗ " + msg);
    }
}
function eq(a, b, msg) {
    ok(a === b, `${msg} (got ${a}, want ${b})`);
}

// A layout that mirrors the x86 profile: a code region (document + zero padding),
// a data region, an unmapped gap, then the stack region. MEM decodes at a fixed
// 4-byte stride (the "easy", fixed-length case); padding is 2 bytes.
const LINES = [0x10000n, 0x10010n, 0x10020n]; // 3 code lines, last spans to 0x10029
const ctx = {
    base: 0x10000n,
    end: 0x10029n,
    memLo: 0x10000n,
    memHi: 0x80000n,
    lineCount: LINES.length,
    lineAddr: (i) => LINES[i],
    maps: [
        { addr: 0x10000n, size: 0x10000n }, // exec  -> [0x10000, 0x20000)
        { addr: 0x20000n, size: 0x10000n }, // data  -> [0x20000, 0x30000)
        { addr: 0x70000n, size: 0x10000n }, // stack -> [0x70000, 0x80000)
    ],
    exec: { addr: 0x10000n, end: 0x20000n },
    padStride: 2n,
    decode: () => ({ size: 4n }),
};

// --- segments -----------------------------------------------------------
eq(segAt(ctx, 0x10029n), PAD, "seg: padding start");
eq(segAt(ctx, 0x1ffffn), PAD, "seg: padding last byte");
eq(segAt(ctx, 0x20000n), MEM, "seg: data start");
eq(segAt(ctx, 0x2ffffn), MEM, "seg: data last");
eq(segAt(ctx, 0x30000n), GAP, "seg: gap start");
eq(segAt(ctx, 0x6ffffn), GAP, "seg: gap last");
eq(segAt(ctx, 0x70000n), MEM, "seg: stack start");

// --- sizes --------------------------------------------------------------
eq(sizeAt(ctx, 0x10029n), 2n, "size: padding stride");
eq(sizeAt(ctx, 0x1ffffn), 1n, "size: padding partial tail clamps to region end");
eq(sizeAt(ctx, 0x20000n), 4n, "size: mem decode");
eq(sizeAt(ctx, 0x2fffcn), 4n, "size: mem at region end");
eq(sizeAt(ctx, 0x30000n), 1n, "size: gap byte");

// --- forward transitions across every segment boundary ------------------
eq(firstPos(ctx), 0, "first: top is doc line 0");
eq(nextPos(ctx, 2), 0x10029n, "next: last code line -> padding");
eq(nextPos(ctx, 0x1fffdn), 0x1ffffn, "next: padding -> partial tail");
eq(nextPos(ctx, 0x1ffffn), 0x20000n, "next: padding tail -> data");
eq(nextPos(ctx, 0x2fffcn), 0x30000n, "next: data -> gap");
eq(nextPos(ctx, 0x6ffffn), 0x70000n, "next: gap -> stack");
eq(nextPos(ctx, 0x7fffcn), null, "next: end of stack -> null");

// --- backward transitions (mirror) --------------------------------------
eq(prevPos(ctx, 0), null, "prev: top of listing -> null");
eq(prevPos(ctx, 0x10029n), 2, "prev: first padding row -> last code line");
eq(prevPos(ctx, 0x1002bn), 0x10029n, "prev: padding row -> previous padding row");
eq(prevPos(ctx, 0x20000n), 0x1ffffn, "prev: data start -> padding partial tail");
eq(prevPos(ctx, 0x30000n), 0x2fffcn, "prev: gap start -> last data instruction");
eq(prevPos(ctx, 0x70000n), 0x6ffffn, "prev: stack start -> last gap byte");

// --- next/prev round-trip across the whole structure --------------------
{
    const probes = [
        0, 1, 2,
        0x10029n, 0x1002bn, 0x1fffbn, 0x1ffffn, // padding incl. partial tail
        0x20000n, 0x20004n, 0x28000n, 0x2fffcn, // data (fixed-stride: exact)
        0x30000n, 0x30001n, 0x55555n, 0x6ffffn, // gap
        0x70000n, 0x70004n, 0x7fffcn, // stack
    ];
    for (const p of probes) {
        const n = nextPos(ctx, p);
        if (n != null) eq(prevPos(ctx, n), p, `roundtrip prev(next(${typeof p === "bigint" ? "0x" + p.toString(16) : p}))`);
    }
}

// --- clamp + posAddr ----------------------------------------------------
eq(clampPos(ctx, 0x18000n), 0x18000n, "clamp: in-range tail address stays");
eq(clampPos(ctx, 0x10010n), 1, "clamp: document address -> line index");
eq(clampPos(ctx, 0n), 0, "clamp: below range -> first position");
eq(clampPos(ctx, 0x90000n), 0x7ffffn, "clamp: above range -> last byte");
eq(posAddr(ctx, 1), 0x10010n, "posAddr: doc line");
eq(posAddr(ctx, 0x20004n), 0x20004n, "posAddr: address position");

// --- variable-length back-disassembly resync ----------------------------
// A region whose instruction sizes vary by address; prevAddr must still land on
// the boundary that the canonical forward decode would produce.
{
    const vctx = {
        ...ctx,
        // sizes: 3,1,3,1,... anchored to the data region start (position-defined,
        // so forward decode is canonical and reversible).
        decode: (a) => ({ size: (a - 0x20000n) % 4n === 0n ? 3n : 1n }),
    };
    // forward from data start: 0x20000(+3) 0x20003(+1) 0x20004(+3) 0x20007(+1) ...
    eq(sizeAt(vctx, 0x20000n), 3n, "var: size at grid origin");
    eq(sizeAt(vctx, 0x20003n), 1n, "var: size off-grid");
    eq(nextPos(vctx, 0x20000n), 0x20003n, "var: forward 1");
    eq(nextPos(vctx, 0x20003n), 0x20004n, "var: forward 2");
    // back-disassembly must reconstruct the same boundaries
    eq(prevAddr(vctx, 0x20004n), 0x20003n, "var: prevAddr resync 1");
    eq(prevAddr(vctx, 0x20003n), 0x20000n, "var: prevAddr resync 2");
    eq(prevPos(vctx, 0x20040n), 0x2003fn, "var: prevPos deep in region");
}

// --- view filters: hide padding / hide non-executable tail --------------
{
    // hideNonExec -> clamp the listing to the executable region [.., 0x20000).
    const exonly = { ...ctx, memHi: 0x20000n };
    eq(nextPos(exonly, 2), 0x10029n, "filter(nonexec): last code line -> padding (still shown)");
    eq(nextPos(exonly, 0x1ffffn), null, "filter(nonexec): padding tail is the end (data hidden)");
    eq(prevPos(exonly, 0x10029n), 2, "filter(nonexec): first padding row -> last code line");
    eq(clampPos(exonly, 0x55555n), 0x1ffffn, "filter(nonexec): stale data anchor clamps to last visible byte");

    // hidePad -> skip the padding hole [0x10029, 0x20000); the data region stays.
    const nopad = { ...ctx, hide: { lo: 0x10029n, hi: 0x20000n } };
    eq(nextPos(nopad, 2), 0x20000n, "filter(pad): last code line jumps straight to data");
    eq(prevPos(nopad, 0x20000n), 2, "filter(pad): data start steps back to last code line");
    eq(nextPos(nopad, 0x20004n), 0x20008n, "filter(pad): navigation within data is unaffected");
    eq(clampPos(nopad, 0x18000n), 2, "filter(pad): anchor inside hidden padding -> last code line");

    // both -> only the document remains.
    const codeonly = { ...ctx, memHi: 0x10029n, hide: { lo: 0x10029n, hi: 0x20000n } };
    eq(firstPos(codeonly), 0, "filter(both): top is still doc line 0");
    eq(nextPos(codeonly, 2), null, "filter(both): nothing past the last code line");
    eq(clampPos(codeonly, 0x40000n), 2, "filter(both): any tail anchor clamps into the document");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
