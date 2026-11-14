// Puts what the notebook loads but does not commit here, in three git-ignored folders:
//
//   pkg/      the cadaclysm web package's pkg/ folder -- the WebAssembly module (the readers,
//             the kernel and the View) and its loader -- from the SDK's releases. The
//             closed-source part.
//   sdk/      the SDK's Python module, cadaclysm_blacksmith.py, which the kernel runs under
//             Pyodide over that module, and schemas/ap203.exp, from the SDK's repository at
//             the same release.
//   pyodide/  the Pyodide runtime (from the pyodide npm package: `npm install` first) and
//             the numpy wheels, fetched from Pyodide's CDN once and checked against its lock
//             file; and Pyodide's and CPython's licence texts, for THIRD-PARTY.txt.
//
//     npm run setup                          # the release pinned below, from GitHub
//     npm run setup -- --zip <package.zip>   # a package zip you already have
//     npm run setup -- --pkg <folder>        # a pkg/ folder (a local build of the package)
//     npm run setup -- --sdk <folder>        # an SDK checkout (python/, schemas/) for sdk/
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

// The notebook needs the View class and the Pyodide side of cadaclysm_blacksmith.py, which
// the SDK has from 0.14 on, and the kernel: the web package's pkg/ has all three.
const VERSION = "0.14.2";
const ASSET = `cadaclysm-${VERSION}-web.zip`;
const URL = `https://github.com/rdeioris/cadaclysm-sdk/releases/download/v${VERSION}/${ASSET}`;
const SDK = `https://raw.githubusercontent.com/rdeioris/cadaclysm-sdk/v${VERSION}`;
// What the notebook loads from the package: the module, and the page modules beside view.js
// (the View's host in the worker, its client on the page, tap-to-activate, the colours).
const NEEDED = ["cadaclysm.js", "cadaclysm_bg.wasm", "index.js", "view.js", "viewer-host.js", "viewer-client.js", "view-activation.js", "view-show.js", "view-canvas.js"];
// What it takes from the SDK, by their paths in the SDK's repository, and where each goes in sdk/.
const SDK_FILES = { "python/cadaclysm_blacksmith.py": "cadaclysm_blacksmith.py", "schemas/ap203.exp": "schemas/ap203.exp" };
// What `loadPyodide({ indexURL })` reads from pyodide/: the loader, the emscripten glue, the
// interpreter, the standard library and the package index the wheels are looked up in.
const RUNTIME = ["pyodide.mjs", "pyodide.js", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const WANTED = ["numpy"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function fetchBytes(url) {
    console.log(`fetching ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    return new Uint8Array(await response.arrayBuffer());
}

// The zip's pkg/ folder (`cadaclysm-<version>-web/pkg/...`): its files by their path in it.
function pkgOfZip(bytes) {
    const found = new Map();
    for (const [name, data] of Object.entries(unzipSync(new Uint8Array(bytes)))) {
        const m = /^[^/]+\/pkg\/(.+[^/])$/.exec(name);
        if (m) found.set(m[1], data);
    }
    return found;
}

// A folder's files by their path in it.
function filesOf(folder, at = folder, found = new Map()) {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) filesOf(folder, path, found);
        else found.set(relative(folder, path).replace(/\\/g, "/"), readFileSync(path));
    }
    return found;
}

// `files` (path -> bytes) written beside `out`, then swapped in: a failed setup leaves the
// folder there was.
function swapIn(out, files) {
    const next = `${out}.next`;
    rmSync(next, { recursive: true, force: true });
    for (const [name, data] of files) {
        mkdirSync(dirname(join(next, name)), { recursive: true });
        writeFileSync(join(next, name), data);
    }
    rmSync(out, { recursive: true, force: true });
    renameSync(next, out);
}

async function pkg() {
    let files, from;
    const folder = option("--pkg"), zip = option("--zip");
    if (folder) {
        files = filesOf(folder);
        from = folder;
    } else {
        files = pkgOfZip(zip ? readFileSync(zip) : await fetchBytes(URL));
        from = zip ?? ASSET;
    }
    const missing = NEEDED.filter((f) => !files.has(f));
    if (missing.length) throw new Error(`${from} has no ${missing.join(", ")}: the notebook needs the 0.14 web package's pkg/ (the kernel, the View and its page modules)`);
    swapIn(join(root, "pkg"), files);
    console.log(`pkg/ from ${from}: ${(statSync(join(root, "pkg", "cadaclysm_bg.wasm")).size / 1048576).toFixed(2)} MB of wasm`);
}

async function sdk() {
    const folder = option("--sdk");
    const files = new Map();
    for (const [path, name] of Object.entries(SDK_FILES)) {
        files.set(name, folder ? readFileSync(join(folder, path)) : await fetchBytes(`${SDK}/${path}`));
    }
    const module = new TextDecoder().decode(files.get("cadaclysm_blacksmith.py"));
    if (!module.includes('sys.platform == "emscripten"')) throw new Error("this cadaclysm_blacksmith.py has no Pyodide side: the notebook needs the SDK's 0.14 or later");
    swapIn(join(root, "sdk"), files);
    console.log(`sdk/ from ${folder ?? `the SDK's v${VERSION}`}: ${Object.values(SDK_FILES).join(", ")}`);
}

async function pyodide() {
    const src = join(root, "node_modules", "pyodide");
    if (!existsSync(join(src, "package.json"))) throw new Error("node_modules/pyodide is missing: run npm install first");
    const version = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version;
    const out = join(root, "pyodide");
    mkdirSync(join(out, "licenses"), { recursive: true });
    for (const name of RUNTIME) copyFileSync(join(src, name), join(out, name));
    const lock = JSON.parse(readFileSync(join(src, "pyodide-lock.json"), "utf8"));
    // The wheels numpy needs, with what they depend on, by the lock file's names and digests.
    const wheels = new Map();
    for (const todo = [...WANTED]; todo.length;) {
        const entry = lock.packages[todo.pop()];
        if (wheels.has(entry.file_name)) continue;
        wheels.set(entry.file_name, entry.sha256);
        todo.push(...(entry.depends ?? []));
    }
    for (const [file, sha256] of wheels) {
        const target = join(out, file);
        if (!existsSync(target)) writeFileSync(target, await fetchBytes(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${file}`));
        // Fetched now or kept from before, checked: what the page loads is what the pinned release built.
        const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
        if (digest !== sha256) {
            rmSync(target);
            throw new Error(`${file}: sha256 ${digest} is not the lock file's ${sha256}; removed -- run again`);
        }
    }
    for (const stray of readdirSync(out).filter((f) => f.endsWith(".whl") && !wheels.has(f))) rmSync(join(out, stray));
    // The licence texts the npm package does not carry, from the tags this runtime was built
    // from, checked by their titles: a 404 page must not pass for a licence.
    const python = lock.info.python;
    const licences = {
        [`pyodide-${version}.txt`]: [`https://raw.githubusercontent.com/pyodide/pyodide/${version}/LICENSE`, "Mozilla Public License Version 2.0"],
        [`cpython-${python}.txt`]: [`https://raw.githubusercontent.com/python/cpython/v${python}/LICENSE`, "PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2"],
    };
    for (const [name, [url, title]] of Object.entries(licences)) {
        const target = join(out, "licenses", name);
        if (existsSync(target)) continue;
        const text = new TextDecoder().decode(await fetchBytes(url));
        if (!text.includes(title)) throw new Error(`${url}: no '${title}' in it; not written`);
        writeFileSync(target, text);
    }
    for (const stray of readdirSync(join(out, "licenses")).filter((f) => !(f in licences))) rmSync(join(out, "licenses", stray));
    console.log(`pyodide/: pyodide ${version} + ${[...wheels.keys()].join(", ")}`);
}

async function main() {
    await pkg();
    await sdk();
    await pyodide();
}

main().catch((e) => {
    console.error(`setup: ${e.message}`);
    if (!option("--pkg") && !option("--zip")) console.error("(local copies: npm run setup -- --zip <package.zip> or --pkg <folder>, and --sdk <SDK checkout>)");
    process.exit(1);
});
