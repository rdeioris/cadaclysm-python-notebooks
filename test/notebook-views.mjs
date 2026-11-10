// notebook-views.js: the notebook worker's side of its views, without a browser or a
// wasm. `wasm` and the View are fakes that record what they are asked.
//
// Run: node test/notebook-views.mjs
import assert from "node:assert";
import { createNotebookViews, createViewRouter, snapshotOf, machiningOf, OPEN_COLOUR, PINCHED_COLOUR } from "../notebook-views.js";
import { PALETTE, OUTLINE, CROSS } from "../notebook-scene.js";

function fakeWasm({ manifold = [0, 0, 0, 0, 0, 0, 1, 1], flaws = null, profileColour = null } = {}) {
    const freed = [], boxed = [];
    let next = 100;
    return {
        freed,
        boxed,
        cadaclysm_blacksmith_solid_share: (h) => next++,
        cadaclysm_blacksmith_solid_free: (h) => freed.push(h),
        cadaclysm_blacksmith_manifold: () => manifold,
        cadaclysm_blacksmith_manifold_flaws: () => flaws,
        // Only a share is ever boxed (100 and up), never the kernel's own handle.
        cadaclysm_blacksmith_box: (h) => { assert.ok(h >= 100, `box of the user's handle ${h}`); boxed.push(h); return [0, 0, 0, 10, 10, 10]; },
        cadaclysm_blacksmith_bounds: () => { throw new Error("bounds meshes the user's handle: not called"); },
        cadaclysm_blacksmith_profile_outline: () => ({ points: new Float32Array([0, 0, 0, 5, 0, 0, 5, 5, 0]), offsets: new Uint32Array([0, 3]), segments: 2 }),
        cadaclysm_blacksmith_profile_colour: () => profileColour,
    };
}

function fakeViewer() {
    const calls = [];
    return {
        calls,
        showSolid: (h, o) => { calls.push(["showSolid", h, o]); return calls.length; },
        showLines: (s, c) => { calls.push(["showLines", Array.from(s), c]); return calls.length; },
        setGrid: (o) => calls.push(["setGrid", o]),
        frame: (...a) => calls.push(["frame", ...a]),
    };
}

function fakeHost() {
    const views = new Map(), dirty = [];
    return { views, dirty, markDirty: (id) => dirty.push(id) };
}

// 1. A solid's snapshot: a shared handle (not the kernel's own), its summary for the page.
{
    const wasm = fakeWasm();
    const s = snapshotOf(wasm, 7, 6, 12, null, [], "solid");
    assert.deepStrictEqual(s.summary, { kind: "solid", faces: 6, edgeCount: 12, colour: null, closure: { closed: true, manifold: true, boundaryEdges: 0, nonManifoldEdges: 0, nonManifoldVertices: 0 } });
    assert.strictEqual(s.show.kind, "solid");
    assert.strictEqual(s.show.handle, 100, "a handle of its own, from solid_share");
    assert.strictEqual(s.box, null, "no box taken while the cell runs");
    assert.deepStrictEqual(wasm.boxed, []);
    assert.strictEqual(s.flaws, null, "a closed solid is not asked where it is open");
}

// 2. A profile's snapshot: its segments, in OUTLINE (it has no colour of its own), no handle kept.
{
    const s = snapshotOf(fakeWasm(), 9, 0, 0, null, [], "profile");
    assert.strictEqual(s.summary.kind, "profile");
    assert.strictEqual(s.summary.edgeCount, 2);
    assert.deepStrictEqual(s.show, { kind: "profile", segments: new Float32Array([0, 0, 0, 5, 0, 0, 5, 0, 0, 5, 5, 0]), colour: OUTLINE.slice() });
}

// 3. keep -> bind -> show: each solid with its palette fill by index (profiles counted), the
// profile's lines, the grid with axes, a frame, and a draw asked for.
{
    const wasm = fakeWasm(), host = fakeHost(), posted = [];
    const views = createNotebookViews({ wasm, host, post: (m) => posted.push(m) });
    const summaries = views.keep(1, [snapshotOf(wasm, 7, 6, 12, null, [], "solid"), snapshotOf(wasm, 9, 0, 0, null, [], "profile"), snapshotOf(wasm, 8, 6, 12, [1, 0, 0], [], "solid")]);
    assert.deepStrictEqual(summaries.map((s) => s.kind), ["solid", "profile", "solid"]);
    const viewer = fakeViewer();
    host.views.set(5, viewer);
    views.bind(5, 1);
    views.show(5);
    assert.deepStrictEqual(viewer.calls.map((c) => c[0]), ["showSolid", "showLines", "showSolid", "setGrid", "frame"]);
    assert.deepStrictEqual(viewer.calls[0][2], { fill: PALETTE[0] });
    assert.deepStrictEqual(viewer.calls[2][2], { fill: PALETTE[2] }, "the third item drawn: PALETTE[2]");
    assert.deepStrictEqual(viewer.calls[3][1], { axes: true });
    assert.deepStrictEqual(host.dirty, [5]);
    assert.deepStrictEqual(posted, []);
    assert.deepStrictEqual(wasm.boxed, [], "nothing pinched: no box taken");
}

// 4. Open and pinched flaws: the boundary in OPEN_COLOUR, the fins and the crosses (arm =
// CROSS x the cell's radius, 5 for a 10-wide box) in PINCHED_COLOUR, after the items.
{
    const flaws = { boundary: new Float32Array([0, 0, 0, 1, 0, 0]), nonManifold: new Float32Array([0, 1, 0, 0, 2, 0]), pinched: new Float32Array([3, 3, 3]) };
    const wasm = fakeWasm({ manifold: [0, 0, 0, 1, 1, 1, 0, 0], flaws }), host = fakeHost();
    const views = createNotebookViews({ wasm, host, post: () => {} });
    views.keep(2, [snapshotOf(wasm, 7, 6, 12, null, [], "solid")]);
    const viewer = fakeViewer();
    host.views.set(6, viewer);
    views.bind(6, 2);
    views.show(6);
    const lines = viewer.calls.filter((c) => c[0] === "showLines");
    assert.deepStrictEqual(lines[0][1], [0, 0, 0, 1, 0, 0]);
    assert.deepStrictEqual(lines[0][2], OPEN_COLOUR);
    assert.strictEqual(lines[1][1].length, 6 + 18, "the fin, then one cross");
    assert.strictEqual(lines[1][1][6], Math.fround(3 - 5 * CROSS), "the cross's x arm, CROSS of the radius (a float32)");
    assert.deepStrictEqual(lines[1][2], PINCHED_COLOUR);
    assert.deepStrictEqual(wasm.boxed, [100], "the box, of the share, for the crosses");
    views.show(6);
    assert.deepStrictEqual(wasm.boxed, [100], "and taken once");
}

// 5. keep again frees the old shared handles; forget frees and unbinds; clear frees all.
{
    const wasm = fakeWasm(), host = fakeHost();
    const views = createNotebookViews({ wasm, host, post: () => {} });
    views.keep(3, [snapshotOf(wasm, 7, 6, 12, null, [], "solid")]);          // handle 100
    views.keep(3, [snapshotOf(wasm, 7, 6, 12, null, [], "solid")]);          // handle 101; 100 freed
    assert.deepStrictEqual(wasm.freed, [100]);
    views.bind(9, 3);
    views.forget(3);
    assert.deepStrictEqual(wasm.freed, [100, 101]);
    const viewer = fakeViewer();
    host.views.set(9, viewer);
    views.show(9);
    assert.deepStrictEqual(viewer.calls, [], "a forgotten cell shows nothing");
    views.keep(4, [snapshotOf(wasm, 7, 6, 12, null, [], "solid"), snapshotOf(wasm, 9, 0, 0, null, [], "profile")]);
    views.clear();
    assert.deepStrictEqual(wasm.freed, [100, 101, 102], "profiles hold no handle");
}

// 6. A throw while showing is a view.error for that view, and the rest of the page goes on.
{
    const wasm = fakeWasm(), host = fakeHost(), posted = [];
    const views = createNotebookViews({ wasm, host, post: (m) => posted.push(m) });
    views.keep(1, [snapshotOf(wasm, 7, 6, 12, null, [], "solid")]);
    host.views.set(5, { ...fakeViewer(), showSolid: () => { throw new Error("no"); } });
    views.bind(5, 1);
    views.show(5);
    assert.deepStrictEqual(posted, [{ kind: "view.error", id: 5, message: "show: no" }]);
}

// 7. An empty cell (keep with nothing) keeps nothing; a view bound to it shows nothing.
{
    const wasm = fakeWasm(), host = fakeHost();
    const views = createNotebookViews({ wasm, host, post: () => {} });
    assert.deepStrictEqual(views.keep(1, []), []);
    const viewer = fakeViewer();
    host.views.set(5, viewer);
    views.bind(5, 1);
    views.show(5);
    assert.deepStrictEqual(viewer.calls, []);
}

// 7b. An assembly's snapshot: the kernel's STEP of it (in mm), read by the module's own
// reader into a scene that is shown with showScene, its parts counted from the spans, its
// box the scene's sphere moved out of the origin-relative space -- and freed with the cell.
{
    const asked = [], freed = [];
    const scene = {
        origin: () => [100, 0, 0],
        bounds: () => [1, 2, 3, 4],
        spans: () => new Uint32Array([5, 0, 3, 5, 3, 3, 6, 6, 3]),   // nodes 5, 5, 6: two parts
        free: () => freed.push("scene"),
    };
    const wasm = {
        ...fakeWasm(),
        cadaclysm_blacksmith_assembly_step: (h, schema, unit) => { asked.push(["step", h, schema, unit]); return "ISO-10303-21;"; },
        open: (bytes, format) => { asked.push(["open", new TextDecoder().decode(bytes), format]); return scene; },
    };
    const s = snapshotOf(wasm, 11, 0, 0, null, [], "assembly");
    assert.deepStrictEqual(asked, [["step", 11, undefined, 1], ["open", "ISO-10303-21;", "stp"]]);
    assert.deepStrictEqual(s.summary, { kind: "assembly", faces: 0, edgeCount: 0, parts: 2, colour: null, closure: null });
    assert.deepStrictEqual(s.box, { lo: [97, -2, -1], hi: [105, 6, 7] });
    assert.strictEqual(s.show.scene, scene);

    const host = fakeHost();
    const views = createNotebookViews({ wasm, host, post: () => {} });
    views.keep(1, [snapshotOf(wasm, 7, 6, 12, null, [], "solid"), s]);
    const viewer = { ...fakeViewer(), showScene: (sc) => { viewer.calls.push(["showScene", sc]); return 1; } };
    host.views.set(5, viewer);
    views.bind(5, 1);
    views.show(5);
    assert.deepStrictEqual(viewer.calls.map((c) => c[0]), ["showSolid", "showScene", "setGrid", "frame"]);
    assert.strictEqual(viewer.calls[1][1], scene);
    views.forget(1);
    assert.deepStrictEqual(freed, ["scene"], "the scene is freed with its cell");
    assert.deepStrictEqual(wasm.freed, [100], "and the solid's share beside it");
}

// 9. A machining's snapshot: the part shared (never the kernel's own handle), the summary the
// caption reads, what showMachining takes, and the part's share freed with the cell.
const RECORD = {
    stock: { min: [-22, -17, 0], max: [22, 17, 12] },
    programs: [{ tool: { number: 1, shape: "flat", diameter: 6, flute_length: 20 }, gcode: "(cadaclysm: job-T1, T1 flat D6)\nG0 X0" }],
    part: 7,
};
{
    const wasm = fakeWasm();
    const s = machiningOf(wasm, RECORD);
    assert.deepStrictEqual(s.summary, { kind: "machining", faces: 0, edgeCount: 0, colour: null, closure: null, programs: [{ tool: 1, shape: "flat", diameter: 6 }], hasPart: true });
    assert.deepStrictEqual(s.show, { kind: "machining", options: { stock: RECORD.stock, programs: RECORD.programs }, part: 100 });
    assert.deepStrictEqual(s.box, { lo: [-22, -17, 0], hi: [22, 17, 12] });
    const bare = machiningOf(wasm, { ...RECORD, part: undefined });
    assert.strictEqual(bare.show.part, null);
    assert.strictEqual(bare.summary.hasPart, false);
    const views = createNotebookViews({ wasm, host: fakeHost(), post: () => {} });
    views.keep(1, [s, bare]);
    views.forget(1);
    assert.deepStrictEqual(wasm.freed, [100], "the part's share, and nothing for no part");
}

// 10. show: the solids, then the job through the bridge, the grid, the stock framed; a
// run starts the cell's job fresh; transport and unbind reach the bridge.
{
    const wasm = fakeWasm(), host = fakeHost(), bridge = [];
    const machining = {
        attach: (view, cell, viewer, show) => { bridge.push(["attach", view, cell, show.kind]); return 9; },
        detach: (view) => bridge.push(["detach", view]),
        forget: (cell) => bridge.push(["forget", cell]),
        command: (view, m) => bridge.push(["command", view, m.command]),
    };
    const views = createNotebookViews({ wasm, host, post: () => {}, machining });
    views.keep(1, [snapshotOf(wasm, 7, 6, 12, null, [], "solid"), machiningOf(wasm, RECORD)]);
    assert.deepStrictEqual(bridge, [["forget", 1]], "a run starts its job fresh");
    const viewer = fakeViewer();
    host.views.set(5, viewer);
    views.bind(5, 1);
    views.show(5);
    assert.deepStrictEqual(viewer.calls.map((c) => c[0]), ["showSolid", "setGrid", "frame"]);
    assert.deepStrictEqual(viewer.calls.at(-1), ["frame", 9], "framed on the stock");
    assert.deepStrictEqual(bridge.at(-1), ["attach", 5, 1, "machining"]);
    views.transport({ kind: "view.transport", id: 5, command: "play", value: 1 });
    assert.deepStrictEqual(bridge.at(-1), ["command", 5, "play"]);
    views.unbind(5);
    assert.deepStrictEqual(bridge.at(-1), ["detach", 5]);
    views.forget(1);
    assert.deepStrictEqual(bridge.at(-1), ["forget", 1]);
}

// 8. createViewRouter: the workers' view messages, in the order they came, none before the
// wasm is up. Everything else is left to the caller (false).
{
    let resolve;
    const ready = new Promise((r) => { resolve = r; });
    const calls = [], crashed = [];
    const views = {
        bind: (v, c) => calls.push(["bind", v, c]),
        forget: (c) => calls.push(["forget", c]),
        unbind: (v) => calls.push(["unbind", v]),
        transport: (d) => calls.push(["transport", d.id]),
    };
    const host = { handle: (d) => { if (d.kind === "view.call" && d.name === "trap") throw new WebAssembly.RuntimeError("trapped"); if (d.kind === "view.call" && d.name === "boom") throw new TypeError("boom"); calls.push(["host", d.kind, d.id]); } };
    const route = createViewRouter({ ready, views, host, crash: (e) => crashed.push(e.message) });

    assert.strictEqual(route({ kind: "run", id: 1 }), false, "a run is not the views'");
    assert.strictEqual(route({ kind: "view-of", view: 1, cell: 7 }), true);
    assert.strictEqual(route({ kind: "view.create", id: 1 }), true);
    assert.strictEqual(route({ kind: "forget", cell: 3 }), true);
    assert.deepStrictEqual(calls, [], "nothing handled before the wasm is up");

    resolve();
    await ready;
    await Promise.resolve();
    assert.deepStrictEqual(calls, [["bind", 1, 7], ["host", "view.create", 1], ["forget", 3]], "replayed in order: the view bound before its view.create");

    route({ kind: "view.free", id: 1 });
    assert.deepStrictEqual(calls.slice(3), [["unbind", 1], ["host", "view.free", 1]], "after the wasm: at once, a view.free unbinding first");

    route({ kind: "view.call", id: 1, name: "trap" });
    assert.deepStrictEqual(crashed, ["trapped"], "a trap while handling is a crash");
    assert.throws(() => route({ kind: "view.call", id: 1, name: "boom" }), /boom/, "any other throw is not swallowed");
    const before = calls.length;
    route({ kind: "view.transport", id: 1, command: "play", value: 1 });
    assert.deepStrictEqual(calls.slice(before), [["transport", 1]], "a transport command is the views', not the host's");
}

console.log("notebook-views: ok");
