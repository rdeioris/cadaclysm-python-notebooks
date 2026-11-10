// The notebook page: cells over one kernel worker. State is the `cells` array; the DOM is
// rebuilt per cell on change (a cell is small). Each output view is a View the kernel's
// worker hosts, over the bridge (viewer-client.js), made when the view is on screen and freed
// when it scrolls far away, so a long notebook never hits the browser's context cap.
import { captionOf, legendOf, documentRefusal } from "./notebook-scene.js";
import { EXAMPLES, scriptOf } from "./notebook-script.js";
import { createEditor } from "./vendor/editor.js";
import { attachViewer } from "./pkg/viewer-client.js";
import { activationListen } from "./pkg/view-activation.js";
import { createTransport } from "./notebook-transport.js";
import { filePicker, fileKeys } from "./file-picker.js";

const $ = (id) => document.getElementById(id);
// The cell the Open button adds for a file of the user's own.
const OPEN_CELL = (name) => `from cadaclysm_blacksmith import Solid

part = Solid.open(${JSON.stringify(name)})   # every body: Solid.open_all(...)
print("faces:", part.faces, "bounds:", part.bounds)
part`;
// The cell the Open button adds for a document (`.json`): it loads, and its results draw,
// each under its node's name -- so a document the notebook saved comes back as it was shown.
const OPEN_DOCUMENT_CELL = (name) => `from cadaclysm_blacksmith import Document

doc = Document.open(${JSON.stringify(name)})
show_document(doc)   # each node no other node reads, under its name`;
// { id, source, n, state: "idle"|"queued"|"running"|"done"|"error"|"stopped", stale, output, el, editor, client, view }
// `stale` is a number from before a Stop: the kernel that made it is gone, so it is greyed
// until the cell runs again, and its view says so instead of drawing. `client` is the bridge
// client of the cell's visible view, or null; `view` is that view's id. `transport` is a played
// job's `{ el, proxies, controls }` (notebook-transport.js), or null.
const cells = [];
let nextId = 1, counter = 0;
let worker = null, ready = false, booted = false, runningId = null;
// The message of a crash no cell owns (a view's), set by crashed() for the next boot(); that
// boot's note of it, on the kernel line through its stages and on its ready line.
let lastCrash = null, crashNote = "";
// The example the cells were loaded from, and whether to run it once the kernel is up
// (an example picked while it boots, or `?run=1` on the first boot).
let loaded = null, runOnReady = false;
// The name "Save document" saves under (`<name>.json`): the example's, or the document opened.
let documentName = "notebook";
// The document's file, as the forge keeps it: the first Save asks where, the next write back
// (ctrl-shift-S asks again). Open is a picker of its own, for a CAD file is never written back.
const documentFile = filePicker({ name: "notebook.json" });
const openPicker = filePicker({ description: "a CAD file or a blacksmith document", accept: { "application/octet-stream": [".step", ".stp", ".sat", ".3dm", ".brep", ".brp", ".iges", ".igs", ".ifc"], "application/json": [".json"] } });
let saveAsNew = false;
// Submitted cells in submission order -- the order the worker runs them in, since it takes
// `run` messages first in, first out. The first key is the cell the worker is on.
const pending = new Map();   // id -> { resolve, started }
// Files the open button read, by name: sent to every worker as it is made, since a Stop or
// a Restart makes a new kernel with an empty file system, and kept as the page's own copy
// (each worker gets a copy of the bytes, never the page's buffer, which a transfer would
// empty). They never leave the page.
const files = new Map();   // name -> ArrayBuffer
// Completion requests in flight, by number: answered in order, dropped (null) on a reboot.
const asking = new Map();    // ask -> resolve
let asks = 0;
// The cells' views: each made when its cell's output scrolls near, over the bridge
// (viewer-client.js) to a View the worker hosts, and freed when it scrolls far away. A
// view's id is never reused -- a canvas hands its drawing to a worker once only, so a view
// made again is a fresh canvas and a fresh id. `clients` routes the worker's view.* back.
const clients = new Map();   // view id -> client
let viewIds = 0;
// pkg/view.js (`listen`, the canvas's events for the View's gestures, and a played job's
// controls, `attachTimelineControls` and `attachMachiningControls`); loaded once, before
// the first boot. Null if it failed to load: then no view is made, and the page says why
// (`viewJsError`, in each view's caption).
let viewJs = null, viewJsError = null;
const params = new URLSearchParams(location.search);
// "exact" or "triangles", for every cell's view: `?surfaces=triangles`, or the toolbar's
// setting.
let surfaces = params.get("surfaces") === "triangles" ? "triangles" : "exact";

function supported() {
    // WebGPU, or else WebGL2: either draws a view.
    let gpu = !!navigator.gpu;
    if (!gpu) {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl2");
        gl?.getExtension("WEBGL_lose_context")?.loseContext();   // a probe, not a view: give it back
        gpu = !!gl;
    }
    return !!(gpu && window.Worker && window.WebAssembly && "transferControlToOffscreen" in HTMLCanvasElement.prototype);
}

// ---- the worker ------------------------------------------------------------------

function boot() {
    ready = false;
    // A view's crash names no cell: its reason stays on the kernel line while the kernel
    // comes back, and after.
    crashNote = lastCrash ? ` · restarted: a view crashed the kernel: ${lastCrash}` : "";
    lastCrash = null;
    setKernel("loading…" + crashNote, crashNote ? "dead" : "");
    $("run-all").disabled = true;
    $("save-document").disabled = true;
    for (const c of cells) renderGutter(c);
    const own = new Worker(new URL("./notebook-worker.js", import.meta.url), { type: "module" });
    worker = own;
    // Queued ahead of any cell: the worker takes its messages first in, first out.
    for (const [name, bytes] of files) sendFile(name, bytes);
    // Only the current worker is heard: a terminated one's late `crashed` (a poisoned wasm
    // can post several before the terminate lands) must not reboot the fresh one.
    worker.onmessage = ({ data }) => {
        if (worker !== own) return;
        if (data.kind === "boot") setKernel({ pyodide: "loading python…", numpy: "loading numpy…", module: "loading the kernel…", ready: "ready" }[data.stage] + crashNote, crashNote ? "dead" : "");
        else if (data.kind === "ready") {
            ready = true;
            const v = data.versions;
            setKernel(`kernel ready · Python ${v.python} · blacksmith ${v.blacksmith}` + crashNote, "ready");
            $("versions").textContent = `cadaclysm_blacksmith ${v.blacksmith} · wasm ${v.wasm} · pyodide ${v.pyodide}`;
            $("run-all").disabled = false;
            $("save-document").disabled = false;
            for (const c of cells) renderGutter(c);
            // `?run=1` runs the notebook once, on the first boot -- not again after a Stop.
            if (!booted && new URLSearchParams(location.search).get("run") === "1") runOnReady = true;
            booted = true;
            if (runOnReady) { runOnReady = false; runAll(); }
        }
        else if (data.kind === "progress") progress(data);
        else if (data.kind === "completion" || data.kind === "signature") { asking.get(data.ask)?.(data.kind === "completion" ? data.items : data.tip); asking.delete(data.ask); }
        else if (data.kind === "view.timeline") timelineState(data);
        else if (typeof data.kind === "string" && data.kind.startsWith("view.")) clients.get(data.id)?.receive(data);
        else if (data.kind === "done") finish(data);
        else if (data.kind === "written") saveWritten(data);
        else if (data.kind === "document") documentSaved(data);
        else if (data.kind === "document-failed") setKernel(`could not save the document: ${data.message}`, "dead");
        else if (data.kind === "crashed") crashed(data);
        else if (data.kind === "file-failed") setKernel(`could not open ${data.name}: ${data.message}`, "dead");
        else if (data.kind === "boot-failed") setKernel(`the kernel failed to load${{ pyodide: " (python)", numpy: " (numpy)", module: " (the kernel module)" }[data.stage] ?? ""}: ${data.message}`, "dead");
    };
    // A script error in the worker itself; a failure past that comes as `boot-failed`. Either
    // way `ready` stays false: the cells stay editable, their run buttons disabled.
    worker.onerror = (e) => { if (worker !== own) return; setKernel(`the kernel failed to load: ${e.message}`, "dead"); };
}

function sendFile(name, bytes) {
    const copy = bytes.slice(0);
    worker.postMessage({ kind: "file", name, bytes: copy }, [copy]);
}

// A file of the user's own, into the kernel beside the cells, and a cell that opens it: the
// notebook ships no sample, so this is how an imported part reaches it. A `.json` is a
// blacksmith document, refused in words when it is not one.
async function openFile(file) {
    const bytes = await file.arrayBuffer();
    const isDocument = /\.json$/i.test(file.name);
    if (isDocument) {
        const refused = documentRefusal(new TextDecoder().decode(bytes));
        if (refused) { setKernel(`could not open ${file.name}: ${refused}`, "dead"); return; }
        documentName = file.name.replace(/\.json$/i, ""); documentFile.forget();
    }
    files.set(file.name, bytes);
    sendFile(file.name, bytes);
    const cell = addCell((isDocument ? OPEN_DOCUMENT_CELL : OPEN_CELL)(file.name), cells[cells.length - 1]);
    cell.el.scrollIntoView({ block: "nearest" });
    runCell(cell);
}

// The document of every cell's shown solids, sheets and profiles, from the kernel, saved as
// `<name>.json`. Asked in turn behind the cells already sent, so it holds what they show.
function saveDocument(asNew = false) {
    if (!ready) return;
    saveAsNew = asNew;
    worker.postMessage({ kind: "document", name: documentName });
}

async function documentSaved({ name, text }) {
    try { await documentFile.save(text, { asNew: saveAsNew, name: `${name}.json` }); }
    catch (e) { setKernel(`save: ${e.message}`, "error"); }
}

function setKernel(text, cls) {
    $("kernel-text").textContent = text;
    $("kernel").className = cls;
}

function runCell(cell) {
    if (!ready || cell.state === "running" || cell.state === "queued") return Promise.resolve();
    cell.source = cell.editor.state.doc.toString();   // whatever is in the editor, however it got there
    cell.state = "queued";
    cell.stale = false;
    cell.n = ++counter;
    cell.output = null;
    renderOutput(cell);
    renderGutter(cell);
    return new Promise((resolve) => {
        pending.set(cell.id, { resolve, started: performance.now() });
        worker.postMessage({ kind: "run", id: cell.id, source: cell.source, n: cell.n, order: cells.map((c) => c.id) });
        promote();
    });
}

// The kernel's completions and call tips for the editor. Not asked while a cell runs or
// waits: the worker is single-threaded, and the answer would come after the cell, for a
// namespace it changed.
function askKernel(kind, source, cursor) {
    if (!ready || pending.size) return Promise.resolve(null);
    const ask = ++asks;
    return new Promise((resolve) => {
        asking.set(ask, resolve);
        worker.postMessage({ kind, ask, source, cursor });
    });
}

// The cell at the head of `pending` is the one the worker is running: mark it so, once.
function promote() {
    runningId = pending.keys().next().value ?? null;
    const cell = cells.find((c) => c.id === runningId);
    if (cell && cell.state === "queued") { cell.state = "running"; renderGutter(cell); renderOutput(cell); }
}

function progress({ id, phase, done, total, elapsed }) {
    const cell = cells.find((c) => c.id === id);
    if (!cell || cell.state !== "running") return;
    const busy = cell.el.querySelector(".busy");
    if (!busy) return;
    busy.querySelector(".phase").textContent = total ? `${phase} · ${done} of ${total}` : phase;
    busy.querySelector(".bar i").style.width = total ? `${Math.round(100 * done / total)}%` : "0";
    busy.querySelector(".time").textContent = `${(elapsed / 1000).toFixed(1)} s`;
}

function finish(data) {
    const cell = cells.find((c) => c.id === data.id);
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (cell) {
        cell.state = data.error ? "error" : "done";
        cell.output = data;
        renderGutter(cell);
        renderOutput(cell);
    }
    promote();   // the next submitted cell, in the worker's order
    p?.resolve(data);
}

// The bytes of a file a cell wrote, as the browser's download of that name.
function saveWritten({ name, bytes }) {
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function crashed({ id, message }) {
    const cell = cells.find((c) => c.id === id);
    if (cell) { cell.state = "error"; cell.output = { stdout: "", error: `the kernel crashed on this cell:\n${message}`, solids: [], timings: [], ms: 0 }; }
    else lastCrash = message;   // a view's: boot() says it
    stopKernel(false);   // the queue, the promises and the reboot, as for Stop
}

// Stop and Restart both terminate the worker: a blocked worker cannot be signalled.
// Every live view is freed first (its input listeners, its size watch), while the worker that
// hosts it is still there to hear the `view.free`; `clients` is then empty.
function stopKernel(clear) {
    for (const c of cells) dropView(c, true);
    worker?.terminate();
    ready = false;
    for (const c of cells) {
        if (c.state === "running") { c.state = "stopped"; c.output = { stdout: "", error: "stopped -- the kernel's state is lost; run the cells again", solids: [], timings: [], ms: 0 }; }
        else if (c.state === "queued") c.state = "idle";
        c.stale = !clear && c.state !== "idle";
        if (clear) { c.output = null; c.state = "idle"; c.n = 0; }
    }
    if (clear) counter = 0;
    pending.forEach((p) => p.resolve(null));
    pending.clear();
    asking.forEach((resolve) => resolve(null));
    asking.clear();
    runningId = null;
    for (const c of cells) { renderGutter(c); renderOutput(c); }
    boot();
}

async function runAll() {
    for (const c of cells) {
        const r = await runCell(c);
        if (!r || r.error) break;
        // A frame between cells: the finished cell's view is observed, and its view-of and
        // view.create posted, ahead of the next `run` -- else they wait behind it in the
        // worker's queue and every view stays blank until the whole run ends. A hidden tab
        // has no frames: a timeout stands in.
        await nextFrame();
    }
}

function nextFrame() {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
    });
}

// ---- cells --------------------------------------------------------------------------

function addCell(source = "", after = null) {
    const cell = { id: nextId++, source, n: 0, state: "idle", stale: false, output: null, el: null, editor: null, client: null, view: null, transport: null };
    const at = after ? cells.indexOf(after) + 1 : cells.length;
    cells.splice(at, 0, cell);
    cell.el = document.createElement("div");
    cell.el.className = "cell";
    cell.el.innerHTML = `<div class="gutter"><span class="n"></span><button class="run" title="run (Shift+Enter)">▶</button><button class="delete" title="delete cell">✕</button></div><div class="code"></div><div class="out"></div>`;
    cell.editor = createEditor({
        parent: cell.el.querySelector(".code"),
        doc: source,
        onChange: (text) => { cell.source = text; },
        onRun: (advance) => {
            runCell(cell);
            if (advance) (cells[cells.indexOf(cell) + 1] ?? addCell("", cell)).editor.focus();
        },
        complete: (source, cursor) => askKernel("complete", source, cursor),
        signature: (source, cursor) => askKernel("signature", source, cursor),
    });
    cell.el.querySelector(".run").addEventListener("click", () => runCell(cell));
    cell.el.querySelector(".delete").addEventListener("click", () => deleteCell(cell));
    const anchor = after ? after.el.nextSibling : null;
    $("cells").insertBefore(cell.el, anchor);
    renderGutter(cell);
    return cell;
}

// The cells replaced by an example's (asked first when the cells are not as some example
// left them -- an edit would be lost), the URL's `?example=` kept in step, and the
// example run -- now, or as soon as the kernel is up. A run in progress is stopped as
// the Stop button stops it (the worker re-made): a queued cell's source is with the
// worker already, and it is a cell about to go.
function loadExample(id) {
    const example = EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
    const pristine = !loaded || (cells.length === loaded.cells.length && cells.every((c, i) => c.source === loaded.cells[i]));
    if (!pristine && !confirm("Replace the cells with this example? The edits here will be lost.")) return false;
    if (pending.size) stopKernel(true);
    for (const c of cells.slice()) { dropView(c); releaseTransport(c); worker?.postMessage({ kind: "forget", cell: c.id }); c.editor.destroy(); c.el.remove(); }
    cells.length = 0;
    for (const s of example.cells) addCell(s);
    loaded = example;
    documentName = example.id; documentFile.forget();
    $("example").value = example.id;
    const url = new URL(location.href);
    if (example === EXAMPLES[0]) url.searchParams.delete("example"); else url.searchParams.set("example", example.id);
    history.replaceState(null, "", url);
    window.scrollTo({ top: $("cells").offsetTop - 16 });
    if (ready) runAll(); else runOnReady = true;
    return true;
}

function deleteCell(cell) {
    // A queued cell's source is already with the worker; it would run on, unseen.
    if (cell.state === "running" || cell.state === "queued") return;
    dropView(cell);
    releaseTransport(cell);
    worker?.postMessage({ kind: "forget", cell: cell.id });
    cells.splice(cells.indexOf(cell), 1);
    cell.editor.destroy();
    cell.el.remove();
    if (!cells.length) addCell();
}

function renderGutter(cell) {
    const g = cell.el.querySelector(".gutter");
    g.classList.toggle("stale", cell.stale);
    g.querySelector(".n").textContent = cell.state === "running" || cell.state === "queued" ? "[*]" : cell.n ? `[${cell.n}]` : "[ ]";
    cell.el.querySelector(".run").disabled = !ready;
}

function renderOutput(cell) {
    const out = cell.el.querySelector(".out");
    dropView(cell);
    releaseTransport(cell);
    out.textContent = "";
    if (cell.state === "running") {
        out.innerHTML = `<div class="busy"><span class="phase">running</span><span class="bar"><i></i></span><span class="time">0.0 s</span><button class="tb stop">■ stop</button></div>`;
        out.querySelector(".stop").addEventListener("click", () => stopKernel(false));
        return;
    }
    if (cell.state === "queued") { out.innerHTML = `<div class="busy"><span class="phase">queued</span></div>`; return; }
    const o = cell.output;
    if (!o) return;
    // What the cell wrote, stdout and stderr where they fell; stderr (a warning, a log
    // line) in its own colour. An output with no `streams` (a crash, a stop) has none.
    if (o.streams?.length) {
        const pre = document.createElement("pre");
        pre.className = "stdout";
        for (const [name, text] of o.streams) {
            if (name === "stderr") { const span = document.createElement("span"); span.className = "stderr"; span.textContent = text; pre.appendChild(span); }
            else pre.appendChild(document.createTextNode(text));
        }
        out.appendChild(pre);
    }
    if (o.error) { const pre = document.createElement("pre"); pre.className = "err"; pre.textContent = o.error; out.appendChild(pre); }
    // Files the cell wrote (`part.step("plate.stp")`), each a download: the kernel keeps the
    // bytes and hands them over when the link is clicked.
    if (o.written?.length) {
        const files = document.createElement("div");
        files.className = "written";
        for (const name of o.written) {
            const a = document.createElement("a");
            a.href = "#";
            a.textContent = `${name} ↓`;
            a.addEventListener("click", (e) => { e.preventDefault(); worker?.postMessage({ kind: "written", name }); });
            files.appendChild(a);
        }
        out.appendChild(files);
    }
    if (o.solids?.length) {
        const view = document.createElement("div");
        view.className = "view";
        const timings = o.timings.map(([w, ms]) => `${w} ${ms} ms`).join(" · ");
        // A stale cell's solids were in the kernel a Stop, a Restart or a crash has since
        // ended: its caption and legend stay, and its view says so instead of drawing.
        const drawing = cell.stale
            ? `<span class="gone">the kernel was restarted -- run the cell again to draw it</span>`
            : `<canvas></canvas>`;
        view.innerHTML = `${drawing}<span class="cap">${captionOf(o.solids)}${timings ? " · " + timings : ""}</span><span class="hint">drag to orbit · right-drag to pan · wheel to zoom</span><span class="touch"><span class="off">tap to turn the view</span><span class="on">pinch to zoom · two fingers to pan</span></span>`;
        const legend = legendOf(o.solids);
        if (legend.length) view.appendChild(legendElement(legend));
        out.appendChild(view);
        watchView(cell, view);
        // A played job: its controls go under the view, once the job's first state comes.
        if (!cell.stale && o.solids.some((s) => s.kind === "machining")) {
            const el = document.createElement("div");
            el.className = "transport";
            out.appendChild(el);
            const send = (command, value) => {
                if (cell.view !== null) worker?.postMessage({ kind: "view.transport", id: cell.view, command, value });
                else cell.transport?.proxies.reset();   // dropped: nothing will answer it
            };
            cell.transport = { el, controls: null, proxies: createTransport({ send }) };
        }
    }
}

// Which solids are closed (notebook-scene.js `legendOf`): a chip per solid, a swatch in
// the colour it is drawn in, its number, and what its topology says.
function legendElement(entries) {
    const legend = document.createElement("div");
    legend.className = "legend";
    const css = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(", ")})`;
    for (const e of entries) {
        const chip = document.createElement("span");
        chip.className = `chip ${e.state}`;
        if (e.colour) {
            const swatch = document.createElement("i");
            swatch.style.background = css(e.colour);
            chip.appendChild(swatch);
        }
        const label = document.createElement("span");
        label.textContent = entries.length > 1 && e.number ? `${e.number} · ${e.text}` : e.text;
        chip.appendChild(label);
        legend.appendChild(chip);
    }
    return legend;
}

// ---- views ---------------------------------------------------------------------------

const watcher = new IntersectionObserver((entries) => {
    for (const e of entries) {
        const cell = cells.find((c) => c.el.contains(e.target));
        if (!cell) continue;
        if (e.isIntersecting) makeView(cell, e.target); else dropView(cell, true);
    }
}, { rootMargin: "600px 0px" });

function watchView(cell, view) { watcher.observe(view); }

function makeView(cell, view) {
    if (viewJsError && !cell.stale) { viewError(view, viewJsError); return; }
    if (cell.client || !worker || !viewJs || cell.stale || !view.querySelector("canvas")) return;
    const canvas = view.querySelector("canvas");
    // A caption an earlier view's error replaced (`viewError`) is the cell's own again.
    const cap = view.querySelector(".cap");
    if (cap?.dataset.caption !== undefined) { cap.textContent = cap.dataset.caption; cap.classList.remove("error"); }
    const id = ++viewIds;
    // Bound before the bridge's view.create, which follows it into the same queue.
    worker.postMessage({ kind: "view-of", view: id, cell: cell.id });
    const client = attachViewer({
        canvas, worker, id, controls: true, surfaces,
        backend: params.get("backend") ?? undefined,
        listen: activationListen({ view, baseListen: viewJs.listen }),
        onError: (m) => viewError(view, m),
    });
    // A double click frames what it hit, as it did before the View made that opt-in (through the
    // bridge's view.call, queued until the worker's View exists).
    client.view.setDoubleClickFrames(true);
    client.ready.catch((e) => { if (cell.client === client) viewError(view, `the view failed: ${e.message}`); });
    cell.client = client;
    cell.view = id;
    view.dataset.viewId = String(id);
    clients.set(id, client);
}

// A played job's state (notebook-machining.js): into its cell's proxies, whose controls are
// made on the first one -- the colour menu offers "deviation" only when the job has a part,
// which the state says -- and kept for the cell's output, across the views it scrolls
// through. `data-view` names the view the last state came from.
function timelineState({ id, state }) {
    const cell = cells.find((c) => c.view === id);
    const t = cell?.transport;
    if (!t) return;
    if (t.el.dataset.view !== String(id)) t.proxies.reset();   // a new view: no target of an older one's
    t.el.dataset.view = String(id);
    t.proxies.update(state);
    t.controls ??= [viewJs.attachTimelineControls(t.el, t.proxies.timeline), viewJs.attachMachiningControls(t.el, t.proxies.machining)];
}

function releaseTransport(cell) {
    for (const c of cell.transport?.controls ?? []) c.detach();
    cell.transport = null;
}

// A view's error, said in its caption's place; the caption kept, for a view made again.
function viewError(view, message) {
    const cap = view.querySelector(".cap");
    if (!cap) return;
    if (cap.dataset.caption === undefined) cap.dataset.caption = cap.textContent;
    cap.textContent = message;
    cap.classList.add("error");
}

// The view let go (its input listeners, its size watch, the worker's View) and its canvas
// replaced by a fresh copy: a canvas hands its drawing to a worker once only, so the next
// `makeView` (scrolled back) needs a new one.
function dropView(cell, keepView = false) {
    if (cell.client) {
        cell.client.free();
        clients.delete(cell.view);
        // Off too: a view dropped while on would come back looking on, its fresh canvas still
        // holding the page's swipes (`touch-action: none` comes over with the clone).
        cell.el.querySelector(".view")?.classList.remove("active");
        cell.el.querySelector(".view")?.removeAttribute("data-view-id");
        const canvas = cell.el.querySelector(".view canvas");
        if (canvas) {
            const fresh = canvas.cloneNode(false);
            fresh.style.touchAction = "";
            canvas.replaceWith(fresh);
        }
        cell.client = null;
        cell.view = null;
    }
    if (!keepView) { const view = cell.el.querySelector(".view"); if (view) watcher.unobserve(view); }
}

// ---- toolbar -------------------------------------------------------------------------

$("run-all").addEventListener("click", runAll);
$("add").addEventListener("click", () => addCell("", cells[cells.length - 1]).editor.focus());
$("add-end").addEventListener("click", () => addCell().editor.focus());
$("restart").addEventListener("click", () => stopKernel(true));
const openPicked = async () => {
    try {
        const picked = await openPicker.open();
        if (picked) openFile(picked.file);
    } catch (e) { setKernel(`open: ${e.message}`, "error"); }
};
$("open").addEventListener("click", openPicked);
$("save-document").addEventListener("click", () => saveDocument(false));
fileKeys({ save: (asNew) => { if (!$("save-document").disabled) saveDocument(asNew); }, open: () => { if (!$("open").disabled) openPicked(); } });
for (const e of EXAMPLES) {
    const o = document.createElement("option");
    o.value = e.id;
    o.textContent = e.title;
    o.title = e.blurb;
    $("example").appendChild(o);
}
$("triangles").checked = surfaces === "triangles";
$("triangles").addEventListener("change", () => {
    surfaces = $("triangles").checked ? "triangles" : "exact";
    const url = new URL(location.href);
    if (surfaces === "triangles") url.searchParams.set("surfaces", "triangles"); else url.searchParams.delete("surfaces");
    history.replaceState(null, "", url);
    for (const client of clients.values()) client.view.setSurfaces(surfaces).catch(() => {});
});
$("example").addEventListener("change", () => { if (!loadExample($("example").value)) $("example").value = loaded?.id ?? EXAMPLES[0].id; });
$("copy").addEventListener("click", async () => {
    const b = $("copy"); const was = b.textContent;
    try { await navigator.clipboard.writeText(scriptOf(cells.map((c) => c.source))); b.textContent = "copied"; }
    catch { b.textContent = "clipboard blocked"; }
    setTimeout(() => { b.textContent = was; }, 1200);
});

// ---- go --------------------------------------------------------------------------------

if (!supported()) {
    $("unsupported").style.display = "block";
    setKernel("unsupported browser", "dead");
    for (const id of ["add", "add-end", "copy", "restart", "open", "save-document", "example", "triangles"]) $(id).disabled = true;   // nothing behind them here
} else {
    // The example the URL names, else the first; its cells, and no run until asked.
    const first = EXAMPLES.find((e) => e.id === params.get("example")) ?? EXAMPLES[0];
    for (const s of first.cells) addCell(s);
    loaded = first;
    documentName = first.id;
    $("example").value = first.id;
    // view.js once, for every view's gestures. A failure is said in each view's caption (the
    // kernel's line is overwritten by its own "ready"), and the notebook still runs.
    const nearViews = () => { for (const c of cells) { const v = c.el.querySelector(".view"); if (!v) continue; const r = v.getBoundingClientRect(); if (r.top < innerHeight + 600 && r.bottom > -600) makeView(c, v); } };
    import("./pkg/view.js").then((m) => {
        viewJs = m;
        nearViews();   // views watched before it loaded: made now
    }, (e) => {
        viewJsError = `the view failed to load: ${e?.message ?? e} -- cells run, nothing is drawn`;
        setKernel(viewJsError, "dead");
        nearViews();
    });
    boot();
}
