// The notebook worker's side of a cell's machining:
// the cell's View plays the job with `showMachining`, and the page drives it over the view
// bridge. Apart from the View so Node can test it (test/notebook-machining.mjs).
//
// Page to worker: `{ kind: "view.transport", id, command, value }`, `command` one of play
// (value: the speed, 1 when absent), pause, seek (value: seconds), loop (value: on), move
// (value: a move -- the machining's own seek), colour (value: "height" | "tool" |
// "deviation"), path and tool (value: on). Worker to page: `{ kind: "view.timeline", id,
// state }`, state `{ time, duration, playing, speed, loop, tracks, segments, markers, status,
// machining: { id, move, moves, hasPart, cycleTime, cell, colour, path, tool } }` -- at once
// on an attach, a command, or a change of play state, speed, loop, duration or the colour and
// overlays; otherwise at most every STATE_EVERY_MS while the clock or the playhead moves, the
// last change always sent (a trailing timer). A command that throws is said as
// `{ kind: "view.error", id, message }`; a trap is thrown on, to the worker's crash path.
//
// The bridge holds each Machining, and the timeline handle its onTime is on, from `attach`
// to `detach`: a View or a Machining nothing references is collected, and a collected
// View stops playing (cd20ff58f). The host's `views` holds the View itself.
//
// A part comes as the snapshot's solid handle. With `meshPart` (the worker's, over the
// kernel's `cadaclysm_blacksmith_mesh`), the first attach meshes it at a quarter of the job's
// tolerance -- what showMachining's own `solid_part` would -- and every attach of that
// snapshot hands showMachining the same `{ positions, indices }`, so a view scrolled away and
// back is not a fresh tessellation. The mesh lives as long as the snapshot (a WeakMap on it).
//
// A paused seek can take several frames (a machining stamps at most 20,000 moves a frame),
// and the host draws only what is dirty: while paused, each move the track stamps asks the
// host for the next frame, until the playhead stops moving.
//
// `detach(view)` -- before the host frees the View -- keeps the view's time, loop, colour
// mode and overlays by cell; the cell's next view (`attach`) starts paused at that time, with
// them. `forget(cell)` drops that: the cell ran again, or went.

export const STATE_EVERY_MS = 100;

const trapped = (e) => typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;

export function createMachiningBridge({ host, post, now, setTimer = setTimeout, clearTimer = clearTimeout, meshPart = null }) {
    const live = new Map();   // view id -> { cell, machining, timeline, colour, path, tool, sent, sentAt, timer }
    const kept = new Map();   // cell id -> { time, loop, colour, path, tool }
    const meshes = new WeakMap();   // snapshot's show -> { positions, indices }

    // The part showMachining gets: the snapshot's mesh, made on its first attach, or the
    // handle itself (no meshPart, or a tolerance showMachining will refuse in its own words).
    function partOf(show) {
        if (show.part == null || !meshPart) return show.part;
        const t = show.options?.tolerance ?? 0.05;   // cadaclysm-machining's default
        if (!(t > 0 && Number.isFinite(t))) return show.part;
        let mesh = meshes.get(show);
        if (!mesh) {
            // wasm's solid_part: the job's tolerance as an f32, then a quarter of it in f64.
            mesh = meshPart(show.part, Math.fround(t) / 4);
            meshes.set(show, mesh);
        }
        return mesh;
    }

    // What changes "at once": everything but the clock and the playhead.
    const keyOf = (v) => `${v.timeline.playing}|${v.timeline.speed}|${v.timeline.loop}|${v.timeline.duration}|${v.colour}|${v.path}|${v.tool}`;

    function stateOf(v) {
        const t = v.timeline, m = v.machining;
        return {
            time: t.time, duration: t.duration, playing: t.playing, speed: t.speed, loop: t.loop,
            tracks: t.tracks, segments: t.segments(), markers: t.markers(), status: t.status(),
            machining: { id: m.id, move: m.move, moves: m.moves, hasPart: m.hasPart, cycleTime: m.cycleTime, cell: m.cell, colour: v.colour, path: v.path, tool: v.tool },
        };
    }

    function sendNow(view, v) {
        if (v.timer !== null) { clearTimer(v.timer); v.timer = null; }
        v.sent = keyOf(v);
        v.sentAt = now();
        post({ kind: "view.timeline", id: view, state: stateOf(v) });
    }

    // A send from a callback or the timer: a Machining disposed meanwhile (the stock removed
    // through view.call) throws from the state, so the view's error is said and the dead
    // callbacks let go instead of firing into the worker's top level. A trap goes on.
    function safeSend(view, v) {
        try {
            sendNow(view, v);
        } catch (e) {
            if (trapped(e)) throw e;
            post({ kind: "view.error", id: view, message: e?.message ?? String(e) });
            detach(view);
        }
    }

    function send(view) {
        const v = live.get(view);
        if (!v) return;
        if (keyOf(v) !== v.sent) { safeSend(view, v); return; }
        const wait = v.sentAt + STATE_EVERY_MS - now();
        if (wait <= 0) { safeSend(view, v); return; }
        if (v.timer === null) v.timer = setTimer(() => { v.timer = null; if (live.get(view) === v) safeSend(view, v); }, wait);
    }

    function attach(view, cell, viewer, show) {
        const part = partOf(show);
        const options = part == null ? show.options : { ...show.options, part };
        const machining = viewer.showMachining(options);
        const timeline = viewer.timeline;
        const v = { cell, machining, timeline, colour: "height", path: true, tool: true, sent: null, sentAt: -Infinity, timer: null };
        live.set(view, v);   // held before the resume steps: one that throws leaves the Machining held
        const resume = kept.get(cell);
        try {
            if (resume) {
                if (resume.colour !== "height" && (resume.colour !== "deviation" || machining.hasPart)) { machining.colourBy(resume.colour); v.colour = resume.colour; }
                if (!resume.path) { machining.showPath(false); v.path = false; }
                if (!resume.tool) { machining.showTool(false); v.tool = false; }
                timeline.setLoop(resume.loop);
                timeline.seek(resume.time);
            }
        } finally {   // a resume step that throws still leaves the controls working
            timeline.onTime(() => send(view));
            machining.onMove(() => { if (!timeline.playing) host.markDirty(view); send(view); });
            sendNow(view, v);
        }
        return machining.id;
    }

    function command(view, { command, value }) {
        const v = live.get(view);
        if (!v) return;
        const { machining: m, timeline: t } = v;
        let failed = null;
        try {
            switch (command) {
                case "play": t.play(value == null ? 1 : Number(value)); break;
                case "pause": t.pause(); break;
                case "seek": t.seek(Number(value)); break;
                case "loop": t.setLoop(!!value); break;
                case "move": m.seek(Number(value)); break;
                case "colour": m.colourBy(String(value)); v.colour = String(value); break;
                case "path": m.showPath(!!value); v.path = !!value; break;
                case "tool": m.showTool(!!value); v.tool = !!value; break;
                default: throw new Error(`no transport command ${command}`);
            }
        } catch (e) {
            if (trapped(e)) throw e;
            failed = e;
            post({ kind: "view.error", id: view, message: e?.message ?? String(e) });
        }
        host.markDirty(view);
        try {
            sendNow(view, v);
        } catch (e) {   // e.g. the stock was removed through view.call: the Machining is disposed
            if (trapped(e)) throw e;
            // One error for the whole command, then let the dead Machining go, as safeSend does.
            if (!failed) post({ kind: "view.error", id: view, message: e?.message ?? String(e) });
            detach(view);
            return;
        }
    }

    function detach(view) {
        const v = live.get(view);
        if (!v) return;
        live.delete(view);
        if (v.timer !== null) clearTimer(v.timer);
        kept.set(v.cell, { time: v.timeline.time, loop: v.timeline.loop, colour: v.colour, path: v.path, tool: v.tool });
        // A Machining disposed meanwhile (the stock removed through view.call) throws on any
        // call; the clears are then moot. Only a wasm trap goes on.
        for (const clear of [() => v.timeline.onTime(null), () => v.machining.onMove(null)]) {
            try { clear(); } catch (e) { if (trapped(e)) throw e; }
        }
    }

    function forget(cell) { kept.delete(cell); }

    function clear() {
        for (const v of live.values()) {
            if (v.timer !== null) clearTimer(v.timer);
            for (const unhook of [() => v.timeline.onTime(null), () => v.machining.onMove(null)]) {
                try { unhook(); } catch (e) { if (trapped(e)) throw e; }
            }
        }
        live.clear();
        kept.clear();
    }

    function held(view) {
        const v = live.get(view);
        return v ? { machining: v.machining, timeline: v.timeline } : undefined;
    }

    return { attach, command, detach, forget, clear, held };
}
