// notebook-transport.js: the page's proxies for a cell's machining, under the real
// controls (the package's pkg/view.js) over a minimal DOM shim, the commands recorded.
//
// Run: node test/notebook-transport.mjs
import assert from "node:assert/strict";
import { createTransport } from "../notebook-transport.js";
import { attachMachiningControls, attachTimelineControls } from "../pkg/view.js";

// An EventTarget stands in for an element; `document.createElement` hands one out.
class FakeElement extends EventTarget {
    constructor(tag) {
        super();
        this.tagName = tag;
        this.children = [];
        this.style = {};
        this.className = "";
        this._text = "";
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = v; this.children = []; }
}
const fakeDocument = { createElement: (tag) => new FakeElement(tag) };
function container() { const c = new FakeElement("div"); c.ownerDocument = fakeDocument; return c; }
function find(root, className) {
    for (const child of root.children) {
        if (child.className === className) return child;
        const nested = find(child, className);
        if (nested) return nested;
    }
    return null;
}
const fire = (el, type) => el.dispatchEvent(new Event(type));

function stateAt(overrides = {}) {
    return {
        time: 3, duration: 120, playing: false, speed: 1, loop: false,
        tracks: [{ id: 1, kind: "machining", name: "job", offset: 0, duration: 120 }],
        segments: [{ track: 1, start: 0, end: 120, label: "T1 flat 6 mm", colour: [1, 0, 0] }],
        markers: [{ track: 1, time: 60, label: "T2 drill 6 mm", kind: "tool change" }],
        status: ["move 3 of 500 · T1 flat 6 mm"],
        machining: { id: 9, move: 3, moves: 500, hasPart: true, cycleTime: 120, cell: 0.1, colour: "height", path: true, tool: true },
        ...overrides,
    };
}

// 1. Before any state: an empty, paused timeline.
{
    const t = createTransport({ send: () => {} });
    assert.equal(t.received, false);
    assert.deepEqual([t.timeline.time, t.timeline.duration, t.timeline.playing, t.timeline.tracks, t.machining.moves], [0, 0, false, [], 0]);
}

// 2. A state: the getters read it, onTime hears its time; onTime(null) stops that.
{
    const t = createTransport({ send: () => {} });
    const times = [];
    t.timeline.onTime((x) => times.push(x));
    t.update(stateAt());
    assert.equal(t.received, true);
    assert.deepEqual(times, [3]);
    assert.equal(t.timeline.duration, 120);
    assert.deepEqual(t.timeline.segments(), stateAt().segments);
    assert.deepEqual(t.timeline.markers(), stateAt().markers);
    assert.deepEqual(t.timeline.status(), stateAt().status);
    assert.deepEqual([t.machining.hasPart, t.machining.move, t.machining.moves, t.machining.id], [true, 3, 500, 9]);
    t.timeline.onTime(null);
    t.update(stateAt({ time: 4 }));
    assert.deepEqual(times, [3]);
}

// 3. Commands: sent, and guessed at once; the worker's next state replaces the guess.
{
    const sent = [];
    const t = createTransport({ send: (c, v) => sent.push([c, v]) });
    t.update(stateAt());
    t.timeline.play(4);
    assert.deepEqual([sent.at(-1), t.timeline.playing, t.timeline.speed], [["play", 4], true, 4]);
    t.timeline.pause();
    assert.deepEqual([sent.at(-1), t.timeline.playing], [["pause", undefined], false]);
    t.timeline.seek(500);
    assert.deepEqual([sent.at(-1), t.timeline.time], [["seek", 120], 120], "clamped to the duration");
    t.timeline.seek(-2);
    assert.deepEqual(sent.at(-1), ["seek", 0]);
    t.timeline.setLoop(1);
    assert.deepEqual([sent.at(-1), t.timeline.loop], [["loop", true], true]);
    t.machining.seek(600);
    assert.deepEqual([sent.at(-1), t.machining.move], [["move", 500], 500], "clamped to the moves");
    t.machining.seek(2.4);
    assert.deepEqual(sent.at(-1), ["move", 2]);
    t.machining.colourBy("tool");
    assert.deepEqual(sent.at(-1), ["colour", "tool"]);
    t.machining.showPath(0);
    assert.deepEqual(sent.at(-1), ["path", false]);
    t.machining.showTool(true);
    assert.deepEqual(sent.at(-1), ["tool", true]);
    const n = sent.length;
    assert.throws(() => t.timeline.play(0), /timeline: speed must be positive and finite/);
    assert.equal(sent.length, n, "a refused play sends nothing");
    t.update(stateAt({ playing: true, speed: 16 }));
    assert.deepEqual([t.timeline.playing, t.timeline.speed, t.machining.move], [true, 16, 3]);
}

// 4. The real controls over the proxies.
{
    const sent = [];
    const t = createTransport({ send: (c, v) => sent.push([c, v]) });
    t.update(stateAt());
    const box = container();
    const timeline = attachTimelineControls(box, t.timeline);
    const machining = attachMachiningControls(box, t.machining);
    const play = find(box, "cadaclysm-timeline-play"), time = find(box, "cadaclysm-timeline-time");
    assert.equal(play.textContent, "Play");
    assert.equal(time.textContent, "0:03.0 / 2:00.0");
    fire(play, "click");
    assert.deepEqual(sent.at(-1), ["play", 1]);
    assert.equal(play.textContent, "Pause", "the guess shows at once");
    t.update(stateAt({ time: 9.5, playing: true }));
    assert.equal(time.textContent, "0:09.5 / 2:00.0", "a state refreshes the readout");
    fire(play, "click");
    assert.deepEqual(sent.at(-1), ["pause", undefined]);
    assert.equal(play.textContent, "Play", "a pause shows at once");
    const scrubber = find(box, "cadaclysm-timeline-scrubber");
    scrubber.value = "30";
    fire(scrubber, "input");
    assert.deepEqual(sent.at(-1), ["seek", 30]);
    const colour = find(box, "cadaclysm-machining-colour");
    assert.deepEqual(colour.children.map((o) => o.value), ["height", "tool", "deviation"], "deviation offered: the job has a part");
    colour.value = "deviation";
    fire(colour, "change");
    assert.deepEqual(sent.at(-1), ["colour", "deviation"]);
    const forward = find(box, "cadaclysm-machining-step-forward");
    fire(forward, "click");
    assert.deepEqual(sent.at(-1), ["move", 4]);
    fire(forward, "click");
    assert.deepEqual(sent.at(-1), ["move", 5], "the second click steps from the first's guess");
    timeline.detach();
    machining.detach();
    assert.equal(box.children.length, 0, "detached");
    const n = sent.length;
    t.update(stateAt({ time: 50 }));
    assert.equal(sent.length, n, "a state after detach drives nothing");
}

// 5. Stepping right after a seek: the worker's first state still carries the move before it.
{
    const sent = [];
    const t = createTransport({ send: (c, v) => sent.push([c, v]) });
    t.update(stateAt());
    const box = container();
    attachMachiningControls(box, t.machining);
    const forward = find(box, "cadaclysm-machining-step-forward");
    const back = find(box, "cadaclysm-machining-step-back");
    const at = (move) => stateAt({ machining: { ...stateAt().machining, move } });
    t.machining.seek(100);
    t.update(at(3));   // stale: the move before the seek
    fire(forward, "click");
    assert.deepEqual(sent.at(-1), ["move", 101], "steps from the pending target, not the stale move");
    t.update(at(3));
    fire(back, "click");
    assert.deepEqual(sent.at(-1), ["move", 100]);
    t.update(at(100));   // reached: the state rules again
    assert.equal(t.machining.move, 100);
    t.update(at(104));
    assert.equal(t.machining.move, 104);
}

// 6. One onTime slot: a second callback replaces the first.
{
    const t = createTransport({ send: () => {} });
    const a = [], b = [];
    t.timeline.onTime((x) => a.push(x));
    t.timeline.onTime((x) => b.push(x));
    t.update(stateAt());
    assert.deepEqual([a, b], [[], [3]]);
}

// 7. A seek onto a zero-time move lands one past it: the target clears there.
{
    const t = createTransport({ send: () => {} });
    t.update(stateAt());
    const at = (move) => stateAt({ machining: { ...stateAt().machining, move } });
    t.machining.seek(100);
    t.update(at(3));
    assert.equal(t.machining.move, 100, "the stale echo: the target still answers");
    t.update(at(101));
    assert.equal(t.machining.move, 101, "past the target, not the old move: the state rules");
}

// 8. reset() drops a target no worker will answer.
{
    const t = createTransport({ send: () => {} });
    t.update(stateAt());
    t.machining.seek(100);
    assert.equal(t.machining.move, 100);
    t.reset();
    t.update(stateAt());
    assert.equal(t.machining.move, 3, "the next state rules");
}

console.log("notebook-transport: ok");
