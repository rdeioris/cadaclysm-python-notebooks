// The notebook worker: one kernel, cells run one at a time, progress posted while the
// kernel is busy. Terminated and re-made by the page on Stop or Restart -- a worker
// blocked in the kernel cannot be signalled, so there is no "cancel" message. It also hosts
// a wasm View per visible cell (viewer-host.js) and keeps each cell's snapshot
// (notebook-views.js) instead of sending meshes.
//
// The protocol, page to worker: `{ kind: "run", id, source, n, order }` -- run cell `n`'s
// `source` and answer for `id`, `order` the page's cell ids in order (what the cell shows is
// kept, under `id`, for the document); `{ kind: "document", name }` -- the document of every
// cell's shown solids, sheets and profiles, answered `{ kind: "document", name, text }` (or
// `{ kind: "document-failed", name, message }`); `{ kind: "file", name, bytes }` -- write a file the open
// button read into the kernel's working directory, answered `{ kind: "file", name }` (or
// `{ kind: "file-failed", name, message }`). Both wait in one queue, so a cell sent after a
// file finds it, and a document asked for after a run has it. `{ kind: "view-of", view, cell }` binds bridge view id `view` to cell
// `cell`, sent just before `attachViewer` posts that view's `view.create`; `{ kind: "forget",
// cell }` -- the cell was deleted or replaced, the worker frees its snapshot; the bridge's
// `view.*` messages go to viewer-host.js's `handle`, but for `{ kind: "view.transport", id,
// command, value }` -- play, pause, seek, loop, move, colour, path or tool on the view's
// played job -- which the machining bridge answers (notebook-machining.js). Worker to page:
// `{ kind: "boot", stage }` as the kernel comes up, then `{ kind: "ready", versions }`; while a cell runs
// `{ kind: "progress", id, phase, done, total, elapsed }` (throttled to one every few
// dozen milliseconds, and always at a phase's start); then `{ kind: "done", id, stdout,
// stderr, streams, error, ms, solids, timings }`, `solids` **summaries**
// (`{ kind, faces, edgeCount, colour, closure }`, what `captionOf` and `legendOf` read; a
// machining's also carries `programs`, `[{ tool, shape, diameter }]`, and `hasPart`) with
// no arrays and nothing transferred, or `{ kind: "crashed", id, message }` when the wasm
// aborts or Pyodide throws outside Python. The host's `view.*` messages go back to the page
// unasked, which routes them by `id` to the view's client, among them the bridge's
// `{ kind: "view.timeline", id, state }` while a view plays a job; `{ kind: "crashed",
// message }`, with no `id`, when any view message traps (a View call, a draw, a show). A boot that fails after this
// script loaded (a runtime file missing, Pyodide refusing) posts
// `{ kind: "boot-failed", stage, message }` -- `stage` the last `boot` stage reached, since
// Pyodide's own rejection (a "Program terminated with exit(1)") names no file -- as the
// page's `onerror` sees only script errors.
//
// Completion, page to worker: `{ kind: "complete", ask, source, cursor }`; worker to page
// `{ kind: "completion", ask, items }`, `items` an array of `{ label, type, signature, doc }`
// from the live namespace, or null when the kernel is not up or has cells to run -- a
// completion never waits behind a cell, and one queued behind a `run` would answer for
// a namespace the page has not seen yet. Call tips the same way: `{ kind: "signature", ask,
// source, cursor }`, answered `{ kind: "signature", ask, tip }` -- the kernel's `signature`,
// or null.
//
// The cadaclysm web package (`npm run setup` fetches it into ./pkg): its index.js loads the
// module and re-exports cadaclysm.js, the kernel's calls and the View. The Python side is
// the SDK's own cadaclysm_blacksmith.py (./sdk/, also from `npm run setup`) over that
// module, and Pyodide (./pyodide/, the same).
import * as wasm from "./pkg/index.js";
import { loadPyodide } from "./pyodide/pyodide.mjs";
import { createKernel } from "./kernel.js";
import { createViewerHost } from "./pkg/viewer-host.js";
import { createNotebookViews, createViewRouter, snapshotOf, machiningOf, scheduleDraw, trapped } from "./notebook-views.js";
import { createMachiningBridge } from "./notebook-machining.js";

const THROTTLE_MS = 40;
let current = null;    // { id, started, lastPhase, lastAt } while a cell runs
let kernel = null;
let stage = null;

function progress(phase, done, total) {
    if (!current) return;
    const now = performance.now();
    if (phase === current.lastPhase && now - current.lastAt < THROTTLE_MS) return;
    current.lastPhase = phase;
    current.lastAt = now;
    self.postMessage({ kind: "progress", id: current.id, phase, done, total, elapsed: Math.round(now - current.started) });
}

// The bridge's host (viewer-host.js) for the cells' views; `post` also shows a cell's
// snapshot into its view the moment that view's View exists (view.ready: the host has put
// the View into `host.views` before it posts). A trap there is a crash.
let views = null;
function post(message, transfer) {
    self.postMessage(message, transfer);
    if (message.kind === "view.ready") {
        try { views.show(message.id); } catch (e) {
            if (trapped(e)) crash(e);
            else throw e;
        }
    }
}
// A trap in any View call is a crash: the Viewers share the kernel's wasm, whose tables
// a panic leaves borrowed, so the page must re-make the worker.
const crash = (e) => self.postMessage({ kind: "crashed", message: String(e?.message ?? e) });
const host = createViewerHost({ View: wasm.View, post, now: () => performance.now(), schedule: scheduleDraw, onTrap: crash });
// A cell's played job: the bridge holds its Machining and the timeline from the view's
// show to its free (notebook-machining.js).
// A shown job's part, meshed once per snapshot by the bridge: the kernel's tessellation,
// the one showMachining's solid_part runs (notebook-machining.js).
const meshPart = (handle, tolerance) => {
    const m = wasm.cadaclysm_blacksmith_mesh(handle, tolerance);
    return { positions: m.positions, indices: m.indices };
};
const machining = createMachiningBridge({ host, post: (m) => self.postMessage(m), now: () => performance.now(), meshPart });
views = createNotebookViews({ wasm, host, post: (m) => self.postMessage(m), machining });

// A license (cadaclysm.lic: its URL or its text) for a site others use; without one the
// module runs in full, with a notice in the console on every file opened and every STEP
// file written. https://cadaclysm.blitter.studio/license
const LICENSE = null;
// The views need the wasm, not the kernel: a cell's view can come and go while Pyodide
// still loads, so the wasm's own readiness is kept apart.
const wasmReady = wasm.load(LICENSE ? { license: LICENSE } : {});
// The views' messages, none before the wasm is up (notebook-views.js).
const route = createViewRouter({ ready: wasmReady, views, host, crash });

// A file beside the page, as text; a missing one (no `npm run setup`) said by its name.
async function text(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url.pathname} -- run npm run setup`);
    return r.text();
}

const ready = (async () => {
    await wasmReady;
    const base = new URL("./", self.location.href).href;
    const [moduleSource, supportSource] = await Promise.all([
        text(new URL("./sdk/cadaclysm_blacksmith.py", base)),
        text(new URL("./notebook_support.py", base)),
    ]);
    kernel = await createKernel({
        loadPyodide,
        indexURL: new URL("./pyodide/", base).href,
        wasm,
        moduleSource,
        supportSource,
        schemaUrl: new URL("./sdk/schemas/", base).href,
        onProgress: progress,
        onBoot: (reached) => { stage = reached; self.postMessage({ kind: "boot", stage }); },
        draw: snapshotOf, undraw: views.undraw, drawMachining: machiningOf,
    });
    self.postMessage({ kind: "ready", versions: kernel.versions });
})();
// Reported, and left rejected: `drain` awaits `ready`, so no cell ever runs on a half-made kernel.
ready.catch((e) => self.postMessage({ kind: "boot-failed", stage, message: String(e?.message ?? e) }));

const queue = [];
let draining = false;

self.onmessage = ({ data }) => {
    if (data.kind === "complete" || data.kind === "signature") { answer(data); return; }
    // A forgotten cell leaves the document too, in turn behind the runs already sent.
    if (data.kind === "forget") { queue.push(data); drain(); }
    if (route(data)) return;
    if (data.kind !== "run" && data.kind !== "file" && data.kind !== "document") return;
    queue.push(data);
    drain();
};

function answer({ kind, ask, source, cursor }) {
    let result = null;
    if (kernel && !draining && !queue.length) {
        try { result = kind === "complete" ? kernel.complete(source, cursor) : kernel.signature(source, cursor); } catch { result = null; }
    }
    self.postMessage(kind === "complete" ? { kind: "completion", ask, items: result } : { kind: "signature", ask, tip: result });
}

async function drain() {
    if (draining) return;
    draining = true;
    try {
        await ready;
        while (queue.length) {
            const item = queue.shift();
            if (item.kind === "file") {
                try {
                    self.postMessage({ kind: "file", name: kernel.writeFile(item.name, new Uint8Array(item.bytes)) });
                } catch (e) {
                    self.postMessage({ kind: "file-failed", name: item.name, message: String(e?.message ?? e) });
                }
                continue;
            }
            if (item.kind === "forget") { kernel.forget(item.cell); continue; }
            if (item.kind === "document") {
                try {
                    self.postMessage({ kind: "document", name: item.name, text: kernel.documentText() });
                } catch (e) {
                    if (/^the wasm trapped/.test(e?.message)) { crash(e); continue; }
                    self.postMessage({ kind: "document-failed", name: item.name, message: String(e?.message ?? e) });
                }
                continue;
            }
            const { id, source, n, order } = item;
            current = { id, started: performance.now(), lastPhase: null, lastAt: -Infinity };
            try {
                const result = await kernel.run(source, n, id, order ?? null);
                // The run's snapshots stay here (their shared handles freed when the cell runs
                // again or is forgotten); the page gets the summaries its caption and legend read.
                const solids = views.keep(id, result.solids);
                self.postMessage({ kind: "done", id, ...result, solids });
            } catch (e) {
                self.postMessage({ kind: "crashed", id, message: String(e?.message ?? e) });
            } finally {
                current = null;
            }
        }
    } finally {
        draining = false;
    }
}
