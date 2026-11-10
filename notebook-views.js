// The notebook worker's side of its views (notebook-worker.js),
// apart from the View so Node can test it (test/notebook-views.mjs).
//
// A cell's run ends in snapshots, not meshes: `snapshotOf` is the kernel's `draw`
// (kernel.js). A solid is kept as a second handle on its brep and paint
// (cadaclysm_blacksmith_solid_share) -- the cell's own may be freed or rebound by a later
// cell before the cell's view ever scrolls in. A profile is kept as its outline's segments,
// an assembly as its read scene. Either way the page gets only the summary its caption and legend read (captionOf,
// legendOf in notebook-scene.js). A played job (`show(job)`) is kept as its record with a
// second handle on its part; `show` hands it to the machining bridge (notebook-machining.js),
// which plays it in the View and answers the page's transport.
//
// The page binds each view it makes to its cell (`view-of`) before the bridge's view.create;
// when the host posts view.ready, the worker calls `show`, which draws the cell's snapshot
// into that View as sceneOf used to draw it, before the View took the page over: a
// solid in its own colour, else the palette's by its index among everything the cell drew
// (showSolid's `fill`, below all paint); a profile in its own colour, else OUTLINE; the
// open edges and the pinched ones (fins, and a cross at each pinched vertex, CROSS of the
// cell's radius) as lines over the edges; the grid with its axes; the camera framed.
import { OUTLINE, CROSS, crossesOf } from "./notebook-scene.js";
import { OUTLINE_STEPS, closureOf, assemblySceneOf, partCountOf } from "./notebook-mesh.js";
import { segmentsOf, paletteColour, sphereOf, boxOfPoints } from "./pkg/view-show.js";

// The same wire colours render.js used to draw.
export const OPEN_COLOUR = [0.88, 0.70, 0.35];
export const PINCHED_COLOUR = [0.90, 0.39, 0.42];

export const trapped = (e) => typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;

// viewer-host's `schedule`: the next frame, and a trap in its draw said as a crash (the page
// re-makes the worker) rather than left an uncaught worker error.
export function scheduleDraw(fn) {
    const draw = () => {
        try { fn(); } catch (e) {
            if (trapped(e)) self.postMessage({ kind: "crashed", message: String(e?.message ?? e) });
            else throw e;
        }
    };
    if (typeof self.requestAnimationFrame === "function") self.requestAnimationFrame(draw);
    else setTimeout(draw, 16);
}

// One drawn item of a cell, as the kernels' `draw` is called (notebook-mesh.js meshOf's
// arguments): `{ summary, show, box, flaws }`. A solid's `box` is null here: it is only
// needed to size the pinched crosses, so `show` takes it then, from the share (boxOf).
// An assembly is kept as its read scene (assemblySceneOf: the kernel's STEP of it, read
// back), shown with showScene -- its parts in their own colours, the scene's default where
// they have none -- and freed with the snapshot.
export function snapshotOf(wasm, handle, faces, edgeCount, colour, faceColours, kind) {
    if (kind === "assembly") {
        const scene = assemblySceneOf(wasm, handle);
        const o = scene.origin(), b = scene.bounds();
        const centre = [0, 1, 2].map((k) => b[k] + o[k]), r = b[3];
        return {
            summary: { kind: "assembly", faces: 0, edgeCount: 0, parts: partCountOf(scene), colour: null, closure: null },
            show: { kind: "scene", scene },
            box: { lo: centre.map((c) => c - r), hi: centre.map((c) => c + r) },
            flaws: null,
        };
    }
    if (kind === "profile") {
        const o = wasm.cadaclysm_blacksmith_profile_outline(handle, OUTLINE_STEPS);
        const segments = segmentsOf(o);
        const own = wasm.cadaclysm_blacksmith_profile_colour(handle);
        const rgb = own ? Array.from(own) : null;
        return {
            summary: { kind: "profile", faces: 0, edgeCount: o.segments, colour: rgb, closure: null },
            show: { kind: "profile", segments, colour: rgb ?? OUTLINE.slice() },
            box: boxOfPoints(segments),
            flaws: null,
        };
    }
    const closure = closureOf(wasm, handle);
    const flaws = closure && !closure.closed ? wasm.cadaclysm_blacksmith_manifold_flaws(handle) : null;
    return {
        summary: { kind: "solid", faces, edgeCount, colour: colour ?? null, closure },
        show: { kind: "solid", handle: wasm.cadaclysm_blacksmith_solid_share(handle) },
        box: null,
        flaws,
    };
}

// A played job (notebook_support._machining's record, kernel.js's drawMachining): its
// part kept as a second handle, as a solid's is; what showMachining takes; the summary the
// caption reads (no faces, no edges, no closure: no legend chip).
export function machiningOf(wasm, record) {
    const part = record.part == null ? null : wasm.cadaclysm_blacksmith_solid_share(record.part);
    return {
        summary: {
            kind: "machining", faces: 0, edgeCount: 0, colour: null, closure: null,
            programs: record.programs.map((p) => ({ tool: p.tool.number, shape: p.tool.shape, diameter: p.tool.diameter })),
            hasPart: part !== null,
        },
        show: { kind: "machining", options: { stock: record.stock, programs: record.programs }, part },
        box: { lo: record.stock.min, hi: record.stock.max },
        flaws: null,
    };
}

function join(parts) {
    const n = parts.reduce((k, p) => k + (p?.length ?? 0), 0);
    const out = new Float32Array(n);
    let at = 0;
    for (const p of parts) if (p?.length) { out.set(p, at); at += p.length; }
    return out;
}

export function createNotebookViews({ wasm, host, post, machining = null }) {
    const cells = new Map();   // cell id -> [snapshot]
    const bound = new Map();   // view id -> cell id

    // A snapshot's shared handle, given back: the kernels' `undraw`, for a run whose later
    // item threw before any of its snapshots were kept.
    function undraw(s) {
        if (s.show.kind === "solid") wasm.cadaclysm_blacksmith_solid_free(s.show.handle);
        else if (s.show.kind === "machining" && s.show.part !== null) wasm.cadaclysm_blacksmith_solid_free(s.show.part);
        else if (s.show.kind === "scene") s.show.scene.free();
    }

    function release(list) {
        for (const s of list ?? []) undraw(s);
    }

    // A cell's run's snapshots, replacing (and freeing) the last run's; the page's summaries.
    function keep(cell, snapshots) {
        machining?.forget(cell);
        release(cells.get(cell));
        if (snapshots.length) cells.set(cell, snapshots); else cells.delete(cell);
        return snapshots.map((s) => s.summary);
    }

    function forget(cell) {
        machining?.forget(cell);
        release(cells.get(cell));
        cells.delete(cell);
        for (const [view, c] of bound) if (c === cell) bound.delete(view);
    }

    // A snapshot's box, a solid's taken once from its share by cadaclysm_blacksmith_box
    // (extent-relative and cached on the share; no mesh made on the user's own handle).
    function boxOf(s) {
        if (s.box || s.show.kind !== "solid") return s.box;
        try {
            const b = wasm.cadaclysm_blacksmith_box(s.show.handle);
            if (b && b.length === 6 && Array.from(b).every(Number.isFinite)) s.box = { lo: [b[0], b[1], b[2]], hi: [b[3], b[4], b[5]] };
        } catch (e) {
            if (trapped(e)) throw e;
            /* an empty solid: nothing to bound */
        }
        return s.box;
    }

    function bind(view, cell) { bound.set(view, cell); }
    function unbind(view) { machining?.detach(view); bound.delete(view); }
    function transport(message) { machining?.command(message.id, message); }

    // Draws the bound cell's snapshot into the view's View. A throw is that view's
    // view.error; a trap is thrown on, to the crash path.
    function show(view) {
        const viewer = host.views.get(view);
        const list = cells.get(bound.get(view));
        if (!viewer || !list) return;
        try {
            let stock = null;
            list.forEach((s, i) => {
                if (s.show.kind === "solid") viewer.showSolid(s.show.handle, { fill: paletteColour(i).slice() });
                else if (s.show.kind === "machining") { if (machining) stock = machining.attach(view, bound.get(view), viewer, s.show); }
                else if (s.show.kind === "scene") viewer.showScene(s.show.scene);
                else if (s.show.segments.length) viewer.showLines(s.show.segments, s.show.colour);
            });
            // The crosses' arm, CROSS of the cell's radius: the boxes are taken only when
            // there is a pinched point to cross.
            const pinches = list.some((s) => s.flaws?.pinched?.length);
            const arm = pinches ? (sphereOf(list.map(boxOf))?.radius ?? 1) * CROSS : 0;
            const open = join(list.map((s) => s.flaws?.boundary));
            const pinched = join(list.flatMap((s) => (s.flaws ? [s.flaws.nonManifold, crossesOf(s.flaws.pinched ?? new Float32Array(0), arm)] : [])));
            if (open.length) viewer.showLines(open, OPEN_COLOUR);
            if (pinched.length) viewer.showLines(pinched, PINCHED_COLOUR);
            viewer.setGrid({ axes: true });
            if (stock === null) viewer.frame(); else viewer.frame(stock);
        } catch (e) {
            if (trapped(e)) throw e;
            post({ kind: "view.error", id: view, message: `show: ${e?.message ?? e}` });
        }
        // Direct changes to the hosted View: the host cannot see them, so ask for a draw.
        host.markDirty(view);
    }

    function clear() {
        machining?.clear();
        for (const list of cells.values()) release(list);
        cells.clear();
        bound.clear();
    }

    return { keep, forget, bind, unbind, show, clear, undraw, transport };
}

// The worker's messages for its views -- the page's `view-of` and `forget`, and the bridge's
// `view.*` -- handled in the order they came, and none before `ready` (the wasm) resolves:
// queued until then and replayed, so a view's `view-of` always binds it before its own
// `view.create` reaches the host. `route(data)` is false for any other message, which the
// worker handles itself. A trap while handling one is `crash(e)` (the wasm the kernel shares
// is left poisoned); any other throw is the caller's.
export function createViewRouter({ ready, views, host, crash }) {
    const early = [];
    let up = false;
    function handle(data) {
        try {
            if (data.kind === "view-of") views.bind(data.view, data.cell);
            else if (data.kind === "forget") views.forget(data.cell);
            else if (data.kind === "view.transport") views.transport(data);
            else {
                if (data.kind === "view.free") views.unbind(data.id);
                host.handle(data);
            }
        } catch (e) {
            if (trapped(e)) crash(e);
            else throw e;
        }
    }
    ready.then(() => { up = true; for (const d of early.splice(0)) handle(d); }, () => {});
    return function route(data) {
        const mine = data.kind === "view-of" || data.kind === "forget" || (typeof data.kind === "string" && data.kind.startsWith("view."));
        if (!mine) return false;
        if (up) handle(data); else early.push(data);
        return true;
    };
}
