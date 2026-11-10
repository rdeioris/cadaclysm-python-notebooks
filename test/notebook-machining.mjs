// notebook-machining.js: the worker's machining bridge, against fakes -- a View whose
// showMachining hands back a fake Machining, a fake timeline, a host that records the views
// it is asked to draw, and a clock and timers the test moves by hand.
//
// Run: node test/notebook-machining.mjs
import assert from "node:assert/strict";
import { createMachiningBridge, STATE_EVERY_MS } from "../notebook-machining.js";

function fakeTimeline() {
    return {
        calls: [], time: 0, duration: 120, playing: false, speed: 1, loop: false,
        tracks: [{ id: 1, kind: "machining", name: "job", offset: 0, duration: 120 }],
        onTimeCb: null,
        play(s) { this.calls.push(["play", s]); this.playing = true; this.speed = s; },
        pause() { this.calls.push(["pause"]); this.playing = false; },
        seek(x) { this.calls.push(["seek", x]); this.time = x; },
        setLoop(on) { this.calls.push(["setLoop", on]); this.loop = on; },
        segments() { return [{ track: 1, start: 0, end: 120, label: "T1 flat 6 mm", colour: [1, 0, 0] }]; },
        markers() { return []; },
        status() { return ["move 3 of 500"]; },
        onTime(cb) { this.calls.push(["onTime", cb === null ? null : "fn"]); this.onTimeCb = cb; },
    };
}

function fakeMachining({ hasPart = true, seekError = null } = {}) {
    return {
        calls: [], id: 9, move: 0, moves: 500, hasPart, cycleTime: 120, cell: 0.1, onMoveCb: null,
        colourBy(m) { this.calls.push(["colourBy", m]); },
        showPath(on) { this.calls.push(["showPath", on]); },
        showTool(on) { this.calls.push(["showTool", on]); },
        seek(m) { this.calls.push(["seek", m]); if (seekError) throw new Error(seekError); this.move = m; },
        onMove(cb) { this.calls.push(["onMove", cb === null ? null : "fn"]); this.onMoveCb = cb; },
    };
}

function fakeViewer(machining, timeline) {
    return { shown: [], showMachining(o) { this.shown.push(o); return machining; }, get timeline() { return timeline; } };
}

function rig({ meshPart = null } = {}) {
    let clock = 0;
    const timers = [], posted = [], dirty = [];
    const bridge = createMachiningBridge({
        host: { markDirty: (v) => dirty.push(v) },
        post: (m) => posted.push(m),
        now: () => clock,
        setTimer: (fn, ms) => { const t = { fn, at: clock + ms, live: true }; timers.push(t); return t; },
        clearTimer: (t) => { t.live = false; },
        meshPart,
    });
    return {
        bridge, posted, dirty, timers,
        advance(ms) { clock += ms; for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); } },
    };
}

const SHOW = {
    kind: "machining",
    options: { stock: { min: [0, 0, 0], max: [40, 30, 10] }, programs: [{ tool: { number: 1, shape: "flat", diameter: 6, flute_length: 20 }, gcode: "G0 X0" }] },
    part: 100,
};

// 1. attach: showMachining with the part's shared handle, the stock's id back, a state at
// once, both callbacks registered, and the Machining and the timeline held.
{
    const r = rig(), t = fakeTimeline(), m = fakeMachining(), v = fakeViewer(m, t);
    assert.equal(r.bridge.attach(5, 1, v, SHOW), 9, "the stock's id, to frame");
    assert.deepEqual(v.shown, [{ ...SHOW.options, part: 100 }]);
    assert.equal(r.posted.length, 1, "a state at once");
    assert.deepEqual(r.posted[0], {
        kind: "view.timeline", id: 5, state: {
            time: 0, duration: 120, playing: false, speed: 1, loop: false, tracks: t.tracks,
            segments: t.segments(), markers: [], status: ["move 3 of 500"],
            machining: { id: 9, move: 0, moves: 500, hasPart: true, cycleTime: 120, cell: 0.1, colour: "height", path: true, tool: true },
        },
    });
    assert.deepEqual(t.calls, [["onTime", "fn"]]);
    assert.deepEqual(m.calls, [["onMove", "fn"]]);
    assert.equal(r.bridge.held(5).machining, m, "the Machining is held");
    assert.equal(r.bridge.held(5).timeline, t, "and the timeline its onTime is on");
    const r2 = rig(), v2 = fakeViewer(fakeMachining({ hasPart: false }), fakeTimeline());
    r2.bridge.attach(6, 2, v2, { ...SHOW, part: null });
    assert.deepEqual(v2.shown, [SHOW.options], "no part: no part key");
}

// 2. The throttle: a command sends at once; ticks inside STATE_EVERY_MS wait for one
// trailing send with the latest time; past it a tick sends at once; a stop sends at once.
{
    const r = rig(), t = fakeTimeline(), m = fakeMachining();
    r.bridge.attach(5, 1, fakeViewer(m, t), SHOW);
    r.bridge.command(5, { command: "play", value: 4 });
    assert.deepEqual(t.calls.at(-1), ["play", 4]);
    assert.deepEqual(r.dirty, [5], "a command asks for a frame");
    assert.equal(r.posted.length, 2);
    assert.equal(r.posted[1].state.playing, true);
    for (let k = 1; k <= 5; k++) { r.advance(10); t.time = k * 0.04; t.onTimeCb(t.time); }
    assert.equal(r.posted.length, 2, "nothing inside 100 ms");
    assert.equal(r.timers.filter((x) => x.live).length, 1, "one trailing send waits");
    r.advance(STATE_EVERY_MS - 50);
    assert.equal(r.posted.length, 3, "the trailing send");
    assert.equal(r.posted[2].state.time, 0.2, "with the latest time");
    r.advance(150); t.time = 0.8; t.onTimeCb(t.time);
    assert.equal(r.posted.length, 4, "past 100 ms a tick sends at once");
    r.advance(10); t.time = 0.84; t.playing = false; t.onTimeCb(t.time);
    assert.equal(r.posted.length, 5, "a stop is a change: at once");
    assert.equal(r.posted[4].state.playing, false);
}

// 3. A paused seek that takes several frames: each move it stamps asks for the next frame;
// while playing the View's own needsDraw does.
{
    const r = rig(), t = fakeTimeline(), m = fakeMachining();
    r.bridge.attach(5, 1, fakeViewer(m, t), SHOW);
    r.bridge.command(5, { command: "seek", value: 60 });
    assert.deepEqual(t.calls.at(-1), ["seek", 60]);
    r.dirty.length = 0;
    m.move = 20000; m.onMoveCb(20000, {});
    assert.deepEqual(r.dirty, [5], "paused and still stamping: another frame");
    t.playing = true; m.onMoveCb(20001, {});
    assert.deepEqual(r.dirty, [5], "playing: no extra frame asked");
}

// 4. Every command, an error said as the view's error (the state still follows), an
// unknown command, a view with no machining, and a trap thrown on.
{
    const r = rig(), t = fakeTimeline(), m = fakeMachining({ seekError: "seek: move 900 is past the end of the 500 moves" });
    r.bridge.attach(5, 1, fakeViewer(m, t), SHOW);
    for (const [command, value, call] of [["pause", undefined, ["pause"]], ["loop", 1, ["setLoop", true]], ["seek", "12.5", ["seek", 12.5]], ["play", undefined, ["play", 1]]]) {
        r.bridge.command(5, { command, value });
        assert.deepEqual(t.calls.at(-1), call, command);
    }
    for (const [command, value, call] of [["colour", "tool", ["colourBy", "tool"]], ["path", 0, ["showPath", false]], ["tool", false, ["showTool", false]]]) {
        r.bridge.command(5, { command, value });
        assert.deepEqual(m.calls.at(-1), call, command);
    }
    const last = r.posted.at(-1).state.machining;
    assert.deepEqual([last.colour, last.path, last.tool], ["tool", false, false]);
    r.bridge.command(5, { command: "move", value: 900 });
    assert.deepEqual(r.posted.at(-2), { kind: "view.error", id: 5, message: "seek: move 900 is past the end of the 500 moves" });
    assert.equal(r.posted.at(-1).kind, "view.timeline", "the state still follows");
    r.bridge.command(5, { command: "rewind" });
    assert.deepEqual(r.posted.at(-2), { kind: "view.error", id: 5, message: "no transport command rewind" });
    const n = r.posted.length;
    r.bridge.command(77, { command: "play", value: 1 });
    assert.equal(r.posted.length, n, "a view with no machining: ignored");
    m.colourBy = () => { throw new WebAssembly.RuntimeError("unreachable"); };
    assert.throws(() => r.bridge.command(5, { command: "colour", value: "height" }), WebAssembly.RuntimeError, "a trap is the crash path's");
}

// 5. A view dropped and made again: the callbacks let go, no state after, and the next
// view of the cell starts paused at the time, with the loop, colour and overlays it had.
{
    const r = rig(), t = fakeTimeline(), m = fakeMachining();
    r.bridge.attach(5, 1, fakeViewer(m, t), SHOW);
    for (const [command, value] of [["play", 4], ["loop", true], ["colour", "deviation"], ["tool", false]]) r.bridge.command(5, { command, value });
    r.advance(10); t.time = 47.25; t.onTimeCb(47.25);   // a trailing send now waits
    r.bridge.detach(5);
    assert.deepEqual(t.calls.at(-1), ["onTime", null]);
    assert.deepEqual(m.calls.at(-1), ["onMove", null]);
    assert.equal(r.bridge.held(5), undefined, "let go");
    const n = r.posted.length;
    r.advance(1000);
    assert.equal(r.posted.length, n, "no state once the view is gone");
    const t2 = fakeTimeline(), m2 = fakeMachining();
    r.bridge.attach(8, 1, fakeViewer(m2, t2), SHOW);
    assert.deepEqual(m2.calls, [["colourBy", "deviation"], ["showTool", false], ["onMove", "fn"]]);
    assert.deepEqual(t2.calls, [["setLoop", true], ["seek", 47.25], ["onTime", "fn"]]);
    const s = r.posted.at(-1).state;
    assert.deepEqual([s.playing, s.time, s.loop, s.machining.colour, s.machining.path, s.machining.tool], [false, 47.25, true, "deviation", true, false]);
    r.bridge.detach(8);
    const m3 = fakeMachining({ hasPart: false });
    r.bridge.attach(9, 1, fakeViewer(m3, fakeTimeline()), { ...SHOW, part: null });
    assert.deepEqual(m3.calls, [["showTool", false], ["onMove", "fn"]], "deviation is not asked of a job with no part");
    assert.equal(r.posted.at(-1).state.machining.colour, "height");
    r.bridge.detach(9);
    r.bridge.forget(1);
    const t4 = fakeTimeline();
    r.bridge.attach(10, 1, fakeViewer(fakeMachining(), t4), SHOW);
    assert.deepEqual(t4.calls, [["onTime", "fn"]], "a cell run again starts fresh");
}

// 6. Task 6 review minors: a disposed Machining, play's coercion, a throw mid-resume.
{
    const DISPOSED = "Machining: this machining was disposed";
    const r = rig(), t = fakeTimeline(), m = fakeMachining();
    r.bridge.attach(5, 1, fakeViewer(m, t), SHOW);
    r.bridge.command(5, { command: "play", value: "4" });
    assert.deepEqual(t.calls.at(-1), ["play", 4], "play coerces its value like seek and move");
    const gone = () => { throw new Error(DISPOSED); };
    // Disposed: every Machining call throws. A command says it as the view's error and does not throw.
    m.onMove = gone;
    Object.defineProperty(m, "id", { get: gone });
    const before = r.posted.filter((x) => x.kind === "view.error").length;
    assert.doesNotThrow(() => r.bridge.command(5, { command: "pause" }));
    assert.deepEqual(r.posted.at(-1), { kind: "view.error", id: 5, message: DISPOSED });
    assert.equal(r.posted.filter((x) => x.kind === "view.error").length, before + 1, "one error, not two");
    assert.equal(r.bridge.held(5), undefined, "a disposed Machining is detached");
    // detach still lets go of the timeline, keeps the cell's state, and does not throw.
    assert.doesNotThrow(() => r.bridge.detach(5));
    assert.deepEqual(t.calls.at(-1), ["onTime", null]);
    const t2 = fakeTimeline();
    r.bridge.attach(6, 1, fakeViewer(fakeMachining(), t2), SHOW);
    assert.deepEqual(t2.calls.slice(0, 2), [["setLoop", false], ["seek", t.time]], "the kept state survived");
    r.bridge.detach(6);
    // A trap in a clear still goes on.
    const t3 = fakeTimeline(), m3 = fakeMachining();
    r.bridge.attach(7, 2, fakeViewer(m3, t3), SHOW);
    m3.onMove = () => { throw new WebAssembly.RuntimeError("unreachable"); };
    assert.throws(() => r.bridge.detach(7), WebAssembly.RuntimeError);
    // A resume step that throws leaves the new Machining held.
    const r4 = rig();
    const ta = fakeTimeline(), ma = fakeMachining();
    r4.bridge.attach(1, 3, fakeViewer(ma, ta), SHOW);
    ta.seek(9);
    r4.bridge.detach(1);
    const tb = fakeTimeline(), mb = fakeMachining();
    tb.seek = () => { throw new Error("seek refused"); };
    assert.throws(() => r4.bridge.attach(2, 3, fakeViewer(mb, tb), SHOW), /seek refused/);
    assert.equal(r4.bridge.held(2)?.machining, mb, "held although a resume step threw");
    assert.ok(tb.calls.some((c) => c[0] === "onTime" && c[1] === "fn"), "onTime registered although a resume step threw");
    assert.ok(r4.posted.some((x) => x.kind === "view.timeline" && x.id === 2), "the first state was sent");
}

// 7. The trailing timer or a callback meeting a disposed Machining: the view's error, and the
// dead callbacks let go -- nothing thrown into the timer.
{
    const DISPOSED = "Machining: this machining was disposed";
    const r = rig(), t = fakeTimeline(), m = fakeMachining();
    r.bridge.attach(5, 1, fakeViewer(m, t), SHOW);
    r.bridge.command(5, { command: "play", value: 1 });
    r.advance(10); t.time = 1; t.onTimeCb(1);
    assert.equal(r.timers.filter((x) => x.live).length, 1, "a trailing send waits");
    Object.defineProperty(m, "move", { get() { throw new Error(DISPOSED); } });
    assert.doesNotThrow(() => r.advance(STATE_EVERY_MS));
    assert.deepEqual(r.posted.at(-1), { kind: "view.error", id: 5, message: DISPOSED });
    assert.equal(r.bridge.held(5), undefined, "detached");
    assert.deepEqual(t.calls.at(-1), ["onTime", null], "the dead callback let go");
    // The same from a callback, not the timer.
    const r2 = rig(), t2 = fakeTimeline(), m2 = fakeMachining();
    r2.bridge.attach(6, 2, fakeViewer(m2, t2), SHOW);
    Object.defineProperty(m2, "moves", { get() { throw new Error(DISPOSED); } });
    t2.time = 5; t2.playing = true;
    assert.doesNotThrow(() => t2.onTimeCb(5));
    assert.equal(r2.posted.at(-1).kind, "view.error");
    assert.equal(r2.bridge.held(6), undefined);
}

// 8. clear lets go of every live Machining's callbacks, as detach does.
{
    const r = rig(), t = fakeTimeline(), m = fakeMachining();
    r.bridge.attach(5, 1, fakeViewer(m, t), SHOW);
    r.bridge.clear();
    assert.deepEqual(t.calls.at(-1), ["onTime", null], "onTime let go by clear");
    assert.equal(r.bridge.held(5), undefined);
}

// 9. A part is meshed once per snapshot: the first attach meshes the handle at a quarter of
// the job's tolerance as wasm's solid_part does (f32 tolerance, default 0.05) and hands
// showMachining the mesh; a cell's view made again gets the same mesh, not a new one; a new
// snapshot (the cell run again) meshes again; no part, or no meshPart, passes what it had.
{
    const meshed = [];
    const meshPart = (handle, tolerance) => { meshed.push([handle, tolerance]); return { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }; };
    const r = rig({ meshPart });
    const v1 = fakeViewer(fakeMachining(), fakeTimeline());
    r.bridge.attach(5, 1, v1, SHOW);
    assert.deepEqual(meshed, [[100, Math.fround(0.05) / 4]], "meshed once, at wasm's tolerance");
    const mesh = v1.shown[0].part;
    assert.ok(mesh.positions instanceof Float32Array && mesh.indices instanceof Uint32Array, "showMachining got the mesh");
    r.bridge.detach(5);
    const v2 = fakeViewer(fakeMachining(), fakeTimeline());
    r.bridge.attach(6, 1, v2, SHOW);
    assert.equal(meshed.length, 1, "the view made again did not mesh the part again");
    assert.equal(v2.shown[0].part, mesh, "it got the first mesh");
    const rerun = { ...SHOW, options: { ...SHOW.options, tolerance: 0.2 } };
    r.bridge.attach(7, 1, fakeViewer(fakeMachining(), fakeTimeline()), rerun);
    assert.deepEqual(meshed[1], [100, Math.fround(0.2) / 4], "a new snapshot meshes again, at its own tolerance");
    const bare = fakeViewer(fakeMachining({ hasPart: false }), fakeTimeline());
    r.bridge.attach(8, 2, bare, { ...SHOW, part: null });
    assert.equal(bare.shown[0].part, undefined, "no part, nothing meshed or passed");
    assert.equal(meshed.length, 2);
    const plain = rig();
    const v3 = fakeViewer(fakeMachining(), fakeTimeline());
    plain.bridge.attach(5, 1, v3, SHOW);
    assert.equal(v3.shown[0].part, 100, "without meshPart the handle goes to showMachining, as before");
    const bad = { ...SHOW, options: { ...SHOW.options, tolerance: -1 } };
    const v4 = fakeViewer(fakeMachining(), fakeTimeline());
    r.bridge.attach(9, 3, v4, bad);
    assert.equal(v4.shown[0].part, 100, "a tolerance showMachining refuses is left for it to refuse, with the handle");
}

console.log("notebook-machining: ok");
