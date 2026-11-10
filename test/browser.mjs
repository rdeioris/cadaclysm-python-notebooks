// The headless-Chrome check: the page served by scripts/serve.mjs, in a Chrome or Edge you
// have installed, driven over the DevTools protocol (Node's own WebSocket: no dependency).
// For each example notebook asked: the page opens it with ?run=1, the kernel boots (Pyodide,
// numpy, the module), every cell runs with no error, every cell that shows something gets a
// live View with no error in its caption, a played job gets its timeline controls, and
// nothing is logged as an error by the page or its worker.
//
//     npm run test:browser                          # the first example (plate), the default backend
//     node test/browser.mjs --webgl2                # the WebGL2 fallback (?backend=webgl2)
//     node test/browser.mjs --example sweeps --example machining
//     node test/browser.mjs --all                   # every example
//     node test/browser.mjs --out test/out          # also a screenshot of each view
//     node test/browser.mjs --chrome <path to chrome or msedge>   (or the CHROME variable)
//     node test/browser.mjs --headed                # watch it
//
// Needs `npm run setup` and `npm run build` first. Exits 1 on the first example that fails.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { inflateSync } from "node:zlib";
import { EXAMPLES } from "../notebook-script.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const options = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const W = 1400, H = 1000;

function findChrome() {
    const given = options("--chrome")[0] ?? process.env.CHROME;
    if (given) return given;
    const candidates = process.platform === "win32"
        ? [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).flatMap((d) => [
            join(d, "Google", "Chrome", "Application", "chrome.exe"), join(d, "Microsoft", "Edge", "Application", "msedge.exe")])
        : process.platform === "darwin"
            ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
            : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
                "/usr/bin/microsoft-edge"];
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new Error("no Chrome or Edge found: pass --chrome <path> or set CHROME");
    return found;
}

const freePort = () => new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(200);
    }
}

// ---- what a view shows ---------------------------------------------------------------------
// A PNG's pixels (8-bit RGB or RGBA, not interlaced: what Chrome's screenshots are), as
// { width, height, channels, data }.
function decodePng(png) {
    let at = 8, width = 0, height = 0, channels = 0;
    const idat = [];
    while (at < png.length) {
        const length = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8), body = png.subarray(at + 8, at + 8 + length);
        if (type === "IHDR") {
            width = body.readUInt32BE(0); height = body.readUInt32BE(4);
            if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6)) throw new Error("a PNG this check does not read");
            channels = body[9] === 6 ? 4 : 3;
        } else if (type === "IDAT") idat.push(body);
        at += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, data = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? data[y * stride + x - channels] : 0, b = y ? data[(y - 1) * stride + x] : 0;
            const c = x >= channels && y ? data[(y - 1) * stride + x - channels] : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const predict = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
            data[y * stride + x] = (row[x] + predict) & 255;
        }
    }
    return { width, height, channels, data };
}

// How many colours (to 4 bits a channel) the middle of a view's screenshot has: the band
// between the legend at its top and the caption at its bottom. A View that has drawn shows
// its grid and what it was given there; one that has not is one flat colour.
function coloursDrawn(png) {
    const { width, height, channels, data } = decodePng(png);
    const seen = new Set();
    for (let y = Math.floor(height * 0.15); y < height * 0.85; y++) {
        for (let x = Math.floor(width * 0.05); x < width * 0.95; x++) {
            const i = (y * width + x) * channels;
            seen.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
        }
    }
    return seen.size;
}

// ---- a DevTools connection: one WebSocket to the browser, flat sessions ------------------
class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.next = 0;
        this.waiting = new Map();
        this.handlers = [];
        this.ws.onmessage = ({ data }) => {
            const m = JSON.parse(data);
            if (m.id !== undefined) {
                const w = this.waiting.get(m.id);
                this.waiting.delete(m.id);
                if (m.error) w?.reject(new Error(`${w.method}: ${m.error.message}`)); else w?.resolve(m.result);
            } else for (const h of this.handlers) h(m);
        };
    }
    open() { return new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = () => fail(new Error("DevTools connection failed")); }); }
    send(method, params = {}, sessionId) {
        const id = ++this.next;
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject, method }));
    }
    on(fn) { this.handlers.push(fn); }
    close() { this.ws.close(); }
}

async function launch(chrome, profile) {
    const flags = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${W},${H}`, "--no-first-run",
        "--no-default-browser-check", "--disable-extensions", "--enable-unsafe-webgpu", "--hide-scrollbars", "about:blank"];
    if (!flag("--headed")) flags.unshift("--headless=new");
    const child = spawn(chrome, flags, { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    const text = await until("Chrome's DevTools port", () => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n") && readFileSync(portFile, "utf8"), 30000);
    const [port, path] = text.trim().split("\n");
    return { child, url: `ws://127.0.0.1:${port}${path}` };
}

// ---- one example in a fresh tab ----------------------------------------------------------
async function checkExample(cdp, base, example, { webgl2, out }) {
    const errors = [];
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessions = new Set([sessionId]);
    const label = (s) => (s === sessionId ? "page" : "worker");
    cdp.on((m) => {
        if (!sessions.has(m.sessionId)) return;
        if (m.method === "Runtime.exceptionThrown") {
            const d = m.params.exceptionDetails;
            errors.push(`${label(m.sessionId)}: ${d.exception?.description ?? d.text}`);
        } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
            errors.push(`${label(m.sessionId)} console.error: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
        } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
            errors.push(`${label(m.sessionId)} log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
        } else if (m.method === "Target.attachedToTarget") {
            // The kernel's worker: its console and exceptions too.
            const s = m.params.sessionId;
            sessions.add(s);
            cdp.send("Runtime.enable", {}, s).catch(() => {});
            cdp.send("Log.enable", {}, s).catch(() => {});
            cdp.send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
        }
    });
    const send = (method, params) => cdp.send(method, params, sessionId);
    async function evaluate(expression) {
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
    }
    const kernelLine = () => evaluate(`({ text: document.getElementById("kernel-text").textContent, cls: document.getElementById("kernel").className })`);
    const nthView = (i) => `document.querySelectorAll("#cells .out .view")[${i}]`;
    try {
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await send("Runtime.enable");
        await send("Log.enable");
        await send("Page.enable");
        // In front, with focus: a background tab gets no animation frames, and the views draw on them.
        await send("Page.bringToFront");
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        const started = Date.now();
        await send("Page.navigate", { url: `${base}/?example=${example.id}&run=1${webgl2 ? "&backend=webgl2" : ""}` });
        // The kernel up: Pyodide, numpy and the module loaded.
        await until("the kernel", async () => {
            const k = await kernelLine().catch(() => null);
            if (k?.cls === "dead") throw new Error(`the kernel line says: ${k.text}`);
            return k?.cls === "ready";
        }, 180000);
        const booted = Date.now();
        // Every cell run: a number in its gutter, nothing queued or running, no error under it.
        const cells = await until("every cell to run", async () => {
            const k = await kernelLine();
            if (k.cls === "dead") throw new Error(`the kernel line says: ${k.text}`);
            const cells = await evaluate(`[...document.querySelectorAll("#cells .cell")].map((c) => ({
                n: c.querySelector(".gutter .n").textContent,
                error: c.querySelector(".out .err")?.textContent ?? null,
            }))`);
            const failed = cells.findIndex((c) => c.error);
            if (failed >= 0) throw new Error(`cell ${failed + 1}: ${cells[failed].error}`);
            return cells.every((c) => /^\[\d+\]$/.test(c.n)) && cells;
        }, 600000);
        if (cells.length !== example.cells.length) throw new Error(`${cells.length} cells, the example has ${example.cells.length}`);
        const ran = Date.now();
        // Each view, scrolled into sight: a View made for it, and no error in its caption.
        const views = await evaluate(`document.querySelectorAll("#cells .out .view").length`);
        if (!views) throw new Error("no cell drew anything");
        for (let i = 0; i < views; i++) {
            await evaluate(`${nthView(i)}.scrollIntoView({ block: "center" })`);
            const caption = () => evaluate(`${nthView(i)}.querySelector(".cap.error")?.textContent ?? null`);
            await until(`view ${i + 1}'s View`, async () => {
                const error = await caption();
                if (error) throw new Error(`view ${i + 1}: ${error}`);
                return evaluate(`!!${nthView(i)}.dataset.viewId`);
            }, 60000);
            // Drawn: the view's pixels, as the page shows them, more than one flat colour.
            let png = null;
            await until(`view ${i + 1} to draw`, async () => {
                const late = await caption();
                if (late) throw new Error(`view ${i + 1}: ${late}`);
                const r = await evaluate(`(() => { const b = ${nthView(i)}.getBoundingClientRect(); return [b.x + scrollX, b.y + scrollY, b.width, b.height]; })()`);
                const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: r[0], y: r[1], width: r[2], height: r[3], scale: 1 } });
                png = Buffer.from(shot.data, "base64");
                return coloursDrawn(png) >= 8;
            }, 120000).finally(() => {
                if (out && png) {
                    mkdirSync(out, { recursive: true });
                    writeFileSync(join(out, `${example.id}-${i + 1}${webgl2 ? "-webgl2" : ""}.png`), png);
                }
            });
        }
        // A played job: its timeline under the view, once the job's first state came.
        const jobs = await evaluate(`document.querySelectorAll("#cells .out .transport").length`);
        if (jobs) await until("the job's timeline", () => evaluate(`document.querySelectorAll("#cells .transport .cadaclysm-timeline").length > 0`), 30000);
        await sleep(300);   // late console errors
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        console.log(`ok - ${example.id}: ${webgl2 ? "webgl2" : "default backend"}, kernel up in ${((booted - started) / 1000).toFixed(1)} s, ` +
            `${cells.length} cells ran in ${((ran - booted) / 1000).toFixed(1)} s, ${views} view${views === 1 ? "" : "s"} drawn` +
            (jobs ? `, ${jobs} job${jobs === 1 ? "" : "s"} with a timeline` : ""));
    } catch (e) {
        // What the page showed when it failed, beside the screenshots of those that passed.
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(join(out, `${example.id}${webgl2 ? "-webgl2" : ""}-failed.png`), Buffer.from(shot.data, "base64"));
        }
        if (errors.length && !/errors logged/.test(e.message)) e.message += `\n  errors logged:\n  ${errors.join("\n  ")}`;
        throw e;
    } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
}

async function main() {
    for (const need of ["pkg/cadaclysm_bg.wasm", "sdk/cadaclysm_blacksmith.py", "pyodide/pyodide.mjs"]) {
        if (!existsSync(join(root, need))) throw new Error(`no ${need}: run \`npm run setup\` first`);
    }
    if (!existsSync(join(root, "vendor", "editor.js"))) throw new Error("no vendor/editor.js: run `npm run build` first");
    const ids = options("--example");
    for (const id of ids) if (!EXAMPLES.some((e) => e.id === id)) throw new Error(`no example ${id}: ${EXAMPLES.map((e) => e.id).join(", ")}`);
    const asked = flag("--all") ? EXAMPLES : ids.length ? EXAMPLES.filter((e) => ids.includes(e.id)) : [EXAMPLES[0]];
    const out = options("--out")[0] ? resolve(options("--out")[0]) : null;

    const port = await freePort();
    const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((ok) => server.stdout.once("data", ok));
    const profile = mkdtempSync(join(tmpdir(), "notebook-chrome-"));
    const { child, url } = await launch(findChrome(), profile);
    const cdp = new Cdp(url);
    let failed = 0;
    try {
        await cdp.open();
        for (const example of asked) {
            try {
                await checkExample(cdp, `http://127.0.0.1:${port}`, example, { webgl2: flag("--webgl2"), out });
            } catch (e) {
                failed++;
                console.error(`not ok - ${example.id}: ${e.message}`);
                break;
            }
        }
    } finally {
        cdp.close();
        const exited = new Promise((ok) => child.once("exit", ok));
        child.kill();
        server.kill();
        await Promise.race([exited, sleep(5000)]);
        // Chrome's helpers can hold a file a moment longer: a profile left in the temp folder is no failure.
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left behind */ }
    }
    if (failed) process.exit(1);
}

main().catch((e) => { console.error(`browser: ${e.message}`); process.exit(1); });
