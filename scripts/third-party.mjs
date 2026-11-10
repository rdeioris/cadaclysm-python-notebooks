// Writes THIRD-PARTY.txt: one section per component the page serves that is not the
// notebook's own, its licence text verbatim, copied from what is served so it cannot drift --
// the Pyodide and CPython texts `npm run setup` took from their source tags, numpy's from
// its wheel, each npm package's own LICENSE for every package esbuild's metafile says went
// into vendor/editor.js, and the font's.
//
//     npm run licences      (after npm run setup and npm run build)
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rule = "=".repeat(78);
const sections = [];
const section = (title, lines, text) => sections.push([rule, title, ...lines, rule, "", text.trim(), ""].join("\n"));
const text = (path) => readFileSync(path, "utf8");

function one(folder, pattern) {
    const found = existsSync(folder) ? readdirSync(folder).filter((f) => pattern.test(f)) : [];
    if (found.length !== 1) throw new Error(`${folder}: expected one file like ${pattern}, found ${found.length} -- run npm run setup`);
    return join(folder, found[0]);
}

const licences = join(root, "pyodide", "licenses");
const pyodide = one(licences, /^pyodide-.+\.txt$/);
const version = /pyodide-(.+)\.txt$/.exec(pyodide)[1];
section(`Pyodide ${version} -- Mozilla Public License 2.0`,
    ["The Python runtime in pyodide/, served unmodified. Source:", `https://github.com/pyodide/pyodide/tree/${version}`], text(pyodide));
const cpython = one(licences, /^cpython-.+\.txt$/);
const python = /cpython-(.+)\.txt$/.exec(cpython)[1];
section(`CPython ${python} -- Python Software Foundation License`,
    ["The interpreter and standard library inside Pyodide. Source:", `https://github.com/python/cpython/tree/v${python}`], text(cpython));

// numpy: the wheel's own LICENSE.txt first, then the vendored components' in its tree.
const wheel = one(join(root, "pyodide"), /^numpy-.+\.whl$/);
const files = unzipSync(readFileSync(wheel), { filter: (f) => /^numpy-[^/]+\.dist-info\/licenses\//.test(f.name) });
const names = Object.keys(files).filter((n) => !n.endsWith("/"));
if (!names.length) throw new Error(`${wheel}: no dist-info/licenses/ in the wheel`);
const release = /^numpy-([^/]+)\.dist-info\//.exec(names[0])[1];
names.sort((a, b) => (a.endsWith("/licenses/LICENSE.txt") ? -1 : b.endsWith("/licenses/LICENSE.txt") ? 1 : a < b ? -1 : 1));
for (const n of names) {
    const part = n.split("/licenses/")[1];
    section(part === "LICENSE.txt" ? `numpy ${release} -- BSD 3-Clause License` : `numpy ${release}: ${part}`,
        ["From the numpy wheel in pyodide/. Source: https://github.com/numpy/numpy"], new TextDecoder().decode(files[n]));
}

// Every npm package esbuild put into vendor/editor.js, grouped by identical licence text.
const metafile = join(root, "vendor", "editor.meta.json");
if (!existsSync(metafile)) throw new Error("vendor/editor.meta.json is missing: run npm run build");
const meta = JSON.parse(text(metafile));
const packages = new Set();
for (const output of Object.values(meta.outputs)) {
    for (const path of Object.keys(output.inputs)) {
        const m = /^(node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
        if (m) packages.add(m[1]);
    }
}
const byText = new Map();
for (const dir of [...packages].sort()) {
    const pkg = JSON.parse(text(join(root, dir, "package.json")));
    const licence = readdirSync(join(root, dir)).sort().find((n) => /^licen[cs]e/i.test(n));
    if (!licence) throw new Error(`${dir}: no LICENSE file to ship`);
    const body = text(join(root, dir, licence)).trim();
    if (!byText.has(body)) byText.set(body, []);
    byText.get(body).push(`${pkg.name} ${pkg.version} (${pkg.license})`);
}
for (const [body, list] of byText) {
    section("The cells' editor: CodeMirror and Lezer (vendor/editor.js)", ["Bundled unmodified by esbuild from these npm packages:", ...list.map((p) => `  ${p}`)], body);
}

section("Quantico -- SIL Open Font License 1.1", ["The display font in font/, served unmodified."], text(join(root, "font", "OFL.txt")));

const head = "Third-party software in the cadaclysm Python notebook\n\n" +
    "The page serves these components, unmodified, under their own licences; their full\n" +
    "texts follow. Nothing here covers cadaclysm itself.\n\n";
writeFileSync(join(root, "THIRD-PARTY.txt"), head + sections.join("\n"));
console.log(`THIRD-PARTY.txt: ${sections.length} sections`);
