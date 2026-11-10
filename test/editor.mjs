// The cell editor's completion rules, on CodeMirror's state alone (no DOM): what is asked of
// the kernel and when, where the completion replaces from, and when Tab completes rather
// than indents. The kernel's side of it is test/kernel.mjs.
//
// Run: node test/editor.mjs   (after npm install)
import assert from "node:assert";
import { EditorState, EditorSelection } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { kernelCompletions, tipRuns, wantsCompletion } from "../editor.js";

function stateOf(doc, cursor = doc.length) {
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [python()] });
    ensureSyntaxTree(state, state.doc.length, 1e9);
    return state;
}

const ITEMS = [
    { label: "fillet", type: "method", signature: "(edges, radius)", doc: "Round the edges." },
    { label: "faces", type: "property", signature: "", doc: "" },
];
const asked = [];
const source = kernelCompletions(async (text, cursor) => { asked.push([text, cursor]); return ITEMS; });

async function complete(doc, explicit, cursor = doc.length) {
    asked.length = 0;
    return source(new CompletionContext(stateOf(doc, cursor), cursor, explicit));
}

// Typing asks only right after a dot, with the whole source and the cursor.
let r = await complete("x = 1\nplate.", false);
assert.deepStrictEqual(asked, [["x = 1\nplate.", 12]]);
assert.strictEqual(r.from, 12, "replaces from after the dot");
assert.deepStrictEqual(r.options[0], { label: "fillet", type: "method", detail: "(edges, radius)", info: "Round the edges." });
assert.deepStrictEqual(r.options[1], { label: "faces", type: "property", detail: undefined, info: undefined });
assert.ok(r.validFor.test("fil") && !r.validFor.test("fil("), "filters locally while the word grows");

r = await complete("plate.fil", false);
assert.strictEqual(r, null, "typing a name does not ask");
assert.deepStrictEqual(asked, []);

// Tab and Ctrl-Space ask after any name.
r = await complete("plate.fil", true);
assert.strictEqual(r.from, 6);
r = await complete("Wor", true);
assert.strictEqual(r.from, 0);
r = await complete("x = Wor", true);
assert.strictEqual(r.from, 4);
r = await complete("print(Wor)", true, 9);
assert.deepStrictEqual(asked, [["print(Wor)", 9]]);
assert.strictEqual(r.from, 6);

// A dot after a call asks too (the kernel reads the chain); the word after it replaces.
r = await complete("Workplane.xy().", false);
assert.deepStrictEqual([asked.length, r.from], [1, 15]);
r = await complete("(Workplane.xy()\n    .", false);
assert.strictEqual(r.from, 21);
r = await complete("Workplane.xy().ext", true);
assert.strictEqual(r.from, 15);
assert.strictEqual(await complete("x = 2", false), null, "typing a name or a number does not ask");

// A call tip's text: the parameters between the parentheses, the one being typed marked.
assert.deepStrictEqual(tipRuns({ name: "extrude", parts: ["profile: Profile", "height"], active: 1, returns: "Workplane" }),
    [["extrude(", false], ["profile: Profile", false], [", ", false], ["height", true], [") -> Workplane", false]]);
assert.deepStrictEqual(tipRuns({ name: "f", parts: [], active: -1, returns: "" }), [["f(", false], [")", false]]);

// Never inside a string or a comment, however asked.
assert.strictEqual(await complete('s = "plate.', true), null);
assert.strictEqual(await complete("# plate.", true), null);
assert.deepStrictEqual((await complete("x = 1  # a note\nplate.", false)).from, 22, "a comment on an earlier line does not stop it");

// A kernel that cannot answer (busy, not booted) is no completion.
const busy = kernelCompletions(async () => null);
assert.strictEqual(await busy(new CompletionContext(stateOf("plate."), 6, true)), null);

// Tab completes after a name or a dot; it indents at a line's start, after a space or
// bracket, over a selection, and inside a string.
assert.ok(wantsCompletion(stateOf("plate.")));
assert.ok(wantsCompletion(stateOf("pla")));
assert.ok(!wantsCompletion(stateOf("")));
assert.ok(!wantsCompletion(stateOf("if x:\n")));
assert.ok(!wantsCompletion(stateOf("f(x, ")));
assert.ok(!wantsCompletion(stateOf("f(")));
assert.ok(!wantsCompletion(stateOf('s = "abc')));
assert.ok(!wantsCompletion(EditorState.create({ doc: "plate", selection: EditorSelection.range(0, 5), extensions: [python()] })));
console.log("editor: ok");
