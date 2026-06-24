/*
 * Icon registry. Every glyph is a standalone SVG file: VS Code Codicons
 * (externals/vscode-codicons, CC-BY-4.0), Feather glyphs (externals/feather,
 * MIT), and a few first-party markers (./icons), inlined as text at build time
 * (the `.svg: "text"` loader in build.mjs). Each file is stored verbatim from its
 * source (Feather's only edit is width/height -> 16); icon() keeps every glyph on
 * its own native viewBox and paint model (Codicons/markers: 16-grid fill;
 * Feather: 24-grid stroke) and only re-tags class, size and a11y. To add one:
 * drop its SVG in the matching folder and register it in PATHS below.
 */
import debugStart from "../../externals/vscode-codicons/debug-start.svg";
import debugPause from "../../externals/vscode-codicons/debug-pause.svg";
import debugStepInto from "../../externals/vscode-codicons/debug-step-into.svg";
import debugStepOver from "../../externals/vscode-codicons/debug-step-over.svg";
import debugStepOut from "../../externals/vscode-codicons/debug-step-out.svg";
import debugRestart from "../../externals/vscode-codicons/debug-restart.svg";
import pin from "../../externals/vscode-codicons/pin.svg";
import pinned from "../../externals/vscode-codicons/pinned.svg";
import closeIcon from "../../externals/vscode-codicons/close.svg";
import info from "../../externals/vscode-codicons/info.svg";
import check from "../../externals/vscode-codicons/check.svg";
import chevronUp from "../../externals/vscode-codicons/chevron-up.svg";
import chevronDown from "../../externals/vscode-codicons/chevron-down.svg";
import circleLarge from "../../externals/vscode-codicons/circle-large.svg";
import playCircle from "../../externals/vscode-codicons/play-circle.svg";
import splitHorizontal from "../../externals/vscode-codicons/split-horizontal.svg";
import gear from "../../externals/vscode-codicons/gear.svg";
import add from "../../externals/feather/plus.svg";
import book from "../../externals/feather/book.svg";
import filePlus from "../../externals/feather/file-plus.svg";
import layout from "../../externals/feather/layout.svg";
import trash from "../../externals/feather/trash-2.svg";
import copy from "../../externals/feather/copy.svg";
import filter from "../../externals/feather/filter.svg";
import folder from "../../externals/feather/folder.svg";
import download from "../../externals/feather/download.svg";
import share from "../../externals/feather/share-2.svg";
import sun from "../../externals/feather/sun.svg";
import moon from "../../externals/feather/moon.svg";
import logo from "./icons/logo.svg";
import breakpoint from "./icons/breakpoint.svg";
import breakpointConditional from "./icons/breakpoint-conditional.svg";
import ip from "./icons/ip.svg";
import sp from "./icons/sp.svg";
import pointer from "./icons/pointer.svg";

// Each entry is the icon's raw SVG text, imported verbatim; icon() re-tags it.
const PATHS = {
    "debug-start": debugStart,
    "debug-pause": debugPause,
    "debug-step-into": debugStepInto,
    "debug-step-over": debugStepOver,
    "debug-step-out": debugStepOut,
    "debug-restart": debugRestart,
    "pin": pin,
    "pinned": pinned,
    "add": add,
    "book": book,
    "file-plus": filePlus,
    "layout": layout,
    "close": closeIcon,
    "info": info,
    "trash": trash,
    "folder": folder,
    "download": download,
    "share": share,
    "sun": sun,
    "moon": moon,
    "copy": copy,
    "check": check,
    "chevron-up": chevronUp,
    "chevron-down": chevronDown,
    "circle-large": circleLarge,
    "play-circle": playCircle,
    "split-horizontal": splitHorizontal,
    "gear": gear,
    "filter": filter,
    "logo": logo,
    "breakpoint": breakpoint,
    "breakpoint-conditional": breakpointConditional,
    "ip": ip,
    "sp": sp,
    "pointer": pointer,
};

/**
 * SVG markup for a named icon, ready to drop into innerHTML. Every icon shares
 * the `.ico` class; contextual colour/flip (e.g. red breakpoints, the flipped SP
 * pointer) lives in CSS, keyed off the container; see app.css. The glyph's own
 * viewBox and paint (fill vs stroke) are kept verbatim; only class, size and the
 * a11y hook are injected, with the source width/height overridden by `size`.
 * @param {string} name  key in PATHS
 * @param {{size?: number}} [opts]
 * @returns {string} an `<svg>` string, or "" if the name is unknown
 */
export function icon(name, { size = 16 } = {}) {
    const svg = PATHS[name];
    if (!svg) return "";
    // trim(): a trailing newline in the .svg file would become a text node in the
    // caller's HTML, a literal line break under white-space:pre (the hex rows).
    return svg.trim().replace(/^<svg\b([^>]*)>/i, (_match, attrs) => {
        const kept = attrs
            .replace(/\s+width="[^"]*"/i, "")
            .replace(/\s+height="[^"]*"/i, "")
            .replace(/\s+xmlns="[^"]*"/i, "");
        return `<svg class="ico" width="${size}" height="${size}" aria-hidden="true"${kept}>`;
    });
}

/**
 * Replace every `<i data-icon="name">` placeholder under `root` with its SVG, so
 * the static HTML stays declarative while the artwork lives only here.
 */
export function applyIcons(root = document) {
    for (const el of root.querySelectorAll("[data-icon]")) {
        el.outerHTML = icon(el.dataset.icon);
    }
}
