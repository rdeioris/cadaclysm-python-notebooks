// The notebook's kernel: Pyodide and the blacksmith wasm in one place, so a Python call
// into the kernel is a synchronous function call. Environment-free -- the worker and the
// Node test both build one, passing in `loadPyodide` and the wasm module.
//
// A cell runs through `pyodide.runPython`, whose value is the cell's last expression (a
// REPL's rule); `notebook_support._end` turns that into the handles to draw. Meshing is
// done here, from JS, on the handles -- never through numpy -- and the arrays go to the page
// (notebook-mesh.js).
import { meshOf as meshHandle } from "./notebook-mesh.js";

// Pyodide's own frames (its `_base.py` runner) come before the cell's; drop everything
// between the header and the first cell frame so the text reads like CPython's. The
// message's trailing newline goes too: the page adds its own.
export function cleanTraceback(text) {
    const lines = text.replace(/\n+$/, "").split("\n");
    const header = lines.findIndex((l) => l.startsWith("Traceback (most recent call last):"));
    if (header < 0) return text;
    const first = lines.findIndex((l, i) => i > header && /^\s*File "<cell/.test(l));
    if (first < 0) return text;
    return [...lines.slice(0, header + 1), ...lines.slice(first)].join("\n");
}

// Python source up to the cursor, read forward once: the brackets open at its end (each
// with its commas so far), where each closed bracket opened, and where each string and
// comment began -- so `exprBefore` can walk back over them. `inString`/`inComment`: the
// text ends inside one.
export function scanPython(text) {
    const open = [], opener = new Map(), strings = new Map(), comments = new Map();
    const result = (inComment, inString) => ({ open, opener, strings, comments, inComment, inString });
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === "#") {
            const nl = text.indexOf("\n", i);
            if (nl < 0) return result(true, false);
            if (nl > i) comments.set(nl - 1, i);
            i = nl;
            continue;
        }
        if (c === '"' || c === "'") {
            const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
            let j = i + quote.length;
            while (j < text.length && !text.startsWith(quote, j)) {
                if (text[j] === "\\") j++;
                else if (quote.length === 1 && text[j] === "\n") break;
                j++;
            }
            if (j >= text.length) return result(false, true);
            if (text[j] === "\n" && quote.length === 1) { i = j; continue; }   // unclosed on its line: over at its end
            strings.set(j + quote.length - 1, i);
            i = j + quote.length;
            continue;
        }
        if (c === "(" || c === "[" || c === "{") open.push({ ch: c, at: i, commas: 0, lastComma: i });
        else if (c === ")" || c === "]" || c === "}") { const o = open.pop(); if (o) opener.set(i, o.at); }
        else if (c === "," && open.length) { const o = open[open.length - 1]; o.commas++; o.lastComma = i; }
        i++;
    }
    return result(false, false);
}

const KEYWORDS = new Set(["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not",
    "or", "pass", "raise", "return", "try", "while", "with", "yield"]);

// Back over whitespace, line continuations and comments.
function back(text, i, scan) {
    for (;;) {
        while (i > 0 && /[\s\\]/.test(text[i - 1])) i--;
        const comment = scan.comments.get(i - 1);
        if (comment === undefined) return i;
        i = comment;
    }
}

// The expression ending at `end` (exclusive): names, strings and bracket groups joined by
// dots, or applied as calls and subscripts -- `Workplane.from_solid(plate).faces(sel)`.
// `{ expr, start }`, or null when there is none (an operator, a keyword, a number, or
// nothing before a dot).
export function exprBefore(text, end, scan) {
    let i = back(text, end, scan), start = null, needed = true;
    for (;;) {
        const c = text[i - 1] ?? "";
        let from;
        if (c === ")" || c === "]" || c === "}") {
            from = scan.opener.get(i - 1);
        } else if (c === '"' || c === "'") {
            from = scan.strings.get(i - 1);
            while (from > 0 && /[A-Za-z]/.test(text[from - 1])) from--;   // f"", rb"" ...
        } else if (/\w/.test(c)) {
            let j = i;
            while (j > 0 && /\w/.test(text[j - 1])) j--;
            const word = text.slice(j, i);
            if (!KEYWORDS.has(word) && !/^\d/.test(word)) from = j;
        }
        if (from === undefined) {
            if (needed) return null;
            break;
        }
        start = from;
        const j = back(text, from, scan);
        if (text[j - 1] === ".") { i = back(text, j - 1, scan); needed = true; continue; }
        // A call or a subscript applies to what comes before it, if anything does.
        if ((c === ")" || c === "]") && /[\w)\]"']/.test(text[j - 1] ?? "")) { i = j; needed = false; continue; }
        break;
    }
    return { expr: text.slice(start, end).trim(), start };
}

// `schemaUrl` is where `ap203.exp` is fetched from on first use, or null when the caller
// writes `/schemas/ap203.exp` into the FS itself; `packageCacheDir` (Node only) keeps
// whatever Pyodide fetches out of `indexURL`, the deployed directory.
// `draw` and `undraw`: what one drawn item becomes (meshHandle's mesh by
// default), and, optional, how to give back the ones already made when a later one throws.
// `drawMachining`, optional: what a played job (a `Job` shown) becomes -- the worker's snapshot
// of it; by default its record.
export async function createKernel({ loadPyodide, indexURL, packageCacheDir, wasm, moduleSource, supportSource, schemaUrl, onProgress = () => {}, onBoot = () => {}, draw, undraw, drawMachining }) {
    onBoot("pyodide");
    const pyodide = await loadPyodide(packageCacheDir ? { indexURL, packageCacheDir } : { indexURL });
    onBoot("numpy");
    await pyodide.loadPackage("numpy");
    onBoot("module");
    globalThis.cadaclysm = wasm;
    wasm.cadaclysm_blacksmith_set_progress_hook((phase, done, total) => onProgress(phase, done, total));
    pyodide.FS.mkdirTree("/notebook");
    pyodide.FS.writeFile("/notebook/cadaclysm_blacksmith.py", moduleSource);
    pyodide.FS.writeFile("/notebook/notebook_support.py", supportSource);
    pyodide.runPython(`
import os, sys
os.environ["CADACLYSM_SCHEMAS"] = "/schemas"
${schemaUrl ? `os.environ["CADACLYSM_SCHEMA_URL"] = ${JSON.stringify(schemaUrl)}` : ""}
sys.path.insert(0, "/notebook")
import notebook_support
from notebook_support import show, show_document
import cadaclysm_blacksmith
`);
    const support = pyodide.pyimport("notebook_support");
    const versions = {
        python: pyodide.runPython("import sys; '.'.join(map(str, sys.version_info[:3]))"),
        blacksmith: pyodide.runPython("import cadaclysm_blacksmith as m; m.__version__"),
        wasm: wasm.cadaclysm_blacksmith_version(),
        pyodide: pyodide.version,
    };
    onBoot("ready");

    // Bytes as written, not `batched` lines: a `print(..., end="")` must reach its own
    // cell's stdout rather than wait, unseen, for the next cell's newline. Python's own
    // text buffers are flushed after every cell for the same reason -- the original
    // streams (`sys.__stdout__`), each on its own and never throwing, since a cell may
    // have closed or replaced `sys.stdout`; the next cell gets the originals back.
    // `streams` is both in the order written, `[name, text]` runs, so the page can tell a
    // warning from a print yet keep them where they fell.
    let streams = [];
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const writer = (name) => ({
        isatty: false,
        write: (buffer) => {
            const text = decoders[name].decode(buffer, { stream: true });
            const last = streams[streams.length - 1];
            if (last && last[0] === name) last[1] += text;
            else if (text) streams.push([name, text]);
            return buffer.length;
        },
    });
    pyodide.setStdout(writer("stdout"));
    pyodide.setStderr(writer("stderr"));
    const joined = (name) => streams.filter(([n]) => n === name).map(([, t]) => t).join("");
    const restore = pyodide.runPython(`
import sys
def _restore():
    sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
_restore`);
    const flush = pyodide.runPython(`
import sys
def _flush():
    for stream in (sys.__stdout__, sys.__stderr__):
        try:
            stream.flush()
        except Exception:
            pass
_flush`);

    // Completion and call tips over the cells' namespace (`__main__`), each name with a kind,
    // a signature for a callable and `inspect.getdoc` for its documentation. What comes
    // before the dot or the call is resolved statically, never run: a name is looked up, a
    // member found with `getattr_static`, and a call is the class its return annotation
    // names -- so `Workplane.xy().extrude(` knows `extrude` without calling `xy`. A property
    // is its getter's annotation, never read; plain values carry no doc (an int's would be
    // int's); `_names` stay hidden until typed. Defined in a scope of its own, so none of
    // these imports lands among the cell's names.
    const scope = pyodide.globals.get("dict")();
    const [completeIn, signatureIn] = pyodide.runPython(`
import ast, builtins, inspect, keyword, re, rlcompleter
import __main__

_DOTTED = re.compile(r"[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*$")
_LITERAL = {ast.List: list, ast.ListComp: list, ast.Tuple: tuple, ast.Dict: dict, ast.DictComp: dict,
            ast.Set: set, ast.SetComp: set, ast.JoinedStr: str}

class _Unquote(ast.NodeTransformer):
    def visit_Subscript(self, node):
        # Literal["a"] holds values, not names.
        head = node.value.attr if isinstance(node.value, ast.Attribute) else getattr(node.value, "id", "")
        return node if head == "Literal" else self.generic_visit(node)

    def visit_Constant(self, node):
        inner = _parsed(node.value) if isinstance(node.value, str) else None
        return inner if inner is not None else node

def _parsed(text):
    # An annotation's text as ast, its quoted parts read as the names they quote: under
    # "from __future__ import annotations" (the package's) a "Solid" return is the text
    # "'Solid'", and list["Edge"] holds a string either way. Never evaluated: the names
    # the package's annotations use are imported only under TYPE_CHECKING.
    try:
        node = ast.parse(text, mode="eval").body
    except SyntaxError:
        return None
    return _Unquote().visit(node)

def _named(fn, node):
    # A name or dotted name in an annotation, looked up in the function's module.
    name = ast.unparse(node) if isinstance(node, (ast.Name, ast.Attribute)) else ""
    if not _DOTTED.match(name):
        return None
    head, *rest = name.split(".")
    scope = getattr(inspect.unwrap(fn), "__globals__", {})
    found = scope.get(head, getattr(builtins, head, None))
    for part in rest:
        try:
            found = inspect.getattr_static(found, part)
        except AttributeError:
            return None
    return found if inspect.isclass(found) else None

def _annotated(fn, annotation):
    # What a return annotation says the value is: ("type", class), or ("type", class, item)
    # for list[X] and tuple[X, ...], whose items are X. A string is read with ast
    # (_parsed), never evaluated; "X | None" is X; "tuple[float, float]" is tuple.
    if inspect.isclass(annotation):
        return ("type", annotation)
    if not isinstance(annotation, str):
        return None
    node = _parsed(annotation)
    if node is None:
        return None
    while isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        sides = [n for n in (node.left, node.right) if not (isinstance(n, ast.Constant) and n.value is None)]
        if len(sides) != 1:
            return None   # A | B: no one class
        node = sides[0]
    item = None
    if isinstance(node, ast.Subscript):
        inner = node.slice
        if isinstance(inner, ast.Tuple) and len(inner.elts) == 2 and isinstance(inner.elts[1], ast.Constant) and inner.elts[1].value is Ellipsis:
            inner = inner.elts[0]
        item = _named(fn, inner)
        node = node.value
    cls = _named(fn, node)
    if cls is None:
        return None
    return ("type", cls, item) if item and cls in (list, tuple) else ("type", cls)

def _returns(fn):
    try:
        return _annotated(fn, inspect.signature(fn).return_annotation)
    except (TypeError, ValueError):
        return None

def _member(found, attr):
    kind, holder = found[0], found[1]
    try:
        value = inspect.getattr_static(holder, attr)
    except AttributeError:
        return None
    if isinstance(value, (staticmethod, classmethod)):
        value = value.__func__
    if isinstance(value, property) and (kind == "type" or not inspect.isclass(holder)):
        return _returns(value.fget) if value.fget else None
    return ("value", value)

# ("value", object) for what the namespace holds, ("type", class) for what a call or a
# property would make, or None.
def _static(node, namespace):
    if isinstance(node, ast.Name):
        if node.id in namespace:
            return ("value", namespace[node.id])
        return ("value", getattr(builtins, node.id)) if hasattr(builtins, node.id) else None
    if isinstance(node, ast.Constant):
        return ("type", type(node.value))
    if type(node) in _LITERAL:
        return ("type", _LITERAL[type(node)])
    if isinstance(node, ast.Attribute):
        found = _static(node.value, namespace)
        return _member(found, node.attr) if found else None
    if isinstance(node, ast.Call):
        found = _static(node.func, namespace)
        if not found or found[0] != "value" or not callable(found[1]):
            return None
        if inspect.isclass(found[1]):
            return ("type", found[1])
        return _returns(found[1])
    if isinstance(node, ast.Subscript) and not isinstance(node.slice, ast.Slice):
        found = _static(node.value, namespace)
        if not found:
            return None
        # An item of a list[X] a call or property makes; an item of a real list or tuple
        # by a literal index (no __getitem__ of anything else is run).
        if found[0] == "type":
            return ("type", found[2]) if len(found) > 2 else None
        if type(found[1]) in (list, tuple) and isinstance(node.slice, ast.Constant) and type(node.slice.value) is int:
            try:
                return ("value", found[1][node.slice.value])
            except IndexError:
                return None
    return None

def _resolve(expression):
    try:
        tree = ast.parse("(" + expression + "\\n)", mode="eval").body
    except SyntaxError:
        return None
    return _static(tree, __main__.__dict__)

def _complete(base, typed, limit=200):
    namespace = __main__.__dict__
    if base is None:
        words = [w.rstrip("(): ") for w in rlcompleter.Completer(namespace).global_matches(typed)]
        found = None
    else:
        found = _resolve(base)
        if found is None:
            return []
        words = sorted(n for n in dir(found[1]) if n.startswith(typed))
    out, seen = [], set()
    for name in words:
        if name in seen or (name.startswith("_") and not typed.startswith("_")):
            continue
        seen.add(name)
        out.append(_describe(name, found, namespace))
        if len(out) >= limit:
            break
    return out

def _describe(name, found, namespace):
    if found is None and (keyword.iskeyword(name) or keyword.issoftkeyword(name)) and name not in namespace:
        return {"label": name, "type": "keyword", "signature": "", "doc": ""}
    if found is None:
        value = namespace[name] if name in namespace else getattr(builtins, name, None)
    else:
        try:
            value = inspect.getattr_static(found[1], name)
        except AttributeError:
            value = None
    if isinstance(value, (staticmethod, classmethod)):
        value = value.__func__
    if isinstance(value, property):
        kind, documented = "property", True
    elif inspect.ismodule(value):
        kind, documented = "namespace", True
    elif inspect.isclass(value):
        kind, documented = "class", True
    elif callable(value):
        # Of an instance (a value, or the type a call makes) a method; of a module or class a function.
        holder = found[1] if found else None
        method = found is not None and (found[0] == "type" or not (inspect.ismodule(holder) or inspect.isclass(holder)))
        kind, documented = ("method" if method else "function"), True
    else:
        kind, documented = "variable", False
    signature = ""
    if kind in ("function", "method", "class"):
        try:
            signature = _text(_unbound(inspect.signature(value), found is not None and kind != "class"))
        except (TypeError, ValueError):
            pass
    doc = ""
    if documented:
        try:
            doc = inspect.getdoc(value.fget if kind == "property" else value) or ""
        except Exception:
            doc = ""
    return {"label": name, "type": kind, "signature": signature, "doc": doc[:2000]}

def _unbound(sig, member):
    # Looked up statically, a method or classmethod still has its self/cls.
    params = list(sig.parameters.values())
    if member and params and params[0].name in ("self", "cls"):
        return sig.replace(parameters=params[1:])
    return sig

# A tip reads as the source would: Profile, not cadaclysm_blacksmith.Profile or 'Profile'.
def _annotation(a):
    if isinstance(a, str):
        node = _parsed(a)
        return a if node is None else ast.unparse(node)
    return a.__qualname__ if inspect.isclass(a) else inspect.formatannotation(a)

def _param(p):
    P = inspect.Parameter
    text = {P.VAR_POSITIONAL: "*", P.VAR_KEYWORD: "**"}.get(p.kind, "") + p.name
    if p.annotation is not P.empty:
        text += ": " + _annotation(p.annotation)
    if p.default is not P.empty:
        text += (" = " if p.annotation is not P.empty else "=") + repr(p.default)
    return text

# The parameters as inspect prints them, the "/" and "*" markers included, and the index
# of \`active\` among them (-1).
def _parts(params, active=None):
    P = inspect.Parameter
    parts, at = [], -1
    for i, p in enumerate(params):
        if p.kind == P.KEYWORD_ONLY and not any(q.kind in (P.KEYWORD_ONLY, P.VAR_POSITIONAL) for q in params[:i]):
            parts.append("*")
        if p is active:
            at = len(parts)
        parts.append(_param(p))
        if p.kind == P.POSITIONAL_ONLY and (i + 1 == len(params) or params[i + 1].kind != P.POSITIONAL_ONLY):
            parts.append("/")
    return parts, at

def _returned(sig):
    return "" if sig.return_annotation is inspect.Signature.empty else _annotation(sig.return_annotation)

def _text(sig):
    ret = _returned(sig)
    return "(" + ", ".join(_parts(list(sig.parameters.values()))[0]) + ")" + (" -> " + ret if ret else "")

# The call tip for callee(...), with index commas before the cursor in its arguments and
# name= typed there (or None), or a bare word (partial) that may be a keyword's start: the
# parameters as they print, and which one is being typed.
def _signature(callee, index, name, partial):
    found = _resolve(callee)
    if not found or found[0] != "value" or not callable(found[1]):
        return None
    fn = found[1]
    try:
        sig = _unbound(inspect.signature(fn), "." in callee and not inspect.isclass(fn))
    except (TypeError, ValueError):
        return None
    params = list(sig.parameters.values())
    P = inspect.Parameter
    if name is not None:
        active = next((p for p in params if p.name == name and p.kind != P.POSITIONAL_ONLY), None)
        active = active or next((p for p in params if p.kind == P.VAR_KEYWORD), None)
    else:
        positional = [p for p in params if p.kind in (P.POSITIONAL_ONLY, P.POSITIONAL_OR_KEYWORD)]
        active = positional[index] if index < len(positional) else next((p for p in params if p.kind == P.VAR_POSITIONAL), None)
        # Past the positionals, a word can only begin a keyword: sorted(xs, rev -> reverse.
        if active is None and partial:
            active = next((p for p in params if p.kind in (P.POSITIONAL_OR_KEYWORD, P.KEYWORD_ONLY) and p.name.startswith(partial)), None)
    parts, at = _parts(params, active)
    ret = _returned(sig)
    try:
        doc = (inspect.getdoc(fn) or "").split("\\n\\n")[0]
    except Exception:
        doc = ""
    label = getattr(fn, "__name__", None) or callee.rpartition(".")[2]
    return {"name": label, "parts": parts, "active": at, "returns": ret, "doc": doc[:600]}

(_complete, _signature)`, { globals: scope }).toJs();

    // What comes before the cursor, found here so Python sees no UTF-16 offsets: after a
    // dot, the expression it follows (a chain of names, calls and subscripts, across lines
    // inside brackets); otherwise a bare name.
    function complete(source, cursor) {
        const text = source.slice(0, cursor);
        const scan = scanPython(text);
        if (scan.inComment || scan.inString) return [];
        const typed = text.match(/\w*$/)[0];
        const dot = cursor - typed.length - 1;
        let base;   // undefined, which Python sees as None (null is JsNull)
        if (text[dot] === ".") {
            base = exprBefore(text, dot, scan)?.expr;
            if (!base) return [];
        }
        const items = completeIn(base, typed);
        try { return items.toJs({ dict_converter: Object.fromEntries }); } finally { items.destroy(); }
    }

    // The call the cursor is in the arguments of: `{ name, parts, active, returns, doc, from }`,
    // `from` the offset of its "(", or null. The innermost open "(" with something callable
    // before it -- a tuple's or a group's bracket is looked through, a call's is not.
    function signature(source, cursor) {
        const text = source.slice(0, cursor);
        const scan = scanPython(text);
        if (scan.inComment) return null;
        for (let k = scan.open.length - 1; k >= 0; k--) {
            const o = scan.open[k];
            if (o.ch !== "(") continue;
            const callee = exprBefore(text, o.at, scan);
            if (!callee) continue;
            if (/\b(?:def|class)\s+$/.test(text.slice(0, callee.start))) return null;
            // `name=` typed (a keyword argument), or a bare word so far; undefined is None.
            const typed = text.slice(o.lastComma + 1).match(/^\s*([A-Za-z_]\w*)\s*(=(?!=))?/);
            const name = typed?.[2] ? typed[1] : undefined;
            const partial = typed && !typed[2] && /^\s*[A-Za-z_]\w*$/.test(text.slice(o.lastComma + 1)) ? typed[1] : undefined;
            const tip = signatureIn(callee.expr, o.commas, name, partial);
            if (!tip) return null;
            try { return { ...tip.toJs({ dict_converter: Object.fromEntries }), from: o.at }; } finally { tip.destroy(); }
        }
        return null;
    }

    // A wasm trap (`panic = abort`: a kernel bug ends in `unreachable`) reaches Python as a
    // `JsException` around the `WebAssembly.RuntimeError`, and the shim re-raises it; Pyodide
    // hands it back as a `PythonError` of that type, ending in the JS error's own text. It is
    // no cell error: the wasm's tables stay borrowed, so the worker must go and be re-made.
    const lastLine = (text) => text.trim().split("\n").pop();
    function trapped(e) {
        return e.type === "JsException" && /JsException: RuntimeError: /.test(lastLine(e.message));
    }

    const meshOf = (...args) => (draw ?? meshHandle)(wasm, ...args);
    // The job a cell plays (notebook_support._machining's record) as what the caller keeps
    // for it: the worker's machiningOf, or the record itself.
    const machiningItem = (record) => (drawMachining ?? ((_, r) => ({ kind: "machining", ...r })))(wasm, record);

    // `cell` is the page's id for the cell and `order` its cells' ids in order: what the cell
    // shows is kept for `documentText` under `cell` until it runs again or is forgotten.
    async function run(source, n, cell = null, order = null) {
        const started = performance.now();
        streams = [];
        for (const d of Object.values(decoders)) d.decode();   // finalize: no bytes carry over from the last cell
        restore();
        // undefined, not null, is Python's None (a null arrives as a JsNull).
        const pyOrder = order ? pyodide.toPy(order) : undefined;
        try { support._begin(cell ?? undefined, pyOrder); } finally { pyOrder?.destroy(); }
        let error = null, solids = [], timings = [];
        let value, drew = false;
        try {
            value = pyodide.runPython(source, { filename: `<cell ${n}>` });
            const ended = support._end(value);
            const [handles, timed, job] = ended.toJs({ dict_converter: Object.fromEntries });
            ended.destroy();
            timings = timed.map(([what, ms]) => [what, ms]);
            const made = [];
            try {
                for (const [h, faces, edgeCount, colour, faceColours, kind] of handles) made.push(meshOf(h, faces, edgeCount, colour, faceColours, kind));
                if (job) made.push(machiningItem(job));
            } catch (e) {
                // Not after a trap: the wasm is poisoned, and the worker goes with everything in it.
                const trap = typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;
                if (undraw && !trap) for (const m of made) undraw(m);
                throw e;
            }
            solids = made;
            drew = true;
        } catch (e) {
            if (!(e instanceof pyodide.ffi.PythonError)) throw e;
            if (trapped(e)) throw new Error(`the wasm trapped: ${lastLine(e.message).replace(/^.*JsException: /, "")}`);
            error = cleanTraceback(e.message);
        } finally {
            // Pure Python, no kernel call: safe after a trap too.
            try { support._finish(drew); } catch { /* kept or not, the run's result stands */ }
            if (value && typeof value.destroy === "function") value.destroy();
            try { flush(); } catch { /* the cell's result stands, flushed or not */ }
        }
        return { stdout: joined("stdout"), stderr: joined("stderr"), streams, error, ms: Math.round(performance.now() - started), solids, timings };
    }

    // A file the page's open button dropped in, written into the working directory -- where
    // a cell's `Solid.open("housing.step")` looks for it. Its name only, never a path: a
    // name from the page reaches nowhere else in the file system. Returns the name written.
    function writeFile(name, bytes) {
        const base = String(name).split(/[\\/]/).pop();
        if (!base || base === "." || base === "..") throw new Error(`not a file name: ${JSON.stringify(name)}`);
        pyodide.FS.writeFile(`${pyodide.FS.cwd()}/${base}`, bytes);
        return base;
    }

    // The document of every cell's shown solids, sheets and profiles (notebook_support's
    // `document()`), as the JSON text the page saves. A Python error is thrown as an Error
    // with the traceback's last line.
    function documentText() {
        try {
            return support._document_text();
        } catch (e) {
            if (!(e instanceof pyodide.ffi.PythonError)) throw e;
            if (trapped(e)) throw new Error(`the wasm trapped: ${lastLine(e.message).replace(/^.*JsException: /, "")}`);
            throw new Error(lastLine(e.message));
        }
    }

    // The page deleted the cell: what it showed leaves the document.
    function forget(cell) { support._forget(cell); }

    return { pyodide, versions, run, complete, signature, writeFile, documentText, forget };
}
