/*
 * Example programs for the SPARC profile: content for the Examples menu, kept
 * out of the structural arch profile (arch/sparc.js). Each entry is
 * { name, mode, code }; app.js loads them via `profile.examples`.
 *
 * Branch targets are absolute addresses: each line assembles at its real address
 * so it round-trips with the disassembler, but labels can't resolve across lines.
 * Keystone does NOT auto-fill SPARC delay slots: every branch needs an explicit
 * nop after it. No subroutine examples: direct `call` mis-encodes in this
 * Keystone build and the jmpl family (call %reg / ret / retl) faults in this
 * Unicorn build (see arch/sparc.js). The addresses below assume the profile's
 * default codeBase (0x10000) and were run-verified in Unicorn (see
 * tests/test_examples_node.mjs).
 */
export default [
    {
        name: "Sum loop (delay slots)",
        mode: "32",
        code: [
            "; Sum 1..10 into %g2, then store the result in the data region.",
            "; The nop after bne is the branch delay slot (not auto-filled).",
            "mov 0, %g2",
            "mov 10, %g3",
            "add %g2, %g3, %g2",
            "subcc %g3, 1, %g3",
            "bne 0x10008",
            "nop",
            "set 0x20000, %g4",
            "st %g2, [%g4]",
        ].join("\n"),
    },
    {
        name: "String upper-case (ldub/stb)",
        mode: "32",
        code: [
            '; Write "hello" into the data region, then upper-case it in place',
            "; byte by byte. The final ld pulls the finished word back into %g2.",
            "set 0x20000, %g1",
            "set 0x68656c6c, %g2",
            "st %g2, [%g1]",
            "mov 0x6f, %g2",
            "stb %g2, [%g1+4]",
            "mov 5, %g3",
            "ldub [%g1], %g2",
            "sub %g2, 0x20, %g2",
            "stb %g2, [%g1]",
            "add %g1, 1, %g1",
            "subcc %g3, 1, %g3",
            "bne 0x1001c",
            "nop",
            "set 0x20000, %g1",
            "ld [%g1], %g2",
        ].join("\n"),
    },
    {
        name: "Fibonacci loop",
        mode: "64",
        code: [
            "; Iterate the Fibonacci recurrence ten times: %g2 ends as fib(10) = 55,",
            "; stored in the data region. Same branch + delay-slot idiom under V9.",
            "mov 0, %g2",
            "mov 1, %g3",
            "mov 10, %g4",
            "add %g2, %g3, %g5",
            "mov %g3, %g2",
            "mov %g5, %g3",
            "subcc %g4, 1, %g4",
            "bne 0x1000c",
            "nop",
            "set 0x20000, %g1",
            "st %g2, [%g1]",
        ].join("\n"),
    },
];
