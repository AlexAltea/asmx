/*
 * Expression evaluator for the goto/inspector fields.
 *
 * Grammar: register names of the current arch (case-insensitive, plus the
 * aliases `pc`/`sp` and sub-registers like `eax`/`bx`/`ah`/`al` resolved via
 * ctx.subRegs), integer literals (decimal / 0x / 0b / 0o, with `_` digit
 * separators), the C-style arithmetic/bitwise operators, parentheses, and
 * memory dereference `[expr]` (reads pointer-width bytes from guest memory,
 * decoded in the guest's byte order, see ctx.bigEndian). Bare numbers are
 * DECIMAL; hex needs `0x`. The six comparisons
 * (== != < <= > >=) yield 1n/0n (breakpoint conditions stop on non-zero) and,
 * unlike C, all sit at one LOWEST precedence, so `rax & 0xff == 10` compares
 * the masked value. They compare mathematical BigInts: register/memory reads
 * are unsigned, only literal negation produces a negative operand.
 *
 * `parse()` is pure and synchronous (unit-testable). Evaluation is async only
 * because a deref awaits the worker's memory read; nested derefs (`[[rsp]]`)
 * and derefs inside arithmetic (`rax + [rbx]`) fall out of the recursion for
 * free. Everything is BigInt; results are masked to pointer width by the
 * callers that treat them as addresses, and by evaluateInspect for display.
 *
 *   ctx = {
 *     reg(NAME) -> Uint8Array | undefined   // raw bytes, looked up by UPPERCASE name
 *     readBytes(addr, size) -> Promise<Uint8Array>
 *     subRegs?  { NAME: { parent, off, mask } }  // sub-register: (parent >> off) & mask
 *     pointerSize, pcName, spName
 *     bigEndian?  // guest MEMORY byte order for derefs (registers stay host-LE)
 *   }
 */
import { bytesToBig, bigToBytes, toHex, hexWidth, maskFor, maskBytes } from "./bigint.js";

// Number literals: 0x/0b/0o (case-insensitive) or bare decimal, `_` allowed as a
// grouping separator. Identifiers are letter-led (register names have no `_`), so
// a leading digit unambiguously starts a number.
const NUM_RE = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*)/;
const ID_RE = /^[A-Za-z][A-Za-z0-9]*/;
const ONE_CHAR_OPS = "+-*/%&|^~()[]<>";
const TWO_CHAR_OPS = ["<<", ">>", "==", "!=", "<=", ">="];
// Binary operator precedence (higher binds tighter). All are left-associative.
const PREC = {
    "==": 0, "!=": 0, "<": 0, "<=": 0, ">": 0, ">=": 0,
    "|": 1, "^": 2, "&": 3, "<<": 4, ">>": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
};
const MAX_SHIFT = 4096n; // far beyond any pointer width; bounds the intermediate BigInt

function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            i++;
            continue;
        }
        const rest = src.slice(i);
        let m;
        if ((m = NUM_RE.exec(rest))) {
            const txt = normalizeRadix(m[0].replace(/_/g, ""));
            let v;
            try {
                v = BigInt(txt);
            } catch {
                throw new Error(`bad number "${m[0]}"`);
            }
            toks.push({ t: "num", v });
        } else if ((m = ID_RE.exec(rest))) {
            toks.push({ t: "id", v: m[0] });
        } else if (TWO_CHAR_OPS.includes(rest.slice(0, 2))) {
            toks.push({ t: "op", v: rest.slice(0, 2) });
            i += 2;
            continue;
        } else if (ONE_CHAR_OPS.includes(ch)) {
            toks.push({ t: "op", v: ch });
        } else {
            throw new Error(`unexpected character "${ch}"`);
        }
        i += m ? m[0].length : 1;
    }
    return toks;
}

// BigInt's string parser wants a lowercase radix prefix; the hex digits A-F are
// already case-insensitive to it.
function normalizeRadix(txt) {
    return /^0[xXoObB]/.test(txt) ? txt.slice(0, 2).toLowerCase() + txt.slice(2) : txt;
}

/** Parse `src` into an AST, throwing a friendly Error on any syntax problem. */
export function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];

    function binary(minPrec) {
        let left = unary();
        for (;;) {
            const t = peek();
            if (!t || t.t !== "op") break;
            const pr = PREC[t.v];
            if (pr == null || pr < minPrec) break;
            p++;
            left = { t: "bin", op: t.v, a: left, b: binary(pr + 1) }; // +1 => left-assoc
        }
        return left;
    }
    function unary() {
        const t = peek();
        if (t && t.t === "op" && (t.v === "-" || t.v === "+" || t.v === "~")) {
            p++;
            return { t: "un", op: t.v, e: unary() };
        }
        return primary();
    }
    function primary() {
        const t = peek();
        if (!t) throw new Error("unexpected end of expression");
        if (t.t === "num") {
            p++;
            return { t: "num", v: t.v };
        }
        if (t.t === "id") {
            p++;
            return { t: "reg", name: t.v };
        }
        if (t.v === "(" || t.v === "[") {
            p++;
            const e = binary(0);
            expect(t.v === "(" ? ")" : "]");
            return t.v === "(" ? e : { t: "deref", e };
        }
        throw new Error(`unexpected token "${t.v}"`);
    }
    function expect(v) {
        const t = toks[p++];
        if (!t || t.v !== v) throw new Error(`expected "${v}"`);
    }

    const ast = binary(0);
    if (p < toks.length) throw new Error(`unexpected token "${toks[p].v}"`);
    return ast;
}

export function ptrMask(ctx) {
    return maskFor(ctx.pointerSize);
}

// Resolve a register name to its raw bytes, in priority order:
//   1. the exact UPPERCASE name (a snapshot register),
//   2. the arch-neutral `pc`/`sp` aliases (always the full-width pointer, so they
//      win over x86's 16-bit SP sub-register),
//   3. a sub-register (eax/bx/ah/al/r8d...) extracted from its live parent as
//      (parent >> off) & mask via ctx.subRegs; its width comes from the mask.
// Throws if the current arch has no such register.
function regBytes(name, ctx) {
    const upper = name.toUpperCase();
    let b = ctx.reg(upper);
    if (b) return b;

    const low = name.toLowerCase();
    if (low === "pc" && ctx.pcName) b = ctx.reg(ctx.pcName);
    else if (low === "sp" && ctx.spName) b = ctx.reg(ctx.spName);
    if (b) return b;

    const sub = ctx.subRegs && ctx.subRegs[upper];
    if (sub) {
        const pb = ctx.reg(sub.parent);
        if (pb) {
            const v = (bytesToBig(pb) >> BigInt(sub.off)) & sub.mask;
            return bigToBytes(v, maskBytes(sub.mask));
        }
    }
    throw new Error(`unknown register "${name}"`);
}

async function evalNode(n, ctx) {
    switch (n.t) {
        case "num":
            return n.v;
        case "reg":
            return bytesToBig(regBytes(n.name, ctx));
        case "deref": {
            const addr = (await evalNode(n.e, ctx)) & ptrMask(ctx);
            const bytes = await ctx.readBytes(addr, ctx.pointerSize);
            if (!bytes) throw new Error("memory read failed");
            return bytesToBig(bytes, ctx.bigEndian);
        }
        case "un": {
            const v = await evalNode(n.e, ctx);
            return n.op === "-" ? -v : n.op === "~" ? ~v : v;
        }
        case "bin": {
            const a = await evalNode(n.a, ctx);
            const b = await evalNode(n.b, ctx);
            return applyBin(n.op, a, b);
        }
    }
    throw new Error("bad node");
}

function applyBin(op, a, b) {
    switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": if (b === 0n) throw new Error("division by zero"); return a / b;
        case "%": if (b === 0n) throw new Error("division by zero"); return a % b;
        case "&": return a & b;
        case "|": return a | b;
        case "^": return a ^ b;
        // Cap the shift count: a result is always masked to pointer width by the
        // caller, so a huge `<<` would only build a giant intermediate BigInt (and
        // freeze the UI thread) to produce bits that get masked off anyway.
        case "<<": if (b < 0n || b > MAX_SHIFT) throw new Error("shift count out of range"); return a << b;
        case ">>": if (b < 0n || b > MAX_SHIFT) throw new Error("shift count out of range"); return a >> b;
        case "==": return a === b ? 1n : 0n;
        case "!=": return a !== b ? 1n : 0n;
        case "<": return a < b ? 1n : 0n;
        case "<=": return a <= b ? 1n : 0n;
        case ">": return a > b ? 1n : 0n;
        case ">=": return a >= b ? 1n : 0n;
    }
    throw new Error(`bad operator "${op}"`);
}

/** Evaluate `src` to a BigInt (used as an address by Memory/Stack). */
export async function evaluate(src, ctx) {
    return evalNode(parse(src), ctx);
}

// Synchronous mirror of evalNode. Identical semantics, but the deref reads guest
// memory through a SYNCHRONOUS `ctx.readBytes(addr, size) -> Uint8Array`. Used
// where memory access is already local and blocking: the engine worker, which
// evaluates conditional-breakpoint expressions inside its per-instruction hook
// (no async round-trip possible there). regBytes/applyBin/ptrMask are shared
// with the async path, so the two stay in lockstep.
function evalNodeSync(n, ctx) {
    switch (n.t) {
        case "num":
            return n.v;
        case "reg":
            return bytesToBig(regBytes(n.name, ctx));
        case "deref": {
            const addr = evalNodeSync(n.e, ctx) & ptrMask(ctx);
            const bytes = ctx.readBytes(addr, ctx.pointerSize);
            if (!bytes) throw new Error("memory read failed");
            return bytesToBig(bytes, ctx.bigEndian);
        }
        case "un": {
            const v = evalNodeSync(n.e, ctx);
            return n.op === "-" ? -v : n.op === "~" ? ~v : v;
        }
        case "bin": {
            const a = evalNodeSync(n.a, ctx);
            const b = evalNodeSync(n.b, ctx);
            return applyBin(n.op, a, b);
        }
    }
    throw new Error("bad node");
}

/** Synchronous `evaluate` for contexts with blocking memory reads (see evalNodeSync). */
export function evaluateSync(src, ctx) {
    return evalNodeSync(parse(src), ctx);
}

/**
 * Evaluate `src` for the Inspector, returning the bytes to reinterpret:
 *   - a bare register  -> its RAW bytes + real size (XMM keeps its 16-byte lanes)
 *   - a top-level [..]  -> the loaded pointer-width bytes
 *   - anything else     -> the value's pointer-width bytes (guest byte order)
 */
export async function evaluateInspect(src, ctx) {
    const ast = parse(src);
    if (ast.t === "reg") {
        const bytes = regBytes(ast.name, ctx);
        return { bytes, size: bytes.length, label: ast.name.toLowerCase() };
    }
    if (ast.t === "deref") {
        const addr = (await evalNode(ast.e, ctx)) & ptrMask(ctx);
        const bytes = await ctx.readBytes(addr, ctx.pointerSize);
        if (!bytes) throw new Error("memory read failed");
        return { bytes, size: ctx.pointerSize, label: `[0x${toHex(addr, hexWidth(ctx.pointerSize))}]` };
    }
    const v = (await evalNode(ast, ctx)) & ptrMask(ctx);
    return { bytes: bigToBytes(v, ctx.pointerSize, ctx.bigEndian), size: ctx.pointerSize, label: src.trim() };
}
