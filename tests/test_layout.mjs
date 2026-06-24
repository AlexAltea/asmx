// Layout engine tree-algebra tests (DOM-free): the split / tab-group / reorder
// / close / sanitize mutations that back drag-and-drop and persistence.
// Run with the svg loader: node --experimental-loader=./tests/svg_loader.mjs tests/test_layout.mjs
import { Layout } from "../src/ui/layout.js";

let pass = 0,
    fail = 0;
function eq(got, want, msg) {
    if (got === want) pass++;
    else {
        fail++;
        console.error(`FAIL: ${msg}\n   got:  ${got}\n   want: ${want}`);
    }
}

// Compact structural view (ignores sizes): row=r(...) col=c(...) stack=[ids@active].
function shape(n) {
    if (!n) return "0";
    if (n.type === "stack") return "[" + n.panels.join(",") + (n.panels.length > 1 ? "@" + n.active : "") + "]";
    return n.type[0] + "(" + n.children.map(shape).join(" ") + ")";
}
const stack = (...panels) => ({ type: "stack", size: 1, panels, active: 0 });
const row = (...c) => ({ type: "row", size: 1, children: c });
const col = (...c) => ({ type: "col", size: 1, children: c });

function L(tree) {
    const l = new Layout({});
    ["editor", "registers", "inspector", "console", "memory", "stack", "maps"].forEach((id) =>
        l.panels.set(id, { title: id, el: null })
    );
    l.tree = tree;
    return l;
}

// find a stack node containing a given panel id
function findStack(n, id) {
    if (!n) return null;
    if (n.type === "stack") return n.panels.includes(id) ? n : null;
    for (const c of n.children) {
        const f = findStack(c, id);
        if (f) return f;
    }
    return null;
}

// ---- tab-group (centre drop): merges into target stack, source collapses ----
{
    const l = L(row(stack("editor"), stack("registers")));
    l._moveTo(findStack(l.tree, "registers"), "registers", {
        node: findStack(l.tree, "editor"),
        zone: "center",
        index: null,
    });
    eq(shape(l.tree), "[editor,registers@1]", "centre drop merges + collapses the emptied row");
}

// ---- split right when parent already a row: insert as sibling (no nesting) ----
{
    const l = L(row(stack("editor"), stack("registers"), stack("inspector")));
    l._moveTo(findStack(l.tree, "inspector"), "inspector", {
        node: findStack(l.tree, "editor"),
        zone: "right",
        index: null,
    });
    eq(shape(l.tree), "r([editor] [inspector] [registers])", "split-right reuses the row (sibling insert)");
}

// ---- split bottom when parent is a row: wrap target in a new column ----------
{
    const l = L(row(stack("editor"), stack("registers"), stack("inspector")));
    l._moveTo(findStack(l.tree, "inspector"), "inspector", {
        node: findStack(l.tree, "editor"),
        zone: "bottom",
        index: null,
    });
    eq(shape(l.tree), "r(c([editor] [inspector]) [registers])", "split-bottom wraps target in a column");
}

// ---- split-left wrap on a single root stack (insert before) -----------------
{
    const l = L(stack("editor", "registers")); // two tabs, root stack
    l._moveTo(l.tree, "registers", { node: l.tree, zone: "left", index: null });
    eq(shape(l.tree), "r([registers] [editor])", "split-left of own stack inserts before");
}

// ---- splitting a lone-panel stack with itself is a no-op --------------------
{
    const l = L(stack("editor"));
    l._moveTo(l.tree, "editor", { node: l.tree, zone: "right", index: null });
    eq(shape(l.tree), "[editor]", "lone panel cannot split against itself");
}

// ---- reorder within a stack (centre drop, explicit index) ------------------
{
    const l = L(stack("editor", "registers", "inspector"));
    l._moveTo(l.tree, "editor", { node: l.tree, zone: "center", index: 3 });
    eq(shape(l.tree), "[registers,inspector,editor@2]", "reorder moves tab to the end, keeps it active");
}

// ---- close: remove panel, collapse single-child parents --------------------
{
    const l = L(row(stack("editor"), stack("registers")));
    l._removeFromStack(findStack(l.tree, "registers"), "registers");
    eq(shape(l.tree), "[editor]", "closing one of two stacks collapses the row");
}
{
    const l = L(stack("editor"));
    l._removeFromStack(l.tree, "editor");
    eq(shape(l.tree), "0", "closing the last panel empties the tree");
}
{
    const l = L(stack("editor", "registers"));
    l._removeFromStack(l.tree, "editor"); // active was 0
    eq(shape(l.tree), "[registers]", "closing a tab keeps the remaining sibling tab");
}

// ---- deep collapse: removing one leaf bubbles the collapse up ---------------
{
    const l = L(col(row(stack("editor"), stack("registers")), stack("console")));
    l._removeFromStack(findStack(l.tree, "registers"), "registers");
    eq(shape(l.tree), "c([editor] [console])", "row collapses to its sole child inside the column");
}

// ---- sanitize: drop unknown ids, prune/collapse, clamp active --------------
{
    const l = L(null);
    const restored = l._sanitize(row(stack("editor", "BOGUS"), stack("UNKNOWN")));
    eq(shape(restored), "[editor]", "sanitize prunes unknown ids and collapses to the survivor");
}
{
    const l = L(null);
    const restored = l._sanitize({ type: "stack", size: 1, panels: ["editor", "registers"], active: 9 });
    eq(restored.active, 0, "sanitize clamps an out-of-range active index");
}
{
    const l = L(null);
    eq(l._sanitize({ type: "row", size: 1, children: [] }), null, "sanitize of an all-empty subtree is null");
}

// ---- _inTree / _parentOf ----------------------------------------------------
{
    const l = L(row(stack("editor"), col(stack("registers"), stack("inspector"))));
    eq(l._inTree("inspector"), true, "_inTree finds a deeply nested panel");
    eq(l._inTree("memory"), false, "_inTree reports absent panels");
    const inspStack = findStack(l.tree, "inspector");
    eq(l._parentOf(inspStack).type, "col", "_parentOf returns the immediate container");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
