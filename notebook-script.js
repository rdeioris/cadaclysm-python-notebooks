// The notebook as text: the example notebooks the page's menu offers (the first is what
// the page opens with), and the one rule that turns cells into a script -- shared by the
// page (Copy as script) and the tests, so there is a single copy of each. Environment-free:
// no DOM, no kernel.
//
// Every example stands on its own: its first cell imports what it uses, and no cell
// reaches for a name another example made. test/kernel.mjs runs each one on a
// namespace wiped clean, and test/notebook-script.mjs runs each one's script next
// to the desktop library.

export const EXAMPLES = [
{
    id: "plate",
    title: "A plate, a boss and a bore",
    blurb: "extrude, join, cut, fillet -- and the colours the cuts keep",
    cells: [
`from cadaclysm_blacksmith import Axis, Profile, Selector, Workplane

plate = Workplane.xy().extrude(Profile.rect(120, 80), 14).solid()
print("faces:", plate.faces, "bounds:", plate.bounds)
plate`,
`boss = (Workplane.from_solid(plate)
        .faces(Selector.max(Axis.Z)).workplane()
        .extrude(Profile.circle(22), 26).solid()
        .coloured("#c8a060"))           # a brass boss: the join keeps its faces brass
part = plate.join(boss)
part`,
`bore = (Workplane.xy().extrude(Profile.circle(11), 60).solid()
        .translate(0, 0, -10).coloured("#378add"))
part = part.cut(bore)                   # the hole's wall takes the tool's blue
show(part, bore.translate(150, 0, 0))   # the part, and the tool beside it`,
`corners = [e for e in part.edges
           if e.is_line and abs(e.direction[2]) > 0.99
           and all(part.face_kind(f) == "plane" for f in e.faces)]
rounded = part.fillet(corners, 12.0)
print(rounded.step_text()[:120])
rounded`,
    ],
},
{
    id: "outlines",
    title: "Outlines: paths, chains and splines",
    blurb: "a profile drawn in pieces, closed, or through control points",
    cells: [
`from cadaclysm_blacksmith import Profile, Workplane

# An outline drawn in pieces, shuffled, the sides drawn against the arc: Profile.chain
# joins them in any order and either way round, and closes the loop.
top = Profile.path((-30, 40)).arc_to(30, 40, centre=(0, 40), ccw=False).end_open()
left = Profile.path((-30, 40)).line_to(-30, 0).end_open()
base = Profile.path((-30, 0)).line_to(30, 0).end_open()
right = Profile.path((30, 0)).line_to(30, 40).end_open()
arch = Profile.chain([top, base, left, right])
tile = Workplane.xy().extrude(arch, 6).solid()
show(arch, tile.translate(90, 0, 0))    # the outline, and the tile it extrudes to`,
`# An open outline closed: a hook drawn as a path ended open, and close_loop() adds the
# straight side from its end back to its start -- the open hook, the closed profile, and
# the solid that closed profile extrudes to.
hook = (Profile.path((0, 0)).line_to(40, 0).arc_to(60, 20, centre=(40, 20), ccw=True)
        .line_to(60, 40).end_open())
shut = hook.close_loop()
show(hook, shut.translate(80, 0), Workplane.xy().extrude(shut, 5).solid().translate(160, 0, 0))`,
`# A hexagon, a closed spline through four control points, and a rectangle with a hole in
# it: each drawn as its outline, and beside it the solid it extrudes to.
hexagon = Profile.regular_polygon((0, 0), 30, 6)
blob = Profile.spline([(-30, -20), (30, -20), (30, 20), (-30, 20)], closed=True)
washer = Profile.rect(60, 40).with_hole(Profile.circle(12))
show(hexagon, blob.translate(0, 70), washer.translate(0, 140),
     Workplane.xy().extrude(hexagon, 8).solid().translate(90, 0, 0),
     Workplane.xy().extrude(blob, 8).solid().translate(90, 70, 0),
     Workplane.xy().extrude(washer, 8).solid().translate(90, 140, 0))`,
    ],
},
{
    id: "press-pull",
    title: "Press-pull, re-round, re-chamfer",
    blurb: "faces pushed and pulled, rounds and bevels made again",
    cells: [
`from cadaclysm_blacksmith import Axis, Profile, Selector, Workplane

# The plate of the first example in one go: a brass boss joined, a blue bore cut, the
# four upright corners rounded.
plate = Workplane.xy().extrude(Profile.rect(120, 80), 14).solid()
boss = (Workplane.from_solid(plate).faces(Selector.max(Axis.Z)).workplane()
        .extrude(Profile.circle(22), 26).solid().coloured("#c8a060"))
bore = Workplane.xy().extrude(Profile.circle(11), 60).solid().translate(0, 0, -10).coloured("#378add")
part = plate.join(boss).cut(bore)
corners = [e for e in part.edges
           if e.is_line and abs(e.direction[2]) > 0.99
           and all(part.face_kind(f) == "plane" for f in e.faces)]
rounded = part.fillet(corners, 12.0)
rounded`,
`# A face of a solid pushed out, as a face extrude does it: the plate's flat right
# side raised 20 along its normal into a tab, its top and bottom merged with the plate's.
# A negative distance pulls the face in instead.
side = rounded.select_face(Selector.max(Axis.X))
rounded.push_pull(side, 20)`,
`# A curved face pushed, as a press-pull does it: a cylinder's (or a cone's) face
# moves out along its normal, and the flat faces beside it follow -- the brass boss's wall
# pushed out 6 is a boss 12 wider, and the blue bore's pushed out 4, into the hole, a bore
# 8 narrower. Each wall's two halves move, and come back, as one.
def wall(solid, colour):
    """The face of \`solid\` on a cylinder, painted \`colour\`."""
    return next(f for f in range(solid.faces)
                if solid.face_kind(f) == "cylinder" and solid.face_colour(f) == colour)

fatter = rounded.push_pull(wall(rounded, boss.colour), 6)
fatter.push_pull(wall(fatter, bore.colour), 4)`,
`# A round made again, as a press-pull on a fillet face does it: one of the plate's
# rounded corners taken from 12 to 4 -- taken back to its sharp corner, rounded again --
# and, beside it, another taken off altogether, square again.
corners = [f for f in range(rounded.faces)
           if rounded.face_kind(f) == "cylinder" and rounded.face_colour(f) is None]
show(rounded.refillet(corners[0], 4), rounded.unfillet(corners[1]).translate(150, 0, 0))`,
`# A chamfer cut again, and one taken off, as a press-pull and a delete do it on a
# chamfer's face: the part's upright corners bevelled 8 -- one bevel cut again at 3, and
# beside it another taken off, its corner square again.
uprights = [e for e in part.edges
            if e.is_line and abs(e.direction[2]) > 0.99
            and all(part.face_kind(f) == "plane" for f in e.faces)]
bevelled = part.chamfer(uprights, 8)
bevels = [f for f in range(bevelled.faces)
          if bevelled.face_kind(f) == "plane" and all(abs(n) > 0.1 for n in bevelled.face_frame(f)[9:11])]
show(bevelled.rechamfer(bevels[0], 3), bevelled.unchamfer(bevels[1]).translate(150, 0, 0))`,
    ],
},
{
    id: "sweeps",
    title: "Sweeps, pipes and coils",
    blurb: "a profile carried along a path in space, a spring",
    cells: [
`import math
from cadaclysm_blacksmith import Frame, Profile, Solid, SweepPath

# A square carried up 40 and bent to run 30 along X -- a mitred L, every wall exact --
# and a circle carried round a quarter arc: an exact surface of revolution.
bend = SweepPath.at((0, 0, 0)).line_to((0, 0, 40)).line_to((30, 0, 40))
arc = SweepPath.at((0, 0, 0)).arc(centre=(25, 0, 0), axis=(0, 1, 0), angle=math.pi / 2)
show(Solid.sweep(Profile.rect(10, 10), Frame.xy(), bend),
     Solid.sweep(Profile.circle(5), Frame.xy(), arc).translate(70, 0, 0))`,
`# A path drawn as a 2D chain -- a line, an arc, a Bezier fitted with tangent arcs -- laid
# on the XY plane, and a pipe run along it: a rod, and above it a tube with walls 1.5.
route = (Profile.path((0, 0)).line_to(40, 0).arc_to(60, 20, centre=(40, 20), ccw=True)
         .bezier_to((60, 50), (100, 50), (100, 80)).end_open())
path = SweepPath.along(route, Frame.xy())
show(Solid.pipe(path, 4), Solid.pipe(path, 4, thickness=1.5).translate(0, 0, 30))`,
`# A circle coiled about Z: a spring of four turns, climbing 12 a turn. The profile is read
# as (distance from the axis, height along it), so the circle is drawn at x = 20.
Solid.coil(Profile.circle(3).translate(20, 0), ((0, 0, 0), (0, 0, 1)), 12, 4)`,
    ],
},
{
    id: "revolve-loft",
    title: "Revolves, lofts and drafts",
    blurb: "a section turned about an axis, walls between sections, a taper",
    cells: [
`import math
from cadaclysm_blacksmith import Frame, Profile, Solid

# A vase: its half-section drawn as (radius, height) and turned a full circle about Z --
# and the same section turned a quarter, drawn with its axis as a sketch draws them.
section = (Profile.path((0, 0)).line_to(24, 0).line_to(28, 30)
           .arc_to(28, 60, centre=(44, 45), ccw=False)      # a waist, bowing in
           .line_to(16, 70).line_to(0, 70).line_to(0, 0).end())
show(Solid.revolve(section, ((0, 0, 0), (0, 0, 1)), math.tau),
     Solid.revolve_in_plane(section, Frame.xy(), (0, 0), (0, 1), math.pi / 2).translate(90, 0, 0))`,
`# A loft between two rectangles is a frustum; through three circles -- wide, narrow,
# wide -- it runs smooth: a waist, round at every height.
frustum = Solid.loft(Profile.rect(40, 40), Frame.xy(), Profile.rect(16, 16), Frame.xy((0, 0, 30)))
waist = Solid.loft_through([(Profile.circle(r), Frame.xy((0, 0, z))) for r, z in ((20, 0), (10, 25), (20, 50))])
show(frustum, waist.translate(80, 0, 0))`,
`# An extrusion with a draft: the walls lean out 10 degrees as they rise, each one exact --
# a plane off a line, a cone off an arc.
Solid.extrude_tapered(Profile.slot((0, 0), 40, 10), Frame.xy(), 25, math.radians(10))`,
    ],
},
{
    id: "shells",
    title: "Shells, sheets and thickening",
    blurb: "a hollow box, a sheet punched and thickened, open walls given thickness",
    cells: [
`from cadaclysm_blacksmith import Axis, Frame, Profile, Selector, Solid

# A block shelled into an open box: walls 2 thick, its top face taken off so the hollow shows.
block = Solid.cuboid(40, 40, 30)
block.shell(2, open=[block.select_face(Selector.max(Axis.Z))])`,
`# A flat sheet -- one face, the outline's exact curves on its edges -- a hole punched
# through it by a cylinder, and the punched sheet thickened into a plate 3 thick.
sheet = Solid.face(Profile.rect(80, 50), Frame.xy())
punched = sheet.trim(Solid.cylinder(10, 20).translate(15, 0, -10), keep="outside")
show(sheet, punched.translate(0, 70, 0), punched.thicken(3).translate(0, 140, 0))`,
`# Open walls -- a rectangle extruded without caps -- thickened outward and inward, the
# corners on their mitres; and a tube from a circle's wall.
walls = Solid.extrude_open(Profile.rect(40, 24), Frame.xy(), 16)
show(walls, walls.thicken(2).translate(60, 0, 0), walls.thicken(-2).translate(120, 0, 0),
     Solid.extrude_open(Profile.circle(12), Frame.xy(), 30).thicken(1.5).translate(190, 0, 0))`,
    ],
},
{
    id: "booleans",
    title: "Booleans, splits and symmetry",
    blurb: "what two solids share, a part split into bodies, mirrored and turned",
    cells: [
`import math
from cadaclysm_blacksmith import Frame, Profile, Solid

# A rod and a thinner one crossing it at right angles: what the two share, the two as one,
# and the rod with the thinner one cut through it.
rod = Solid.cylinder(20, 80).translate(0, 0, -40)
cross = Solid.cylinder(14, 80).translate(0, 0, -40).rotate(((0, 0, 0), (1, 0, 0)), math.pi / 2)
show(rod.common(cross), rod.join(cross).translate(100, 0, 0), rod.cut(cross).translate(200, 0, 0))`,
`# A part split by a plane into bodies -- a flat sheet splits by the whole plane it lies
# on -- each body a solid of its own, shown moved apart.
knob = Solid.sphere(25).join(Solid.cylinder(8, 50).translate(0, 0, 20))
halves = knob.split(Solid.face(Profile.rect(200, 200), Frame.xy((0, 0, 10))))
show(*[h.translate(0, 70 * i, 0) for i, h in enumerate(halves)])`,
`# A lug drawn on one side of the XZ plane and mirrored in it, the two joined into one
# symmetric part; then the part turned 30 degrees about Z, raised beside it.
lug = (Solid.extrude(Profile.rect(60, 30), Frame.xy(), 12).translate(0, 10, 0)
       .join(Solid.cylinder(8, 12).translate(30, 18, 0)))
whole = lug.join(lug.mirror(Frame.xz()))
show(whole, whole.rotate(((0, 0, 0), (0, 0, 1)), math.radians(30)).translate(0, 0, 30))`,
    ],
},
{
    id: "frames",
    title: "Frames and faces",
    blurb: "a sketch on any plane or face, a face as a sheet",
    cells: [
`import math
from cadaclysm_blacksmith import Axis, Frame, Profile, Selector, Solid, Workplane

# A frame is where a sketch lives: Frame.at is the plane through a point square to a
# normal, and a solid's face has a frame of its own. A peg grows out of the block's front
# face along that face's normal; a plate sits on a frame leaning 20 degrees off the top.
block = Workplane.xy().extrude(Profile.rect(60, 40), 30).solid()
front = block.select_face(Selector.min(Axis.Y))
peg = Solid.extrude(Profile.circle(6), block.face_frame(front), 15)
lean = Frame.at((0, 0, 30), (math.sin(math.radians(20)), 0, math.cos(math.radians(20))))
show(block.join(peg), Solid.extrude(Profile.rect(24, 24), lean, 6).translate(100, 0, 0))`,
`# A face on its own: the block's top as a sheet -- its surface, its edges' exact curves
# -- and the prism over it, the sheet raised 10 along its normal.
top = block.select_face(Selector.max(Axis.Z))
cap = block.face_sheet(top)
show(block, cap.translate(80, 0, 0), cap.extrude_faces(10).translate(160, 0, 0))`,
    ],
},
{
    id: "subd",
    title: "SubD: a cage fired into a solid",
    blurb: "a control cage pushed, pulled, creased and mirrored, then converted to exact NURBS",
    cells: [
`from cadaclysm_blacksmith import Solid, Subd

# A SubD cage: a box of 3 x 2 x 1 quads, whose smooth Catmull-Clark surface to_solid
# turns into an exact solid -- one NURBS face per patch, measured against the limit
# surface it stands for.
cage = Subd.cuboid((40, 30, 16), (3, 2, 1))
pebble, report = cage.to_solid()
print("cage faces:", len(cage.faces), "solid faces:", pebble.faces)
print(f"patches: {report.regular} exact, {report.refined} refined, deviation {report.deviation:.1e} of the diagonal")
pebble`,
`# A little fighter, built on its right half: mirror_on keeps the cage symmetric in X,
# every later edit landing on both sides. Faces are picked by where their centres sit.
def where(cage, test):
    p = cage.positions
    return [i for i, f in enumerate(cage.faces) if test(*p[f].mean(axis=0))]

def scale(sx, sy, sz, dx=0, dy=0, dz=0):
    return [[sx, 0, 0, dx], [0, sy, 0, dy], [0, 0, sz, dz], [0, 0, 0, 1]]

def moved(cage, m):
    return cage.transform(cage.selection, m)

def rim(cage, faces):
    loops = cage.faces
    return [(loops[i][k], loops[i][(k + 1) % len(loops[i])]) for i in faces for k in range(len(loops[i]))]

# The hull: a box cage subdivided once -- four quads for each, the smooth surface unchanged.
ship = Subd.cuboid((16, 48, 10), (2, 2, 1)).mirror_on("x").subdivide()
# The nose: the front faces drawn out and pinched.
ship = ship.transform(("faces", where(ship, lambda x, y, z: y < -18)), scale(0.45, 1, 0.55, 0, -12, -0.5))
# The wings: the lower side faces behind the middle pulled out 24, the tips thinned and
# swept back; each tip inset, and the inner face pushed out 2 into a wingtip pod.
ship = moved(ship.extrude(where(ship, lambda x, y, z: x > 6.5 and y > 0 and z < 0), 24), scale(1, 0.6, 0.45, 0, 10, -1))
ship = moved(ship.inset(ship.selection[1], 0.3), scale(1, 1, 1, 2, 0, 0))
# Twin fins: the outer deck faces at the tail pulled up 8 and raked back, the tips'
# outline creased to a sharp edge.
ship = moved(ship.extrude(where(ship, lambda x, y, z: x > 4.5 and y > 12 and z > 3), 8), scale(0.75, 0.8, 1, 1.5, 6, 0))
ship = ship.crease(rim(ship, ship.selection[1]))
# The canopy: the deck ahead of the wings raised 2.5, a smooth bubble.
ship = ship.transform(("faces", where(ship, lambda x, y, z: x < 3 and -12 < y < 0 and z > 3)), scale(1, 1, 1, 0, 0, 2.5))
fighter, fired = ship.to_solid()
print("half cage faces:", len(ship.faces), "solid faces:", fighter.faces, "refined patches:", fired.refined)
fighter`,
`# The converted fighter is an ordinary solid: a vent cut through each wing, the walls
# taking the tools' orange -- one cut, the two tools joined first.
vents = (Solid.cylinder(2.5, 20).translate(-19, 13, -10)
         .join(Solid.cylinder(2.5, 20).translate(19, 13, -10)).coloured("#ff7a2e"))
show(fighter.cut(vents), fighter.translate(80, 0, 0))`,
    ],
},
{
    id: "motor",
    title: "A drone motor",
    blurb: "a base, a bell with windows, a shaft and a nut; then the parts as an assembly with a joint",
    cells: [
`import math
from cadaclysm_blacksmith import Frame, Profile, Solid

# A drone motor: an orange base, a blue anodised bell with six windows, a shaft and a nut.
base = Solid.cylinder(15, 3).coloured("#ff6b0d")
bell = Solid.cylinder(15, 12).translate(0, 0, 3)
for k in range(6):
    a = k * math.pi / 3
    bell = bell.cut(Solid.cylinder(4, 10).translate(8.5 * math.cos(a), 8.5 * math.sin(a), 7))
bell = bell.coloured("#2f6fd6")
shaft = Solid.cylinder(2.5, 24).coloured("#9ea3ad")
nut = Solid.extrude(Profile.regular_polygon((0, 0), 4.6, 6), Frame.xy((0, 0, 15)), 4).coloured("#d6d8dc")

show(base, bell, shaft, nut)`,
`from cadaclysm_blacksmith import Assembly

# The same parts as an assembly: the bell turns on the base, a joint about Z.
motor = Assembly("motor")
motor.link("base", [motor.place(base, Frame.xy())])
motor.link("bell", [motor.place(p, Frame.xy()) for p in (bell, shaft, nut)])
motor.joint("bearing", "base", "bell")
motor.pair("bearing", "revolute", Frame.xy())
print(motor.step_text().count("REVOLUTE_PAIR"), "revolute pair")`,
`# A joint's value turns the mechanism: posed() returns a NEW assembly with the bell turned.
# (A joint inside a sub-assembly is named by its path.)
show(motor.posed({"bearing": 0.5}))`,
    ],
},
{
    id: "sparky",
    title: "SPARKY-01, a combat robot",
    blurb: "a wedge hull, saw damage as cuts, a hollow shell and its mass; wheels, a spinner on a joint",
    cells: [
`import math
from cadaclysm_blacksmith import Frame, Mass, Profile, Solid

# SPARKY-01, in millimetres. The hull: a wedge side profile, extruded across the width.
W = 260.0
side = Profile.polygon([(-190, 18), (238, 18), (238, 34), (110, 112), (-190, 112)])
hull = Solid.extrude(side, Frame.at((0, W / 2, 0), (0, -1, 0), (1, 0, 0)), W)

# The top rear edge rounded, a slot through the nose for the weapon, four wheel wells.
rear = [e for e in hull.edges
        if e.is_line and abs(e.direction[1]) > 0.99 and e.segments[0][0][0] < -189
        and e.segments[0][0][2] > 100]
hull = hull.fillet(rear, 14.0)
hull = hull.cut(Solid.cuboid(190, 44, 260).translate(160, 0, 100))
# Every strip the wells leave -- behind the rear pair, above all four -- stays thicker
# than the two 6 mm walls the shell below gives it, or the hollow hull would cross itself.
for x in (-105, 105):
    for side_y in (-1, 1):
        hull = hull.cut(Solid.cuboid(132, 50, 100).translate(x, side_y * (W / 2 - 18), 40))
hull = hull.coloured("#ff7a2e")
hull`,
`# Battle damage: a horizontal spinner bit the flank twice. Each bite is a plain cut,
# a thin tilted disc overlapping the side -- the hole is real geometry. Both land on the
# full-height flank between the wheel wells, clear of them, the floor and the deck.
hurt = hull
for z, tilt in ((45, 0.12), (82, -0.10)):
    blade = Solid.cylinder(26, 10).rotate(((0, 0, 0), (1, 0, 0)), tilt)
    hurt = hurt.cut(blade.translate(0, W / 2 + 26 - 16, z - 5))

# Hollowed to 6 mm walls; the mass comes from the geometry (aluminium, kg per mm^3),
# measured to 0.1 % -- plenty for kilograms, and far quicker than the default.
ALU, STEEL, RUBBER = 2.7e-6, 7.85e-6, 1.2e-6
def kg(solid, density):
    return Mass.of(solid, 1e-3).mass(density)

shell = hurt.shell(6.0)
print(f"hull: solid {kg(hurt, ALU):.2f} kg, hollow {kg(shell, ALU):.2f} kg")
shell`,
`# Many holes at once: join the tools, then cut once -- one boolean instead of one per hole.
def cut_all(solid, tools):
    tools = list(tools)
    for t in tools[1:]:
        tools[0] = tools[0].join(t)
    return solid.cut(tools[0])

def around(n, r, z, tool, turn=0.0):
    """n copies of tool, on a circle of radius r at height z, each turned to face out."""
    for k in range(n):
        a = 2 * math.pi * k / n + turn
        yield tool.rotate(((0, 0, 0), (0, 0, 1)), a).translate(r * math.cos(a), r * math.sin(a), z)

# The running gear: one wheel -- a tyre with tread grooves, a recessed hub -- placed four times.
tyre = cut_all(Solid.cylinder(52, 36), [*around(14, 52, 18, Solid.cuboid(10, 6, 60)),
                                        Solid.cylinder(30, 10).translate(0, 0, 30)])
tyre = tyre.coloured("#1c1c1e")
hub = cut_all(Solid.cylinder(30, 6).translate(0, 0, 30),
              [Solid.cylinder(9, 20).translate(0, 0, 25), *around(5, 19, 25, Solid.cylinder(5, 20))])
hub = hub.coloured("#9aa0a6")
wheels = []                             # tyre, hub, tyre, hub, ...
for x in (-105, 105):
    for side_y in (-1, 1):
        out = ((0, 0, 0), (1, 0, 0)), -side_y * math.pi / 2    # the wheel's +Z turned to face out
        wheels += [p.rotate(*out).translate(x, side_y * W / 2, 52) for p in (tyre, hub)]

# The weapon: a three-tooth disc with lightening holes, on its axle in the nose slot.
disc = Solid.extrude(Profile.star((0, 0), 86, 58, 3).round(6.0), Frame.xy((0, 0, -11)), 22)
disc = cut_all(disc, [Solid.cylinder(12, 40).translate(0, 0, -20),
                      *around(3, 40, -20, Solid.cylinder(13, 40), turn=0.5)])
upright = ((0, 0, 0), (1, 0, 0)), -math.pi / 2                  # Z onto Y
disc = disc.rotate(*upright).translate(165, 0, 84).coloured("#cfd4da")
axle = Solid.cylinder(11, 120).rotate(*upright).translate(165, -60, 84).coloured("#6b7178")

# A bolted top plate, and the brain's sensor bar: two lenses and an antenna.
spots = [(px, py) for px in (-170, -60, 50) for py in (-100, 100)]
plate = cut_all(Solid.cuboid(250, 236, 6).translate(-60, 0, 116),
                [Solid.cylinder(6, 20).translate(px, py, 105) for px, py in spots])
plate = plate.coloured("#3e444c")
bolts = [Solid.cylinder(4.5, 9).translate(px, py, 113).coloured("#b8bec6") for px, py in spots]
head = Solid.cuboid(40, 110, 34).translate(-150, 0, 136)
forward = ((0, 0, 0), (0, 1, 0)), math.pi / 2                  # Z onto X
lenses = []
for py in (-28, 28):
    head = head.cut(Solid.cylinder(13, 10).rotate(*forward).translate(-133, py, 138))
    lenses.append(Solid.cylinder(11, 10).rotate(*forward).translate(-132, py, 138).coloured("#38d9ea"))
head = head.coloured("#2b3036")
antenna = Solid.cylinder(2.5, 90).translate(-160, 40, 153).join(Solid.sphere(6).translate(-160, 40, 245))
antenna = antenna.coloured("#ff3b30")

body = [shell, plate, head, antenna, *bolts, *lenses]
show(*body, *wheels, disc, axle)`,
`from cadaclysm_blacksmith import Assembly

# The robot as an assembly: the body, four wheels and the weapon, each a link; the
# spinner on a revolute joint about its axle (the pair frame's z, along Y).
robot = Assembly("sparky-01")
robot.link("body", [robot.place(p, Frame.xy()) for p in body])
robot.link("weapon", [robot.place(p, Frame.xy()) for p in (disc, axle)])
robot.joint("spinner", "body", "weapon")
robot.pair("spinner", "revolute", Frame.at((165, 0, 84), (0, 1, 0)))
for i in range(4):
    robot.link(f"wheel {i + 1}", [robot.place(p, Frame.xy()) for p in wheels[2 * i:2 * i + 2]])

# Its mass, material by material, straight from the geometry.
total = (sum(kg(p, ALU) for p in [shell, head, antenna, *lenses, *wheels[1::2]])
         + sum(kg(p, STEEL) for p in [plate, disc, axle, *bolts])
         + sum(kg(p, RUBBER) for p in wheels[0::2]))
print(f"SPARKY-01: {total:.2f} kg")

# A joint's value turns the weapon: posed() returns a new assembly, the disc spun 50 degrees.
show(robot.posed({"spinner": math.radians(50)}))`,
    ],
},
{
    id: "machining",
    title: "Machining a plate",
    blurb: "a part, a job that works out its own toolpaths, and the stock cut on the timeline",
    cells: [
`from cadaclysm_blacksmith import Frame, Job, Profile, Solid, Stock, Tool

# An 80 x 50 x 12 plate: rounded corners, a pocket round a boss, four through holes.
part = Solid.extrude(Profile.rect(80, 50).round(6), Frame.xy(), 12)
pocket = Profile.rect(40, 24).round(4).with_hole(Profile.circle(5))
part = part.cut(Solid.extrude(pocket, Frame.xy((0, 0, 7)), 5))
for x in (-32, 32):
    for y in (-17, 17):
        part = part.cut(Solid.cylinder(3, 12).translate(x, y, 0))
part`,
`# A job on a block 3 mm bigger all round: machine() works out the facing, the pockets
# and the drilling, and reports anything it could not cut.
end_mill = Tool.flat(1, 6, 20, 800, 200, 12000)
drill = Tool.drill(2, 6, 30, 150, 3000)
job = Job(Stock.around(part, 3), safe_z=25, name="plate")
print(job.machine(part, end_mill, drills=[drill]))
print([p.name for p in job.gcode()])`,
`# Play it under the view; Deviation in the colour menu shows how close each cell is to the part.
show(job, part=part)`,
    ],
},
];

// What the page opens with.
export const STARTER = EXAMPLES[0].cells;

// Cells joined by `# %%` separators, the import line first when no cell has one, and a
// `show()` stub when a cell calls it -- `show()` is the notebook's own, a script has no
// view -- so the text runs unchanged next to the library. Empty cells are skipped; the
// script ends in a newline.
export function scriptOf(sources) {
    const body = sources.map((s) => s.trimEnd()).filter(Boolean).join("\n\n# %%\n") + "\n";
    const head = /^\s*(from|import)\s+cadaclysm_blacksmith\b/m.test(body) ? "" : "from cadaclysm_blacksmith import *\n\n";
    const stub = (/\bshow\s*\(/.test(body) ? "def show(*solids, part=None):\n    pass   # the notebook draws these; a script has no view\n\n" : "")
        + (/\bshow_document\s*\(/.test(body) ? "def show_document(doc):\n    return {}   # the notebook draws its results; a script has no view\n\n" : "");
    return head + stub + body;
}
