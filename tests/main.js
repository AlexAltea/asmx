// Node test-suite runner (invoked by `npm test`). Every tests/test_*.mjs runs in
// its own `node` process; the run stops at the first failure (non-zero exit).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const loader = pathToFileURL(join(here, "svg_loader.mjs")).href;

// Extra node args per file: test_layout needs the .svg import resolve stub.
const extraArgs = { "test_layout.mjs": [`--experimental-loader=${loader}`] };

for (const file of readdirSync(here).filter((f) => /^test_.*\.mjs$/.test(f)).sort()) {
    const res = spawnSync("node", [...(extraArgs[file] || []), join(here, file)], { stdio: "inherit" });
    if (res.status !== 0) process.exit(res.status ?? 1);
}
