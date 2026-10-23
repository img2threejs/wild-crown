"""Blender-authored Koro and Vara companion skill clips (sampled onto the original glTF joint basis).

Run: Blender -b --python scripts/assets/blender_companion_creatures.py [-- koro|vara|all]
Outputs asset-source/animation/companions-blender/{koro,vara}.{json,blend}. Source GLBs are never written.
Clip lengths follow the existing creature clip set; skill fractions follow the timing contract.
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy  # noqa: E402
from blender_companion_common import C, CI, FPS, Rig, curve  # noqa: E402
from mathutils import Quaternion, Vector  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'asset-source/animation/companions-blender'
KORO_SRC = ROOT / 'asset-source/generated/actor-koro-runtime-01/actor-koro-combat.glb'
VARA_SRC = ROOT / 'asset-source/generated/actor-vara-harpy-runtime-01/actor-vara-harpy-animated.glb'
TAU = math.tau
V = lambda *a: Vector(a)


def sn(x):
    return math.sin(TAU * x)


def cs(x):
    return math.cos(TAU * x)


def mirror(v):
    """Mirror a (forward, up, left) offset to the opposite arm."""
    return Vector((v[0], v[1], -v[2]))


# ---------------------------------------------------------------------------------------------
# Metrics: every baked clip records world displacement of chosen joints (read-only measurement)
# ---------------------------------------------------------------------------------------------
REPORT = {}


def bake_measured(rig, name, seconds, pose, markers, watch, extra=None):
    frames = round(seconds * FPS)
    rec = {w: [] for w in watch}
    extras = []

    def wrapped(t, r):
        pose(t, r)
        for w in watch:
            rec[w].append(r.point(w).copy())
        if extra:
            extras.append(extra(r))

    rig.bake(name, seconds, wrapped, markers)
    stats = {}
    for w, pts in rec.items():
        rest = rig.rest_points[w]
        disp = [(p - rest).length for p in pts]
        path = sum((b - a).length for a, b in zip(pts, pts[1:]))
        speed = max((b - a).length for a, b in zip(pts, pts[1:])) * FPS
        stats[w] = {'maxDisplacementFromRest': round(max(disp), 4), 'pathLength': round(path, 4), 'peakSpeed': round(speed, 3),
                    'range': [[round(min(p[k] for p in pts), 3), round(max(p[k] for p in pts), 3)] for k in range(3)]}
    REPORT[name] = {'frames': frames + 1, 'seconds': seconds, 'markers': markers, 'joints': stats}
    if extra:
        REPORT[name]['extra'] = extra_summary(extras)
    return rec


def extra_summary(extras):
    keys = extras[0].keys()
    return {k: [round(min(e[k] for e in extras), 4), round(max(e[k] for e in extras), 4)] for k in keys}


def finish(rig, path):
    rig.save(path)
    (Path('/tmp') / f'{path.stem}-companion-metrics.json').write_text(json.dumps(REPORT, indent=1))


# ---------------------------------------------------------------------------------------------
# KORO (biped, faces +X, left = -Z)
# ---------------------------------------------------------------------------------------------
TORSO_W = (('Waist', .25), ('Spine01', .35), ('Spine02', .4))
NECK_W = (('NeckTwist01', .3), ('NeckTwist02', .3), ('Head', .4))


def koro_legs(r, off=None):
    off = off or {}
    for s in 'LR':
        foot, toe = f'{s}_Foot', f'{s}_ToeBase'
        o = off.get(s, V(0, 0, 0))
        target = r.rest_points[foot] + o
        r.ik([f'{s}_Thigh', f'{s}_Calf', foot], target, V(.14, .08, 0))
        cur = r.point(toe) - r.point(foot)
        rest = r.rest_points[toe] - r.rest_points[foot]
        r.rotate_world(foot, cur.rotation_difference(rest))


def koro_arm(r, side, offset, pole, world=None):
    u, f, h = f'{side}_Upperarm', f'{side}_Forearm', f'{side}_Hand'
    target = Vector(world) if world is not None else r.point(u) + r.offset(*offset)
    r.ik([u, f, h], target, r.offset(*pole))


def koro_hand_vertices(r, name='R_Hand'):
    """The skinned vertices a hand joint carries, as (object, vertex index) pairs.

    Cached on the rig, because the pairs reference the rig's imported scene.
    """
    cached = getattr(r, '_koro_hand_vertices', None)
    if cached is None:
        cached = r._koro_hand_vertices = {}
    if name in cached:
        return cached[name]
    pairs = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' for mod in obj.modifiers):
            continue
        index = next((i for i, group in enumerate(obj.vertex_groups) if group.name == name), None)
        if index is None:
            continue
        pairs.append((obj, [i for i, vertex in enumerate(obj.data.vertices)
                            if any(g.group == index and g.weight > 0 for g in vertex.groups)]))
    if not pairs:
        raise ValueError(f'Koro: no skinned geometry carries the {name} joint')
    cached[name] = pairs
    return pairs


def koro_hand_lowest(r, name='R_Hand'):
    """The lowest world height the hand's own skinned geometry reaches (the fingertips).

    Measured on the evaluated skinned mesh: the rig's joint offsets are not the hand's shape, and the
    deformation makes the effective drop depend on the pose.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lowest = None
    for obj, indices in koro_hand_vertices(r, name):
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            for i in indices:
                world = CI @ (evaluated.matrix_world @ mesh.vertices[i].co)
                if lowest is None or world.y < lowest:
                    lowest = world.y
        finally:
            evaluated.to_mesh_clear()
    return lowest


def koro_hand_drop(r, name='R_Hand'):
    """How far the hand's own skinned geometry hangs below its joint (the fingers below the wrist).

    A property of the rig, so it is measured once on the rest pose (the rig is at rest when it is
    created) and reused for every frame of the clip.
    """
    cached = getattr(r, '_koro_hand_drops', None)
    if cached is None:
        cached = r._koro_hand_drops = {}
    if name not in cached:
        drop = r.point(name).y - koro_hand_lowest(r, name)
        if drop <= 0:
            raise ValueError(f'Koro: the {name} geometry does not hang below its joint (drop {drop:.4f})')
        cached[name] = drop
    return cached[name]


def koro_pose(r, hipdrop=0, hipfwd=0, hip=(0, 0, 0), torso=(0, 0, 0), head=(0, 0, 0), feet=None, arms=None):
    """arms = {'R': (offset, pole[, world]), 'L': ...}; offsets are (forward, up, left) from the shoulder."""
    if hipdrop or hipfwd:
        r.translate('Hip', (hipfwd, -hipdrop, 0))
    if any(hip):
        r.rotate('Hip', *hip)
    for name, w in TORSO_W:
        if any(torso):
            r.rotate(name, *[a * w for a in torso])
    for name, w in NECK_W:
        if any(head):
            r.rotate(name, *[a * w for a in head])
    koro_legs(r, feet)
    for side, spec in (arms or {}).items():
        koro_arm(r, side, spec[0], spec[1], spec[2] if len(spec) > 2 else None)


REST_R = V(-.02, -.29, -.26)
REST_POLE_R = V(0, -.04, -.08)


def k(keys, t):
    return curve(keys, t)


def koro_throw(t, r):
    yaw_t = k([(0, 0), (.30, 32), (.38, 32), (.44, -18), (.60, -34), (.82, -8), (1, 0)], t)
    yaw_h = k([(0, 0), (.30, 14), (.38, 14), (.46, -20), (.60, -26), (.82, -6), (1, 0)], t)
    pitch_t = k([(0, 0), (.30, -14), (.38, -14), (.50, 10), (.62, 32), (.82, 14), (1, 0)], t)
    roll_t = k([(0, 0), (.30, -8), (.44, 6), (.62, 10), (1, 0)], t)
    hipdrop = k([(0, 0), (.30, .06), (.44, .025), (.68, .07), (1, 0)], t)
    hipfwd = k([(0, 0), (.30, -.025), (.46, .035), (.68, .06), (1, 0)], t)
    head = (k([(0, 0), (.30, -6), (.62, 14), (1, 0)], t), -.7 * (yaw_t + yaw_h), 0)
    rh = k([(0, REST_R), (.14, V(-.08, -.02, -.20)), (.30, V(-.14, .22, -.07)), (.36, V(-.14, .21, -.06)), (.44, V(.30, .16, -.04), 'linear'),
            (.56, V(.27, -.08, -.05)), (.68, V(.17, -.27, .05)), (.82, V(0, -.29, -.14)), (1, REST_R)], t)
    rp = k([(0, REST_POLE_R), (.30, V(-.02, .10, -.14)), (.40, V(.06, .12, -.08)), (.44, V(.10, .05, -.05)), (.68, V(0, -.08, -.10)), (1, REST_POLE_R)], t)
    lh = k([(0, mirror(REST_R)), (.30, V(.22, .06, .10)), (.44, V(.10, -.06, .14)), (.62, V(-.06, -.18, .22)), (1, mirror(REST_R))], t)
    koro_pose(r, hipdrop, hipfwd, (0, yaw_h, 0), (pitch_t, yaw_t, roll_t), head,
              arms={'R': (rh, rp), 'L': (lh, mirror(REST_POLE_R))})


def koro_push(t, r):
    b = k([(0, 0), (.12, .8), (.24, 1), (.70, 1), (.90, .2), (1, 0)], t)
    p = k([(0, 0), (.24, 0), (.42, 1), (.62, 1), (.78, .25), (1, 0)], t)
    lift = .03 * 4 * b * (1 - b)
    feet = {'L': V(-.08 * b, lift, 0), 'R': V(.06 * b, lift, 0)}
    rh = k([(0, REST_R), (.12, V(.10, .02, .10)), (.24, V(.32, -.04, .06)), (.42, V(.37, -.02, .06)), (.62, V(.37, -.02, .06)),
            (.78, V(.28, -.06, .02)), (1, REST_R)], t)
    rp = k([(0, REST_POLE_R), (.12, V(-.04, -.08, -.14)), (.42, V(0, -.04, -.10)), (.62, V(0, -.04, -.10)), (1, REST_POLE_R)], t)
    koro_pose(r, .06 * b + .01 * p, .05 * p, (4 * b, 0, 0), (18 * b + 16 * p, 0, 0), (-10 * b - 4 * p, 0, 0), feet,
              arms={'R': (rh, rp), 'L': (mirror(rh), mirror(rp))})


def koro_distract(t, r):
    env = k([(0, 0), (.2, 1), (.78, 1), (.95, 0), (1, 0)], t)
    hipdrop = env * (.03 + .025 * sn(3 * t))
    clap = V(.15, .22, .165)
    rh = k([(0, REST_R), (.14, V(.02, 0, -.22)), (.32, V(.06, .30, -.12)), (.41, clap, 'linear'), (.46, V(.08, .28, -.02)), (.50, clap, 'linear'),
            (.60, V(.06, .30, -.10)), (.70, clap, 'linear'), (.82, V(0, -.10, -.20)), (1, REST_R)], t)
    rp = k([(0, REST_POLE_R), (.32, V(0, .06, -.14)), (.41, V(0, .02, -.12)), (.70, V(0, .02, -.12)), (.82, V(0, -.06, -.10)), (1, REST_POLE_R)], t)
    koro_pose(r, hipdrop, 0, (0, 0, 0), (-8 * env + 5 * sn(3 * t) * env, 0, 0), (-8 * env, 12 * sn(2 * t) * env, 4 * sn(2 * t) * env),
              arms={'R': (rh, rp), 'L': (mirror(rh), mirror(rp))})


def koro_search(t, r):
    c = k([(0, 0), (.2, 1), (.8, 1), (.92, .05), (1, 0)], t)
    w = k([(0, 0), (.2, 1), (.8, 1), (.92, 0), (1, 0)], t)
    reveal = k([(0, 0), (.78, 0), (.9, 1), (1, 0)], t)
    s = sn((t - .2) / .65) if .2 <= t <= .85 else 0
    s *= c
    r.reset()
    koro_pose_search = dict(hipdrop=.12 * c, hipfwd=-.02 * c, hip=(8 * c, 0, 0), torso=(42 * c - 10 * reveal, 10 * s, 0),
                            head=(18 * c - 14 * reveal, 26 * s, 0))
    # Legs and torso first so the arm targets (ground and left knee) are measured on the crouched body.
    koro_pose(r, **koro_pose_search)
    foot = r.rest_points['R_Foot']
    # The search reads the ground with the fingertips. The IK chain is aimed at the R_Hand wrist, but the hand's own
    # geometry (the fingers) hangs below that joint and the effective drop changes with the pose, so the wrist aim
    # height is solved per frame until the measured fingertips meet the height the gesture intends.
    contact = V(foot.x + .30 + .04 * cs((t - .2) / .65), .035, foot.z + .02 + .16 * s)
    koro_reach_to_ground(r, 'R', contact, w, V(0, .05, -.10), lambda: koro_pose(r, **koro_pose_search))
    knee = r.point('L_Calf') + V(.015, .035, 0)
    koro_arm(r, 'L', None, V(0, 0, .10), world=r.rest_points['L_Hand'].lerp(knee, w))


def koro_reach_to_ground(r, side, contact, w, pole, body, height=.035, name=None):
    """Aim a hand so its FINGERTIPS reach a contact height, not so its wrist joint does.

    `contact` is the point the fingertips are meant to touch and `w` how far the reach has travelled
    (0 = the hand is still at rest, 1 = the fingertips are on the ground). The wrist aim height is
    solved by measuring the real, deformed fingertips and correcting the aim by the residual, because
    the distance from the wrist to the fingertips depends on the pose. `body` poses the rest of the
    character, because the reach is solved against the crouched body.
    """
    name = name or f'{side}_Hand'
    rest_fingers = r.rest_points[name].y - koro_hand_drop(r, name)
    want = rest_fingers + (height - rest_fingers) * w
    aim = height + (r.rest_points[name].y - height)
    base = r.rest_points[name]

    def aim_at(aim_y):
        r.reset()
        body()
        target = base.lerp(V(contact.x, aim_y, contact.z), w)
        koro_arm(r, side, None, pole, world=target)

    for _ in range(8):
        aim_at(aim)
        residual = koro_hand_lowest(r, name) - want
        aim -= residual
        if abs(residual) < .001:
            break
    aim_at(aim)


KORO_WATCH = ['R_Hand', 'R_Forearm', 'R_Upperarm', 'L_Hand', 'L_Forearm', 'Head', 'L_Foot', 'R_Foot']


def koro_extra(r):
    rest = r.rest_points
    return {'rightFootSlideXZ': math.hypot(*( (r.point('R_Foot') - rest['R_Foot'])[k] for k in (0, 2))),
            'leftFootSlideXZ': math.hypot(*((r.point('L_Foot') - rest['L_Foot'])[k] for k in (0, 2))),
            'rightToeHeight': r.point('R_ToeBase').y, 'leftToeHeight': r.point('L_ToeBase').y,
            'rightHandHeight': r.point('R_Hand').y, 'leftHandHeight': r.point('L_Hand').y,
            'rightElbowAngle': math.degrees((r.point('R_Upperarm') - r.point('R_Forearm')).angle(r.point('R_Hand') - r.point('R_Forearm'))),
            'leftElbowAngle': math.degrees((r.point('L_Upperarm') - r.point('L_Forearm')).angle(r.point('L_Hand') - r.point('L_Forearm')))}


def author_koro():
    r = Rig(str(KORO_SRC), 'Head', 'Hip')
    # Head-minus-hips is vertical noise on this biped; Koro faces +X, left = -Z (see author-creature-clips.mjs Howler frame).
    r.forward = V(1, 0, 0)
    r.left = r.up.cross(r.forward).normalized()
    # Measure the hand's own drop below its wrist joint while the rig is still at rest, so every clip
    # that reaches for the ground aims the same way (the drop is a property of the rig, not of a pose).
    for hand in ('R_Hand', 'L_Hand'):
        koro_hand_drop(r, hand)
    clips = [
        ('koro-throw', 1.2, koro_throw, {'windup': .3, 'release': .44, 'impact': .68, 'recover': .82}),
        ('koro-push', 1.5, koro_push, {'plant': .24, 'push': .42, 'settle': .78}),
        ('koro-distract', 1.1, koro_distract, {'handsUp': .32, 'attention': .5, 'settle': .82}),
        ('koro-search', 1.0, koro_search, {'crouch': .2, 'inspect': .6, 'reveal': .9}),
    ]
    for name, secs, pose, marks in clips:
        bake_measured(r, name, secs, pose, marks, KORO_WATCH, koro_extra)
    r.reset()
    finish(r, OUT / 'koro.json')


# ---------------------------------------------------------------------------------------------
# VARA (harpy; faces +X, right wing +Z, left wing -Z). Pose state is one flat Vector so clips key/blend whole poses.
# ---------------------------------------------------------------------------------------------
LAYOUT = [('flap', 5), ('sweep', 5), ('wpitch', 5), ('leg', 4), ('toe', 1), ('bp', 1), ('br', 1), ('up', 1), ('chest', 1), ('h1', 1), ('h2', 1),
          ('hy', 1), ('beak', 1), ('asym', 1), ('sasym', 1)]
OFF = {}
_o = 0
for _n, _s in LAYOUT:
    OFF[_n] = (_o, _s)
    _o += _s
SIZE = _o


def S(**kw):
    v = [0.0] * SIZE
    for name, val in kw.items():
        o, n = OFF[name]
        if n == 1:
            v[o] = float(val)
        else:
            assert len(val) == n, name
            v[o:o + n] = [float(x) for x in val]
    return Vector(v)


def G(v, name):
    o, n = OFF[name]
    return v[o] if n == 1 else list(v[o:o + n])


TUCK = (-35, 80, -45, -10)
STRIKE_LEG = (-70, 8, 50, 40)
LEG_REACH = (-8, 12, -6, 0)

R_WING = ['bone_20', 'bone_22', 'bone_24', 'bone_26', 'bone_27']   # shoulder, elbow, wrist, hand feather, tip
L_WING = ['bone_28', 'bone_30', 'bone_32', 'bone_34', 'bone_35']
R_EXTRA = {'bone_20': 'bone_21', 'bone_22': 'bone_23', 'bone_24': 'bone_25'}   # coverts / branch feather ride their parent joint
L_EXTRA = {'bone_28': 'bone_29', 'bone_30': 'bone_31', 'bone_32': 'bone_33'}
B_PAIRS = [('bone_45', 'bone_30'), ('bone_46', 'bone_31'), ('bone_47', 'bone_32'), ('bone_48', 'bone_34'), ('bone_49', 'bone_35')]
LEG = {'L': ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2', 'tripo::0_Left_Limb_3'],
       'R': ['bone_9', 'tripo::0_Right_Limb_0', 'tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2']}
TOES = {'L': (['bone_7', 'bone_8'], 'bone_4'), 'R': (['bone_15', 'bone_16'], 'bone_12')}   # (front talons, hind talon)


def tilt(r, pitch, roll):
    """Rotate the whole bird about its hips (Spine_0) so the hip point does not travel; Root only carries the pivot compensation."""
    if not pitch and not roll:
        return
    q = Quaternion(r.left, math.radians(pitch)) @ Quaternion(r.forward, math.radians(roll))
    pivot = r.rest_points['tripo::Spine_0']
    root = r.point('tripo::Root')
    r.rotate_world('tripo::Root', q)
    after = root + q @ (pivot - root)
    r.translate('tripo::Root', pivot - after)


def delta_rot(r, name):
    cur = (CI @ r.arm.matrix_world @ r.bones[name].matrix @ C).to_3x3().normalized()
    bind = (CI @ r.bind[name] @ C).to_3x3().normalized()
    return (cur @ bind.inverted()).to_quaternion()


def drive_chain_b(r):
    """Left wing chain B (off Spine_3) copies chain A's world rotation and joint position so the two skinned sets never tear."""
    for b, a in B_PAIRS:
        qa = delta_rot(r, a)
        r.rotate_world(b, qa @ delta_rot(r, b).inverted())
        target = r.point(a) + qa @ (r.rest_points[b] - r.rest_points[a])
        r.translate(b, target - r.point(b))


def apply_vara(r, v):
    tilt(r, G(v, 'bp'), G(v, 'br'))
    if G(v, 'up'):
        r.translate('tripo::Root', (0, G(v, 'up'), 0))
    if G(v, 'chest'):
        r.rotate('tripo::Spine_1', pitch=G(v, 'chest'))
    hy = G(v, 'hy')
    r.rotate('tripo::Head_1', pitch=G(v, 'h1'), yaw=hy * .6)
    r.rotate('tripo::Head_2', pitch=G(v, 'h2'), yaw=hy * .4)
    if G(v, 'beak'):
        r.rotate('bone_40', pitch=G(v, 'beak'))
    flap, sweep, wp = G(v, 'flap'), G(v, 'sweep'), G(v, 'wpitch')
    asym, sasym = G(v, 'asym'), G(v, 'sasym')
    for chain, extra, sg in ((R_WING, R_EXTRA, 1), (L_WING, L_EXTRA, -1)):
        for i, name in enumerate(chain):
            fl = flap[i] + (asym if i == 0 else asym * .5) * sg
            sw = sweep[i] + (sasym if i == 0 else sasym * .5) * sg
            # right: raise = -roll, back = -yaw; left mirrors both; leading-edge pitch is shared.
            r.rotate(name, pitch=wp[i], yaw=-sw * sg, roll=-fl * sg)
            if name in extra:
                r.rotate(extra[name], roll=-flap[i] * .35 * sg)
    drive_chain_b(r)
    leg, toe = G(v, 'leg'), G(v, 'toe')
    for s in 'LR':
        for name, ang in zip(LEG[s], leg):
            r.rotate(name, pitch=ang)
        front, hind = TOES[s]
        for name in front:
            r.rotate(name, pitch=toe)
        r.rotate(hind, pitch=-toe * .7)


def keyed(keys, t):
    return curve(keys, t)


def fly_state(p, cycles=1):
    p *= cycles
    amp, lag, base = (40, 22, 18, 12, 9), (0, .05, .11, .17, .22), (6, 2, -2, -3, -3)
    flap = [base[i] + amp[i] * cs(p - lag[i]) for i in range(5)]
    sweep = [6 - 10 * sn(p), 4 - 6 * sn(p - .06), 2 - 3 * sn(p - .1), 0, 0]
    wp = [0, 0, 5 * sn(p - .1), 9 * sn(p - .15), 9 * sn(p - .2)]
    return S(flap=flap, sweep=sweep, wpitch=wp, leg=TUCK, toe=25, bp=8, up=.007 * sn(p), chest=2.5 * sn(p + .05), h1=-4, h2=-3)


def hover_state(p, cycles=2):
    p *= cycles
    amp, lag, base = (30, 16, 12, 9, 7), (0, .05, .1, .15, .2), (4, 0, -2, -2, -2)
    flap = [base[i] + amp[i] * cs(p - lag[i]) for i in range(5)]
    sweep = [8 - 14 * sn(p), 4 - 8 * sn(p - .05), 2 - 4 * sn(p - .1), 0, 0]
    wp = [0, 0, 6 * sn(p - .1), 10 * sn(p - .15), 10 * sn(p - .2)]
    return S(flap=flap, sweep=sweep, wpitch=wp, leg=(-8, 22, -14, -4), toe=10, bp=-28, up=.006 * sn(p), chest=2 * sn(p), h1=14, h2=12)


def idle_state(t):
    flutter = keyed([(0, 0), (.20, 0), (.24, 1), (.30, 0), (1, 0)], t) * sn(5 * t * 6)   # quick wing shuffle
    stretch = keyed([(0, 0), (.45, 0), (.55, 1), (.66, 0), (1, 0)], t)
    look = sn(t)
    return S(flap=[-18 + 4 * flutter + 6 * stretch, -8 + 3 * flutter + 10 * stretch, -6 + 2 * flutter + 6 * stretch, -4, -4],
             sweep=[32 - 14 * stretch, 20 - 10 * stretch, 14 - 6 * stretch, 8, 6], leg=(0, 0, 0, 0), up=.003 * sn(2 * t), chest=1.8 * sn(2 * t),
             h1=3 * sn(2 * t), h2=2 * sn(t) , hy=20 * look + 6 * sn(3 * t), asym=3 * flutter - 5 * stretch)


def vara_idle(t, r):
    apply_vara(r, idle_state(t))


def vara_fly(t, r):
    apply_vara(r, fly_state(t))


def vara_hover(t, r):
    apply_vara(r, hover_state(t))


FLYTOP = fly_state(0)
IDLE0 = idle_state(0)


def vara_takeoff(t, r):
    crouch = S(flap=[48, 26, 18, 12, 8], sweep=[6, 2, 0, 0, 0], leg=(-14, 34, -20, 0), toe=20, bp=6, up=-.02, h1=-3)
    down = S(flap=[-36, -16, -12, -8, -6], sweep=[-6, 0, 0, 0, 0], leg=(0, 0, 0, 0), toe=0, bp=-12, h1=6, h2=4)
    mid = S(flap=[20, 12, 10, 6, 4], sweep=[2, 0, 0, 0, 0], leg=(-20, 45, -25, -5), toe=18, bp=0, h1=2)
    apply_vara(r, keyed([(0, IDLE0), (.2, crouch), (.48, down), (.75, mid), (1, FLYTOP)], t))


DIVE_END = S(flap=[-8, -6, -6, -4, -4], sweep=[46, 26, 18, 10, 6], leg=(-18, 45, -10, 5), toe=-4, bp=55, h1=-24, h2=-16)


REACH = S(flap=[-8, -6, -6, -4, -4], sweep=[52, 30, 20, 11, 8], leg=(-45, 15, 25, 20), toe=-20, bp=48, h1=-22, h2=-14)
OPEN = S(flap=[-6, -4, -4, -3, -3], sweep=[44, 26, 18, 10, 8], leg=STRIKE_LEG, toe=-35, bp=40, h1=-18, h2=-12)
CONTACT = S(flap=[-2, -2, -2, 0, 0], sweep=[34, 20, 14, 8, 6], leg=STRIKE_LEG, toe=55, bp=34, h1=-14, h2=-10)


def vara_dive(t, r):
    """The runtime starts vara:strike at its contact fraction (.44), so the dive itself folds, reaches, opens and closes the talons and ends exactly on strike(.44)."""
    mid = S(flap=[-20, -10, -8, -5, -5], sweep=[30, 18, 12, 6, 4], leg=TUCK, toe=25, bp=35, h1=-16, h2=-10)
    apply_vara(r, keyed([(0, FLYTOP), (.35, mid), (.55, DIVE_END), (.72, REACH), (.85, OPEN), (1, CONTACT, 'linear')], t))


def vara_strike(t, r):
    flare = S(flap=[36, 20, 14, 10, 8], sweep=[-18, -8, -4, -2, 0], wpitch=[8, 6, 6, 6, 6], leg=(-60, 6, 40, 30), toe=40, bp=-18, h1=8, h2=6)
    tuck = S(flap=[44, 26, 20, 12, 8], sweep=[0, 0, 0, 0, 0], leg=(-45, 60, -25, 10), toe=30, bp=0, h1=0)
    apply_vara(r, keyed([(0, DIVE_END), (.22, REACH), (.34, OPEN), (.44, CONTACT, 'linear'), (.62, flare), (.82, tuck), (1, FLYTOP)], t))


def vara_land(t, r):
    flare = S(flap=[32, 18, 14, 10, 8], sweep=[-14, -6, -4, 0, 0], leg=(-30, 5, 30, 20), toe=-20, bp=-32, h1=14, h2=10)
    touch = S(flap=[-30, -14, -10, -8, -6], sweep=[-4, 0, 0, 0, 0], leg=(-8, 18, -12, 0), toe=0, bp=-8, up=-.015, h1=4)
    fold = S(flap=[-6, -4, -4, -3, -3], sweep=[10, 6, 4, 2, 2], leg=(0, 0, 0, 0), bp=0, up=-.01)
    apply_vara(r, keyed([(0, FLYTOP), (.25, flare), (.5, touch), (.75, fold), (1, IDLE0)], t))


def vara_mark(t, r):
    env = keyed([(0, 0), (.18, 1), (.82, 1), (1, 0)], t)
    pre = S(flap=[36, 14, 10, 6, 4], leg=(-8, 22, -14, -4), toe=10, bp=-30, h1=-10, h2=-6)
    screech = S(flap=[30, 12, 8, 6, 4], sweep=[-14, -8, -4, -2, 0], leg=(-14, 30, -16, -5), toe=15, bp=-34, up=.01, chest=-8, h1=-26, h2=-22, beak=-25)
    snap = S(flap=[-12, -6, -4, -3, -2], sweep=[10, 6, 3, 0, 0], leg=(-8, 22, -14, -4), toe=10, bp=-12, chest=6, h1=22, h2=18, beak=8)
    settle = S(flap=[14, 6, 4, 2, 1], sweep=[-4, -2, 0, 0, 0], leg=(-8, 22, -14, -4), toe=10, bp=-22, h1=-4, h2=-2)
    mark = keyed([(.18, pre), (.35, screech), (.5, snap, 'linear'), (.7, settle), (.82, settle)], t)
    apply_vara(r, hover_state(t, 2) * (1 - env) + mark * env)


def vara_survey(t, r):
    env = keyed([(0, 0), (.2, 1), (.9, 1), (1, 0)], t)
    glide = dict(flap=[10, 4, 2, -2, -2], sweep=[-4, -2, 0, 0, 0], leg=(-30, 55, -30, -5), toe=18, h1=6, h2=4)
    left = S(**glide, bp=-18, br=-18, hy=40, asym=16, sasym=10, up=.006)
    right = S(**glide, bp=-18, br=18, hy=-40, asym=-16, sasym=-10, up=.006)
    center = S(**glide, bp=-18, up=.006)
    survey = keyed([(.2, left), (.55, right), (.9, center)], t)
    apply_vara(r, hover_state(t, 2) * (1 - env) + survey * env)


VARA_WATCH = ['bone_27', 'bone_35', 'bone_49', 'bone_25', 'bone_7', 'bone_15', 'bone_40', 'tripo::Head_2', 'tripo::Spine_0', 'tripo::Root']


def vara_extra(r):
    p = r.point
    rest = r.rest_points
    return {'wingSpanZ': p('bone_27').z - p('bone_35').z,
            'tipHeightR': p('bone_27').y - rest['bone_27'].y, 'tipHeightL': p('bone_35').y - rest['bone_35'].y,
            'chainA_B_tipGap': (p('bone_35') - p('bone_49')).length,
            'chainA_B_elbowGap': (p('bone_30') - p('bone_45')).length,
            'spine0DriftXZ': math.hypot(p('tripo::Spine_0').x - rest['tripo::Spine_0'].x, p('tripo::Spine_0').z - rest['tripo::Spine_0'].z),
            'spine0DriftY': p('tripo::Spine_0').y - rest['tripo::Spine_0'].y,
            'rootDriftXZ': math.hypot(p('tripo::Root').x, p('tripo::Root').z),
            'talonPairGapZ': p('bone_15').z - p('bone_7').z, 'talonForwardX': (p('bone_7').x + p('bone_15').x) / 2 - rest['bone_7'].x,
            'talonHeight': (p('bone_7').y + p('bone_15').y) / 2, 'beakTipY': p('bone_40').y, 'beakTipX': p('bone_40').x}


def author_vara():
    r = Rig(str(VARA_SRC), 'tripo::Head_2', 'tripo::Spine_0')
    clips = [
        ('vara:idle', 3.0, vara_idle, {}),
        ('vara:takeoff', .6, vara_takeoff, {'liftoff': .48}),
        ('vara:fly', .7, vara_fly, {}),
        ('vara:hover', .9, vara_hover, {}),
        ('vara:land', .7, vara_land, {'touch': .5}),
        ('vara:dive', .4, vara_dive, {}),
        ('vara:strike', .5667, vara_strike, {'contact': .44, 'flare': .62}),
        ('vara-sky-mark', .8, vara_mark, {'screech': .35, 'snap': .5}),
        ('vara-sky-survey', 1.0, vara_survey, {'scanStart': .2, 'scanEnd': .9}),
    ]
    for name, secs, pose, marks in clips:
        bake_measured(r, name, secs, pose, marks, VARA_WATCH, vara_extra)
    r.reset()
    finish(r, OUT / 'vara.json')


if __name__ == '__main__':
    which = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'all'
    if which in ('koro', 'all'):
        REPORT.clear()
        author_koro()
    if which in ('vara', 'all'):
        REPORT.clear()
        author_vara()
