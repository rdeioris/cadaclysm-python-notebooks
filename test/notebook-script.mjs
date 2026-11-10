// The copy-as-script rule, the one the page's button uses: `# %%` between cells, the import
// line added when no cell has one, a `show()` stub when a cell calls it, empty cells
// skipped, a trailing newline. Every example notebook's script is then run by the desktop
// Python when the DLL is built (a Python on PATH and target/release/cadaclysm_blacksmith.dll
// -- skipped otherwise), which is the "runs unchanged next to the library" promise.
//
// Run: node test/notebook-script.mjs
import assert from "node:assert";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { EXAMPLES, STARTER, scriptOf } from "../notebook-script.js";

assert.strictEqual(scriptOf(["from cadaclysm_blacksmith import Solid", "Solid.cuboid(1, 2, 3)"]),
    "from cadaclysm_blacksmith import Solid\n\n# %%\nSolid.cuboid(1, 2, 3)\n");
assert.strictEqual(scriptOf(["Solid.cuboid(1, 2, 3)"]),
    "from cadaclysm_blacksmith import *\n\nSolid.cuboid(1, 2, 3)\n", "the import line when no cell has one");
assert.strictEqual(scriptOf(["import cadaclysm_blacksmith as bs", "", "  ", "bs.Solid.cuboid(1, 2, 3)  \n"]),
    "import cadaclysm_blacksmith as bs\n\n# %%\nbs.Solid.cuboid(1, 2, 3)\n", "empty cells skipped, trailing space trimmed");
assert.strictEqual(scriptOf(["a = Solid.cuboid(1, 2, 3)", "show(a)"]),
    "from cadaclysm_blacksmith import *\n\ndef show(*solids, part=None):\n    pass   # the notebook draws these; a script has no view\n\na = Solid.cuboid(1, 2, 3)\n\n# %%\nshow(a)\n",
    "a show() call gets the stub, after the import");
assert.ok(!scriptOf(["showcase = 1"]).includes("def show"), "`showcase` is not a call to show()");
assert.ok(scriptOf(["from cadaclysm_blacksmith import Solid\nshow (Solid.cuboid(1, 1, 1))"]).startsWith("def show(*solids, part=None):"),
    "the stub comes first when the cells bring their own import");

// Every example stands alone: an import line of its own, distinct ids and titles, no empty cell.
assert.strictEqual(STARTER, EXAMPLES[0].cells);
for (const e of EXAMPLES) {
    assert.match(e.cells[0], /^(import math\n)?from cadaclysm_blacksmith import /, `${e.id} imports what it uses first`);
    assert.ok(e.cells.every((c) => c.trim()), `${e.id}: no empty cell`);
}
assert.strictEqual(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length);
assert.strictEqual(new Set(EXAMPLES.map((e) => e.title)).size, EXAMPLES.length);

// Every example notebook, as the button copies it, against the SDK's desktop library: the
// same cadaclysm_blacksmith.py (sdk/, from npm run setup) over the native library that
// CADACLYSM_BLACKSMITH_LIBRARY names. Skipped without one.
const here = dirname(fileURLToPath(import.meta.url));
const dll = process.env.CADACLYSM_BLACKSMITH_LIBRARY;
const python = spawnSync("python", ["--version"]);
if (!dll || !existsSync(dll) || python.status !== 0 || !existsSync(join(here, "..", "sdk", "cadaclysm_blacksmith.py"))) {
    console.log(`notebook-script: ok (the desktop run skipped: ${!dll || !existsSync(dll) ? "no CADACLYSM_BLACKSMITH_LIBRARY" : python.status !== 0 ? "no python on PATH" : "no sdk/"})`);
} else {
    const dir = mkdtempSync(join(tmpdir(), "notebook-script-"));
    for (const e of EXAMPLES) {
        const file = join(dir, `${e.id}.py`);
        writeFileSync(file, scriptOf(e.cells));
        const run = spawnSync("python", [file], {
            encoding: "utf8",
            env: { ...process.env, PYTHONPATH: join(here, "..", "sdk"), CADACLYSM_BLACKSMITH_LIBRARY: dll },
        });
        assert.strictEqual(run.status, 0, `the ${e.id} script failed on the desktop:\n${run.stderr}`);
        if (e === EXAMPLES[0]) assert.match(run.stdout, /^faces: 6 bounds: \(\(-60\.0, -40\.0, 0\.0\), \(60\.0, 40\.0, 14\.0\)\)\r?\nISO-10303-21;/);
    }
    console.log(`notebook-script: ok (${EXAMPLES.length} examples ran on the desktop)`);
}
