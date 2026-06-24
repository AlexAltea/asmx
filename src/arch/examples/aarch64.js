/*
 * Example programs for the AArch64 profile: content for the Examples menu,
 * kept out of the structural arch profile (arch/aarch64.js). Each entry is
 * { name, mode, code }; app.js loads them via `profile.examples`.
 *
 * Branch targets are absolute addresses: each line assembles at its real address
 * so it round-trips with the disassembler, but labels can't resolve across lines.
 * Instructions are a fixed 4 bytes; the addresses below assume the profile's
 * default codeBase (0x10000) and were run-verified in Unicorn (see
 * tests/test_examples_node.mjs).
 */
export default [
    {
        name: "Counting loop",
        mode: "64",
        code: [
            "; Sum 1..10 into x0, then store the result in the data region.",
            "mov x0, #0",
            "mov x1, #10",
            "add x0, x0, x1",
            "subs x1, x1, #1",
            "b.ne 0x10008",
            "mov x2, #0x20000",
            "str x0, [x2]",
        ].join("\n"),
    },
    {
        name: "Function call & stack",
        mode: "64",
        code: [
            "; Sum of squares 1..5 via a subroutine: x19 = 55. The callee builds a",
            "; real frame (stp/ldp), so step-over/step-out have a call to track.",
            "mov x19, #0",
            "mov x20, #1",
            "mov x0, x20",
            "bl 0x10024",
            "add x19, x19, x0",
            "add x20, x20, #1",
            "cmp x20, #5",
            "b.le 0x10008",
            "b 0x10034",
            "; SQUARE: x0 = x0 * x0",
            "stp x29, x30, [sp, #-16]!",
            "mul x0, x0, x0",
            "ldp x29, x30, [sp], #16",
            "ret",
        ].join("\n"),
    },
    {
        name: "Flags & conditional select",
        mode: "64",
        code: [
            "; Branch-free max(x0, x1) via NZCV + csel, then a subs that sets Z;",
            "; watch the Flags chips in the Registers panel.",
            "mov x0, #7",
            "mov x1, #12",
            "cmp x0, x1",
            "csel x2, x0, x1, gt",
            "mov x3, #0x20000",
            "str x2, [x3]",
            "subs x4, x0, x0",
        ].join("\n"),
    },
];
