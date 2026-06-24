/*
 * Pragmatic asm syntax highlighter. Arch-agnostic: no register table required.
 * Colors the mnemonic, immediates, an optional leading label, a trailing
 * comment, punctuation, and treats remaining bare words as registers (the
 * common case in operands). Returns HTML with escaped text.
 *
 * `highlightAsmParts` returns the pieces separately (label / mnemonic / operands
 * / comment) so the Disassembly view can lay the mnemonic and operands out as
 * two resizable columns.
 */
import { escapeHtml } from "../core/bigint.js";

// One identifier/word: a mnemonic, register, or label name (letter/_/./$ led).
const WORD = "[A-Za-z_.$][\\w.$]*";
// An immediate: optional `#` (ARM) and sign, then hex / binary / decimal-or-float.
// Kept in sync with TOKEN's number branch so a tokenized immediate also matches here.
const NUM = /^#?-?(?:0x[0-9a-fA-F]+|0b[01]+|\d+(?:\.\d+)?)$/;
// One operand token: a word, an immediate, or a single punctuation char.
// Whitespace is left untouched (so indentation/spacing round-trips).
const TOKEN = new RegExp(`(${WORD}|0x[0-9a-fA-F]+|#?-?\\d[\\w.]*|[^\\sA-Za-z0-9_])`, "g");
const LABEL_RE = new RegExp(`^(\\s*${WORD}:)`);
const MNEM_RE = new RegExp(`^(\\s*)(${WORD})([\\s\\S]*)$`);

/**
 * Split `text` into highlighted HTML pieces:
 *   { label, mnem, ops, comment }  (each a possibly-empty HTML string)
 * The mnemonic is the first bare word; everything after it is operands. Bare
 * words in the operands are highlighted as registers, the common case.
 */
export function highlightAsmParts(text) {
    let code = text;

    // Split off a trailing ';' comment (we only treat ';' as a comment char).
    let comment = "";
    const ci = code.indexOf(";");
    if (ci >= 0) {
        comment = `<span class="t-comment">${escapeHtml(code.slice(ci))}</span>`;
        code = code.slice(0, ci);
    }

    // Leading label "name:"
    let label = "";
    const lm = code.match(LABEL_RE);
    if (lm) {
        label = `<span class="t-label">${escapeHtml(lm[1])}</span>`;
        code = code.slice(lm[1].length);
    }

    // Leading whitespace + first word (mnemonic) + the remainder (operands).
    let mnem = "";
    let ops = "";
    const mm = code.match(MNEM_RE);
    if (mm) {
        mnem = escapeHtml(mm[1]) + `<span class="t-mnem">${escapeHtml(mm[2])}</span>`;
        ops = highlightOperands(mm[3]);
    } else {
        // No leading word (blank line, or operands-only oddity): treat it all
        // as operands so nothing is dropped.
        ops = highlightOperands(code);
    }

    return { label, mnem, ops, comment };
}

/** Highlight an operand string (registers / immediates / punctuation). */
function highlightOperands(code) {
    return code.replace(TOKEN, (tok) => {
        if (/^[A-Za-z_.$]/.test(tok)) return `<span class="t-reg">${escapeHtml(tok)}</span>`;
        if (NUM.test(tok)) return `<span class="t-imm">${escapeHtml(tok)}</span>`;
        if (/^[,[\]{}()+\-*:!@#$]/.test(tok)) return `<span class="t-punct">${escapeHtml(tok)}</span>`;
        return escapeHtml(tok);
    });
}
