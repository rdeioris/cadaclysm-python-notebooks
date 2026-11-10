// The page's side of a cell's machining: proxy objects
// with the members pkg/view.js's attachTimelineControls and
// attachMachiningControls read and call, fed by the worker's `view.timeline` state
// (notebook-machining.js) and sending its `view.transport` commands. Apart from the page so
// Node can test it (test/notebook-transport.mjs).
//
// A proxy answers from the latest state. A command also sets what it changes at once
// (playing, speed, time, loop, move, colour, path, tool), so a control that reads back right
// after a click sees its click; the worker's next state replaces the guess. `send(command,
// value)` is the page's: it posts to whichever view the cell has now, or drops the command
// when it has none.

const EMPTY = Object.freeze({
    time: 0, duration: 0, playing: false, speed: 1, loop: false, tracks: [], segments: [], markers: [], status: [],
    machining: { id: null, move: 0, moves: 0, hasPart: false, cycleTime: 0, cell: 0, colour: "height", path: true, tool: true },
});

export function createTransport({ send }) {
    let state = EMPTY;
    let onTime = null;
    // The move a `move` command asked for, until a state shows the worker reached it. The
    // state sent with a command still carries the move before it (the track realizes a seek
    // on a later frame), so a step button reading `move` right after a seek would step from
    // the old one; `move` answers with the target meanwhile.
    let pending = null, from = null;   // `from`: the move the state held when the target was set
    const set = (changes) => { state = { ...state, ...changes }; };
    const setMachining = (changes) => { state = { ...state, machining: { ...state.machining, ...changes } }; };

    const timeline = {
        get time() { return state.time; },
        get duration() { return state.duration; },
        get playing() { return state.playing; },
        get speed() { return state.speed; },
        get loop() { return state.loop; },
        get tracks() { return state.tracks; },
        play(speed = 1) {
            if (!(Number.isFinite(speed) && speed > 0)) throw new Error("timeline: speed must be positive and finite");
            pending = null;
            set({ playing: true, speed });
            send("play", speed);
        },
        pause() { set({ playing: false }); send("pause"); },
        seek(t) {
            pending = null;
            const time = Math.min(Math.max(Number(t) || 0, 0), state.duration);
            set({ time });
            send("seek", time);
        },
        setLoop(on) { set({ loop: !!on }); send("loop", !!on); },
        segments() { return state.segments; },
        markers() { return state.markers; },
        status() { return state.status; },
        onTime(callback) { onTime = callback; },
    };

    const machining = {
        get id() { return state.machining.id; },
        get move() { return pending ?? state.machining.move; },
        get moves() { return state.machining.moves; },
        get hasPart() { return state.machining.hasPart; },
        get playing() { return state.playing; },
        get cycleTime() { return state.machining.cycleTime; },
        get cell() { return state.machining.cell; },
        play(speed = 1) { timeline.play(speed); },
        pause() { timeline.pause(); },
        seek(move) {
            const m = Math.min(Math.max(Math.round(Number(move) || 0), 0), state.machining.moves);
            if (pending === null) from = state.machining.move;
            pending = m;
            setMachining({ move: m });
            send("move", m);
        },
        colourBy(mode) { setMachining({ colour: mode }); send("colour", mode); },
        showPath(on) { setMachining({ path: !!on }); send("path", !!on); },
        showTool(on) { setMachining({ tool: !!on }); send("tool", !!on); },
    };

    return {
        timeline,
        machining,
        reset() { pending = null; },   // a command that never reached a worker leaves no target to wait for
        get state() { return state; },
        get received() { return state !== EMPTY; },
        update(next) {
            state = next;
            // Reached, or passed: a seek onto a zero-time move lands one past it, never on it.
            const at = next.machining.move;
            if (pending !== null && (next.playing || at === pending || (at > pending && at !== from))) pending = null;
            onTime?.(next.time);
        },
    };
}
