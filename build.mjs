/*
 * esbuild bundle for the playground. Two ES-module entry points:
 *   - app.js            -> build/app.js  (+ build/app.css from imported CSS)
 *   - worker/engine-worker.js -> build/engine-worker.js
 * Keystone/Capstone come from npm; their separate .wasm files are emitted as
 * assets (file loader) and pointed at via Module.locateFile. The all-arch
 * Unicorn build (single-file, wasm embedded) is split into one lazy chunk by
 * the worker's dynamic import().
 *
 *   node build.mjs          # production build into build/
 *   node build.mjs --dev    # watch + serve on :8000
 */
import * as esbuild from "esbuild";

const dev = process.argv.includes("--dev");
const withTests = process.argv.includes("--with-tests");
const elfTest = process.argv.includes("--elf-test");
const noMinify = process.argv.includes("--no-minify");

// A test build uses a SINGLE app-side entry (no `app`) so Keystone stays inlined
// in that entry: same locateFile/worker-URL resolution as prod, no chunk
// hoisting. Build one harness at a time to keep each isolated.
const entryPoints = elfTest
    ? { "test-elf": "tests/build_elf.js", "engine-worker": "src/worker/engine-worker.js" }
    : withTests
    ? { "test-engine": "tests/build_engine.js", "engine-worker": "src/worker/engine-worker.js" }
    : { app: "src/app.js", "engine-worker": "src/worker/engine-worker.js" };

/** @type {import('esbuild').BuildOptions} */
const opts = {
    entryPoints,
    outdir: "build",
    bundle: true,
    format: "esm",
    platform: "browser",
    // Emscripten builds carry a dead Node branch that require()s node builtins;
    // it never runs in the browser, so leave those specifiers external.
    external: ["node:*"],
    splitting: true, // lazy unicorn chunk + shared code
    target: ["es2022"], // BigInt, top-level await, optional chaining
    // .svg -> text: icon files (externals/{vscode-codicons,feather}/ + src/ui/icons/) are
    // inlined into the bundle at build time (no per-icon HTTP request; the source keeps
    // them as separate assets).
    loader: { ".wasm": "file", ".css": "css", ".svg": "text" },
    assetNames: "[name]-[hash]", // keystone-XXXX.wasm, capstone-XXXX.wasm
    entryNames: "[name]", // no hash -> new URL("./engine-worker.js", ...) resolves
    chunkNames: "chunks/[name]-[hash]",
    minify: !dev && !noMinify,
    sourcemap: dev,
    logLevel: "info",
    // Per-build id, appended as a ?v= query to the worker URL so a rebuilt
    // engine-worker.js is never served from a stale HTTP/Worker cache (the worker
    // is fetched by name, so without this a cached copy survives a rebuild:
    // exactly how an old, pre-fix engine keeps running after the source is fixed).
    define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
};

if (dev) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    const { host, port } = await ctx.serve({ servedir: ".", port: 8000 });
    console.log(`dev -> http://${host === "0.0.0.0" ? "localhost" : host}:${port}/`);
} else {
    await esbuild.build(opts);
    console.log("build -> build/");
}
