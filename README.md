# cadaclysm Python notebook

A Python notebook that runs in the browser on the [cadaclysm](https://cadaclysm.blitter.studio/)
CAD kernel. Each cell is Python against `cadaclysm_blacksmith`, the module the SDK ships for
desktop Python. Here it runs under Pyodide over the kernel's WebAssembly build. A cell that
ends in a solid, a profile or an assembly draws it in a 3D view under the cell, and so does
anything passed to `show()`. A machining `Job` plays its cut on a timeline. **Save document**
writes what the views show as a blacksmith document (`.json`), and **Open a file…** reads one
back, or a STEP, SAT, 3DM, BREP, IGES or IFC file. **Copy as script** gives the notebook as a
`.py` file that runs unchanged next to the desktop library.

Everything runs in your browser, in a worker. Nothing is uploaded.

The menu holds twelve example notebooks: a plate with a boss and a bore, outlines, press-pull,
sweeps, revolves and lofts, shells, booleans, frames, a SubD cage made into a solid, a drone
motor, a small rover assembly, and a machining job.

## Architecture

```
index.html ── notebook.js (the page) ─── cells: CodeMirror editors (vendor/editor.js, from editor.js)
                 │  notebook-script.js     the example notebooks, Copy as script
                 │  notebook-scene.js      a view's caption and legend
                 │  notebook-transport.js  a played job's controls (pkg/view.js draws them)
                 │  pkg/viewer-client.js   each view's canvas, handed to the worker,
                 │  pkg/view-activation.js its size, input and picks
                 ▼   postMessage: run / complete / document / file / view.*
            notebook-worker.js (module worker)
                 ├─ kernel.js ── Pyodide (pyodide/) + numpy
                 │                 sdk/cadaclysm_blacksmith.py ─┐
                 │                 notebook_support.py          │ globalThis.cadaclysm
                 │                                              ▼
                 ├─ pkg/index.js ── the cadaclysm web package: cadaclysm_blacksmith_* (the kernel)
                 │                                             and View (WebGPU, WebGL2 fallback)
                 ├─ notebook-views.js, notebook-mesh.js   what each cell shows, kept as snapshots
                 │    (colours and framing from pkg/view-show.js)
                 ├─ notebook-machining.js                 a played job's timeline
                 └─ pkg/viewer-host.js ── a View per visible cell's view
```

- **Page and worker.** The page (`notebook.js`) holds the cells and their editors and draws
  nothing itself. One module worker (`notebook-worker.js`) holds everything heavy: the
  WebAssembly module, Pyodide and the Views. A cell runs on the worker, so a long boolean never
  blocks the page. **Stop** and **Restart** terminate the worker and make a new one, because a
  worker busy in the kernel cannot be interrupted. If the module traps, the worker reports the
  crash and the page replaces it the same way.
- **The kernel** (`kernel.js`) boots Pyodide from `pyodide/`, loads numpy, and puts the
  package's exports on `globalThis.cadaclysm`. That is where the SDK's
  `cadaclysm_blacksmith.py` looks when it runs under Pyodide (`sys.platform == "emscripten"`)
  instead of loading the native library. The kernel writes that module and `notebook_support.py`
  into Pyodide's file system and imports them. `notebook_support` adds `show()` and
  `show_document()` to the cells' namespace. It also times the long calls (join, cut, fillet…)
  for the caption, and keeps what each cell showed for the document.
- **Running a cell.** The worker runs cells one at a time, in the order the page sent them.
  `pyodide.runPython` runs the cell and returns its last expression.
  `notebook_support._end` turns that value, plus anything passed to `show()`, into kernel
  handles. While the kernel works, its progress hook posts the phase and a progress bar to the
  page. stdout and stderr come back in the order they were written. An exception comes back as
  a traceback with Pyodide's own frames removed. Tab completion and call tips are answered from
  the live namespace while no cell is running.
- **Views.** The worker does not send meshes to the page. It keeps a snapshot of each cell's
  output (`notebook-views.js`): a second handle on each solid, a profile's outline segments,
  an assembly's scene. The page gets only the summary for the caption and the legend. When a
  cell's view scrolls near the screen, the page hands its canvas to the worker as an
  OffscreenCanvas (`pkg/viewer-client.js`). The worker makes a `View` on it (`pkg/viewer-host.js`) and
  shows the snapshot: exact surfaces, or triangles with the **triangles** box. When the view
  scrolls far away, the page frees it, so a long notebook stays under the browser's limit on
  GPU contexts. Drag to orbit, right-drag to pan, wheel to zoom, double-click to frame what you
  hit. On a touch screen, tap a view to turn it on.
- **Machining.** A cell that shows a `Job` (`show(job, part=part)`) plays it in its view with
  the View's `showMachining`. The worker keeps the job's timeline (`notebook-machining.js`) and
  posts its state. The page drives it through proxies (`notebook-transport.js`) under the
  controls from the package's `pkg/view.js`: play, speed, loop, a scrubber, a step per move,
  and the stock coloured by height, by tool or by its distance from the part.
- **Documents.** **Save document** asks the worker for the document of every solid, sheet and
  profile the views show: the last run of each cell, in the page's cell order, each named by
  `show(..., part="name")` or by its variable's name. It is saved as `<name>.json`, the
  blacksmith document format that the loom, the forge and the SDK read. In a cell,
  `notebook_support.document()` gives the same `Document`. **Open a file…** writes the file into
  the kernel's working directory and adds a cell that opens it. A `.json` is opened with
  `Document.open(...)` and `show_document(doc)`, which draws each node that no other node reads.
  A CAD file is opened with `Solid.open(...)`.
- **Examples** are in `notebook-script.js`. Each one imports what it uses and stands on its own.
  `?example=sparky` opens one, and `?run=1` runs it once the kernel is up.

## Setup

You need Node.js 22 or later.

```bash
npm install
npm run setup
npm run build
```

`npm run setup` fills three folders. None of them is committed:

- `pkg/`: the cadaclysm web package's `pkg/` folder, fetched from the
  [SDK's releases](https://github.com/rdeioris/cadaclysm-sdk/releases). It holds the
  WebAssembly module (the readers, the kernel and the View) and its loader. It also holds the
  page modules that go with the View, which the notebook imports from there instead of keeping
  copies: `viewer-host.js` and `viewer-client.js` (a View in a worker, drawing a canvas the
  page hands over), `view-activation.js` (tap a view to turn it on), `view-show.js` (the
  palette, outline segments, framing) and `view.js` (input and the job controls).
- `sdk/`: `cadaclysm_blacksmith.py` and `schemas/ap203.exp`, from the
  [SDK's repository](https://github.com/rdeioris/cadaclysm-sdk) at the same release.
- `pyodide/`: the Pyodide runtime, copied from the `pyodide` npm package, and the numpy wheel
  fetched from Pyodide's CDN and checked against its lock file. Also Pyodide's and CPython's
  licence texts.

The notebook needs the `View` class and its page modules, and the Pyodide side of
`cadaclysm_blacksmith.py`. The SDK has them from 0.14 on. Copies you already have work too:

```bash
npm run setup -- --zip path/to/cadaclysm-0.14.2-web.zip --sdk path/to/cadaclysm-sdk
```

`--pkg path/to/pkg` takes a local build's `pkg/` folder instead of a zip. `--sdk` takes an
SDK checkout (its `python/` and `schemas/` folders).

`npm run build` bundles CodeMirror into `vendor/editor.js`.

## Run

```bash
npm start
```

Then open http://localhost:8000/. Any static server works, as long as it serves `.wasm` files
as `application/wasm` (`python -m http.server`, `npx serve`). The page is plain ES modules,
with no build step beyond `vendor/`. Useful URL options: `?example=machining`, `?run=1`,
`?surfaces=triangles`, `?backend=webgl2`.

### Licensing the module

Without a license, the module runs in full and prints a notice in the browser console whenever
a file is read or written. For a site other people use, put your license (`cadaclysm.lic`, as
its URL or its text) in `LICENSE` near the top of `notebook-worker.js`. See
https://cadaclysm.blitter.studio/license. `*.lic` files are git-ignored.

## Test

```bash
npm test
npm run test:browser
```

`npm test` runs the Node tests against `pkg/`, `sdk/` and `pyodide/`:

- `test/kernel.mjs` boots the kernel under Node, as the worker does. It checks stdout and
  tracebacks, `show()`, timings, completion and call tips, a wasm trap, opening a file, a played
  job, and the document (save, open, cell order). Then it runs every example notebook, each on a
  clean namespace, and checks that each one's saved document opens and evaluates with no error.
  It takes a few minutes.
- `test/notebook-views.mjs`, `test/notebook-machining.mjs` and `test/notebook-transport.mjs`
  test the worker's views, the machining bridge and the page's job controls against fakes.
- `test/notebook-scene.mjs` tests the captions and legends, and how the kernel's edge colours
  are read.
- `test/notebook-script.mjs` tests Copy as script. With `CADACLYSM_BLACKSMITH_LIBRARY` set to
  the SDK's native library and `python` on the PATH, it also runs every example as a script on
  the desktop.
- `test/editor.mjs` tests the editor's completion rules.

`npm run test:browser` serves the page and drives a Chrome or Edge that you have installed,
headless, over the DevTools protocol. For each example it checks that the kernel boots, that
every cell runs with no error, and that every view draws (from the view's own pixels). It also
checks that a played job gets its timeline and that the page and worker log no errors.
`--all` runs every example, `--webgl2` uses the fallback, and `--out <folder>` keeps a
screenshot of each view.

## Files

| | |
|---|---|
| `index.html`, `notebook.js` | the page: cells, toolbar, views |
| `notebook-worker.js` | the module worker: the kernel, the views, a played job |
| `kernel.js` | Pyodide and the module: runs a cell, completion, call tips, documents |
| `notebook_support.py` | `show()`, `show_document()` and the bookkeeping behind them |
| `notebook-script.js` | the example notebooks and Copy as script |
| `notebook-views.js`, `notebook-mesh.js`, `notebook-scene.js` | what a cell shows, its caption and legend |
| `notebook-machining.js`, `notebook-transport.js` | a played job, worker side and page side |
| `file-picker.js` | Open and Save |
| `editor.js` | the CodeMirror editor and its kernel completion (bundled into `vendor/`) |
| `chrome.css`, `notebook.css`, `font/`, `favicon.svg`, `mark-dark.svg` | the look |
| `scripts/setup.mjs`, `scripts/serve.mjs`, `scripts/third-party.mjs` | fetch what is not committed; a static server; THIRD-PARTY.txt |

## License

The notebook's own code is under the Apache License 2.0 (see [LICENSE](LICENSE) and
[NOTICE](NOTICE)). Pyodide (MPL-2.0), CPython (PSF), numpy (BSD-3-Clause), CodeMirror (MIT) and
the Quantico font (SIL OFL) are under their own licences, reproduced in
[THIRD-PARTY.txt](THIRD-PARTY.txt) (`npm run licences` writes it again from what setup and
build put here). The cadaclysm web package that `npm run setup` fetches has its own license
and is not part of this repository. The cadaclysm name and logo are not covered by the Apache
license.

Links: [cadaclysm SDK](https://github.com/rdeioris/cadaclysm-sdk) ·
[cadaclysm.blitter.studio](https://cadaclysm.blitter.studio/)
