/*
 * Capstone disassembler wrapper (main thread). Capstone is a hard dependency:
 * a load or configure failure throws (fatal), never degrades.
 *
 * classify() works off the profile's branchInfo patterns matched against the
 * disassembled text, NOT Capstone's instruction groups: capstone-js 5.0.9
 * parses cs_detail with Capstone-v4 struct offsets against a v5 wasm, so
 * detail.groups is always empty (for every arch). Text patterns also cover
 * what groups can't express anyway, like ARM's operand-dependent returns
 * (`bx lr`, `pop {..., pc}`).
 */
import { asU8 } from "./bigint.js";

export class Disassembler {
    constructor(csModule) {
        this.cs = csModule;
        this.inst = null;
        this.branchInfo = null;
    }

    configure({ csArch, csMode, branchInfo }) {
        this.branchInfo = branchInfo; // mandatory: classify() matches its patterns
        if (this.inst && this.inst.close) this.inst.close();
        // csArch / csMode are full constant names (e.g. "ARCH_X86", "MODE_64").
        const arch = this.cs[csArch];
        let mode = 0;
        for (const m of csMode) mode |= this.cs[m] || 0;
        this.inst = new this.cs.Capstone(arch, mode);
    }

    /** Returns [{address, size, mnemonic, op_str, bytes}] or [] on undecodable bytes. */
    disasm(bytes, addr) {
        try {
            const buf = asU8(bytes);
            return this.inst.disasm(buf, Number(addr)) || [];
        } catch (e) {
            return [];
        }
    }

    /** Disassemble a single instruction's bytes; returns one insn or null. */
    one(bytes, addr) {
        const r = this.disasm(bytes, addr);
        return r.length ? r[0] : null;
    }

    /** Disassemble an image and classify() each instruction. */
    analyze(bytes, base) {
        return this.disasm(bytes, base).map((insn) => this.classify(insn));
    }

    classify(insn) {
        const mn = (insn.mnemonic || "").toLowerCase();
        const text = mn + (insn.op_str ? " " + insn.op_str.toLowerCase() : "");
        const b = this.branchInfo;
        // Precedence mirrors the old group semantics: a return is neither a call
        // nor a jump (x86 `ret`, ARM `bx lr`), a call is not a jump.
        const isRet = b.ret.test(text);
        const isCall = !isRet && b.call.test(text);
        const isJump = !isRet && !isCall && b.jump.test(text);
        const isCond = isJump && !b.uncond.test(text);

        let target = null;
        if (isJump || isCall) {
            target = this._target(insn);
        }
        return {
            address: BigInt(insn.address),
            size: insn.size,
            mnemonic: mn,
            op_str: insn.op_str || "",
            isCall,
            isRet,
            isJump,
            isCond,
            target,
        };
    }

    _target(insn) {
        // Capstone resolves direct branches to an absolute address printed as the
        // final operand ("0x10015", "#0x1000c", "x0, #0x3e, #0xfffc"); parse that.
        // Indirect targets ("rax", "[rip + 0x200]", "lr") don't match: null.
        const m = (insn.op_str || "").match(/#?(0x[0-9a-fA-F]+)$/);
        return m ? BigInt(m[1]) : null;
    }
}

/** Join a decoded instruction into display text: "mnemonic op_str". */
export function formatInsn(insn) {
    return insn.mnemonic + (insn.op_str ? " " + insn.op_str : "");
}
