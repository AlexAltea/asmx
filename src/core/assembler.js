/*
 * Keystone assembler wrapper (main thread). The app instantiates the bundled
 * MKeystone() factory and passes the resolved module in. `configure()` builds a
 * Keystone instance for the current arch/mode; `asm()` returns {bytes}|{error}
 * so the document model can keep its failing-line policy.
 */
import { errMsg } from "./bigint.js";

export class Assembler {
    constructor(ksModule) {
        this.ks = ksModule;
        this.inst = null;
    }

    configure({ ksArch, ksMode, ksSyntax }) {
        if (this.inst && this.inst.close) this.inst.close();
        // ksArch / ksMode are full constant names (e.g. "ARCH_X86", "MODE_64").
        const arch = this.ks[ksArch];
        let mode = 0;
        for (const m of ksMode) mode |= this.ks[m] || 0;
        this.inst = new this.ks.Keystone(arch, mode);
        // Syntax is profile-chosen (x86: Intel). Keystone rejects syntax options
        // on arches with a single syntax (ARM/AArch64), so only set it when asked.
        if (ksSyntax) this.inst.option(this.ks.OPT_SYNTAX, this.ks[ksSyntax]);
    }

    /**
     * Assemble one line. `address` is the origin Keystone resolves relative
     * branches against (loop/jcc/call), so absolute operands like `loop 0x1001e`
     * encode correctly. Position-independent instructions ignore it. Defaults to
     * 0 for callers that don't track addresses.
     */
    asm(text, address = 0n) {
        let r;
        try {
            r = this.inst.asm(text, address);
        } catch (e) {
            return { error: errMsg(e) };
        }
        const mc = r && r.mc;
        if (!mc || mc.length === 0) return { error: this._err() };
        return { bytes: Array.from(mc) };
    }

    _err() {
        try {
            const no = this.inst.errno ? this.inst.errno() : 0;
            if (this.ks.strerror && no) return this.ks.strerror(no);
        } catch {}
        return "invalid instruction";
    }
}
