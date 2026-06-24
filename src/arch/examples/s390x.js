/*
 * Example programs for the S390X profile: content for the Examples menu, kept
 * out of the structural arch profile (arch/s390x.js). Each entry is
 * { name, mode, code }; app.js loads them via `profile.examples`.
 *
 * Branch targets are absolute addresses: each line assembles at its real address
 * so it round-trips with the disassembler, but labels can't resolve across lines.
 * Code lives below 0x10000 (codeBase 0x8000) so Keystone's 16-bit-relative
 * branches (j<cond>) pass their base-0 range check; jg<cond>/brasl work
 * anywhere. The addresses below were run-verified in Unicorn (see
 * tests/test_examples_node.mjs).
 */
export default [
    {
        name: "Sum loop (condition code)",
        mode: "64",
        code: [
            "; Sum 1..10 into r2, then store the result in the data region.",
            "; aghi sets the condition code; jh tests CC2 (result > 0).",
            "lghi %r2, 0",
            "lghi %r3, 10",
            "agr %r2, %r3",
            "aghi %r3, -1",
            "jh 0x8008",
            "larl %r1, 0x20000",
            "stg %r2, 0(%r1)",
        ].join("\n"),
    },
    {
        name: "Function call & stack",
        mode: "64",
        code: [
            "; Sum of squares 1..5 via a subroutine: r4 = 55, stored big-endian in",
            "; the data region. brasl puts the return address in r14; the callee",
            "; keeps a stack frame on r15 and spills r14 into it, so step-over and",
            "; step-out have a real call to track.",
            "lghi %r4, 0",
            "lghi %r5, 1",
            "lgr %r2, %r5",
            "brasl %r14, 0x8032",
            "agr %r4, %r2",
            "aghi %r5, 1",
            "cghi %r5, 6",
            "jl 0x8008",
            "larl %r1, 0x20000",
            "stg %r4, 0(%r1)",
            "j 0x804c",
            "; SQUARE: r2 = r2 * r2",
            "aghi %r15, -160",
            "stg %r14, 0(%r15)",
            "msgr %r2, %r2",
            "lg %r14, 0(%r15)",
            "aghi %r15, 160",
            "br %r14",
        ].join("\n"),
    },
    {
        name: "String upper-case (byte loop)",
        mode: "64",
        code: [
            '; Write "hello" into the data region, then upper-case it in place:',
            "; nill clears the 0x20 case bit, brct decrements r2 and loops while",
            "; it is nonzero.",
            "larl %r1, 0x20000",
            "mvi 0(%r1), 0x68",
            "mvi 1(%r1), 0x65",
            "mvi 2(%r1), 0x6c",
            "mvi 3(%r1), 0x6c",
            "mvi 4(%r1), 0x6f",
            "lghi %r2, 5",
            "llgc %r3, 0(%r1)",
            "nill %r3, 0xdf",
            "stc %r3, 0(%r1)",
            "la %r1, 1(%r1)",
            "brct %r2, 0x801e",
        ].join("\n"),
    },
];
