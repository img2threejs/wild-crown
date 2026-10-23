"""Blender-only companion pose authoring; bake onto the unchanged original glTF joint basis.

The imported Blender bone axes may differ from glTF. Capture pose/rest world deltas,
then reconstruct original-node local transforms, rather than copying Blender quaternions.
This preserves meshes, inverse bind matrices, original clips and repaired production rigs.
"""
import hashlib
import json
import math
import struct
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30
C = Matrix.Rotation(math.pi / 2, 4, 'X')
CI = C.inverted()


def glb_json(path):
    data = Path(path).read_bytes()
    length, kind = struct.unpack_from('<II', data, 12)
    if data[:4] != b'glTF' or kind != 0x4E4F534A:
        raise ValueError('Expected a GLB 2.0 JSON chunk')
    return json.loads(data[20:20 + length]), hashlib.sha256(data).hexdigest()


def curve(keys, t):
    """Smooth pose-to-pose interpolation, with optional linear segments."""
    if t <= keys[0][0]:
        return keys[0][1]
    for a, b in zip(keys, keys[1:]):
        if t <= b[0]:
            u = (t - a[0]) / (b[0] - a[0])
            if len(b) < 3 or b[2] != 'linear':
                u = u * u * (3 - 2 * u)
            return a[1] + (b[1] - a[1]) * u
    return keys[-1][1]


def window(t, start, peak, hold, end):
    return curve([(0, 0), (start, 0), (peak, 1), (hold, 1), (end, 0), (1, 0)], t)


class Rig:
    def __init__(self, source, head, hips, root='tripo::Root'):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.source = str(Path(source).resolve())
        self.json, self.source_hash = glb_json(self.source)
        bpy.ops.import_scene.gltf(filepath=self.source)
        arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
        if len(arms) != 1:
            raise ValueError(f'Expected one production armature, got {len(arms)}')
        self.arm = arms[0]
        for obj in bpy.context.scene.objects:
            obj.animation_data_clear()
        self.bones = self.arm.pose.bones
        self.root = root
        self.nodes = self.json['nodes']
        self.names = {n.get('name'): i for i, n in enumerate(self.nodes) if n.get('name')}
        self.parent = {}
        for i, node in enumerate(self.nodes):
            for child in node.get('children', []):
                self.parent[child] = i
        self.rest_local = []
        for node in self.nodes:
            if 'matrix' in node:
                m = node['matrix']
                self.rest_local.append(Matrix([m[i::4] for i in range(4)]))
            else:
                q = node.get('rotation', [0, 0, 0, 1])
                self.rest_local.append(Matrix.LocRotScale(Vector(node.get('translation', [0, 0, 0])), Quaternion((q[3], q[0], q[1], q[2])), Vector(node.get('scale', [1, 1, 1]))))
        self.rest_world = {}
        def world(index):
            if index not in self.rest_world:
                self.rest_world[index] = (world(self.parent[index]) if index in self.parent else Matrix.Identity(4)) @ self.rest_local[index]
            return self.rest_world[index]
        for i in range(len(self.nodes)):
            world(i)
        self.joints = sorted(set(j for skin in self.json.get('skins', []) for j in skin['joints']))
        missing = [self.nodes[j].get('name') for j in self.joints if self.nodes[j].get('name') not in self.bones]
        if missing:
            raise ValueError(f'Imported skeleton dropped original joints: {missing}')
        self.reset()
        self.bind = {b.name: (self.arm.matrix_world @ b.matrix).copy() for b in self.bones}
        self.forward = self.rest_world[self.names[head]].translation - self.rest_world[self.names[hips]].translation
        self.forward.y = 0
        self.forward.normalize()
        self.up = Vector((0, 1, 0))
        self.left = self.up.cross(self.forward).normalized()
        # glTF import creates an Icosphere custom bone display; it is not character geometry.
        bounds = []
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for obj in bpy.context.scene.objects:
            if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' for mod in obj.modifiers):
                continue
            evaluated = obj.evaluated_get(depsgraph)
            mesh = evaluated.to_mesh()
            bounds.extend(CI @ (evaluated.matrix_world @ vertex.co) for vertex in mesh.vertices)
            evaluated.to_mesh_clear()
        if not bounds:
            raise ValueError('Imported character has no evaluated skinned geometry')
        self.height = max(v.y for v in bounds) - min(v.y for v in bounds)
        self.floor = min(v.y for v in bounds)
        self.rest_points = {b.name: self.point(b.name) for b in self.bones}
        self.clips = []
        bpy.context.scene.render.fps = FPS

    def reset(self):
        for bone in self.bones:
            bone.matrix_basis = Matrix.Identity(4)
            bone.rotation_mode = 'QUATERNION'
        bpy.context.view_layer.update()

    def point(self, name):
        return CI @ (self.arm.matrix_world @ self.bones[name].matrix).translation

    def offset(self, forward=0, up=0, left=0):
        return self.forward * forward + self.up * up + self.left * left

    def rotate(self, name, pitch=0, yaw=0, roll=0):
        """World anatomical rotation in degrees; positive pitch tips forward/down."""
        q = Quaternion(self.left, math.radians(pitch)) @ Quaternion(self.up, math.radians(yaw)) @ Quaternion(self.forward, math.radians(roll))
        self.rotate_world(name, q)

    def rotate_world(self, name, rotation):
        bone = self.bones[name]
        world = self.arm.matrix_world @ bone.matrix
        pivot = world.translation.copy()
        world = (C @ rotation.to_matrix().to_4x4() @ CI) @ world
        world.translation = pivot
        bone.matrix = self.arm.matrix_world.inverted() @ world
        bpy.context.view_layer.update()

    def translate(self, name, offset):
        bone = self.bones[name]
        world = self.arm.matrix_world @ bone.matrix
        world.translation += C.to_3x3() @ Vector(offset)
        bone.matrix = self.arm.matrix_world.inverted() @ world
        bpy.context.view_layer.update()

    def ik(self, chain, target, pole=None):
        """Rotation-only FABRIK, preserving every measured production bone length."""
        points = [self.point(name) for name in chain]
        lengths = [(b - a).length for a, b in zip(points, points[1:])]
        anchor = points[0].copy()
        target = Vector(target)
        if (target - anchor).length >= sum(lengths):
            direction = (target - anchor).normalized()
            for i, length in enumerate(lengths):
                points[i + 1] = points[i] + direction * length
        else:
            # Use the authored anatomical bend as the seed, not a straight singular chain.
            if pole is not None:
                for i in range(1, len(points) - 1):
                    points[i] += Vector(pole) * math.sin(math.pi * i / (len(points) - 1))
            for _ in range(20):
                points[-1] = target.copy()
                for i in range(len(points) - 2, -1, -1):
                    delta = points[i] - points[i + 1]
                    if delta.length > 1e-9:
                        points[i] = points[i + 1] + delta.normalized() * lengths[i]
                points[0] = anchor.copy()
                for i, length in enumerate(lengths):
                    delta = points[i + 1] - points[i]
                    if delta.length > 1e-9:
                        points[i + 1] = points[i] + delta.normalized() * length
                if (points[-1] - target).length < 1e-5:
                    break
        for i, name in enumerate(chain[:-1]):
            current = self.point(chain[i + 1]) - self.point(name)
            desired = points[i + 1] - points[i]
            if current.length > 1e-8 and desired.length > 1e-8:
                self.rotate_world(name, current.rotation_difference(desired))

    def sample_locals(self):
        desired = {}
        for joint in self.joints:
            name = self.nodes[joint]['name']
            pose = self.arm.matrix_world @ self.bones[name].matrix
            delta = CI @ pose @ self.bind[name].inverted() @ C
            desired[joint] = delta @ self.rest_world[joint]
        def world(index):
            if index in desired:
                return desired[index]
            return (world(self.parent[index]) if index in self.parent else Matrix.Identity(4)) @ self.rest_local[index]
        return {j: (world(self.parent[j]).inverted() if j in self.parent else Matrix.Identity(4)) @ desired[j] for j in self.joints}

    def bake(self, name, seconds, pose, markers=None):
        self.arm.animation_data_clear()
        frames = round(seconds * FPS)
        tracks = {j: {'rotation': [], 'translation': []} for j in self.joints}
        # Keep release/contact poses exact rather than interpolating across a fast claw/toe closure.
        phases = (markers or {}).values()
        if any(not isinstance(t, (int, float)) or not 0 <= t <= 1 for t in phases):
            raise ValueError(f'{name}: markers must be normalized phase fractions')
        samples = {round(i * seconds / frames, 9): i * seconds / frames for i in range(frames + 1)}
        samples.update({round(t * seconds, 9): t * seconds for t in phases})
        times = sorted(samples.values())
        for at in times:
            frame = at * FPS
            bpy.context.scene.frame_set(math.floor(frame), subframe=frame % 1)
            self.reset()
            pose(at / seconds, self)
            for joint, local in self.sample_locals().items():
                p, q, _ = local.decompose()
                rotation = [q.x, q.y, q.z, q.w]
                previous = tracks[joint]['rotation'][-1] if tracks[joint]['rotation'] else None
                if previous and sum(a * b for a, b in zip(previous, rotation)) < 0:
                    rotation = [-v for v in rotation]
                tracks[joint]['rotation'].append(rotation)
                tracks[joint]['translation'].append(list(p))
            for bone in self.bones:
                bone.keyframe_insert('location', frame=frame, group=bone.name)
                bone.keyframe_insert('rotation_quaternion', frame=frame, group=bone.name)
        action = self.arm.animation_data.action
        action.name = name
        action.use_fake_user = True
        channels = []
        for joint, paths in tracks.items():
            for path, values in paths.items():
                # Keep all rotations; translations are retained only when they differ from bind.
                rest = list(self.rest_local[joint].translation)
                if path == 'translation' and max(abs(v[k] - rest[k]) for v in values for k in range(3)) < 1e-5:
                    continue
                channels.append({'node': joint, 'name': self.nodes[joint]['name'], 'path': path, 'values': values})
        self.clips.append({'name': name, 'seconds': seconds, 'times': times, 'markers': markers or {}, 'channels': channels})
        print(f'BAKED {name}: {len(times)} samples including exact markers, {len(channels)} channels', flush=True)

    def save(self, output):
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        report = {'source': Path(self.source).relative_to(Path(__file__).resolve().parents[2]).as_posix(), 'sourceSha256': self.source_hash, 'blenderVersion': bpy.app.version_string, 'fps': FPS, 'height': self.height, 'forward': list(self.forward), 'clips': self.clips}
        output.write_text(json.dumps(report, separators=(',', ':')) + '\n')
        bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix('.blend')), check_existing=False)
        print(f'SAVED {output}', flush=True)
