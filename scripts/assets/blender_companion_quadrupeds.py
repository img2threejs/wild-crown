"""Author the Asha / Sable / Nyra / Solkar companion skill clips in Blender on the native production rigs.

Run (one or more actors; `all` by default):
  /tmp/wc-blender-mount/Blender.app/Contents/MacOS/Blender -b --python scripts/assets/blender_companion_quadrupeds.py -- asha sable nyra solkar

Every pose is built from world anatomical rotations of the real skinned joints plus rotation-only IK that keeps the
planted paws on their measured rest ground points, so bone lengths, meshes, skins and the repaired hind legs survive.
The body only ever moves vertically (compression / rear); planar travel belongs to the simulation.
Clip lengths and release / contact markers follow src/game/companions/CompanionSkills.ts at 60 simulation ticks per second.
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'assets'))

from blender_companion_common import Rig, curve, window  # noqa: E402

TICK = 1 / 60
OUT = ROOT / 'asset-source' / 'animation' / 'companions-blender'
JAW_REPAIR = 'repair::Jaw'


def tripo(*names):
    return ['tripo::' + n for n in names]


# Measured native hierarchies (see author-quadruped-clips.mjs ASHA_RIG / NYRA_RIG / SOLKAR_RIG and the inspected GLB node trees).
# jaw: the skinned native lower jaw, or the approved repair joint on Sable and Solkar.
ACTORS = {
    'asha': {
        'source': 'asset-source/generated/actor-asha-runtime-01/actor-asha-combat.glb',
        'hips': 'tripo::0_Right_Limb_0', 'spine': tripo('0_Right_Limb_1', '0_Right_Limb_2'), 'neck': tripo('Head_0', 'Head_1'), 'head': 'tripo::Head_2',
        'jaw': 'tripo::Head_3', 'jawTip': 'tripo::Head_4', 'muzzle': 'bone_15',
        'tail': ['bone_30', *tripo('1_Left_Limb_0', '1_Left_Limb_1', '1_Left_Limb_2', '1_Left_Limb_3')],
        'legs': {
            'FL': ['tripo::Spine_0', 'bone_21', 'bone_22', 'bone_23', 'bone_24'],
            'FR': tripo('0_Right_Limb_3', '0_Right_Limb_4', '0_Right_Limb_5', '0_Right_Limb_6', '0_Right_Limb_7'),
            'HL': [*tripo('0_Left_Limb_0', '0_Left_Limb_1', '0_Left_Limb_2'), 'repair::HL_Paw'],
            'HR': ['repair::HR_0', 'repair::HR_1', 'repair::HR_2', 'repair::HR_Paw'],
        },
    },
    'sable': {
        'source': 'asset-source/generated/actor-sable-runtime-01/actor-sable-companion-rig.glb',
        'hips': 'tripo::Spine_0', 'spine': tripo('Spine_1', 'Spine_2'), 'neck': tripo('Spine_3', 'Head_0', 'Head_1'), 'head': 'tripo::Head_2',
        'jaw': JAW_REPAIR, 'jawTip': JAW_REPAIR, 'muzzle': 'tripo::Head_3',
        'tail': ['bone_19', 'bone_20', *tripo('Tail_0', 'Tail_1', 'Tail_2', 'Tail_3')],
        'legs': {
            'FL': ['bone_4', *tripo('0_Left_Limb_0', '0_Left_Limb_1', '0_Left_Limb_2', '0_Left_Limb_3')],
            'FR': ['bone_9', *tripo('0_Right_Limb_0', '0_Right_Limb_1', '0_Right_Limb_2', '0_Right_Limb_3')],
            'HL': tripo('1_Left_Limb_0', '1_Left_Limb_1', '1_Left_Limb_2', '1_Left_Limb_3'),
            'HR': tripo('1_Right_Limb_0', '1_Right_Limb_1', '1_Right_Limb_2', '1_Right_Limb_3'),
        },
    },
    'nyra': {
        'source': 'asset-source/generated/actor-nyra-runtime-01/actor-nyra-combat.glb',
        'hips': 'tripo::0_Right_Limb_0', 'spine': tripo('0_Right_Limb_1', '0_Right_Limb_2'), 'neck': tripo('Head_0', 'Head_1'), 'head': 'tripo::Head_2',
        'jaw': 'tripo::Head_3', 'jawTip': 'tripo::Head_4', 'muzzle': 'tripo::Head_4',
        'tail': ['bone_31', 'bone_32', *tripo('Tail_0', 'Tail_1', 'Tail_2', 'Tail_3', 'Tail_4', '0_Left_Limb_0')],
        'legs': {
            'FL': ['bone_13', 'bone_14', 'bone_15', 'bone_16', 'bone_17'],
            'FR': [*tripo('Spine_0', 'Spine_1'), 'bone_20', 'bone_21', 'bone_22'],
            'HL': ['bone_23', 'bone_24', 'bone_25', 'bone_26'],
            'HR': ['bone_27', 'bone_28', 'bone_29', 'bone_30'],
        },
    },
    'solkar': {
        'source': 'asset-source/generated/actor-solkar-runtime-01/actor-solkar-companion-rig.glb',
        # Head_1 carries the beard / chin mass (1965 dominant verts under the skull), so the head pivots there and Head_2 only adds the skull nod.
        'hips': 'tripo::1_Left_Limb_0', 'spine': tripo('Spine_0', 'Spine_1'), 'neck': tripo('Head_0', 'Head_1'), 'head': 'tripo::Head_2',
        'jaw': JAW_REPAIR, 'jawTip': JAW_REPAIR, 'muzzle': 'tripo::Head_3',
        'tail': ['bone_30', 'bone_31', *tripo('Tail_0', 'Tail_1', 'Tail_2', 'Tail_3', 'Tail_4'), 'bone_37'],
        'legs': {
            'FL': ['bone_7', *tripo('0_Left_Limb_0', '0_Left_Limb_1', '0_Left_Limb_2', '0_Left_Limb_3', '0_Left_Limb_4')],
            'FR': ['bone_13', *tripo('0_Right_Limb_0', '0_Right_Limb_1', '0_Right_Limb_2', '0_Right_Limb_3', '0_Right_Limb_4')],
            'HL': tripo('1_Left_Limb_1', '1_Left_Limb_2', '1_Left_Limb_3', '1_Left_Limb_4', '1_Left_Limb_5'),
            'HR': ['bone_25', 'bone_26', 'bone_27', 'bone_28', 'bone_29'],
        },
    },
}
BODY = 'tripo::Root'


def smooth(t, a, b):
    """0 -> 1 smoothstep between phases a and b."""
    if t <= a:
        return 0.0
    if t >= b:
        return 1.0
    u = (t - a) / (b - a)
    return u * u * (3 - 2 * u)


def arc(s):
    """Half-sine lift profile for a stepping paw: 0 at both ends, 1 mid swing."""
    return math.sin(math.pi * min(max(s, 0.0), 1.0))


class Anatomy:
    """Measured rest geometry plus the pose primitives every clip is built from."""

    def __init__(self, actor, rig):
        self.spec = ACTORS[actor]
        self.rig = rig
        self.jaw = self.spec['jaw']
        if self.jaw not in rig.bones:
            raise ValueError(f'{actor}: required skinned lower-jaw joint {self.jaw} is missing; prepare companion jaws first')
        self.legs = self.spec['legs']
        self.paws = {leg: chain[-1] for leg, chain in self.legs.items()}
        self.rest_paw = {leg: rig.rest_points[paw].copy() for leg, paw in self.paws.items()}
        floor = min(p.y for p in self.rest_paw.values())
        # Body scale: hip height above the paws, never the suspect mesh bound box.
        self.L = rig.rest_points[self.spec['hips']].y - floor
        self.slack = {}
        for leg, chain in self.legs.items():
            pts = [rig.rest_points[n] for n in chain]
            self.slack[leg] = sum((b - a).length for a, b in zip(pts, pts[1:])) - (pts[-1] - pts[0]).length
        self.front_rise = 0.8 * min(self.slack['FL'], self.slack['FR'])
        self.rear_rise = 0.8 * min(self.slack['HL'], self.slack['HR'])
        jaw_at = tuple(round(v, 3) for v in rig.rest_points[self.jaw]) if self.jaw else None
        print(f'ANATOMY {actor}: L={self.L:.3f} jaw={self.jaw} at {jaw_at} slack={{{", ".join(f"{k}:{v:.3f}" for k, v in self.slack.items())}}}', flush=True)

    # --- body ---------------------------------------------------------------------------------
    def lower(self, amount):
        if abs(amount) > 1e-9:
            self.rig.translate(BODY, (0, -amount, 0))

    def body(self, pitch=0, yaw=0, roll=0):
        self.rig.rotate(self.spec['hips'], pitch=pitch, yaw=yaw, roll=roll)

    def chain(self, names, pitch=0, yaw=0, roll=0, taper=False):
        n = len(names)
        weights = [1 / n] * n if not taper else [2 * (i + 1) / (n * (n + 1)) for i in range(n)]
        for name, w in zip(names, weights):
            self.rig.rotate(name, pitch=pitch * w, yaw=yaw * w, roll=roll * w)

    def spine(self, pitch=0, yaw=0, roll=0):
        self.chain(self.spec['spine'], pitch, yaw, roll)

    def neck(self, pitch=0, yaw=0, roll=0):
        self.chain(self.spec['neck'], pitch, yaw, roll)

    def head(self, pitch=0, yaw=0, roll=0):
        self.rig.rotate(self.spec['head'], pitch=pitch, yaw=yaw, roll=roll)

    def jaw_open(self, degrees):
        """Positive opens the skinned lower jaw; all four input rigs must provide one."""
        if abs(degrees) > 1e-6:
            self.rig.rotate(self.jaw, pitch=degrees)

    def tail(self, up=0, yaw=0, roll=0):
        # The tail points backwards, so a positive anatomical pitch raises its tip.
        self.chain(self.spec['tail'], pitch=up, yaw=yaw, roll=roll, taper=True)

    # --- legs ---------------------------------------------------------------------------------
    def plant(self, leg, forward=0.0, up=0.0, left=0.0):
        """Rotation-only IK: keep the paw on its rest ground point (plus an optional offset in body heights)."""
        target = self.rest_paw[leg] + self.rig.offset(forward * self.L, up * self.L, left * self.L)
        self.rig.ik(self.legs[leg], target)

    def raise_leg(self, leg, shoulder, elbow=0.0, wrist=0.0):
        """Swing a leg forward / up (negative shoulder pitch) and fold the lower leg back (positive elbow pitch).

        While the body is still compressed and the swing is only starting, the paw would pass under the ground;
        it is then IK-settled onto the ground at its swung position so the blend never clips the floor."""
        chain = self.legs[leg]
        self.rig.rotate(chain[1], pitch=shoulder)
        self.rig.rotate(chain[2], pitch=elbow)
        if len(chain) > 4 and abs(wrist) > 1e-6:
            self.rig.rotate(chain[3], pitch=wrist)
        self.settle(leg)

    def settle(self, leg):
        point = self.paw_point(leg)
        ground = self.rest_paw[leg].y
        if point.y < ground - 1e-4:
            point.y = ground
            self.rig.ik(self.legs[leg], point)

    def plant_all(self, except_legs=()):
        for leg in self.legs:
            if leg not in except_legs:
                self.plant(leg)

    def step(self, leg, t, start, end, forward=0.12, lift=0.15, left=0.0):
        """A paw that lifts and re-plants on its own rest point (stepping in place, no travel)."""
        s = (t - start) / (end - start)
        if 0 < s < 1:
            a = arc(s)
            self.plant(leg, forward=forward * a, up=lift * a, left=left * a)
        else:
            self.plant(leg)

    def lift_or_plant(self, leg, w, shoulder, elbow, wrist=0.0):
        if w <= 1e-4:
            self.plant(leg)
        else:
            self.raise_leg(leg, shoulder * w, elbow * w, wrist * w)

    def paw_point(self, leg):
        return self.rig.point(self.paws[leg])

    def paw_toward(self, leg, target, s):
        """IK the paw from where it currently is toward a world target, by fraction s, never below its ground point."""
        point = self.paw_point(leg).lerp(target, s)
        point.y = max(point.y, self.rest_paw[leg].y)
        self.rig.ik(self.legs[leg], point)

    def ground_target(self, leg, forward=0.0, left=0.0, up=0.0):
        return self.rest_paw[leg] + self.rig.offset(forward * self.L, up * self.L, left * self.L)


# ------------------------------------------------------------------------------------------------
# Asha: protective heavy tigress
# ------------------------------------------------------------------------------------------------

def asha_guard(t, A):
    # Weight shifts to the hind legs: the rump sinks while both forepaws come up into a brace, then everything settles.
    w = window(t, .08, .25, .5, .8)
    A.lower(0.16 * A.L * w)
    A.body(pitch=-12 * w)
    A.spine(pitch=-6 * w)
    A.neck(pitch=-8 * w)
    A.head(pitch=10 * w)
    A.jaw_open(12 * window(t, .3, .45, .55, .7))
    A.tail(up=18 * w, yaw=14 * math.sin(2 * math.pi * 2 * t) * w)
    A.plant('HL')
    A.plant('HR')
    A.lift_or_plant('FL', w, shoulder=-52, elbow=60, wrist=20)
    A.lift_or_plant('FR', w, shoulder=-48, elbow=66, wrist=20)


def asha_pin(t, A):
    # Load, lift the right forepaw high, drive it down onto the target at .55, hold the pin, recover.
    load = window(t, .05, .36, .55, .8)
    pin = curve([(0, 0), (.45, 0), (.55, 1), (.75, 1), (.95, 0), (1, 0)], t)
    lift = curve([(0, 0), (.1, 0), (.36, 1), (.45, 1), (.55, 0), (1, 0)], t)
    A.lower(A.L * (0.1 * load + 0.08 * pin))
    A.body(pitch=-5 * lift + 10 * pin)
    A.spine(pitch=-4 * lift + 6 * pin)
    A.neck(pitch=4 * lift + 10 * pin, yaw=-6 * pin)
    A.head(pitch=6 * lift + 16 * pin, yaw=-8 * pin)
    A.jaw_open(22 * window(t, .4, .55, .65, .8))
    A.tail(up=22 * load, yaw=-16 * lift + 12 * pin)
    A.plant('HL')
    A.plant('HR')
    A.plant('FL')
    if t < .45:
        A.lift_or_plant('FR', lift, shoulder=-78, elbow=72, wrist=15)
    else:
        A.raise_leg('FR', -78 * lift, 72 * lift, 15 * lift)
        target = A.ground_target('FR', forward=0.5, left=-0.06)
        if t <= .75:
            A.paw_toward('FR', target, smooth(t, .45, .55))
        else:
            A.rig.ik(A.legs['FR'], target.lerp(A.rest_paw['FR'], smooth(t, .75, .95)))


def asha_search(t, A):
    # Nose to the ground, scenting left and right, one small forepaw plant.
    w = window(t, 0, .2, .9, 1)
    sweep = math.sin(2 * math.pi * 1.5 * (t - .2) / .7) if .2 <= t <= .9 else 0
    A.lower(0.1 * A.L * w)
    A.body(pitch=8 * w)
    A.spine(pitch=6 * w)
    A.neck(pitch=36 * w, yaw=18 * sweep * w)
    A.head(pitch=34 * w, yaw=22 * sweep * w)
    A.tail(up=-10 * w, yaw=10 * sweep * w)
    A.plant('HL')
    A.plant('HR')
    A.plant('FR')
    A.step('FL', t, .3, .55, forward=0.16, lift=0.12)


def asha_distract(t, A):
    # Neck and head swing toward the target with a growl and a tail lash; the root never yaws.
    w = window(t, .08, .32, .5, .9)
    lash = math.sin(2 * math.pi * 2 * (t - .2)) * window(t, .2, .3, .7, .85)
    A.lower(0.04 * A.L * w)
    A.body(roll=5 * w)
    A.spine(yaw=10 * w)
    A.neck(pitch=-6 * w, yaw=32 * w)
    A.head(pitch=-8 * w, yaw=26 * w, roll=-6 * w)
    A.jaw_open(20 * window(t, .3, .4, .55, .7))
    A.tail(up=12 * w, yaw=34 * lash)
    A.plant('HL')
    A.plant('HR')
    A.plant('FR')
    A.step('FL', t, .36, .56, forward=0.04, lift=0.08, left=0.06)


# ------------------------------------------------------------------------------------------------
# Sable: watchful pack scout, with the approved skinned lower-jaw repair
# ------------------------------------------------------------------------------------------------

def sable_flank(t, A):
    # Side-hop tuck, then the neck drives forward into a bite at .58 and the legs brace on landing.
    crouch = window(t, .05, .22, .3, .42)
    hop = window(t, .3, .4, .44, .52)
    land = window(t, .46, .54, .72, .95)
    bite = window(t, .46, .58, .64, .8)
    A.lower(A.L * (0.2 * crouch + 0.14 * land) - A.rear_rise * hop)
    A.body(pitch=-6 * hop + 4 * land, roll=10 * hop - 4 * land)
    A.spine(pitch=4 * crouch - 6 * hop + 6 * bite)
    A.neck(pitch=8 * crouch - 6 * hop + 22 * bite, yaw=14 * hop - 10 * bite)
    A.head(pitch=12 * crouch - 10 * hop + 18 * bite, yaw=10 * hop - 8 * bite)
    A.jaw_open(curve([(0, 0), (.44, 0), (.52, 24), (.55, 24), (.58, 0), (1, 0)], t))
    A.tail(up=-8 * crouch + 22 * hop + 10 * land, yaw=16 * math.sin(2 * math.pi * 1.5 * t) * (hop + land))
    for leg in ('HL', 'HR'):
        if hop > 1e-4:
            A.rig.rotate(A.legs[leg][0], pitch=35 * hop)
            A.rig.rotate(A.legs[leg][1], pitch=-55 * hop)
            A.settle(leg)
        else:
            A.plant(leg, left=0.08 * land * (1 if leg == 'HL' else -1))
    for leg in ('FL', 'FR'):
        side = 1 if leg == 'FL' else -1
        if hop > 1e-4:
            A.raise_leg(leg, -40 * hop, 65 * hop, 15 * hop)
        else:
            A.plant(leg, forward=0.1 * land, left=0.09 * land * side)


def sable_search(t, A):
    # Nose down on the trail with tracked steps in place.
    w = window(t, 0, .2, .9, 1)
    sweep = math.sin(2 * math.pi * 1.25 * (t - .2) / .7) if .2 <= t <= .9 else 0
    A.lower(0.08 * A.L * w)
    A.body(pitch=6 * w)
    A.spine(pitch=8 * w)
    A.neck(pitch=30 * w, yaw=14 * sweep * w)
    A.head(pitch=30 * w, yaw=16 * sweep * w)
    A.tail(up=-6 * w, yaw=12 * sweep * w)
    A.step('FL', t, .22, .42, forward=0.14, lift=0.12)
    A.step('HR', t, .36, .56, forward=0.1, lift=0.1)
    A.step('FR', t, .52, .72, forward=0.14, lift=0.12)
    A.step('HL', t, .66, .86, forward=0.1, lift=0.1)


def sable_distract(t, A):
    # Neck rises into a jaw-open howl; the tail swings while the rear squats a touch.
    w = window(t, .08, .32, .6, .92)
    wag = math.sin(2 * math.pi * 2 * (t - .2)) * window(t, .2, .3, .7, .9)
    A.lower(0.06 * A.L * w)
    A.body(pitch=-6 * w)
    A.spine(pitch=-6 * w)
    A.neck(pitch=-30 * w, yaw=8 * w)
    A.head(pitch=-34 * w, yaw=6 * w)
    A.jaw_open(24 * window(t, .28, .36, .55, .7))
    A.tail(up=28 * w, yaw=26 * wag)
    A.plant('HL')
    A.plant('HR')
    A.plant('FL')
    A.step('FR', t, .34, .52, forward=0.05, lift=0.1, left=-0.05)


# ------------------------------------------------------------------------------------------------
# Nyra: low silent panther
# ------------------------------------------------------------------------------------------------

def nyra_ambush(t, A):
    # Deep crouch loading the hind legs, forelegs thrust into the pounce, right claw rakes down at .52, recover.
    crouch = curve([(0, 0), (.04, 0), (.26, 1), (.32, 1), (.42, 0), (1, 0)], t)
    thrust = curve([(0, 0), (.26, 0), (.42, 1), (.5, 1), (.62, 0), (1, 0)], t)
    rake = curve([(0, 0), (.4, 0), (.52, 1), (.66, 1), (.95, 0), (1, 0)], t)
    A.lower(A.L * (0.3 * crouch + 0.12 * rake) - A.rear_rise * thrust)
    A.body(pitch=-4 * crouch - 12 * thrust + 10 * rake)
    A.spine(pitch=6 * crouch - 8 * thrust + 8 * rake)
    A.neck(pitch=14 * crouch - 12 * thrust + 10 * rake, yaw=-6 * rake)
    A.head(pitch=10 * crouch - 6 * thrust + 14 * rake, yaw=-8 * rake)
    A.jaw_open(24 * window(t, .4, .5, .58, .72))
    A.tail(up=-14 * crouch + 24 * thrust + 6 * rake, yaw=12 * math.sin(2 * math.pi * 2 * t) * (thrust + rake))
    A.plant('HL')
    A.plant('HR')
    reach = max(thrust, 0)
    if t < .4:
        A.lift_or_plant('FL', reach, shoulder=-56, elbow=24, wrist=10)
        A.lift_or_plant('FR', reach, shoulder=-62, elbow=18, wrist=10)
    else:
        A.raise_leg('FL', -56 * reach, 24 * reach, 10 * reach)
        A.raise_leg('FR', -62 * reach, 18 * reach, 10 * reach)
        right = A.ground_target('FR', forward=0.42, left=-0.1)
        left = A.ground_target('FL', forward=0.26, left=0.06)
        if t <= .66:
            A.paw_toward('FR', right, smooth(t, .4, .52))
            A.paw_toward('FL', left, smooth(t, .44, .58))
        else:
            A.rig.ik(A.legs['FR'], right.lerp(A.rest_paw['FR'], smooth(t, .66, .92)))
            A.rig.ik(A.legs['FL'], left.lerp(A.rest_paw['FL'], smooth(t, .7, .95)))


def nyra_search(t, A):
    # Low stalking sniff: belly low, nose to the ground, a slow sweep and two creeping forepaw steps.
    w = window(t, 0, .2, .9, 1)
    sweep = math.sin(2 * math.pi * (t - .2) / .7) if .2 <= t <= .9 else 0
    A.lower(0.24 * A.L * w)
    A.body(pitch=4 * w)
    A.spine(pitch=6 * w)
    A.neck(pitch=28 * w, yaw=20 * sweep * w)
    A.head(pitch=30 * w, yaw=22 * sweep * w)
    A.tail(up=4 * w, yaw=14 * sweep * w)
    A.plant('HL')
    A.plant('HR')
    A.step('FL', t, .26, .5, forward=0.12, lift=0.08)
    A.step('FR', t, .52, .76, forward=0.12, lift=0.08)


def nyra_distract(t, A):
    # A low hiss: the body drops and arches, the head whips toward the target with an open mouth and a lashing tail.
    w = window(t, .08, .32, .5, .9)
    lash = math.sin(2 * math.pi * 2.5 * (t - .2)) * window(t, .2, .28, .75, .9)
    A.lower(0.16 * A.L * w)
    A.body(roll=-4 * w)
    A.spine(pitch=-8 * w, yaw=8 * w)
    A.neck(pitch=18 * w, yaw=30 * w)
    A.head(pitch=-4 * w, yaw=24 * w, roll=8 * w)
    A.jaw_open(26 * window(t, .28, .36, .55, .72))
    A.tail(up=24 * w, yaw=36 * lash)
    A.plant_all()


# ------------------------------------------------------------------------------------------------
# Solkar: heavy regal lion, with the approved skinned lower-jaw repair
# ------------------------------------------------------------------------------------------------

def solkar_rally(t, A):
    # Rear and brace, chest swelling into the roar through .28-.48, then both forepaws stomp down and settle.
    rear = curve([(0, 0), (.06, 0), (.28, 1), (.48, 1), (.58, 0), (1, 0)], t)
    roar = window(t, .22, .3, .46, .58)
    stomp = curve([(0, 0), (.5, 0), (.58, 1), (.7, 1), (.95, 0), (1, 0)], t)
    A.lower(A.L * (0.1 * rear + 0.1 * stomp))
    A.body(pitch=-16 * rear + 5 * stomp)
    A.spine(pitch=-10 * rear + 4 * stomp)
    A.neck(pitch=-14 * roar + 6 * stomp, roll=4 * roar)
    A.head(pitch=-18 * roar + 8 * stomp, roll=8 * roar)
    A.jaw_open(24 * roar)
    A.tail(up=22 * rear + 8 * stomp, yaw=10 * math.sin(2 * math.pi * 1.5 * t) * (rear + stomp))
    A.plant('HL')
    A.plant('HR')
    for leg in ('FL', 'FR'):
        if rear > 1e-4:
            A.raise_leg(leg, -36 * rear, 52 * rear, 18 * rear)
        else:
            A.plant(leg, forward=0.06 * stomp, left=0.05 * stomp * (1 if leg == 'FL' else -1))


def solkar_search(t, A):
    # Proud head scan high over the ground with one planted step per foreleg.
    w = window(t, 0, .2, .9, 1)
    scan = curve([(0, 0), (.2, 0), (.4, 1), (.55, 1), (.75, -1), (.9, 0), (1, 0)], t)
    A.body(pitch=-2 * w)
    A.spine(pitch=-4 * w)
    A.neck(pitch=-12 * w, yaw=22 * scan)
    A.head(pitch=-8 * w, yaw=24 * scan, roll=-6 * scan)
    A.tail(up=12 * w, yaw=10 * math.sin(2 * math.pi * t) * w)
    A.plant('HL')
    A.plant('HR')
    A.step('FL', t, .24, .46, forward=0.12, lift=0.14)
    A.step('FR', t, .5, .72, forward=0.12, lift=0.14)


def solkar_distract(t, A):
    # Head thrown up into a short roar at the target, then a glance aside and one right-paw stamp. No rear, unlike the rally.
    w = window(t, .08, .32, .5, .75)
    glance = window(t, .5, .62, .75, .95)
    A.lower(0.05 * A.L * w)
    A.spine(pitch=-5 * w)
    A.neck(pitch=-26 * w + 4 * glance, yaw=18 * glance)
    A.head(pitch=-22 * w + 6 * glance, yaw=20 * glance)
    A.jaw_open(26 * window(t, .26, .34, .5, .62))
    A.tail(up=16 * w, yaw=-18 * window(t, .4, .5, .6, .8))
    A.plant('HL')
    A.plant('HR')
    A.plant('FL')
    A.step('FR', t, .5, .66, forward=0.05, lift=0.12, left=-0.05)


CLIPS = {
    'asha': [('asha-guard', 84, .25, .5, asha_guard), ('asha-pin', 72, .36, .55, asha_pin), ('asha-search', 60, .2, .9, asha_search), ('asha-distract', 66, .32, .5, asha_distract)],
    'sable': [('sable-flank', 72, .32, .58, sable_flank), ('sable-search', 60, .2, .9, sable_search), ('sable-distract', 66, .32, .5, sable_distract)],
    'nyra': [('nyra-ambush', 60, .26, .52, nyra_ambush), ('nyra-search', 60, .2, .9, nyra_search), ('nyra-distract', 66, .32, .5, nyra_distract)],
    'solkar': [('solkar-rally', 96, .28, .48, solkar_rally), ('solkar-search', 60, .2, .9, solkar_search), ('solkar-distract', 66, .32, .5, solkar_distract)],
}


def measure(A, name, pose, phases):
    """Peak world displacement of the paws, muzzle and jaw tip against rest, for the evidence report."""
    rig = A.rig
    watch = {**{f'paw{leg}': paw for leg, paw in A.paws.items()}, 'muzzle': A.spec['muzzle']}
    if A.jaw:
        watch['jaw'] = A.spec['jawTip'] or A.jaw
    peaks = {k: 0.0 for k in watch}
    floor = {k: 0.0 for k in A.paws}
    jaw_angle = 0.0
    for t in sorted(set(i / 40 for i in range(41)) | set(phases)):
        rig.reset()
        pose(t, A)
        for k, node in watch.items():
            peaks[k] = max(peaks[k], (rig.point(node) - rig.rest_points[node]).length)
        for leg, paw in A.paws.items():
            floor[leg] = min(floor[leg], rig.point(paw).y - A.rest_paw[leg].y)
        if A.jaw:
            head = rig.arm.matrix_world @ rig.bones[A.spec['head']].matrix
            jaw = rig.arm.matrix_world @ rig.bones[A.jaw].matrix
            rel = (head.inverted() @ jaw).to_quaternion()
            rest_rel = (rig.bind[A.spec['head']].inverted() @ rig.bind[A.jaw]).to_quaternion()
            angle = math.degrees(rest_rel.rotation_difference(rel).angle)
            jaw_angle = max(jaw_angle, min(angle, 360 - angle))
    rig.reset()
    text = ' '.join(f'{k}={v:.3f}' for k, v in peaks.items())
    print(f'MEASURE {name}: peak displacement {text} | lowest paw below rest {min(floor.values()):.4f} | jaw angle {jaw_angle:.1f}', flush=True)
    return {'peakDisplacement': peaks, 'lowestPawBelowRest': min(floor.values()), 'jawAngle': jaw_angle}


def author(actor):
    spec = ACTORS[actor]
    rig = Rig(ROOT / spec['source'], spec['head'], spec['hips'])
    A = Anatomy(actor, rig)
    evidence = {}
    for name, ticks, release, contact, pose in CLIPS[actor]:
        markers = {'release': release, 'contact': contact}
        evidence[name] = measure(A, name, pose, markers.values())
        rig.bake(name, ticks * TICK, lambda t, _rig, pose=pose: pose(t, A), markers)
    output = OUT / f'{actor}.json'
    rig.save(output)
    report = json.loads(output.read_text())
    report['anatomy'] = {
        'bodyHeightScale': A.L,
        'forepaws': {'FL': A.paws['FL'], 'FR': A.paws['FR']},
        'hindpaws': {'HL': A.paws['HL'], 'HR': A.paws['HR']},
        'muzzle': spec['muzzle'],
        'jaw': A.jaw,
        'jawTip': spec['jawTip'],
        'legSlack': A.slack,
        'evidence': evidence,
    }
    output.write_text(json.dumps(report, separators=(',', ':')) + '\n')
    print(f'DONE {actor}: {[c["name"] for c in report["clips"]]}', flush=True)


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    actors = list(ACTORS) if not args or args == ['all'] else args
    for actor in actors:
        if actor not in ACTORS:
            raise SystemExit(f'Unknown actor {actor}; choose from {list(ACTORS)}')
        author(actor)
