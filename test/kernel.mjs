// The notebook kernel under Node: a cell that prints and ends in a solid yields stdout and a
// mesh; a cell that raises yields a traceback without the runner's frames; show() collects;
// the timings name the long calls; state persists between cells.
//
// Run: node test/kernel.mjs   (after npm install and npm run setup)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert";
import { loadPyodide } from "pyodide";
import { createKernel, cleanTraceback, scanPython, exprBefore } from "../kernel.js";
import { EXAMPLES, STARTER } from "../notebook-script.js";
import { loadWasm } from "./package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = join(here, "..", "sdk");
// A plain object over the module's exports, not the read-only module namespace: the trap
// test below swaps one export on it.
const wasm = { ...(await loadWasm()) };

// The worker imports browser-only modules, so it runs nowhere but the page; it parses, at least.
execFileSync(process.execPath, ["--check", join(here, "..", "notebook-worker.js")], { stdio: "inherit" });

assert.strictEqual(cleanTraceback(`Traceback (most recent call last):
  File "/lib/python314.zip/_pyodide/_base.py", line 597, in eval_code
    .run(globals, locals)
  File "<cell 3>", line 2, in <module>
  File "/work/cadaclysm_blacksmith.py", line 622, in join
    return x
cadaclysm_blacksmith.BuildError: join: nope`), `Traceback (most recent call last):
  File "<cell 3>", line 2, in <module>
  File "/work/cadaclysm_blacksmith.py", line 622, in join
    return x
cadaclysm_blacksmith.BuildError: join: nope`);

const stages = [], progress = [];
const kernel = await createKernel({
    loadPyodide,
    indexURL: join(here, "..", "pyodide"),
    wasm,
    moduleSource: readFileSync(join(sdk, "cadaclysm_blacksmith.py"), "utf8"),
    supportSource: readFileSync(join(here, "..", "notebook_support.py"), "utf8"),
    schemaUrl: null,
    onProgress: (phase, done, total) => progress.push(phase),
    onBoot: (stage) => stages.push(stage),
});
kernel.pyodide.FS.mkdirTree("/schemas");
kernel.pyodide.FS.writeFile("/schemas/ap203.exp", readFileSync(join(sdk, "schemas", "ap203.exp"), "utf8"));
assert.deepStrictEqual(stages, ["pyodide", "numpy", "module", "ready"]);
assert.match(kernel.versions.python, /^3\.\d+/);
assert.match(kernel.versions.blacksmith, /^\d+\.\d+/);

let r = await kernel.run(`from cadaclysm_blacksmith import Profile, Solid, Workplane
plate = Workplane.xy().extrude(Profile.rect(120, 80), 14).solid()
print("faces:", plate.faces)
plate`, 1);
assert.strictEqual(r.error, null);
assert.strictEqual(r.stdout, "faces: 6\n");
assert.strictEqual(r.solids.length, 1);
assert.strictEqual(r.solids[0].faces, 6);
assert.strictEqual(r.solids[0].indices.length, 36);
assert.ok(r.solids[0].vertices instanceof Float32Array);
assert.strictEqual(r.solids[0].edges.length % 6, 0);
assert.ok(r.solids[0].edges.length > 0);
// Whether it is closed, read off its topology: a cube is.
assert.deepStrictEqual(r.solids[0].closure, { closed: true, manifold: true, boundaryEdges: 0, nonManifoldEdges: 0, nonManifoldVertices: 0 });
assert.strictEqual(r.solids[0].flaws, null, "a closed solid is not asked where it is open");

r = await kernel.run(`a = Solid.cuboid(10, 10, 10)`, 2);
assert.strictEqual(r.solids.length, 0, "an assignment shows nothing");

r = await kernel.run(`b = plate.join(a)
show(b, plate.translate(150, 0, 0))
b.faces`, 3);
assert.strictEqual(r.error, null);
assert.strictEqual(r.solids.length, 2, "show() twice, and an int last expression adds nothing");
assert.ok(progress.length > 0, "the join reported progress");
assert.ok(r.timings.some(([what]) => what === "join"), JSON.stringify(r.timings));

// A list or tuple of solids is drawn as show(*value) would; a mixed or empty one, or a
// generator, draws nothing.
r = await kernel.run(`[plate, a]`, 13);
assert.strictEqual(r.error, null, r.error);
assert.deepStrictEqual(r.solids.map((s) => s.faces), [6, 6], "[plate, boss] -> 2 solids");
r = await kernel.run(`show(plate)
(plate, a)`, 14);
assert.strictEqual(r.solids.length, 2, "a solid shown and listed is drawn once");
for (const [source, what] of [[`[plate, 1]`, "mixed"], [`[]`, "empty"], [`(s for s in [plate])`, "a generator"]]) {
    r = await kernel.run(source, 15);
    assert.strictEqual(r.error, null, r.error);
    assert.strictEqual(r.solids.length, 0, `${what} draws nothing`);
}

// A profile returned is drawn as its outline: its segments as drawn, on the XY plane, and
// no triangles -- a rectangle's four sides and the round hole's two arcs, each loop closed.
// `edges` are segment pairs (x0, y0, z0, x1, y1, z1).
const pairs = (e) => Array.from({ length: e.length / 6 }, (_, k) => Array.from(e.subarray(6 * k, 6 * k + 6)));
r = await kernel.run(`Profile.rect(40, 20).with_hole(Profile.circle(5))`, 30);
assert.strictEqual(r.error, null, r.error);
assert.strictEqual(r.solids.length, 1);
const [outline] = r.solids;
assert.strictEqual(outline.kind, "profile");
assert.strictEqual(outline.edgeCount, 6, "four sides and two arcs");
assert.strictEqual(outline.indices.length, 0, "no triangles");
assert.ok(outline.edges.every((v, k) => k % 3 !== 2 || v === 0), "on z = 0");
assert.deepStrictEqual(pairs(outline.edges).slice(0, 4), [[-20, -10, 0, 20, -10, 0], [20, -10, 0, 20, 10, 0], [20, 10, 0, -20, 10, 0], [-20, 10, 0, -20, -10, 0]], "the rectangle, closed");
assert.strictEqual(pairs(outline.edges).length, 4 + 2 * 64, "and the circle, two arcs of 64 steps");
// An open chain is drawn open: a single line is that line, an L its two sides and no
// third back to its start. A closed path gets its closing side.
r = await kernel.run(`Profile.path((0, 0)).line_to(10, 0).end_open()`, 33);
assert.strictEqual(r.error, null, r.error);
assert.deepStrictEqual(pairs(r.solids[0].edges), [[0, 0, 0, 10, 0, 0]]);
assert.strictEqual(r.solids[0].edgeCount, 1);
r = await kernel.run(`Profile.path((0, 0)).line_to(10, 0).line_to(10, 5).end_open()`, 34);
assert.deepStrictEqual(pairs(r.solids[0].edges), [[0, 0, 0, 10, 0, 0], [10, 0, 0, 10, 5, 0]], "an L, open");
r = await kernel.run(`Profile.path((0, 0)).line_to(10, 0).line_to(10, 5).line_to(0, 0).end()`, 35);
assert.strictEqual(pairs(r.solids[0].edges).length, 3, "a closed triangle");
// show() and lists take profiles beside solids.
r = await kernel.run(`show(plate, Profile.circle(3))`, 31);
assert.deepStrictEqual(r.solids.map((s) => s.kind), ["solid", "profile"]);
assert.strictEqual(r.solids[1].closure, null, "a profile's outline is neither closed nor open");
r = await kernel.run(`[Profile.circle(1), plate]`, 32);
assert.deepStrictEqual(r.solids.map((s) => s.kind), ["profile", "solid"]);
// An assembly returned is drawn as everything placed in it, at its placements: two cubes
// 50 apart, one inside a sub-assembly, read back as two parts spanning the gap.
r = await kernel.run(`from cadaclysm_blacksmith import Assembly
rig = Assembly("rig")
arm = Assembly("arm")
arm.place(Solid.cuboid(10, 10, 10), (50, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1), "far")
rig.place(Solid.cuboid(10, 10, 10), (0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1), "near")
rig.place(arm, (0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1))
rig`, 36);
assert.strictEqual(r.error, null, r.error);
assert.deepStrictEqual(r.solids.map((s) => s.kind), ["assembly"]);
assert.strictEqual(r.solids[0].parts, 2, "both cubes, the sub-assembly's too");
assert.strictEqual(r.solids[0].indices.length, 2 * 12 * 3, "twelve triangles a cube");
{
    const xs = r.solids[0].vertices.filter((_, k) => k % 3 === 0);
    assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 60) < 1e-3, `the cubes 50 apart: x spans ${Math.min(...xs)}..${Math.max(...xs)}`);
}
// ... beside a solid in show(), and in a list.
r = await kernel.run(`show(plate, rig)`, 37);
assert.deepStrictEqual(r.solids.map((s) => s.kind), ["solid", "assembly"]);
r = await kernel.run(`[rig, Profile.circle(1)]`, 38);
assert.deepStrictEqual(r.solids.map((s) => s.kind), ["assembly", "profile"]);
r = await kernel.run(`show(3)`, 39);
assert.match(r.error, /TypeError: show\(\) draws solids, profiles, assemblies and jobs, not int$/);
// A posed assembly draws where the pose puts it: a cube on a hinge about z through the
// origin, placed at x = 50, turned a quarter, spans y around 50 and x around 0.
r = await kernel.run(`hinge = Assembly("hinge")
hinge.place(Solid.cuboid(10, 10, 10), (0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1), "post")
hinge.place(Solid.cuboid(10, 10, 10), (50, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1), "flap")
hinge.link("post", ["post"])
hinge.link("flap", ["flap"])
hinge.joint("turn", "post", "flap")
hinge.pair("turn", "revolute", (0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1))
hinge.posed({"turn": 1.5707963267948966})`, 40);
assert.strictEqual(r.error, null, r.error);
assert.deepStrictEqual(r.solids.map((s) => [s.kind, s.parts]), [["assembly", 2]]);
{
    const v = r.solids[0].vertices;
    const ys = v.filter((_, k) => k % 3 === 1);
    assert.ok(Math.max(...ys) > 50 && Math.max(...ys) < 56, `the flap turned onto +y: y up to ${Math.max(...ys)}`);
}
// Four walls and no caps: a sheet, open along its two rims.
r = await kernel.run(`Solid.extrude_open(Profile.rect(4, 4), (0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1), 2)`, 35);
assert.strictEqual(r.error, null, r.error);
assert.deepStrictEqual(r.solids[0].closure, { closed: false, manifold: true, boundaryEdges: 8, nonManifoldEdges: 0, nonManifoldVertices: 0 });
// ... and where: its two rims, eight straight segments, and nothing pinched.
assert.strictEqual(r.solids[0].flaws.boundary.length, 8 * 6);
assert.strictEqual(r.solids[0].flaws.nonManifold.length + r.solids[0].flaws.pinched.length, 0);

// A solid's colours (the SDK's `coloured`) reach the mesh, with the face runs the scene
// colours by: the solid's own, and the faces drawn otherwise. A list carries its members'
// colours; a solid made from a coloured one inherits them, and an uncoloured one has none.
r = await kernel.run(`from cadaclysm_blacksmith import Axis, Selector
top = plate.select_face(Selector.max(Axis.Z))
print(top)
gold = plate.coloured("#cc9966").coloured((0.2, 0.4, 1), face=top)
[gold, a.coloured("#0f0")]`, 16);
assert.strictEqual(r.error, null, r.error);
const top = Number(r.stdout);
assert.deepStrictEqual(r.solids[0].colour, [0.8, 0.6, 0.4]);
assert.deepStrictEqual(r.solids[0].faceColours, [[top, [0.2, 0.4, 1]]]);
assert.deepStrictEqual(Array.from(r.solids[0].faceTriangles), [2, 2, 2, 2, 2, 2]);
assert.deepStrictEqual(r.solids[1].colour, [0, 1, 0]);
assert.deepStrictEqual(r.solids[1].faceColours, []);
r = await kernel.run(`gold.translate(0, 0, 1)`, 17);
assert.deepStrictEqual(r.solids[0].colour, [0.8, 0.6, 0.4], "a move keeps the colours");
assert.deepStrictEqual(r.solids[0].faceColours, [[top, [0.2, 0.4, 1]]]);
r = await kernel.run(`plate`, 18);
assert.strictEqual(r.solids[0].colour, null, "an uncoloured solid: the palette's");

r = await kernel.run(`Profile.rect(0, 1)`, 4);
assert.strictEqual(r.solids.length, 0);
assert.match(r.error, /^Traceback \(most recent call last\):\n  File "<cell 4>", line 1, in <module>\n/);
assert.match(r.error, /BuildError: profile_rect: width and height must be positive and finite$/);

r = await kernel.run(`text = plate.step_text()
print(len(text) > 1000)`, 5);
assert.strictEqual(r.error, null, r.error);
assert.strictEqual(r.stdout, "True\n");

// A partial line belongs to the cell that printed it, not the next.
r = await kernel.run(`print("partial", end="")`, 6);
assert.strictEqual(r.stdout, "partial");
r = await kernel.run(`print("second")`, 7);
assert.strictEqual(r.stdout, "second\n");

// stderr apart from stdout, and both in the order written: a warning between two prints
// stays between them; runs of one stream are one run.
r = await kernel.run(`import sys, warnings
print("one")
print("a", end=""); print("b")
warnings.warn("careful")
print("err", file=sys.stderr)
print("two")`, 19);
assert.strictEqual(r.error, null, r.error);
assert.strictEqual(r.stdout, "one\nab\ntwo\n");
assert.match(r.stderr, /UserWarning: careful\n[\s\S]*err\n$/);
assert.deepStrictEqual(r.streams.map(([n]) => n), ["stdout", "stderr", "stdout"]);
assert.strictEqual(r.streams[0][1], "one\nab\n");
assert.strictEqual(r.streams[1][1], r.stderr);
r = await kernel.run(`print("quiet")`, 20);
assert.deepStrictEqual(r.streams, [["stdout", "quiet\n"]], "nothing carries over");
assert.strictEqual(r.stderr, "");

// A cell that breaks sys.stdout and raises still resolves with its own error, and the
// next cell prints again (the kernel restores the streams before each run).
r = await kernel.run(`import sys; sys.stdout = None; raise ValueError("boom")`, 8);
assert.match(r.error, /ValueError: boom$/);
r = await kernel.run(`print("back")`, 9);
assert.strictEqual(r.error, null, r.error);
assert.strictEqual(r.stdout, "back\n");

// A wasm trap (a kernel panic under `panic = abort`) is no cell error: `run` rejects, so the
// worker posts `crashed` and the page re-makes it. The kernel holds `wasm` itself, so the
// export is swapped on that very object -- one the shim has not resolved yet, since it
// caches each export on first use.
const sphere = wasm.cadaclysm_blacksmith_sphere;
wasm.cadaclysm_blacksmith_sphere = () => { throw new WebAssembly.RuntimeError("unreachable"); };
try {
    await assert.rejects(kernel.run(`Solid.sphere(1)`, 10), (e) => {
        assert.ok(!(e instanceof kernel.pyodide.ffi.PythonError), "not a Python error");
        assert.strictEqual(e.message, "the wasm trapped: RuntimeError: unreachable");
        return true;
    });
} finally {
    wasm.cadaclysm_blacksmith_sphere = sphere;
    // The shim resolved the export once, in the trapping call: forget that (a real trap
    // takes the whole worker with it, so nothing survives to be forgotten).
    kernel.pyodide.runPython(`delattr(cadaclysm_blacksmith._library, "cadaclysm_blacksmith_sphere")`);
}
r = await kernel.run(`Solid.sphere(1).faces`, 11);
assert.strictEqual(r.error, null, r.error);
assert.strictEqual(r.stdout, "");
// A JS `Error` from an export is still the C ABI's refusal, a `BuildError` in the cell.
r = await kernel.run(`Solid.cuboid(-1, 1, 1)`, 12);
assert.match(r.error, /BuildError: cuboid: /);

// The page's starter notebook, cell by cell on a kernel that already has state, followed
// by the cells of the outlines and press-pull examples that build on its names (they were
// one notebook once; the numbers below are pinned per cell): the starter's numbers are
// the desktop library's for the same four cells -- the cut part
// has 11 faces and 20 edges, the bore 4 and 4, the fillet of its four corners takes the
// part to 15 faces and 32 edges. A fillet that found no corners would leave 11.
const byId = Object.fromEntries(EXAMPLES.map((e) => [e.id, e.cells]));
const SEQUENCE = [...STARTER, byId.outlines[0], byId["press-pull"][1], byId.outlines[1], byId["press-pull"][2], byId["press-pull"][3], byId["press-pull"][4]];
const starter = [];
for (const [i, source] of SEQUENCE.entries()) {
    starter.push(await kernel.run(source, 20 + i));
    assert.strictEqual(starter[i].error, null, `starter cell ${i + 1}: ${starter[i].error}`);
}
assert.strictEqual(starter[0].stdout, "faces: 6 bounds: ((-60.0, -40.0, 0.0), (60.0, 40.0, 14.0))\n");
assert.deepStrictEqual(starter[1].solids.map((s) => [s.faces, s.edgeCount]), [[9, 16]]);
assert.deepStrictEqual(starter[2].solids.map((s) => [s.faces, s.edgeCount]), [[11, 20], [4, 4]], "the cut part, then the bore beside it");
assert.deepStrictEqual(starter[3].solids.map((s) => [s.faces, s.edgeCount]), [[15, 32]], "four corners rounded: four more faces than the cut part");
assert.ok(starter[3].solids[0].faces > starter[2].solids[0].faces);
assert.ok(starter[3].timings.some(([what]) => what === "fillet"), JSON.stringify(starter[3].timings));
assert.match(starter[3].stdout, /^ISO-10303-21;\nHEADER;\n/);
// The chain cell: the arch's four pieces chained into one closed outline (its last point
// its first), then the tile it extrudes to -- two caps, three flat walls and the arc's
// cylinder.
assert.deepStrictEqual(starter[4].solids.map((s) => s.kind), ["profile", "solid"]);
const [arch, tile] = starter[4].solids;
assert.strictEqual(arch.edgeCount, 4, "a line, an arc, a line, a line");
assert.deepStrictEqual(Array.from(arch.edges.subarray(0, 2)), Array.from(arch.edges.subarray(arch.edges.length - 3, arch.edges.length - 1)), "closed: the last point is the first");
assert.strictEqual(tile.faces, 6);
// The face cell: the plate with a tab pushed out of its right side -- closed, and 15 faces:
// the plate's 15 less the side the tab grows from, the tab's end and two sides, its top and
// bottom merged into the plate's -- and the bore's and the boss's half walls each merged
// round into one wall.
assert.deepStrictEqual(starter[5].solids.map((s) => [s.faces, s.closure?.closed]), [[15, true]]);
assert.ok(starter[5].timings.some(([what]) => what === "push_pull"), JSON.stringify(starter[5].timings));
// The close_loop cell: the hook drawn open (a line, an arc, a line -- its last point not its
// first), the same hook closed with a fourth side back to its start, and the solid that
// extrudes to: four walls and two caps.
const [hook, shut, slab] = starter[6].solids;
assert.deepStrictEqual(starter[6].solids.map((s) => s.kind), ["profile", "profile", "solid"]);
assert.deepStrictEqual([hook.edgeCount, shut.edgeCount], [3, 4]);
const ends = (e) => [Array.from(e.subarray(0, 2)), Array.from(e.subarray(e.length - 3, e.length - 1))];
assert.notDeepStrictEqual(...ends(hook.edges), "the hook is open");
assert.deepStrictEqual(...ends(shut.edges), "closed: its last point is its first");
assert.deepStrictEqual([slab.faces, slab.closure?.closed], [6, true]);
// The starter's colours: the plate has none (the palette's); the boss's wall and top stay
// brass through the join, the hole's wall takes the bore's blue through the cut, and the
// fillet's rounds are new faces, the plate's -- so the fillet adds no coloured face.
const BRASS = [200 / 255, 160 / 255, 96 / 255], BLUE = [0x37 / 255, 0x8a / 255, 0xdd / 255];
const tally = (s) => ({
    colour: s.colour,
    brass: s.faceColours.filter(([, c]) => String(c) === String(BRASS)).length,
    blue: s.faceColours.filter(([, c]) => String(c) === String(BLUE)).length,
    coloured: s.faceColours.length,
});
// The 9 faces of the joined part are the plate's 6, the boss's top and its wall in two halves.
assert.deepStrictEqual(tally(starter[1].solids[0]), { colour: null, brass: 3, blue: 0, coloured: 3 }, "the boss's wall and top");
assert.deepStrictEqual(tally(starter[2].solids[0]), { colour: null, brass: 3, blue: 2, coloured: 5 }, "and the hole's wall, in two halves");
assert.deepStrictEqual(starter[2].solids[1].colour, BLUE, "the tool beside it");
assert.deepStrictEqual(tally(starter[3].solids[0]), tally(starter[2].solids[0]), "the rounds are the plate's");
// The press-pull cell: the rounded part with its boss 12 wider and its bore 8 narrower --
// closed, each wall's halves one wall (15 faces less two), and the walls keep their paint
// though they moved off where they lay.
assert.deepStrictEqual(starter[7].solids.map((s) => [s.faces, s.closure?.closed]), [[13, true]]);
assert.ok(starter[7].timings.filter(([what]) => what === "push_pull").length === 2, JSON.stringify(starter[7].timings));
assert.deepStrictEqual(tally(starter[7].solids[0]), { colour: null, brass: 2, blue: 1, coloured: 3 }, "the boss's wall and top, and the bore's wall");
// The refillet cell: a corner made again at 4 is the rounded part tidied (its flush faces
// merged -- the boss's and the bore's half walls each one wall): 13 faces; one taken off
// leaves 12, its two plates meeting square. Both closed, and the paint kept.
assert.deepStrictEqual(starter[8].solids.map((s) => [s.faces, s.closure?.closed]), [[13, true], [12, true]]);
for (const s of starter[8].solids) assert.deepStrictEqual(tally(s), { colour: null, brass: 2, blue: 1, coloured: 3 }, "the boss's wall and top, and the bore's wall, keep their colours");
// The rechamfer cell: the part's four upright corners bevelled, one bevel cut again at 3 --
// the part tidied as the refillet cell's is, 13 faces -- and one taken off, 12. Both
// closed, and the paint kept.
assert.deepStrictEqual(starter[9].solids.map((s) => [s.faces, s.closure?.closed]), [[13, true], [12, true]]);
for (const s of starter[9].solids) assert.deepStrictEqual(tally(s), { colour: null, brass: 2, blue: 1, coloured: 3 }, "the boss's wall and top, and the bore's wall, keep their colours");

// Completion over the live namespace: the cursor ends the text it completes, anywhere in
// the source; a method carries its signature without `self` (a timed one too -- the
// wrapper keeps `__wrapped__`) and its docstring, its annotations as the source spells them
// (the package's `from __future__ import annotations` quotes none of them twice); `_names`
// stay hidden until typed; and a property is never evaluated to describe it.
const labels = (items) => items.map((i) => i.label);
const byLabel = (items, label) => items.find((i) => i.label === label);
let items = kernel.complete("x = 1\nplate.", "x = 1\nplate.".length);
for (const name of ["fillet", "faces", "bounds", "join", "translate"]) assert.ok(labels(items).includes(name), `plate. offers ${name}: ${labels(items)}`);
assert.ok(!labels(items).some((l) => l.startsWith("_")), "no private names after a bare dot");
assert.deepStrictEqual(byLabel(items, "fillet"), { label: "fillet", type: "method", signature: "(edges: Iterable[Edge | int], radius: float | Sequence[float], tolerance: float | None = 1e-06, progress: Progress = None, radius_end: float | None = None) -> Solid",
    doc: "`edges`: `Edge` objects or their indices. A spline edge -- the crease between two\nfaces on NURBS surfaces, as between a fender patch and a door patch -- is rounded by a\nball rolled along it, in a call of its own (not with straight or circular edges);\n`tolerance` is then the fillet surface's fit, floored at a millionth of the body. Its ends\nlie on the shell's free edges, or at a corner where three or more creases meet, every one\nof them picked in the same call: the corner between their fillets is blended. `radius`\na list (spline edges only) gives each edge its own, in the order of `edges`. `radius_end`\n(spline edges only) runs the radius linearly from `radius` to it in arc length along the\nedge, `radius` at the end where the edge's curve starts." });
assert.strictEqual(byLabel(items, "faces").type, "property");
assert.match(byLabel(items, "bounds").doc, /^The solid's axis-aligned box/);
items = kernel.complete("plate.fil", 9);
assert.deepStrictEqual(labels(items), ["fillet", "fillet_law", "fillet_surfaces"]);
items = kernel.complete("Wor", 3);
assert.strictEqual(byLabel(items, "Workplane").type, "class");
items = kernel.complete("Workplane.x", 11);
assert.deepStrictEqual(items.map((i) => [i.label, i.type, i.signature]), [["xy", "function", "() -> Workplane"], ["xz", "function", "() -> Workplane"]]);
assert.ok(!labels(kernel.complete("Workplane.", 10)).includes("mro"), "a class offers its own names, not type's");
assert.deepStrictEqual(kernel.complete("Workplane.m", 11), []);
items = kernel.complete("pri", 3);
assert.strictEqual(byLabel(items, "print").type, "function");
items = kernel.complete("whi", 3);
assert.deepStrictEqual(byLabel(items, "while"), { label: "while", type: "keyword", signature: "", doc: "" });
assert.ok(!labels(kernel.complete("", 0)).some((l) => l.startsWith("_")), "no private globals");
assert.ok(!labels(kernel.complete("i", 1)).includes("inspect"), "the completer's own imports stay out of the namespace");
assert.ok(labels(kernel.complete("_", 1)).includes("__name__"), "typed, a private name is offered");
assert.deepStrictEqual(kernel.complete("nothing_here.", 13), []);
r = await kernel.run(`class Counted:
    calls = 0
    @property
    def expensive(self):
        """Counted every time it is read."""
        Counted.calls += 1
        return 1
counted = Counted()`, 30);
assert.strictEqual(r.error, null, r.error);
items = kernel.complete("counted.exp", 11);
assert.deepStrictEqual(items, [{ label: "expensive", type: "property", signature: "", doc: "Counted every time it is read." }]);
r = await kernel.run(`print(Counted.calls)`, 31);
assert.strictEqual(r.stdout, "0\n", "describing the property did not read it");

// The expression before a dot or a call, read back over calls, subscripts, strings,
// comments and line breaks inside brackets; none before an operator, a keyword, a number.
const before = (text, end = text.length) => exprBefore(text, end, scanPython(text))?.expr ?? null;
assert.strictEqual(before("x = Workplane.xy().extrude(Profile.rect(1, 2), 3)"), "Workplane.xy().extrude(Profile.rect(1, 2), 3)");
assert.strictEqual(before(`b = (Workplane.from_solid(plate)  # the top
        .faces(Selector.max(Axis.Z)).coloured("#c8a")
        .extrude`), `Workplane.from_solid(plate)  # the top
        .faces(Selector.max(Axis.Z)).coloured("#c8a")
        .extrude`);
assert.strictEqual(before("parts[0].bounds"), "parts[0].bounds");
assert.strictEqual(before("return (a).b"), "(a).b", "a keyword before a group is no callee");
assert.strictEqual(before("x = 1 + "), null);
assert.strictEqual(before("x = 2."), null, "a number");
assert.strictEqual(before("x = ."), null);
assert.strictEqual(before("return"), null);
assert.ok(scanPython("s = 'a(b").inString && scanPython("# (x").inComment);
assert.deepStrictEqual(scanPython("f(a, [1, 2], (3,), 'x,y', g(4, 5),").open.map((o) => [o.ch, o.commas]), [["(", 5]]);

// Completion after a chain: resolved by the return annotations, nothing run.
r = await kernel.run(`calls = []
def made() -> "Counted":
    calls.append(1)
    return Counted()`, 32);
assert.strictEqual(r.error, null, r.error);
assert.deepStrictEqual(labels(kernel.complete("Workplane.xy().ext", 18)), ["extrude"]);
const chain = "(Workplane.xy()\n    .extrude(Profile.rect(1, 2), 3)\n    .";
items = kernel.complete(chain, chain.length);
assert.ok(labels(items).includes("solid") && byLabel(items, "solid").type === "method", labels(items).join());
assert.ok(labels(kernel.complete("plate.translate(1, 2, 3).", 25)).includes("fillet"));
assert.deepStrictEqual(labels(kernel.complete("made().exp", 10)), ["expensive"]);
assert.deepStrictEqual(labels(kernel.complete("'abc'.upp", 9)), ["upper"]);
assert.deepStrictEqual(labels(kernel.complete("[1].app", 7)), ["append"]);
assert.deepStrictEqual(labels(kernel.complete("plate.bounds.", 13)), ["count", "index"], "tuple[...] is a tuple");
assert.deepStrictEqual(labels(kernel.complete("plate.colour.", 13)), ["count", "index"], "X | None is X");
let chained = "plate.edges[0].is";
assert.deepStrictEqual(labels(kernel.complete(chained, chained.length)), ["is_line"], "an item of a list[Edge] is an Edge");
chained = "Solid.open_all('x.step')[1].fil";
assert.deepStrictEqual(labels(kernel.complete(chained, chained.length)), ["fillet", "fillet_law", "fillet_surfaces"], "and of a call's list[Solid]");
r = await kernel.run(`pair = [plate, 1]`, 35);
assert.deepStrictEqual(labels(kernel.complete("pair[0].fil", 11)), ["fillet", "fillet_law", "fillet_surfaces"], "a real list by a literal index");
assert.deepStrictEqual(kernel.complete("pair[5].", 8), [], "out of range: nothing");
assert.deepStrictEqual(kernel.complete("counted.expensive.", 18), [], "an unannotated property is not read");
assert.deepStrictEqual(kernel.complete("unknown().", 10), []);
r = await kernel.run(`print(len(calls), Counted.calls)`, 33);
assert.strictEqual(r.stdout, "0 0\n", "completing ran no call and read no property");

// Call tips: the parameters, the one being typed (by position, or by name once `name=` is
// typed), the return annotation and the doc's first paragraph; `from` is the "(".
const tip = (text) => kernel.signature(text, text.length);
let t = tip("Workplane.xy().extrude(Profile.rect(10, 20), ");
assert.deepStrictEqual([t.name, t.parts, t.active, t.from], ["extrude", ["profile: Profile", "height: float"], 1, 22]);
assert.strictEqual(t.returns, "Workplane");
t = tip("Workplane.xy().extrude(Profile.rect(10, ");
assert.deepStrictEqual([t.name, t.active], ["rect", 1], "the innermost call");
t = tip("plate.fillet(edges, tolerance=");
assert.strictEqual(t.parts[t.active], "tolerance: float | None = 1e-06");
assert.strictEqual(t.parts[0], "edges: Iterable[Edge | int]", "a method's self is gone");
t = tip("Profile.polygon([(0, 0), (1, ");
assert.deepStrictEqual([t.name, t.active], ["polygon", 0], "a tuple's bracket is looked through");
t = tip("Solid.cuboid(");
assert.deepStrictEqual([t.name, t.active], ["cuboid", 0]);
// The tip holds 600 characters of it (fillet's first paragraph is longer), the completion all of it.
const filletDoc = byLabel(kernel.complete("plate.fil", 9), "fillet").doc;
assert.match(filletDoc, /^`edges`: `Edge` objects or their indices\. A spline edge[^]*curve starts\.$/, "the doc's first paragraph");
assert.ok(filletDoc.length > 600);
assert.strictEqual(tip("plate.fillet(").doc, filletDoc.slice(0, 600), "the doc's first paragraph, to the tip's 600 characters");
t = tip("Counted(");
assert.deepStrictEqual([t.name, t.parts, t.active], ["Counted", [], -1], "a class: its constructor");
t = tip("print('a, b', ");
assert.deepStrictEqual([t.name, t.active], ["print", 0], "the comma in the string is not counted: the first of *args");
assert.strictEqual(t.parts[t.active], "*args");
t = tip("sorted([3, 1], key=None, rev");
assert.strictEqual(t.parts[t.active], "reverse=False", "past the positionals, a word begins a keyword");
t = tip("sorted([3, 1], key");
assert.strictEqual(t.parts[t.active], "key=None");
t = tip("plate.fillet(ed");
assert.strictEqual(t.parts[t.active], "edges: Iterable[Edge | int]", "a word where a positional goes is that positional");
t = tip("sorted([3, 1], reverse=");
assert.strictEqual(t.parts[t.active], "reverse=False");
assert.deepStrictEqual(t.parts, ["iterable", "/", "*", "key=None", "reverse=False"]);
assert.strictEqual(tip("made()"), null, "after the call closed");
assert.strictEqual(tip("def made("), null, "a definition");
assert.strictEqual(tip("x = (1, "), null, "a bare tuple");
assert.strictEqual(tip("unknown(1, "), null);
assert.strictEqual(tip("plate.faces("), null, "a property is not called");
assert.strictEqual(tip("f(1)  # g("), null, "in a comment");
r = await kernel.run(`print(len(calls), Counted.calls)`, 34);
assert.strictEqual(r.stdout, "0 0\n", "a call tip ran nothing");

// A file the open button read: written into the working directory by its name alone --
// a path from the page reaches nowhere else -- and opened by a cell as a solid of its own.
// The file is a STEP file the kernel writes: a block with a hole through it.
r = await kernel.run(`print(Solid.cuboid(30, 20, 10).cut(Solid.cylinder(4, 40).translate(0, 0, -20)).step_text(), end="")`, 39);
assert.strictEqual(r.error, null, r.error);
const fixture = new TextEncoder().encode(r.stdout);
assert.strictEqual(kernel.writeFile("C:\\Users\\someone\\../boolean-chain.stp", fixture), "boolean-chain.stp");
assert.throws(() => kernel.writeFile("somewhere/..", fixture), /not a file name/);
r = await kernel.run(`import os
print(sorted(f for f in os.listdir() if f.endswith(".stp")))
imported = Solid.open("boolean-chain.stp")
imported.cut(Solid.cuboid(1, 1, 1000))`, 40);
assert.strictEqual(r.error, null, r.error);
assert.strictEqual(r.stdout, "['boolean-chain.stp']\n");
assert.strictEqual(r.solids.length, 1);
assert.ok(r.solids[0].faces > 0 && r.solids[0].vertices.length > 0);
r = await kernel.run(`Solid.open("not-there.stp")`, 41);
assert.match(r.error, /BuildError: open: /);
// A Job shown records a machining output: the stock box, each
// program's tool description and G-code, and the part's handle -- what the worker's
// showMachining takes. A pocketed block.
r = await kernel.run(`from cadaclysm_blacksmith import Job, Stock, Tool
pocketed = Solid.cuboid(40, 30, 10).translate(0, 0, 5).cut(Solid.cuboid(20, 10, 8).translate(0, 0, 6))
cam = Job(Stock.around(pocketed, 2), 30)
report = cam.machine(pocketed, Tool.flat(1, 6, 20, 800, 200, 12000))
show(cam, part=pocketed)`, 60);
assert.strictEqual(r.error, null, r.error);
assert.deepStrictEqual(r.solids.map((s) => s.kind), ["machining"]);
{
    const [job] = r.solids;
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
    assert.ok(near(job.stock.min, [-22, -17, 0]) && near(job.stock.max, [22, 17, 12]), JSON.stringify(job.stock));
    assert.ok(job.programs.length >= 1);
    assert.deepStrictEqual(job.programs[0].tool, { number: 1, shape: "flat", diameter: 6, flute_length: 20 });
    assert.ok(job.programs[0].gcode.startsWith("(cadaclysm: job-T1, T1 flat D6)"), job.programs[0].gcode.slice(0, 60));
    assert.strictEqual(typeof job.part, "number", "the part's handle");
}
r = await kernel.run(`cam`, 61);
assert.strictEqual(r.error, null, r.error);
assert.deepStrictEqual(r.solids.map((s) => s.kind), ["machining"], "a Job as the last value plays");
assert.strictEqual(r.solids[0].part ?? null, null, "no part given: none");
r = await kernel.run(`show(pocketed, cam)`, 62);
assert.deepStrictEqual(r.solids.map((s) => s.kind), ["solid", "machining"], "a solid beside the job, the job last");
r = await kernel.run(`Job(Stock.box((0, 0, 0), (10, 10, 10)), 20)`, 63);
assert.strictEqual(r.error, null, r.error);
assert.strictEqual(r.solids.length, 0, "an empty job as the last value draws nothing");
for (const [source, error] of [
    [`show(Job(Stock.box((0, 0, 0), (10, 10, 10)), 20))`, /ValueError: show\(\): the job has no operations to play/],
    [`show(pocketed, part=pocketed)`, /TypeError: show\(\): part= is the part a job cuts; show a Job with it/],
    [`show(cam, part=Profile.circle(3))`, /TypeError: show\(\): part must be a Solid, not Profile/],
    [`other = Job(Stock.around(pocketed, 2), 30)
other.machine(pocketed, Tool.flat(1, 6, 20, 800, 200, 12000))
show(cam, other)`, /ValueError: show\(\): a cell plays one job/],
    [`show(cam)
show(other)`, /ValueError: show\(\): a cell plays one job/],
    [`show(3)`, /TypeError: show\(\) draws solids, profiles, assemblies and jobs, not int/],
    // A program whose T number the job's tools do not name (a job made otherwise could): said
    // as the program and its number, not a bare KeyError.
    [`bare = Job(Stock.around(pocketed, 2), 30)
bare.machine(pocketed, Tool.flat(1, 6, 20, 800, 200, 12000))
bare.__class__ = type("Toolless", (Job,), {"__slots__": (), "tools": property(lambda self: {})})
show(bare)`, /ValueError: show\(\): program \S+-T1 uses T1, which is not among the job's tools/],
]) {
    r = await kernel.run(source, 64);
    assert.match(r.error ?? "", error, source);
}
// ---- the document of what the views show -------------------------------------------
// Every cell's shown solids, sheets and profiles, kept across cells under the page's cell
// id: the last run of each, in the page's cell order. A cell run with no id keeps nothing.
{
    const nodesOf = (text) => {
        const doc = JSON.parse(text);
        assert.strictEqual(doc.format, "cadaclysm-blacksmith");
        return doc.nodes.map(({ id, ...rest }) => rest);
    };
    const summary = (text) => nodesOf(text).map((n) => `${n.kind} ${n.name}`);
    // The cells above ran with no id: the document is empty.
    assert.deepStrictEqual(nodesOf(kernel.documentText()), []);
    r = await kernel.run(`from cadaclysm_blacksmith import Profile, Solid, Workplane
plate = Workplane.xy().extrude(Profile.rect(120, 80), 14).solid()
plate`, 70, 101, [101, 102, 103]);
    assert.strictEqual(r.error, null, r.error);
    r = await kernel.run(`show(Solid.cuboid(5, 5, 5).coloured("#ff0000"), Profile.circle(3), part="bits")
show(Solid.cuboid(1, 2, 3))`, 71, 102, [101, 102, 103]);
    assert.strictEqual(r.error, null, r.error);
    // A sheet, by the variable holding it.
    r = await kernel.run(`walls = Solid.extrude_open(Profile.rect(4, 4), (0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1), 2)
walls`, 72, 103, [101, 102, 103]);
    assert.strictEqual(r.error, null, r.error);
    let text = kernel.documentText();
    assert.deepStrictEqual(summary(text), ["solid.body plate", "solid.body bits", "profile.path bits 2", "solid.body solid 1", "sheet.body walls"]);
    const nodes = nodesOf(text);
    assert.deepStrictEqual(nodes[1].meta, { colour: "#ff0000" }, "the colour is in meta");
    assert.strictEqual(nodes[0].meta, undefined, "an uncoloured solid has no meta");
    assert.ok(nodes[0].body && nodes[2].path, "the geometry is held");

    // Re-running a cell replaces its items, in place in the cell order.
    r = await kernel.run(`show(Solid.cuboid(2, 2, 2), part="cube")`, 73, 102, [101, 102, 103]);
    assert.deepStrictEqual(summary(kernel.documentText()), ["solid.body plate", "solid.body cube", "sheet.body walls"]);
    // A cell that raises keeps nothing: its view draws nothing either.
    r = await kernel.run(`show(Solid.cuboid(3, 3, 3))
raise ValueError("no")`, 74, 102, [101, 102, 103]);
    assert.match(r.error, /ValueError: no/);
    assert.deepStrictEqual(summary(kernel.documentText()), ["solid.body plate", "sheet.body walls"]);
    // The page's order, not the order the cells ran in; a cell gone from the page goes.
    r = await kernel.run(`show(Profile.rect(3, 4), part="tile")`, 75, 104, [103, 104, 101]);
    assert.deepStrictEqual(summary(kernel.documentText()), ["sheet.body walls", "profile.path tile", "solid.body plate"]);
    kernel.forget(103);
    assert.deepStrictEqual(summary(kernel.documentText()), ["profile.path tile", "solid.body plate"]);
    // A run that says no order keeps the last one.
    r = await kernel.run(`show(Solid.cuboid(4, 4, 4), part="late")`, 76, 101);
    assert.deepStrictEqual(summary(kernel.documentText()), ["profile.path tile", "solid.body late"]);

    // From a cell: notebook_support.document(), the running cell's items so far included.
    r = await kernel.run(`import notebook_support
show(Solid.cuboid(6, 6, 6), part="here")
d = notebook_support.document()
print([n.get("name") for n in __import__("json").loads(d.save())["nodes"]])
d.close()`, 77, 105, [104, 101, 105]);
    assert.strictEqual(r.error, null, r.error);
    assert.strictEqual(r.stdout, "['tile', 'late', 'here']\n");
    // part= is a Solid beside a job, and a name otherwise: an empty one is refused.
    r = await kernel.run(`show(Solid.cuboid(1, 1, 1), part="")`, 78, 106, [104, 101, 105, 106]);
    assert.match(r.error, /part= names the items/);

    // An assembly (the rig above: a cube, and one 50 along in a sub-assembly) goes in as one
    // body per part, each where the assembly places it.
    r = await kernel.run(`rig`, 79, 106, [106]);
    assert.strictEqual(r.error, null, r.error);
    text = kernel.documentText();
    assert.deepStrictEqual(summary(text), ["solid.body rig 1", "solid.body rig 2"]);
    kernel.writeFile("rig.json", new TextEncoder().encode(text));
    r = await kernel.run(`_rig = __import__("cadaclysm_blacksmith").Document.open("rig.json")
print(sorted(round(_rig.result(n["id"]).bounds[0][0]) for n in __import__("json").loads(_rig.save())["nodes"]))`, 79);
    assert.strictEqual(r.error, null, r.error);
    assert.strictEqual(r.stdout, "[-5, 45]\n", "the parts where the assembly places them");

    // Open: the saved document loads, and its results draw under their names, in their
    // colours -- so saving again writes the same nodes.
    r = await kernel.run(`show(plate, part="plate")
show(Solid.cuboid(5, 5, 5).coloured("#00ff00").coloured("#0000ff", face=2), part="gem")
show(Profile.circle(4), part="ring")
show(walls)`, 80, 107, [107]);
    assert.strictEqual(r.error, null, r.error);
    text = kernel.documentText();
    assert.deepStrictEqual(nodesOf(text)[1].meta, { colour: "#00ff00", faces: { 2: "#0000ff" } });
    kernel.writeFile("saved.json", new TextEncoder().encode(text));
    r = await kernel.run(`from cadaclysm_blacksmith import Document

doc = Document.open("saved.json")
show_document(doc)   # each node no other node reads, under its name`, 81, 108, [108]);
    assert.strictEqual(r.error, null, r.error);
    assert.deepStrictEqual(r.solids.map((s) => s.kind), ["solid", "solid", "profile", "solid"]);
    assert.deepStrictEqual(nodesOf(kernel.documentText()), nodesOf(text), "opened and saved again: the same nodes");
    // A document of kinds that build: only what nothing else reads is drawn.
    r = await kernel.run(`built = Document()
rect = built.add("profile.rect", w=20, h=10)
built.add("solid.extrude", profile=rect, frame="xy", distance=5, name="slab")
show_document(built)`, 82, 109, [109]);
    assert.strictEqual(r.error, null, r.error);
    assert.deepStrictEqual(summary(kernel.documentText()), ["solid.body slab"]);
    kernel.forget(109);
}

// Every example notebook the menu offers, each on a namespace wiped back to what the
// boot put there: no cell errors, every cell draws or prints, and the ids are distinct.
// Last, since the wipe takes the names the blocks above rely on. Each also saves a
// document of what it shows, which loads and evaluates with no error.
assert.strictEqual(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length);
assert.strictEqual(STARTER, EXAMPLES[0].cells);
r = await kernel.run(`_boot = set(globals()) | {"_boot"}`, 50);
assert.strictEqual(r.error, null, r.error);
for (const example of EXAMPLES) {
    r = await kernel.run(`for _n in [n for n in globals() if n not in _boot]:
    del globals()[_n]`, 51);
    assert.strictEqual(r.error, null, r.error);
    const ids = example.cells.map((_, i) => 1000 + i);
    for (const [i, source] of example.cells.entries()) {
        r = await kernel.run(source, 52 + i, ids[i], ids);
        assert.strictEqual(r.error, null, `example ${example.id}, cell ${i + 1}:
${r.error}`);
        assert.ok(r.solids.length > 0 || r.stdout, `example ${example.id}, cell ${i + 1} neither draws nor prints`);
        // The SubD notebook's cells each draw a converted solid.
        if (example.id === "subd") assert.ok(r.solids.some((s) => s.kind === "solid"), `example subd, cell ${i + 1} draws no solid`);
        for (const s of r.solids) {
            if (s.kind === "machining") assert.ok(s.programs.length > 0, `example ${example.id}, cell ${i + 1}: a job with no programs`);
            else assert.ok(s.edges.length > 0, `example ${example.id}, cell ${i + 1}: an empty drawing`);
        }
    }
    const saved = kernel.documentText();
    kernel.writeFile("example.json", new TextEncoder().encode(saved));
    r = await kernel.run(`_doc = __import__("cadaclysm_blacksmith").Document.open("example.json")
print(len(__import__("json").loads(_doc.save())["nodes"]), _doc.errors())
_doc.close()`, 99);
    assert.strictEqual(r.error, null, `example ${example.id}'s document: ${r.error}`);
    assert.match(r.stdout, /^[1-9]\d* \[\]\n$/, `example ${example.id}'s document: ${r.stdout}`);
}
console.log("kernel: ok");
