// Pure unit test for the document model + sticky-IP. Run: node test_document.mjs
import { Document } from "../src/model/document.js";

let pass = 0,
    fail = 0;
function ok(cond, msg) {
    if (cond) {
        pass++;
    } else {
        fail++;
        console.error("  ✗ " + msg);
    }
}
function eq(a, b, msg) {
    ok(a === b, `${msg} (got ${a}, want ${b})`);
}

// Fake assembler: "lenN ..." => N bytes; "bad" => error; else 2 bytes.
const assemble = (t) => {
    if (t === "bad") return { error: "bad instruction" };
    const m = t.match(/^len(\d+)/);
    const n = m ? +m[1] : 2;
    return { bytes: new Array(n).fill(0x90) };
};

// --- layout -----------------------------------------------------------
{
    const d = new Document({ base: 0x1000n, assemble });
    d.setLines("len4 a\nlen2 b\nlen2 c");
    const [a, b, c] = d.lines;
    eq(a.addr, 0x1000n, "layout: a addr");
    eq(b.addr, 0x1004n, "layout: b addr");
    eq(c.addr, 0x1006n, "layout: c addr");
    eq(d.endAddr(), 0x1008n, "layout: end addr");
    eq(d.entryAddr(), 0x1000n, "layout: entry");
}

// --- sticky IP across insert + edit -----------------------------------
{
    const d = new Document({ base: 0x1000n, assemble });
    d.setLines("len4 a\nlen2 b\nlen2 c");
    const b = d.lines[1];
    d.setIPFromAddr(0x1004n);
    eq(d.ipLineId, b.id, "IP set onto line b by address");
    eq(d.ipAddress(), 0x1004n, "IP address before insert");

    // Insert a long line BEFORE b: b's address must shift, IP stays on b.
    d.insertAfter(d.lines[0].id, "len8 x");
    eq(d.ipLineId, b.id, "IP still on b after insert-between");
    eq(d.ipAddress(), 0x100cn, "IP address followed b after insert (0x1000+8+4)");

    // Edit a non-IP line's size: IP still on b, address reflows.
    d.setText(d.lines[0].id, "len2 a");
    eq(d.ipLineId, b.id, "IP still on b after editing another line");
    eq(d.ipAddress(), 0x100an, "IP address reflowed (2+8 = 0x100A)");
}

// --- delete IP line moves to neighbor ---------------------------------
{
    const d = new Document({ base: 0x1000n, assemble });
    d.setLines("len2 a\nlen2 b\nlen2 c");
    const [a, b, c] = d.lines;
    d.setIPFromAddr(b.addr);
    eq(d.ipLineId, b.id, "IP on b");
    d.remove(b.id);
    eq(d.ipLineId, c.id, "delete IP line -> moves to NEXT instruction (c)");
    d.remove(c.id);
    eq(d.ipLineId, a.id, "delete IP line with no next -> PREVIOUS (a)");
    d.remove(a.id);
    eq(d.ipLineId, null, "delete last instruction -> IP null");
}

// --- failing line keeps last-good size --------------------------------
{
    const d = new Document({ base: 0x1000n, assemble });
    d.setLines("len4 a\nlen2 b");
    const a = d.lines[0];
    eq(a.size, 4, "a assembled to 4 bytes");
    d.setText(a.id, "bad");
    ok(a.error != null, "a now has an error");
    eq(a.size, 4, "failing line keeps last-good size (no thrash)");
    ok(!d.isRunnable(), "doc with an error is not runnable");
    d.setText(a.id, "len6 a");
    ok(a.error == null, "a re-assembles cleanly");
    eq(a.size, 6, "a size updates to 6");
    ok(d.isRunnable(), "doc runnable again");
}

// --- labels resolve to addresses; comments/blank are zero-size --------
{
    const d = new Document({ base: 0x2000n, assemble });
    d.setLines("start:\nlen4 a\n; a comment\n\nlen2 b");
    eq(d.symbols.get("start"), 0x2000n, "label resolves to following addr");
    eq(d.lines[1].addr, 0x2000n, "instr after label keeps label's addr");
    eq(d.lines[4].addr, 0x2004n, "comment + blank contribute zero bytes");
    eq(d.image().bytes.length, 6, "image excludes label/comment/blank bytes");
}

// --- addrToLine maps mid-instruction PC -------------------------------
{
    const d = new Document({ base: 0x1000n, assemble });
    d.setLines("len4 a\nlen4 b");
    const b = d.lines[1];
    const hit = d.addrToLine(0x1006n); // 2 bytes into b (0x1004..0x1008)
    eq(hit.line.id, b.id, "addrToLine finds the containing instruction");
    eq(hit.offset, 2n, "addrToLine reports the mid-instruction offset");
}

// --- relative-branch relaxation (address-aware assembly) --------------
{
    // Toy ISA: "jrel <abs>" encodes as [0xEB, rel8] when the absolute target is
    // within +/-127 of the next instruction, else [0xE9, rel32...] (5 bytes). Both
    // the size and the displacement depend on the line's address, so layout must
    // assemble it at its real address and iterate to a fixed point. Everything
    // else is position-independent ("lenN ..." => N bytes).
    const asm = (t, addr) => {
        const m = t.match(/^jrel\s+(\d+)$/);
        if (!m) {
            const k = t.match(/^len(\d+)/);
            return { bytes: new Array(k ? +k[1] : 2).fill(0x90) };
        }
        const target = BigInt(m[1]);
        const a = BigInt(addr);
        const relShort = target - (a + 2n);
        if (relShort >= -128n && relShort <= 127n) return { bytes: [0xeb, Number(relShort & 0xffn)] };
        const relNear = Number((target - (a + 5n)) & 0xffffffffn);
        return { bytes: [0xe9, relNear & 0xff, (relNear >> 8) & 0xff, (relNear >> 16) & 0xff, (relNear >> 24) & 0xff] };
    };
    const relBranch = (t) => /^jrel\b/.test(t);

    // Backward branch lands near its origin -> relaxes to the short (2-byte) form,
    // with the displacement computed against the branch's real address (0x104).
    const d = new Document({ base: 0x100n, assemble: asm, relBranch });
    d.setLines("len4 a\njrel 256"); // 256 = 0x100
    eq(d.lines[1].addr, 0x104n, "relax: branch line address");
    eq(d.lines[1].size, 2, "relax: backward near branch is short (2 bytes)");
    eq(d.lines[1].bytes[1], 0xfa, "relax: rel8 = 0x100 - (0x104+2) = -6"); // 0xFA

    // Far-forward target can't fit rel8 -> grows to 5 bytes; following lines reflow.
    const d2 = new Document({ base: 0n, assemble: asm, relBranch });
    d2.setLines("jrel 1000\nlen4 a");
    eq(d2.lines[0].size, 5, "relax: far branch grows to the near (5-byte) form");
    eq(d2.lines[1].addr, 5n, "relax: following line reflows after the branch grows");

    // Editing a line above the branch shifts it; the branch re-encodes at its
    // new address (relaxation reruns), and the size converges.
    const d3 = new Document({ base: 0n, assemble: asm, relBranch });
    d3.setLines("len2 a\njrel 0"); // backward branch to 0 -> short
    eq(d3.lines[1].size, 2, "relax: short before edit");
    d3.setText(d3.lines[0].id, "len200 a"); // push the branch ~200 bytes away from 0
    eq(d3.lines[1].size, 5, "relax: branch grows when its target falls out of rel8 range");
}

// --- position-sensitive fixed-size instructions re-encode -------------
{
    // Models x86-64 RIP-relative memory operands: the instruction length can stay
    // fixed while the encoded displacement must still be recomputed from addr.
    const asm = (t, addr) => {
        if (t === "addr-byte") return { bytes: [Number(BigInt(addr) & 0xffn)] };
        const m = t.match(/^len(\d+)/);
        return { bytes: new Array(m ? +m[1] : 1).fill(0x90) };
    };
    const d = new Document({ base: 0x120n, assemble: asm, positionSensitive: (t) => t === "addr-byte" });
    d.setLines("len4 a\naddr-byte\nlen1 c");
    const target = d.lines[1];
    eq(target.addr, 0x124n, "pos: instruction laid out at real address");
    eq(target.bytes[0], 0x24, "pos: bytes assembled from real address");
    d.insertAfter(d.lines[0].id, "len4 x");
    eq(target.addr, 0x128n, "pos: address shifts after insert");
    eq(target.bytes[0], 0x28, "pos: fixed-size bytes re-encode after address shift");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
