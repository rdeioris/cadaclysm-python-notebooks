// How a notebook cell's drawn items are named and coloured (notebook-scene.js): the
// caption and legend text over a view, the pinched cross's arms, and the kernel's paint
// read back through notebook-mesh.js's meshOf; and the words Open refuses a non-document in.
// Run: node test/notebook-scene.mjs   (after npm run setup)
import assert from "node:assert";
import { captionOf, crossesOf, documentRefusal, legendOf, MAX_LEGEND, PALETTE } from "../notebook-scene.js";
import { meshOf, RENDER_TOLERANCE } from "../notebook-mesh.js";
import { loadWasm } from "./package.mjs";

const tri = (dx) => ({
    vertices: new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    edges: new Float32Array([dx, 0, 0, dx + 1, 0, 0]),
    faces: 1, edgeCount: 1,
});
// A profile is edges alone: no faces, its own edgeCount.
const ring = { vertices: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0),
    edges: new Float32Array([-5, -2, 0, 5, -2, 0, 5, -2, 0, 5, 2, 0]), faces: 0, edgeCount: 2, kind: "profile" };
// The caption: solids and their faces, profiles, every edge.
assert.strictEqual(captionOf([tri(0)]), "1 solid · 1 faces · 1 edges");
assert.strictEqual(captionOf([tri(0), tri(1)]), "2 solids · 2 faces · 2 edges");
assert.strictEqual(captionOf([ring]), "1 profile · 2 edges");
assert.strictEqual(captionOf([tri(0), ring, ring]), "1 solid · 2 profiles · 1 faces · 5 edges");
const job = { kind: "machining", faces: 0, edgeCount: 0, colour: null, closure: null, programs: [{ tool: 1, shape: "flat", diameter: 6 }, { tool: 2, shape: "drill", diameter: 6 }], hasPart: true };
assert.strictEqual(captionOf([job]), "a job · 2 programs · T1 flat 6 mm, T2 drill 6 mm");
assert.strictEqual(captionOf([tri(0), job]), "a job · 2 programs · T1 flat 6 mm, T2 drill 6 mm · 1 solid · 1 faces · 1 edges");
assert.deepStrictEqual(legendOf([job]), [], "a job has no legend chip");
// An assembly: its parts counted, its edges not (they are its parts'); with a solid beside it.
const rig = (parts) => ({ kind: "assembly", faces: 0, edgeCount: 0, parts, colour: null, closure: null });
assert.strictEqual(captionOf([rig(3)]), "1 assembly of 3 parts");
assert.strictEqual(captionOf([rig(1), rig(4)]), "2 assemblies of 5 parts");
assert.strictEqual(captionOf([tri(0), rig(2)]), "1 solid · 1 assembly of 2 parts · 1 faces · 1 edges");
// The legend: which solids are closed. One entry per solid, numbered among the solids (a
// profile has none and takes no number), in the colour it is drawn in; the counts worded.
const closed = { closed: true, manifold: true, boundaryEdges: 0, nonManifoldEdges: 0, nonManifoldVertices: 0 };
const sheet = { closed: false, manifold: true, boundaryEdges: 4, nonManifoldEdges: 0, nonManifoldVertices: 0 };
const fin = { closed: false, manifold: false, boundaryEdges: 9, nonManifoldEdges: 1, nonManifoldVertices: 0 };
const corner = { closed: false, manifold: false, boundaryEdges: 0, nonManifoldEdges: 0, nonManifoldVertices: 2 };
assert.deepStrictEqual(legendOf([{ ...tri(0), closure: closed }]), [{ number: 1, colour: PALETTE[0], state: "closed", text: "closed" }]);
assert.deepStrictEqual(
    legendOf([{ ...tri(0), closure: closed }, ring, { ...tri(1), closure: sheet, colour: [1, 0, 0] }, { ...tri(2), closure: fin }, { ...tri(3), closure: corner }]),
    [
        { number: 1, colour: PALETTE[0], state: "closed", text: "closed" },
        { number: 2, colour: [1, 0, 0], state: "open", text: "open · 4 boundary edges" },
        { number: 3, colour: PALETTE[3], state: "pinched", text: "not manifold · 1 edge on 3+ faces" },
        { number: 4, colour: PALETTE[0], state: "pinched", text: "not manifold · 2 pinched vertices" },
    ],
    "the colour is the scene's: palette by position, the profile's slot counted");
assert.strictEqual(legendOf([{ ...tri(0), closure: { ...sheet, boundaryEdges: 1 } }])[0].text, "open · 1 boundary edge");
assert.deepStrictEqual(legendOf([ring]), [], "a profile is neither closed nor open");
assert.deepStrictEqual(legendOf([tri(0)]), [], "a solid the kernel said nothing about has no entry");
// Past MAX_LEGEND the closed fold into one count and the rest keep their numbers.
const many = Array.from({ length: MAX_LEGEND + 2 }, (_, k) => ({ ...tri(k), closure: k === 4 ? sheet : closed }));
assert.deepStrictEqual(legendOf(many).map((e) => [e.number, e.text]), [[null, `${MAX_LEGEND + 1} closed`], [5, "open · 4 boundary edges"]]);

// meshOf reads the kernel's paint: a cube with every edge gold and edge 5 blue has a
// colour for every segment, some blue and not all; a paint-free cube has none; a
// coloured profile carries its colour and a plain one null.
{
    const wasm = await loadWasm();
    const cube = wasm.cadaclysm_blacksmith_cuboid(2, 2, 2);
    const gold = wasm.cadaclysm_blacksmith_edges_coloured(cube, null, 0.8, 0.6, 0.4);
    const painted = wasm.cadaclysm_blacksmith_edges_coloured(gold, Uint32Array.of(5), 0.2, 0.4, 1);
    const m = meshOf(wasm, painted, 6, 12, null, [], "solid");
    assert.strictEqual(m.edgeColours.length, m.edges.length / 6, "a colour per segment");
    assert.ok(m.edgeColours.every((c) => c !== null), "every edge painted");
    const blue = m.edgeColours.filter((c) => c[2] === 1).length;
    assert.ok(blue >= 1 && blue < m.edgeColours.length, `${blue} of ${m.edgeColours.length} segments blue`);
    // Per-polyline alignment: reading the wasm's own two arrays directly, segment i of
    // m.edgeColours belongs to whichever polyline it fell under above, in order -- so it
    // must equal that polyline's paint (or null, where the polyline's own r is negative).
    const paint = wasm.cadaclysm_blacksmith_edge_polyline_colours(painted, RENDER_TOLERANCE);
    const lines = wasm.cadaclysm_blacksmith_edge_polylines(painted, RENDER_TOLERANCE);
    let seg = 0;
    for (let i = 0; i + 1 < lines.offsets.length; i++) {
        const expected = paint[3 * i] < 0 ? null : [paint[3 * i], paint[3 * i + 1], paint[3 * i + 2]];
        for (let j = lines.offsets[i]; j + 1 < lines.offsets[i + 1]; j++) {
            assert.deepStrictEqual(m.edgeColours[seg], expected, `polyline ${i} segment ${seg}`);
            seg++;
        }
    }
    assert.strictEqual(seg, m.edgeColours.length, "every segment of every polyline checked, in order");
    assert.strictEqual(meshOf(wasm, cube, 6, 12, null, [], "solid").edgeColours, null, "no paint: null");
    const rect = wasm.cadaclysm_blacksmith_profile_rect(4, 2);
    const blueRect = wasm.cadaclysm_blacksmith_profile_coloured(rect, 0.2, 0.4, 1);
    assert.deepStrictEqual(meshOf(wasm, blueRect, 0, 0, null, [], "profile").colour, [0.2, 0.4, 1]);
    assert.strictEqual(meshOf(wasm, rect, 0, 0, null, [], "profile").colour, null);
    for (const h of [cube, gold, painted]) wasm.cadaclysm_blacksmith_solid_free(h);
    for (const h of [rect, blueRect]) wasm.cadaclysm_blacksmith_profile_free(h);
}

// crossesOf: three arms per point, `arm` either way along each axis -- the pinched cross.
{
    const c = crossesOf(new Float32Array([1, 2, 3]), 0.5);
    assert.strictEqual(c.length, 18);
    assert.deepStrictEqual(Array.from(c.subarray(0, 6)), [0.5, 2, 3, 1.5, 2, 3], "the x arm");
    assert.deepStrictEqual(Array.from(c.subarray(12, 18)), [1, 2, 2.5, 1, 2, 3.5], "the z arm");
    assert.strictEqual(crossesOf(new Float32Array(0), 1).length, 0);
}

// Open takes a blacksmith document and refuses anything else in words, naming the format it
// saw when there is one.
assert.strictEqual(documentRefusal(JSON.stringify({ format: "cadaclysm-blacksmith", version: 1, nodes: [] })), null);
assert.strictEqual(documentRefusal(JSON.stringify({ format: "cadaclysm-forge", version: 3 })), 'not a cadaclysm-blacksmith document (it is "cadaclysm-forge")');
assert.strictEqual(documentRefusal(JSON.stringify({ nodes: [] })), "not a cadaclysm-blacksmith document");
assert.strictEqual(documentRefusal("[1, 2]"), "not a cadaclysm-blacksmith document");
assert.strictEqual(documentRefusal("{ nope"), "not a cadaclysm-blacksmith document (not JSON)");

console.log("notebook-scene: ok");
