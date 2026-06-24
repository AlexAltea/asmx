/*
 * Example programs for the PowerPC profile: content for the Examples menu, kept
 * out of the structural arch profile (arch/ppc.js). Each entry is
 * { name, mode, code }; app.js loads them via `profile.examples`.
 *
 * Branch targets are absolute addresses: each line assembles at its real address
 * so it round-trips with the disassembler, but labels can't resolve across lines.
 * Keystone's PPC parser only accepts NUMERIC register operands ("li 3, 5").
 * The addresses below assume the profile's default codeBase (0x10000) and were
 * run-verified in Unicorn (see tests/test_examples_node.mjs).
 */
export default [
    {
        name: "Sum loop (CR0 + bne)",
        mode: "32",
        code: [
            "; Sum 1..10 into r4, then store the result in the data region.",
            "; addic. is a dotted op: it sets CR0, which bne tests.",
            "li 4, 0",
            "li 5, 10",
            "add 4, 4, 5",
            "addic. 5, 5, -1",
            "bne 0x10008",
            "lis 6, 2",
            "stw 4, 0(6)",
        ].join("\n"),
    },
    {
        name: "Function call & stack",
        mode: "32",
        code: [
            "; Sum of squares 1..5 via a subroutine: r4 = 55, stored at 0x20000.",
            "; The callee builds a frame (stwu on r1) and saves LR in the caller's",
            "; frame, so step-over/step-out have a real call to track.",
            "li 4, 0",
            "li 5, 1",
            "addi 3, 5, 0",
            "bl 0x1002c",
            "add 4, 4, 3",
            "addi 5, 5, 1",
            "cmpwi 5, 6",
            "bne 0x10008",
            "lis 6, 2",
            "stw 4, 0(6)",
            "b 0x1004c",
            "; SQUARE: r3 = r3 * r3",
            "mflr 0",
            "stwu 1, -16(1)",
            "stw 0, 20(1)",
            "mullw 3, 3, 3",
            "lwz 0, 20(1)",
            "mtlr 0",
            "addi 1, 1, 16",
            "blr",
        ].join("\n"),
    },
    {
        name: "Powers of two (CTR + bdnz)",
        mode: "32",
        code: [
            "; Store 1, 2, 4, ... 128 into the data region. bdnz decrements CTR",
            "; and branches while it is nonzero; rlwinm shifts the value left.",
            "lis 6, 2",
            "li 7, 1",
            "li 8, 8",
            "mtctr 8",
            "stw 7, 0(6)",
            "rlwinm 7, 7, 1, 0, 30",
            "addi 6, 6, 4",
            "bdnz 0x10010",
        ].join("\n"),
    },
];
