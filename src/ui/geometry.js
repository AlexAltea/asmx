/*
 * Shared pixel geometry for the windowed listings. JS row math and the CSS
 * layout must agree, so each constant here mirrors a CSS length (noted alongside);
 * change one and you change its twin. Centralized so the disassembly listing
 * and its arrow gutter, and the two hex views, each read from one source.
 */
export const DISASM_ROW_H = 22; // --lh-row     (.ed-row / arrow gutter)
export const HEX_ROW_H = 18; //    --lh-hex-row (.hex-row in Memory / Stack)
export const MONO_CH = 7.2; //     1ch of --font-mono at --fs-2 (default column widths)
