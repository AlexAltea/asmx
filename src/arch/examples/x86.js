/*
 * Example programs for the x86 profile: content for the Examples menu, kept
 * out of the structural arch profile (arch/x86.js). Each entry is
 * { name, mode, code }; app.js loads them via `profile.examples`.
 *
 * Branch targets are absolute addresses: each line assembles at its real address
 * so it round-trips with the disassembler, but labels can't resolve across lines.
 * The addresses below assume the profile's default codeBase (0x10000).
 */
export default [
    {
        // TEMPORARY default: a broad "feature tour" that exercises most of the UI:
        // nested loops (arrow gutter), call/ret + an indirect register "callback"
        // (stack panel + step-over/out), a string loop and memory load/stores
        // (Memory panel), and XMM double-precision float math (Vector register
        // group). Branch/call targets are absolute (the profile's 0x10000 codeBase);
        // they were resolved + run-verified in Unicorn, so re-assembling in place
        // reproduces the same layout. Restore the plain examples below when done.
        name: "Feature tour: loops, calls, stack, XMM",
        mode: "64",
        code: [
            "; === ASMX feature tour (x86-64) ===",
            "; Nested loops, call/ret, an indirect 'callback', the stack, memory",
            "; load/store, a string loop, and XMM double-precision float math.",
            '; --- 1) String loop: lower-case "WORLD" -> "world" in the data region ---',
            "mov rdi, 0x20000",
            "mov rax, 0x444c524f57",
            "mov [rdi], rax",
            "mov rsi, rdi",
            "mov rcx, 5",
            "mov al, [rsi]",
            "or al, 0x20",
            "mov [rsi], al",
            "inc rsi",
            "dec rcx",
            "jnz 0x1001e",
            "; --- 2) Nested loops: sum (i*4 + j) for i,j in 0..3 -> r8 ---",
            "xor r8, r8",
            "xor r9, r9",
            "xor r10, r10",
            "mov rax, r9",
            "shl rax, 2",
            "add rax, r10",
            "add r8, rax",
            "inc r10",
            "cmp r10, 4",
            "jl 0x10035",
            "inc r9",
            "cmp r9, 4",
            "jl 0x10032",
            "mov [0x20010], r8",
            "; --- 3) Stack + call/ret: square the sum via a subroutine ---",
            "push r8",
            "mov rdi, r8",
            "call 0x100d3",
            "mov [0x20018], rax",
            "pop r9",
            "; --- 4) Callback: invoke the subroutine through a register ---",
            "mov rax, 0x100d3",
            "mov rdi, 7",
            "call rax",
            "mov [0x20020], rax",
            "; --- 5) XMM floats: (2.5 + 1.5) * 3.0 + acc, stored as a double ---",
            "mov rax, 0x4004000000000000",
            "movq xmm0, rax",
            "mov rax, 0x3ff8000000000000",
            "movq xmm1, rax",
            "addsd xmm0, xmm1",
            "mov rax, 0x4008000000000000",
            "movq xmm2, rax",
            "mulsd xmm0, xmm2",
            "cvtsi2sd xmm3, r9",
            "addsd xmm0, xmm3",
            "movq [0x20028], xmm0",
            "jmp 0x100db",
            "; --- SQUARE(rdi): rax = rdi * rdi ---",
            "mov rax, rdi",
            "imul rax, rdi",
            "ret",
        ].join("\n"),
    },
    // Original default; restore when the feature-tour example above is removed.
    // {
    //     // A loop that reads/writes the data region (0x20000) and upper-cases a
    //     // string in place. `loop 0x1001e` jumps to the four-instruction body.
    //     name: "String upper-case (loop)",
    //     mode: "64",
    //     code: [
    //         '; Write "hello" into the data region, then upper-case it in a loop.',
    //         "mov rsi, 0x20000",
    //         "mov rax, 0x6f6c6c6568",
    //         "mov [rsi], rax",
    //         "mov rcx, 5",
    //         "mov rdi, rsi",
    //         "mov al, [rdi]",
    //         "sub al, 0x20",
    //         "mov [rdi], al",
    //         "inc rdi",
    //         "loop 0x1001e",
    //     ].join("\n"),
    // },
    {
        name: "64-bit arithmetic",
        mode: "64",
        code: [
            "mov rax, 0x1122334455667788",
            "mov rbx, 0xff",
            "and rax, rbx",
            "add rax, 0x10",
            "mov rcx, rax",
        ].join("\n"),
    },
    {
        name: "Counting loop",
        mode: "32",
        code: [
            "mov eax, 0",
            "mov edx, 1",
            "mov ecx, 30",
            "xadd eax, edx",
            "loop 0x1000f",
        ].join("\n"),
    },
    {
        name: "Bit tricks",
        mode: "64",
        code: [
            "mov rax, 0xdeadbeef",
            "not rax",
            "shl rax, 4",
            "popcnt rcx, rax",
            "bswap eax",
        ].join("\n"),
    },
];
