// A notebook cell's editor: CodeMirror 6 with the Python language, coloured in the page's
// palette, completing from the live kernel. The source of `vendor/editor.js`, which
// `npm run build` bundles with esbuild (git-ignored); the page imports the bundle, the Node
// test imports this file.
//
// Keys: Shift-Enter runs and moves on, Ctrl-Enter runs in place; Tab accepts an open
// completion, asks for one after a name or a dot, and indents anywhere else; Shift-Tab
// dedents; Ctrl-Space asks always; typing a dot asks too. Inside a call's parentheses a
// tip above shows its parameters, the one being typed marked; Escape hides it.
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap, drawSelection, showTooltip, ViewPlugin } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { acceptCompletion, autocompletion, startCompletion } from "@codemirror/autocomplete";
import { python } from "@codemirror/lang-python";
import { tags as t } from "@lezer/highlight";

// The colours of the site's code blocks.
const palette = HighlightStyle.define([
    { tag: [t.keyword, t.bool, t.null, t.self, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--blue)" },
    { tag: [t.string, t.special(t.string), t.docString], color: "var(--core)" },
    { tag: t.number, color: "#E8C070" },
    { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: "#9CD3FF" },
    { tag: t.special(t.variableName), color: "#E8C070" },
]);

const theme = EditorView.theme({
    "&": { backgroundColor: "var(--cell)", color: "var(--fg)", fontSize: "14px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55", minHeight: "3em" },
    ".cm-content": { padding: "12px 0", caretColor: "var(--fg)" },
    ".cm-line": { padding: "0 16px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#2D4A66" },
    ".cm-matchingBracket": { backgroundColor: "rgba(55, 138, 221, 0.28)", outline: "1px solid rgba(55, 138, 221, 0.6)" },
    ".cm-nonmatchingBracket": { color: "var(--red)" },
    ".cm-tooltip": { backgroundColor: "#2A2928", color: "var(--fg)", border: "1px solid #5F5E5A", fontFamily: "var(--mono)", fontSize: "13px" },
    // Capped, so a long signature is cut rather than pushing the doc panel over the list.
    ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", maxHeight: "16em", maxWidth: "min(34em, 80vw)" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 10px 2px 4px", overflow: "hidden", textOverflow: "ellipsis" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--blue)", color: "var(--bg)" },
    ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "0.8em" },
    ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail": { color: "var(--bg)" },
    ".cm-completionMatchedText": { textDecoration: "none", color: "#9CD3FF" },
    ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionMatchedText": { color: "var(--bg)" },
    ".cm-completionInfo": { whiteSpace: "pre-wrap", maxWidth: "30em", padding: "6px 10px", color: "var(--muted)" },
    ".cm-tooltip.cm-callTip": { padding: "4px 10px", maxWidth: "min(40em, 90vw)", whiteSpace: "pre-wrap" },
    ".cm-callTip-active": { color: "#9CD3FF", fontWeight: "bold" },
    ".cm-callTip-doc": { color: "var(--muted)", marginTop: "2px", maxHeight: "4.6em", overflow: "hidden" },
}, { dark: true });

const NO_COMPLETION = new Set(["String", "FormatString", "Comment"]);

function inStringOrComment(state, pos) {
    for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
        if (NO_COMPLETION.has(node.name)) return true;
    }
    return false;
}

// Tab asks for a completion when the cursor ends a name or a dot, and indents otherwise.
export function wantsCompletion(state) {
    const sel = state.selection.main;
    if (!sel.empty || sel.from === 0) return false;
    return /[\w.]/.test(state.sliceDoc(sel.from - 1, sel.from)) && !inStringOrComment(state, sel.from);
}

// The completion source: `ask(source, cursor)` resolves to the kernel's items, or null when
// the kernel cannot answer (busy with a cell, not booted). Typing asks only right after a
// dot -- after a name or a call, `plate.` or `Workplane.xy().`: the kernel reads what the
// dot follows; Tab and Ctrl-Space (explicit) ask after any name. Once open, the list
// filters locally while the word grows (`validFor`), so a keystroke is not a round trip.
export function kernelCompletions(ask) {
    return async (context) => {
        if (inStringOrComment(context.state, context.pos)) return null;
        const from = context.matchBefore(/\w*/)?.from ?? context.pos;
        const afterDot = context.state.sliceDoc(from - 1, from) === ".";
        if (!context.explicit && !(afterDot && from === context.pos)) return null;
        const items = await ask(context.state.doc.toString(), context.pos);
        if (!items || context.aborted) return null;
        return {
            from,
            options: items.map((i) => ({ label: i.label, type: i.type, detail: i.signature || undefined, info: i.doc || undefined })),
            validFor: /^\w*$/,
        };
    };
}

function indentOrSpaces(view) {
    const sel = view.state.selection.main;
    if (!sel.empty) return indentMore(view);
    const width = view.state.facet(indentUnit).length;
    const column = sel.head - view.state.doc.lineAt(sel.head).from;
    view.dispatch(view.state.replaceSelection(" ".repeat(width - (column % width))), { scrollIntoView: true, userEvent: "input" });
    return true;
}

// A call tip as runs of text, `[text, active]`: extrude(profile: Profile, [height]) -> Workplane.
export function tipRuns(tip) {
    const runs = [[tip.name + "(", false]];
    tip.parts.forEach((part, i) => {
        if (i) runs.push([", ", false]);
        runs.push([part, i === tip.active]);
    });
    runs.push([")" + (tip.returns ? " -> " + tip.returns : ""), false]);
    return runs;
}

const setTip = StateEffect.define();
const tipField = StateField.define({
    create: () => null,
    update(tip, tr) {
        for (const e of tr.effects) if (e.is(setTip)) tip = e.value;
        return tip && tr.docChanged ? { ...tip, from: tr.changes.mapPos(tip.from) } : tip;
    },
    provide: (field) => showTooltip.from(field, (tip) => tip && {
        pos: tip.from,
        above: true,
        create() {
            const dom = document.createElement("div");
            dom.className = "cm-callTip";
            const line = dom.appendChild(document.createElement("div"));
            for (const [text, active] of tipRuns(tip)) {
                if (!active) { line.appendChild(document.createTextNode(text)); continue; }
                const span = line.appendChild(document.createElement("span"));
                span.className = "cm-callTip-active";
                span.textContent = text;
            }
            if (tip.doc) {
                const doc = dom.appendChild(document.createElement("div"));
                doc.className = "cm-callTip-doc";
                doc.textContent = tip.doc;
            }
            return { dom };
        },
    }),
});

// Asks `signature(source, cursor)` a moment after the text or the cursor settles; the tip
// goes when the cursor leaves the call, the editor loses focus, or Escape is pressed. An
// answer overtaken by a later edit is dropped.
function callTips(signature) {
    const plugin = ViewPlugin.fromClass(class {
        constructor(view) { this.view = view; this.timer = 0; this.seq = 0; }
        update(u) {
            if (!u.docChanged && !u.selectionSet && !u.focusChanged) return;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.ask(), 120);
        }
        async ask() {
            const view = this.view, seq = ++this.seq;
            const sel = view.state.selection.main;
            const tip = view.hasFocus && sel.empty ? await signature(view.state.doc.toString(), sel.head) : null;
            if (seq !== this.seq || (!tip && !view.state.field(tipField))) return;
            view.dispatch({ effects: setTip.of(tip) });
        }
        destroy() { clearTimeout(this.timer); this.seq++; }
    });
    const escape = keymap.of([{ key: "Escape", run: (view) => {
        if (!view.state.field(tipField)) return false;
        view.dispatch({ effects: setTip.of(null) });
        return true;
    } }]);
    return [tipField, plugin, escape];
}

// `onRun(advance)`: Shift-Enter runs and moves to the next cell (advance = true), Ctrl-Enter
// runs and stays. `onChange(text)` on every edit. `complete(source, cursor)` and
// `signature(source, cursor)` are the kernel's (either may be null: no completion, no tips).
export function createEditor({ parent, doc = "", onRun, onChange, complete = null, signature = null }) {
    const indent = "    ";
    const keys = Prec.highest(keymap.of([
        { key: "Shift-Enter", run: () => { onRun(true); return true; } },
        { key: "Mod-Enter", run: () => { onRun(false); return true; } },
        {
            key: "Tab",
            run: (view) => acceptCompletion(view) || (wantsCompletion(view.state) ? startCompletion(view) : indentOrSpaces(view)),
            shift: indentLess,
        },
    ]));
    return new EditorView({
        parent,
        state: EditorState.create({
            doc,
            extensions: [
                keys,
                history(),
                drawSelection(),
                indentOnInput(),
                bracketMatching(),
                python(),
                indentUnit.of(indent),
                EditorState.tabSize.of(indent.length),
                syntaxHighlighting(palette),
                theme,
                complete ? autocompletion({ override: [kernelCompletions(complete)], activateOnTyping: true, maxRenderedOptions: 200 }) : [],
                signature ? callTips(signature) : [],
                keymap.of([...defaultKeymap, ...historyKeymap]),
                EditorView.contentAttributes.of({ "aria-label": "python cell", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
                EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(u.state.doc.toString()); }),
            ],
        }),
    });
}
