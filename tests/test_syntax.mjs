// Unit test for ui/syntax.js, the asm highlighter, with focus on the
// mnemonic/operands split that drives the Disassembly view's two-column mode.
// Run: node tests/test_syntax.mjs

import { highlightAsmParts } from "../src/ui/syntax.js";

let pass = 0,
    fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else {
        fail++;
        console.error("  ✗ " + msg);
    }
}
// Strip tags to compare the plain text a column would render (copy-safe text).
const txt = (html) => html.replace(/<[^>]*>/g, "");

// ---- mnemonic / operands split -----------------------------------------
{
    const p = highlightAsmParts("mov rax, rbx");
    ok(txt(p.mnem) === "mov", "mnem is the first word");
    ok(txt(p.ops) === " rax, rbx", "ops is everything after the mnemonic");
    ok(p.mnem.includes('class="t-mnem"'), "mnemonic is tagged t-mnem");
    ok((p.ops.match(/t-reg/g) || []).length === 2, "both operand registers tagged t-reg");
    ok(p.label === "" && p.comment === "", "no label/comment here");
}

// ---- no operands -------------------------------------------------------
{
    const p = highlightAsmParts("ret");
    ok(txt(p.mnem) === "ret" && txt(p.ops) === "", "operand-less instruction -> empty ops");
}

// ---- label + comment ---------------------------------------------------
{
    const p = highlightAsmParts("loop: add eax, 1 ; counter");
    ok(txt(p.label) === "loop:", "leading label captured");
    ok(txt(p.mnem).trim() === "add", "mnemonic after the label");
    ok(txt(p.ops).includes("eax") && txt(p.ops).includes("1"), "operands hold reg + immediate");
    ok(txt(p.comment) === "; counter", "trailing comment captured");
    ok(p.comment.includes("t-comment"), "comment is tagged t-comment");
    ok(!p.ops.includes(";"), "comment is not duplicated into operands");
}

// ---- immediates are not registers --------------------------------------
{
    const p = highlightAsmParts("mov rax, 0x10");
    ok(p.ops.includes('class="t-imm"'), "hex immediate tagged t-imm");
    ok((p.ops.match(/t-reg/g) || []).length === 1, "only rax is a register, not 0x10");
}

// ---- blank / whitespace-only -------------------------------------------
{
    const p = highlightAsmParts("   ");
    ok(txt(p.mnem) === "" && p.label === "" && p.comment === "", "whitespace-only -> empty mnem");
}

// ---- HTML is escaped ---------------------------------------------------
{
    const p = highlightAsmParts("mov rax, <b>");
    ok(!/<b>/.test(p.ops) && p.ops.includes("&lt;") && p.ops.includes("&gt;"), "operand markup is escaped");
}

// ---- immediates: signed hex, binary, and '#'-prefixed all read as t-imm -----
for (const imm of ["0x10", "-0x4", "0b1010", "#0x10", "42", "-7"]) {
    const p = highlightAsmParts("mov rax, " + imm);
    ok(p.ops.includes(`<span class="t-imm">${imm}</span>`), `immediate "${imm}" highlights as t-imm`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
