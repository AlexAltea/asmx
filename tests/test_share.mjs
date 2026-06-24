// Round-trip test for the share codec (single gzip container in the URL hash).
// Run: node test_share.mjs; uses the platform CompressionStream (node ≥18).

// Node <22.13 lacks the native Uint8Array base64 codec share.js uses (Baseline
// 2025 in browsers); shim the two calls it makes via node's Buffer.
if (!Uint8Array.prototype.toBase64) {
    Uint8Array.prototype.toBase64 = function ({ alphabet } = {}) {
        return Buffer.from(this).toString(alphabet === "base64url" ? "base64url" : "base64");
    };
    Uint8Array.fromBase64 = (s, { alphabet } = {}) =>
        new Uint8Array(Buffer.from(s, alphabet === "base64url" ? "base64url" : "base64"));
}

import { encodeShareHash, decodeShareHash } from "../src/core/share.js";
import { writeElf, parseElf, EM, ELFCLASS64 } from "../src/core/elf.js";

let pass = 0,
    fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else {
        fail++;
        console.error("  ✗ " + msg);
    }
}
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${a}, want ${b})`);
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 0x0a inside the code bytes: only the header's newline may delimit the container.
const elfBytes = writeElf({
    machine: EM.X86_64,
    elfClass: ELFCLASS64,
    entry: 0x10000n,
    segments: [{ vaddr: 0x10000n, bytes: Uint8Array.from([0xb8, 0x0a, 0x12, 0, 0, 0xc3]), memsz: 0x10000n }],
});
const cpu = { RAX: "1234", RBX: "1", RIP: "10000" };
const bp = [{ a: "10002" }, { a: "10004", c: "rax == 10" }];

// --- encode -------------------------------------------------------------
const hash = await encodeShareHash({ elfBytes, cpu, bp });
ok(hash.startsWith("v=1&s="), "hash: tagged v=1&s=");
ok(!/[+/=]/.test(hash.slice("v=1&s=".length)), "hash: base64url (no +/=)");
// gzip should shrink a mostly-zero 64-bit ELF well under its raw size.
ok(hash.length < elfBytes.length, "hash: compressed smaller than the raw ELF");

// --- decode -------------------------------------------------------------
const snap = await decodeShareHash("#" + hash);
ok(bytesEq(snap.elfBytes, elfBytes), "decode: ELF bytes round-trip (embedded 0x0a intact)");
eq(JSON.stringify(snap.cpu), JSON.stringify(cpu), "decode: cpu map round-trip");
eq(JSON.stringify(snap.bp), JSON.stringify(bp), "decode: breakpoints round-trip");
eq(parseElf(snap.elfBytes).machine, EM.X86_64, "decode: ELF still valid");

// bp omitted -> absent from the header entirely
const bare = await decodeShareHash("#" + (await encodeShareHash({ elfBytes, cpu })));
ok(bare.bp === undefined, "decode: no bp field when none were shared");
ok(bare.log === undefined, "decode: no log field when none was shared");

// console logs: [ts, level, message] triples round-trip alongside cpu/bp
const log = [
    [1752130800000, "info", "ready; press Run or Step into (F11)."],
    [1752130801500, "error", 'asm error: "mov rax," (invalid operand)'],
];
const withLog = await decodeShareHash("#" + (await encodeShareHash({ elfBytes, cpu, bp, log })));
eq(JSON.stringify(withLog.log), JSON.stringify(log), "decode: log round-trip");
eq(JSON.stringify(withLog.bp), JSON.stringify(bp), "decode: bp intact alongside log");

// --- versioning ----------------------------------------------------------
const noV = await decodeShareHash("#" + hash.replace(/^v=1&/, ""));
ok(bytesEq(noV.elfBytes, elfBytes), "version: absent v decodes as v=1");
let badV = false;
try {
    await decodeShareHash("#" + hash.replace(/^v=1/, "v=99"));
} catch {
    badV = true;
}
ok(badV, "version: unknown v throws (future formats keep this parser)");

// --- absent vs garbled --------------------------------------------------
ok((await decodeShareHash("")) === null, "hash: empty -> null");
ok((await decodeShareHash("#other=1")) === null, "hash: no s= -> null");
let threw = false;
try {
    await decodeShareHash("#v=1&s=nonsense");
} catch {
    threw = true;
}
ok(threw, "hash: garbled payload throws (caller reports it)");

console.log(`test_share: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
