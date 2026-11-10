"""What the notebook adds to a cell's namespace: `show()`, `show_document()`, and the
bookkeeping the kernel reads after each cell. Imported into `__main__` by the kernel; a
user never imports it, but for `notebook_support.document()`."""
import functools
import json
import os
import sys
import tempfile
import time

import cadaclysm_blacksmith as _bs

_shown = []
_names = {}       # id(item) -> the name `show(..., part="name")` gave it, this cell
_jobs = []        # at most one (job, part): the job this cell plays, and the part it is cut to
_timings = []
_LONG = ("join", "cut", "common", "fillet", "chamfer", "shell", "push_pull")
_DRAWN = (_bs.Solid, _bs.Profile, _bs.Assembly)
# What every cell showed, for `document()`: cell -> [(name, item)], the last run of each
# cell (a cell that raised keeps nothing, as its view draws nothing); `_order` is the
# page's cell order, which the page sends with every run, and `_cell` the cell running.
_kept = {}
_order = []
_cell = None


def show(*items, part=None):
    """Draw these solids, profiles and assemblies under the cell, in one view --
    a profile as its outline, on the XY plane its own x and y are: its segments
    as drawn, an open chain open; an assembly as everything placed in it, each
    part at its placement and in its own colours. A `Job` plays there: its
    stock, cut by its programs on the view's timeline, with the controls under
    the view; `part`, a `Solid`, colours the stock by how far it is from the
    part. A cell plays one job.

    Without a job, `part` is a name: what `document()` and the toolbar's "Save
    document" call these items (several are "name", "name 2", "name 3", ...).
    Unnamed, an item is called by the variable holding it, else by its kind and
    number."""
    if isinstance(part, str):
        if not part:
            raise ValueError("show(): part= names the items; give a name, not an empty string")
        if any(isinstance(s, _bs.Job) for s in items):
            raise TypeError("show(): part= is a Solid when a job is shown, not a name")
        named = [s for s in items if isinstance(s, _DRAWN)]
        for k, s in enumerate(named):
            _names[id(s)] = part if k == 0 else f"{part} {k + 1}"
        part = None
    for s in items:
        if not isinstance(s, _DRAWN + (_bs.Job,)):
            raise TypeError(f"show() draws solids, profiles, assemblies and jobs, not {type(s).__name__}")
    jobs = [s for s in items if isinstance(s, _bs.Job)]
    if part is not None:
        if not jobs:
            raise TypeError("show(): part= is the part a job cuts; show a Job with it")
        if not isinstance(part, _bs.Solid):
            raise TypeError(f"show(): part must be a Solid, not {type(part).__name__}")
    if len(jobs) > 1 or (jobs and _jobs and _jobs[0][0] is not jobs[0]):
        raise ValueError("show(): a cell plays one job")
    if jobs and not jobs[0].operations():
        raise ValueError("show(): the job has no operations to play")
    for s in items:
        if not isinstance(s, _bs.Job) and s not in _shown:
            _shown.append(s)
    if jobs:
        kept = _jobs[0][1] if _jobs else None
        _jobs[:] = [(jobs[0], part if part is not None else kept)]


def _timed(name):
    original = getattr(_bs.Solid, name)

    def wrapper(self, *args, **kwargs):
        started = time.perf_counter()
        try:
            return original(self, *args, **kwargs)
        finally:
            _timings.append((name, round((time.perf_counter() - started) * 1000)))

    functools.update_wrapper(wrapper, original)   # the name, the doc, and __wrapped__ for the signature
    setattr(_bs.Solid, name, wrapper)


for _name in _LONG:
    _timed(_name)


def _begin(cell=None, order=None):
    """A cell starts: `cell` the page's id for it (None: nothing of it is kept for the
    document), `order` the page's cells in order (None: as last sent). The cell's earlier
    run is dropped, and so is every cell no longer on the page."""
    global _cell
    _shown.clear()
    _names.clear()
    _jobs.clear()
    _timings.clear()
    if order is not None:
        _order[:] = list(order)
        for gone in [c for c in _kept if c not in _order]:
            del _kept[gone]
    _cell = cell
    _kept.pop(cell, None)


def _finish(ok):
    """The run is over (the kernel calls this whatever happened): a cell that raised, or
    whose drawing failed, keeps nothing, and no cell is running."""
    global _cell
    if not ok:
        _kept.pop(_cell, None)
    _cell = None


def _forget(cell):
    """The page deleted `cell`: nothing of it goes in the document."""
    _kept.pop(cell, None)
    if cell in _order:
        _order.remove(cell)


def _named(items):
    """`(name, item)` for what this cell showed: `show(..., part=)`'s name, else the
    variable in `__main__` holding it, else None (`document` numbers it)."""
    held = {}
    for k, v in vars(sys.modules["__main__"]).items():
        if not k.startswith("_") and isinstance(v, _DRAWN):
            held.setdefault(id(v), k)
    return [(_names.get(id(s)) or held.get(id(s)), s) for s in items]


def _cells_in_order():
    """Each kept cell's `(name, item)` list in the page's order, then any it never
    ordered; called from a cell, that cell's items so far are its run."""
    kept = dict(_kept)
    if _cell is not None:
        kept[_cell] = _named(s for s in _shown if isinstance(s, _DRAWN))
    order = [c for c in _order if c in kept] + [c for c in kept if c not in _order]
    return [kept[c] for c in order]


def _hex(rgb):
    return "#" + "".join(f"{round(max(0.0, min(1.0, v)) * 255):02x}" for v in rgb)


def _parts(assembly):
    """An assembly's parts as bodies placed where it draws them, read back off its STEP:
    one per placement, as `Solid.open_all` reads them."""
    fd, path = tempfile.mkstemp(suffix=".step")
    os.close(fd)
    try:
        assembly.step(path)
        return _bs.Solid.open_all(path)
    finally:
        os.remove(path)


def document():
    """A `Document` of every solid, sheet and profile the views show: the last run of each
    cell, in cell order. A solid is a `solid.body`, an open one a `sheet.body`, a profile a
    `profile.path`, each holding the geometry exactly; an assembly is one body per part
    ("rig 1", "rig 2", ...). A node is named as `show(..., part=)` names it, else by the
    variable holding it, else "solid 1", "profile 1", ...; its colour is in its `meta`:
    `colour` "#rrggbb", and `faces`, {face: colour}, for the faces drawn otherwise. The
    document the toolbar's "Save document" saves."""
    doc = _bs.Document()
    taken, counts = set(), {}

    def name_of(wanted, kind):
        if wanted and wanted not in taken:
            taken.add(wanted)
            return wanted
        base = wanted or kind
        while True:
            counts[base] = counts.get(base, 1 if wanted else 0) + 1
            name = f"{base} {counts[base]}"
            if name not in taken:
                taken.add(name)
                return name

    def add_solid(s, wanted):
        sheet = not s.manifold.is_closed
        meta = {}
        colour = s.colour
        if colour is not None:
            meta["colour"] = _hex(colour)
        faces = {str(f): _hex(c) for f in range(s.faces) if (c := s.face_colour(f)) is not None and c != colour}
        if faces:
            meta["faces"] = faces
        fields = {"name": name_of(wanted, "sheet" if sheet else "solid")}
        if meta:
            fields["meta"] = meta
        doc.add_solid(s, sheet=sheet, **fields)

    try:
        with doc.batch("the notebook's views"):
            for items in _cells_in_order():
                for wanted, s in items:
                    if isinstance(s, _bs.Profile):
                        fields = {"name": name_of(wanted, "profile")}
                        if s.colour is not None:
                            fields["meta"] = {"colour": _hex(s.colour)}
                        doc.add_profile(s, **fields)
                    elif isinstance(s, _bs.Assembly):
                        group = name_of(wanted, "assembly")
                        parts = _parts(s)
                        try:
                            for k, p in enumerate(parts):
                                add_solid(p, f"{group} {k + 1}")
                        finally:
                            for p in parts:
                                p.close()
                    else:
                        add_solid(s, wanted)
    except BaseException:
        doc.close()
        raise
    return doc


def _document_text():
    """`document()` saved: what the toolbar's "Save document" downloads."""
    doc = document()
    try:
        return doc.save()
    finally:
        doc.close()


def _reads(node, ids):
    """The ids of `ids` a saved node's fields name."""
    found = set()

    def walk(v):
        if isinstance(v, str):
            if v in ids:
                found.add(v)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    for k, v in node.items():
        if k not in ("id", "kind", "name", "hidden", "meta"):
            walk(v)
    return found


def show_document(doc):
    """Draw a document's results under the cell, each under its node's name: every node
    no other node reads that makes a solid, a sheet or a profile, in the document's order,
    coloured as its `meta` says (as `document()` writes it). Returns them, {name: item}."""
    nodes = [n for n in json.loads(doc.save()).get("nodes", []) if not n.get("hidden")]
    ids = {n["id"] for n in nodes}
    read = set()
    for n in nodes:
        read |= _reads(n, ids)
    shown = {}
    for n in nodes:
        if n["id"] in read:
            continue
        item = doc.result(n["id"])
        if not isinstance(item, (_bs.Solid, _bs.Profile)):
            continue
        meta = n.get("meta") or {}
        if isinstance(meta.get("colour"), str):
            item = item.coloured(meta["colour"])
        if isinstance(item, _bs.Solid):
            for f, c in (meta.get("faces") or {}).items():
                item = item.coloured(c, face=int(f))
        name = n.get("name") or n["id"]
        show(item, part=name)
        shown[name] = item
    return shown


def _machining():
    """The job `show` recorded, as the worker's `showMachining` takes it: the stock
    box, each program's tool description and G-code in run order, and the part's
    handle (None without a part). None when the cell plays no job."""
    if not _jobs:
        return None
    job, part = _jobs[0]
    lo, hi = job.stock
    tools = job.tools
    programs = []
    for p in job.gcode():
        t = tools.get(p.tool)   # every operation records its tool, and programs come from them
        if t is None:
            raise ValueError(f"show(): program {p.name} uses T{p.tool}, which is not among the job's tools")
        tool = {"number": t.number, "shape": t.shape, "diameter": t.diameter, "flute_length": t.flute_length}
        if t.angle is not None:
            tool["angle"] = t.angle
        if t.corner_radius is not None:
            tool["corner_radius"] = t.corner_radius
        programs.append({"tool": tool, "gcode": p.text})
    return {"stock": {"min": list(lo), "max": list(hi)}, "programs": programs,
            "part": part._h() if part is not None else None}


def _end(result):
    """The handles to mesh, the timings, and the job this cell plays, as `_machining`
    records it: called with the cell's last value.
    A solid, a profile or an assembly is drawn, and so is a list or tuple of
    nothing but those, as `show(*result)` would; a generator is never consumed,
    which would be a side effect, and a list of anything else, or an empty one,
    draws nothing. Each handle goes with its kind: "solid", "profile" or
    "assembly"."""
    if isinstance(result, _DRAWN):
        show(result)
    elif isinstance(result, (list, tuple)) and result and all(isinstance(s, _DRAWN) for s in result):
        show(*result)
    elif isinstance(result, _bs.Job):
        # The last value plays as show(result) would -- unless it has nothing to play,
        # or the cell already shows another job: then it draws nothing, as a list of
        # anything else does.
        if result.operations() and not (_jobs and _jobs[0][0] is not result):
            show(result)
    if _cell is not None:
        _kept[_cell] = _named(s for s in _shown if isinstance(s, _DRAWN))
    drawn = []
    for s in _shown:
        if isinstance(s, _bs.Profile):
            # Its outline, which the kernel reads off the profile's own handle
            # (`profile_outline`): each loop's segments as drawn. `_shown` keeps the
            # profile alive until then.
            drawn.append((s._handle, 0, 0, None, [], "profile"))
            continue
        if isinstance(s, _bs.Assembly):
            # Everything placed in it, which the page reads off the handle as the
            # kernel writes it out (`assembly_step`); `_shown` keeps it alive until then.
            drawn.append((s._h(), 0, 0, None, [], "assembly"))
            continue
        # The solid's colour (None: the view's palette), and each face drawn otherwise.
        colour = s.colour
        faces = [(f, c) for f in range(s.faces) if (c := s.face_colour(f)) != colour]
        drawn.append((s._h(), s.faces, len(s.edges), colour, faces, "solid"))
    return drawn, list(_timings), _machining()
