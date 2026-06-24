/*
 * Example programs for the ARM profile: content for the Examples menu, kept
 * out of the structural arch profile (arch/arm.js). Each entry is
 * { name, mode, code }; app.js loads them via `profile.examples`.
 *
 * Branch targets are absolute addresses: each line assembles at its real address
 * so it round-trips with the disassembler, but labels can't resolve across lines.
 * The addresses below assume the profile's default codeBase (0x10000) and were
 * run-verified in Unicorn (see tests/test_examples_node.mjs).
 */
export default [
    {
        // ARM instructions are a fixed 4 bytes, so targets step by 4.
        name: "String upper-case (loop)",
        mode: "arm",
        code: [
            '; Write "hello" into the data region, then upper-case it in a loop.',
            "mov r0, #0x20000",
            "movw r1, #0x6568",
            "movt r1, #0x6c6c",
            "str r1, [r0]",
            "mov r1, #0x6f",
            "strb r1, [r0, #4]",
            "mov r2, #5",
            "ldrb r3, [r0]",
            "sub r3, r3, #0x20",
            "strb r3, [r0]",
            "add r0, r0, #1",
            "subs r2, r2, #1",
            "bne 0x1001c",
        ].join("\n"),
    },
    {
        name: "Function call & stack",
        mode: "arm",
        code: [
            "; Sum of squares 1..5 via a subroutine: r4 = 55. The callee keeps a",
            "; stack frame (push/pop), so step-over/step-out have a real call to track.",
            "mov r4, #0",
            "mov r5, #1",
            "mov r0, r5",
            "bl 0x10024",
            "add r4, r4, r0",
            "add r5, r5, #1",
            "cmp r5, #5",
            "ble 0x10008",
            "b 0x10030",
            "; SQUARE: r0 = r0 * r0",
            "push {r4, lr}",
            "mul r0, r0, r0",
            "pop {r4, pc}",
        ].join("\n"),
    },
    {
        name: "Thumb-2 (mixed 2/4-byte)",
        mode: "thumb",
        code: [
            "; Thumb mixes narrow (2-byte) and wide (4-byte) encodings: sum 1..10",
            "; into r0, then store it in the data region with a wide mov.",
            "movs r0, #0",
            "movs r1, #10",
            "adds r0, r0, r1",
            "subs r1, #1",
            "bne 0x10004",
            "mov.w r2, #0x20000",
            "str r0, [r2]",
        ].join("\n"),
    },
];
