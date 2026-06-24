// Unit test for core/expr.js, the goto/inspector expression evaluator. The
// parser is pure; evaluation is async only for memory deref, which we feed from
// a fake register map + fake word-addressed memory. Run: node test_expr.mjs

import { parse, evaluate, evaluateInspect, evaluateSync } from "../src/core/expr.js";
import { bytesToBig, bigToBytes } from "../src/core/bigint.js";
import x86 from "../src/arch/x86.js";

let pass = 0,
    fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else {
        fail++;
        console.error("  ✗ " + msg);
    }
}

// ---- fake evaluation context -------------------------------------------
const REGS = {
    RAX: { v: 0x1122334455667788n, size: 8 },
    RBX: { v: 0xffn, size: 8 },
    RSP: { v: 0x7000n, size: 8 },
    RIP: { v: 0x401000n, size: 8 },
    RSI: { v: 0x1111222233334444n, size: 8 },
    RDI: { v: 0x5555666677778888n, size: 8 },
    RBP: { v: 0x0102030405060708n, size: 8 },
    R8: { v: 0xaabbccddeeff0011n, size: 8 },
    R15: { v: 0xfedcba9876543210n, size: 8 },
    XMM0: { v: 0x0102030405060708090a0b0c0d0e0f10n, size: 16 },
};
const MEM = new Map([
    [0x7000n, 0x2000n], // [rsp]   -> 0x2000
    [0x2000n, 0xdeadbeefn], // [[rsp]] -> 0xdeadbeef
]);
const ctx = {
    reg: (name) => (REGS[name] ? bigToBytes(REGS[name].v, REGS[name].size) : undefined),
    readBytes: async (addr, size) => bigToBytes(MEM.get(addr) ?? 0n, size),
    subRegs: x86.subRegsFor("64"), // the real arch table, so a future offset/size typo fails here
    pointerSize: 8,
    pcName: "RIP",
    spName: "RSP",
};

async function val(src) {
    return evaluate(src, ctx);
}
async function rejects(src, msg) {
    try {
        await evaluate(src, ctx);
        ok(false, msg + " (did not throw)");
    } catch {
        ok(true, msg);
    }
}

// ---- literals & radixes -------------------------------------------------
ok((await val("255")) === 255n, "bare number is decimal");
ok((await val("0xff")) === 255n, "0x hex");
ok((await val("0b1010")) === 10n, "0b binary");
ok((await val("0o17")) === 15n, "0o octal");
ok((await val("0X1F")) === 31n, "uppercase 0X prefix");
ok((await val("0b1_0000_0000_0000_0000")) === 0x10000n, "underscore separators");
ok((await val("1_000")) === 1000n, "underscores in decimal");

// ---- precedence & operators --------------------------------------------
ok((await val("1+2*3")) === 7n, "* binds tighter than +");
ok((await val("(1+2)*3")) === 9n, "parentheses override precedence");
ok((await val("1<<4 | 1")) === 17n, "shift binds tighter than |");
ok((await val("0xff & 0x0f")) === 0x0fn, "bitwise and");
ok((await val("0xf0 ^ 0x0f")) === 0xffn, "bitwise xor");
ok((await val("8>>1")) === 4n, "right shift");
ok((await val("17/5")) === 3n, "integer division truncates");
ok((await val("17%5")) === 2n, "modulo");

// associativity: all operators are left-associative (each value differs under right-assoc)
ok((await val("8-3-2")) === 3n, "minus is left-associative");
ok((await val("16/4/2")) === 2n, "division is left-associative");
ok((await val("1<<2<<1")) === 8n, "shift is left-associative");
ok((await val("100%30%7")) === 3n, "modulo is left-associative");

// cross-class precedence, C ordering: * > + > shift > & > ^ > |
ok((await val("1<<1+1")) === 4n, "+ binds tighter than <<");
ok((await val("1|2&3")) === 3n, "& binds tighter than |");
ok((await val("1^1&0")) === 1n, "& binds tighter than ^");
ok((await val("0xf0|0x0f^0xff")) === 0xf0n, "^ binds tighter than |");

// ---- unary -------------------------------------------------------------
ok((await val("-5")) === -5n, "unary minus");
ok((await val("~0")) === -1n, "bitwise not");
ok((await val("3 - -2")) === 5n, "binary minus then unary minus");
ok((await val("-2*3")) === -6n, "unary binds tighter than *");

// ---- registers + aliases (case-insensitive) ----------------------------
ok((await val("rax")) === 0x1122334455667788n, "lowercase register");
ok((await val("RAX")) === 0x1122334455667788n, "uppercase register");
ok((await val("rsp+8")) === 0x7008n, "register arithmetic");
ok((await val("pc")) === 0x401000n, "pc alias -> RIP");
ok((await val("sp")) === 0x7000n, "sp alias -> RSP");
await rejects("r99", "unknown register throws");

// ---- sub-registers (sliced off the live parent's little-endian bytes) ---
ok((await val("eax")) === 0x55667788n, "eax = low 4 bytes of rax");
ok((await val("ax")) === 0x7788n, "ax = low 2 bytes of rax");
ok((await val("al")) === 0x88n, "al = low byte of rax");
ok((await val("ah")) === 0x77n, "ah = second byte of rax");
ok((await val("AL")) === 0x88n, "sub-register lookup is case-insensitive");
ok((await val("bx")) === 0xffn, "bx = low 2 bytes of rbx");
ok((await val("r8d")) === 0xeeff0011n, "r8d = low 4 bytes of r8");
ok((await val("r8b")) === 0x11n, "r8b = low byte of r8");
ok((await val("ah+al")) === 0xffn, "sub-registers compose in arithmetic");
{
    const r = await evaluateInspect("al", ctx);
    ok(r.size === 1 && bytesToBig(r.bytes) === 0x88n && r.label === "al", "inspect: sub-register keeps its real width (1 byte)");
}
{
    const r = await evaluateInspect("eax", ctx);
    ok(r.size === 4 && bytesToBig(r.bytes) === 0x55667788n && r.label === "eax", "inspect: eax is a 4-byte value");
}
// Families beyond A/B/C/D and the R8 set; guards the real table's offsets/sizes.
ok((await val("esi")) === 0x33334444n, "esi = low 4 bytes of rsi");
ok((await val("si")) === 0x4444n, "si = low 2 bytes of rsi");
ok((await val("sil")) === 0x44n, "sil = low byte of rsi");
ok((await val("di")) === 0x8888n, "di = low 2 bytes of rdi");
ok((await val("dil")) === 0x88n, "dil = low byte of rdi");
ok((await val("bp")) === 0x0708n, "bp = low 2 bytes of rbp");
ok((await val("bpl")) === 0x08n, "bpl = low byte of rbp");
ok((await val("r15d")) === 0x76543210n, "r15d = low 4 bytes of r15");
ok((await val("r15w")) === 0x3210n, "r15w = low 2 bytes of r15");
ok((await val("r15b")) === 0x10n, "r15b = low byte of r15");

// The pc/sp aliases must WIN over x86's 16-bit SP/IP sub-registers (a regression
// guard: with sub-registers resolvable, `sp` must still mean the full RSP).
{
    const r = await evaluateInspect("sp", ctx);
    ok(r.size === 8, "inspect: sp (alias) keeps full pointer width, not the 2-byte SP slice");
}
{
    const r = await evaluateInspect("spl", ctx);
    ok(r.size === 1, "inspect: spl is a 1-byte sub-register (distinct from the sp alias)");
}

// ---- 32-bit mode: parents shrink to E-registers; 64-bit names disappear --------
const REGS32 = { EAX: 0x55667788n, ESP: 0x7000n, EIP: 0x401000n };
const ctx32 = {
    reg: (name) => (REGS32[name] != null ? bigToBytes(REGS32[name], 4) : undefined),
    readBytes: async () => bigToBytes(0n, 4),
    subRegs: x86.subRegsFor("32"),
    pointerSize: 4,
    pcName: "EIP",
    spName: "ESP",
};
const v32 = (src) => evaluate(src, ctx32);
async function rejects32(src, msg) {
    try {
        await evaluate(src, ctx32);
        ok(false, msg + " (did not throw)");
    } catch {
        ok(true, msg);
    }
}
ok((await v32("eax")) === 0x55667788n, "32-bit: eax via exact snapshot name");
ok((await v32("ax")) === 0x7788n, "32-bit: ax = low 2 bytes of eax");
ok((await v32("al")) === 0x88n, "32-bit: al = low byte of eax");
ok((await v32("ah")) === 0x77n, "32-bit: ah = second byte of eax");
ok((await v32("sp")) === 0x7000n, "32-bit: sp alias resolves to the full ESP");
await rejects32("rax", "32-bit: rax (no register, no sub-register) throws");
await rejects32("rsp", "32-bit: rsp throws in 32-bit mode");
{
    const r = await evaluateInspect("sp", ctx32);
    ok(r.size === 4, "32-bit inspect: sp (alias) is the full 4-byte ESP, not a 16-bit slice");
}

// ---- dereference -------------------------------------------------------
ok((await val("[rsp]")) === 0x2000n, "deref reads memory");
ok((await val("[[rsp]]")) === 0xdeadbeefn, "nested deref");
ok((await val("[rsp]+4")) === 0x2004n, "deref inside arithmetic");

// ---- syntax errors -----------------------------------------------------
await rejects("", "empty input throws");
await rejects("   ", "whitespace-only throws");
await rejects("@", "stray character throws");
await rejects("rax +", "trailing operator throws");
await rejects("1 2", "two values with no operator throws");
await rejects("(1+2", "unbalanced paren throws");
await rejects("[rsp", "unbalanced bracket throws");
await rejects("5/0", "division by zero throws");
await rejects("5%0", "modulo by zero throws");
await rejects("1<<-1", "negative shift count throws");
await rejects("5<<5000", "shift count beyond cap throws (no giant BigInt)");
ok(parse("rax+1").t === "bin", "parse returns an AST (pure, no ctx)");

// ---- evaluateInspect: the three display branches ------------------------
{
    const r = await evaluateInspect("rax", ctx);
    ok(r.size === 8 && bytesToBig(r.bytes) === 0x1122334455667788n && r.label === "rax", "inspect: bare register -> raw bytes");
}
{
    const r = await evaluateInspect("xmm0", ctx);
    ok(r.size === 16 && r.bytes.length === 16, "inspect: XMM keeps its 16-byte width");
}
{
    const r = await evaluateInspect("[rsp]", ctx);
    ok(r.size === 8 && bytesToBig(r.bytes) === 0x2000n, "inspect: top-level deref -> loaded bytes");
    ok(r.label === "[0x0000000000007000]", "inspect: deref label is the address");
}
{
    const r = await evaluateInspect("rax+0", ctx);
    ok(r.size === 8 && bytesToBig(r.bytes) === 0x1122334455667788n && r.label === "rax+0", "inspect: value -> pointer-width LE bytes");
}
{
    const r = await evaluateInspect("-1", ctx);
    ok(r.bytes.length === 8 && r.bytes.every((b) => b === 0xff), "inspect: negative masks to two's-complement pointer width");
}

// ---- evaluateSync (worker conditional-breakpoint path) -----------------
// Same grammar/semantics as evaluate(), but with a SYNCHRONOUS readBytes; the
// engine worker uses this inside its per-instruction hook (no async round-trip).
{
    const sctx = {
        reg: ctx.reg,
        readBytes: (addr, size) => bigToBytes(MEM.get(addr) ?? 0n, size), // sync
        subRegs: x86.subRegsFor("64"),
        pointerSize: 8,
        pcName: "RIP",
        spName: "RSP",
    };
    ok(evaluateSync("1+2*3", sctx) === 7n, "sync: arithmetic precedence");
    ok(evaluateSync("rax", sctx) === 0x1122334455667788n, "sync: register read");
    ok(evaluateSync("eax", sctx) === 0x55667788n, "sync: sub-register slice");
    ok(evaluateSync("[rsp]", sctx) === 0x2000n, "sync: deref via synchronous readBytes");
    ok(evaluateSync("[[rsp]]", sctx) === 0xdeadbeefn, "sync: nested deref");
    let threw = false;
    try { evaluateSync("r99", sctx); } catch { threw = true; }
    ok(threw, "sync: unknown register throws");

    // Comparisons (breakpoint conditions stop on non-zero): 1n/0n, lowest precedence.
    ok(evaluateSync("1 == 1", sctx) === 1n && evaluateSync("1 != 1", sctx) === 0n, "cmp: equality -> 1/0");
    ok(evaluateSync("2 < 3", sctx) === 1n && evaluateSync("3 <= 2", sctx) === 0n, "cmp: less-than family");
    ok(evaluateSync("3 > 2", sctx) === 1n && evaluateSync("2 >= 3", sctx) === 0n, "cmp: greater-than family");
    ok(evaluateSync("rax & 0xff == 0x88", sctx) === 1n, "cmp: binds loosest, mask applies first");
    ok(evaluateSync("1 << 2 == 4", sctx) === 1n, "cmp: shift binds tighter than ==");
    ok(evaluateSync("[rsp] == 0x2000", sctx) === 1n, "cmp: deref inside a condition");
    ok(evaluateSync("-1 < 0", sctx) === 1n, "cmp: literal negation compares signed");
}

// ---- big-endian guests (MIPS BE / PPC / SPARC / S390X) -------------------
// Registers stay host-little-endian; only MEMORY derefs flip byte order. The
// mock uses LITERAL byte arrays (not the helpers under test), so a symmetric
// loss of the bigEndian flag in bigint.js would flip these results and fail.
{
    // Guest memory at 0x2000 holds the big-endian bytes 11 22 33 44.
    const MEM_BE = [0x11, 0x22, 0x33, 0x44];
    const bectx = {
        reg: (name) => (name === "R9" ? Uint8Array.from([0x00, 0x20, 0x00, 0x00]) : undefined), // 0x2000 host-LE
        readBytes: async (addr, size) => (addr === 0x2000n ? Uint8Array.from(MEM_BE.slice(0, size)) : undefined),
        subRegs: {},
        pointerSize: 4,
        pcName: "PC",
        spName: "R1",
        bigEndian: true,
    };
    ok((await evaluate("[r9]", bectx)) === 0x11223344n, "BE: deref decodes big-endian memory");
    ok((await evaluate("r9", bectx)) === 0x2000n, "BE: register read stays little-endian");
    // A little-endian deref of the same bytes would read 0x44332211; pin that it does not.
    ok((await evaluate("[r9]", bectx)) !== 0x44332211n, "BE: deref is NOT little-endian");
    const sync = { ...bectx, readBytes: (addr, size) => (addr === 0x2000n ? Uint8Array.from(MEM_BE.slice(0, size)) : undefined) };
    ok(evaluateSync("[r9] == 0x11223344", sync) === 1n, "BE: sync deref (breakpoint conditions)");
    // evaluateInspect re-encodes a computed value in guest order; big-endian bytes are 11 22 33 44.
    const insp = await evaluateInspect("[r9] + 0", bectx);
    ok(insp.bytes.length === 4 && Array.from(insp.bytes).join(",") === "17,34,51,68", "BE: computed inspect value re-encodes big-endian");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
