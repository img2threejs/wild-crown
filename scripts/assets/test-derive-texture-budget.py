#!/usr/bin/env python3
"""Behavior regressions, not production asset acceptance."""
import copy
import importlib.util
import io
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

SCRIPT = Path(__file__).with_name("derive-texture-budget.py")
spec = importlib.util.spec_from_file_location("texture_budget", SCRIPT)
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


def fixture():
    image = Image.new("RGBA", (80, 40), (220, 110, 30, 100))
    file = io.BytesIO()
    image.save(file, format="PNG")
    png = file.getvalue()
    file = io.BytesIO()
    image.convert("RGB").save(file, format="JPEG")
    jpeg = file.getvalue()
    binary = bytearray(b"\x11\x22\x33\x44")
    views = []

    def add(payload, **fields):
        binary.extend(b"\0" * (-len(binary) % 4))
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload), **fields})
        binary.extend(payload)
        return len(views) - 1

    add(struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0), target=34962, extras={"preserve": True})
    add(png, extras={"authored": "shared-image-view"})
    add(struct.pack("<3H", 0, 1, 2), target=34963)
    add(struct.pack("<32f", 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1))
    add(struct.pack("<2f6f", 0, 1, 0, 0, 0, 1, 0, 0))
    add(jpeg)
    # Alias a non-image subset of the original PNG bytes. It must never become resized pixels.
    views.append({"buffer": 0, "byteOffset": views[1]["byteOffset"] + 4, "byteLength": 8, "extras": {"alias": True}})
    doc = {"asset": {"version": "2.0", "extras": {"authoredPolicy": "keep"}}, "buffers": [{"byteLength": len(binary), "extras": {"keep": 1}}], "bufferViews": views,
           "images": [{"bufferView": 1, "mimeType": "image/png", "extras": {"keep": True}}, {"bufferView": 1, "mimeType": "image/png"}, {"bufferView": 5, "mimeType": "image/jpeg"}],
           "textures": [{"source": 0, "sampler": 0}, {"source": 1, "sampler": 0}, {"source": 2, "sampler": 0}], "samplers": [{"wrapS": 33071, "wrapT": 33648}],
           "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicRoughnessTexture": {"index": 1}}, "normalTexture": {"index": 2}}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]}, {"bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR"}, {"bufferView": 3, "componentType": 5126, "count": 1, "type": "MAT4"}, {"bufferView": 4, "componentType": 5126, "count": 2, "type": "SCALAR"}, {"bufferView": 4, "byteOffset": 8, "componentType": 5126, "count": 2, "type": "VEC3"}],
           "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0, "extras": {"keep": "primitive"}}]}], "nodes": [{"mesh": 0, "skin": 0, "children": [1]}, {"name": "root"}], "skins": [{"joints": [1], "skeleton": 1, "inverseBindMatrices": 2}], "animations": [{"name": "authored", "samplers": [{"input": 3, "output": 4, "interpolation": "LINEAR"}], "channels": [{"sampler": 0, "target": {"node": 1, "path": "translation"}}]}], "scenes": [{"nodes": [0]}], "scene": 0, "extensions": {"VENDOR_custom": {"unknownField": [1, "preserve"]}}}
    doc["accessors"].append({"bufferView": 1, "componentType": 5121, "count": 8, "type": "SCALAR"})
    joints_view = add(struct.pack("<12B", *([0, 1, 0, 0] * 3)), target=34962)
    weights_view = add(struct.pack("<12f", 1, 0, 0, 0, 0.25, 0.75, 0, 0, 0, 1, 0, 0), target=34962)
    tip_animation_view = add(struct.pack("<6f", 0, 1, 0, 0, 3, 0))
    doc["buffers"][0]["byteLength"] = len(binary)
    doc["accessors"][2]["count"] = 2
    doc["accessors"][3].update(min=[0], max=[1])
    doc["accessors"].extend([
        {"bufferView": joints_view, "componentType": 5121, "count": 3, "type": "VEC4"},
        {"bufferView": weights_view, "componentType": 5126, "count": 3, "type": "VEC4"},
        {"bufferView": tip_animation_view, "componentType": 5126, "count": 2, "type": "VEC3"},
    ])
    doc["meshes"][0]["primitives"][0]["attributes"].update(JOINTS_0=6, WEIGHTS_0=7)
    doc["nodes"][1]["children"] = [2]
    doc["nodes"].append({"name": "tip", "translation": [0, 1, 0]})
    doc["skins"][0]["joints"] = [1, 2]
    doc["animations"][0]["samplers"].append({"input": 3, "output": 8, "interpolation": "LINEAR"})
    doc["animations"][0]["channels"].append({"sampler": 1, "target": {"node": 2, "path": "translation"}})
    return budget.write_glb(doc, bytes(binary), [(0x12345678, b"abcd")])


def accessor_values(doc, binary, index):
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4, "MAT4": 16}[accessor["type"]]
    code = {5121: "B", 5123: "H", 5126: "f"}[accessor["componentType"]]
    size = struct.calcsize("<" + code * width)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return [struct.unpack_from("<" + code * width, binary, start + row * view.get("byteStride", size)) for row in range(accessor["count"])]


def sample_bound_vertices(data, time):
    """Evaluate this fixture's real linear translation tracks and native skin bindings."""
    doc, binary, _ = budget.read_glb(data)
    mesh_node = next(node for node in doc["nodes"] if "mesh" in node)
    skin = doc["skins"][mesh_node["skin"]]
    primitive = doc["meshes"][mesh_node["mesh"]]["primitives"][0]
    attributes = primitive["attributes"]
    positions = accessor_values(doc, binary, attributes["POSITION"])
    joints = accessor_values(doc, binary, attributes["JOINTS_0"])
    weights = accessor_values(doc, binary, attributes["WEIGHTS_0"])
    inverse_binds = accessor_values(doc, binary, skin["inverseBindMatrices"])
    translations = [list(node.get("translation", [0, 0, 0])) for node in doc["nodes"]]
    clip = doc["animations"][0]
    for channel in clip["channels"]:
        assert channel["target"]["path"] == "translation"
        sampler = clip["samplers"][channel["sampler"]]
        assert sampler["interpolation"] == "LINEAR"
        times = [row[0] for row in accessor_values(doc, binary, sampler["input"])]
        values = accessor_values(doc, binary, sampler["output"])
        fraction = max(0, min(1, (time - times[0]) / (times[1] - times[0])))
        translations[channel["target"]["node"]] = [a + (b - a) * fraction for a, b in zip(values[0], values[1])]
    parents = {child: index for index, node in enumerate(doc["nodes"]) for child in node.get("children", [])}

    def world_translation(node):
        local = translations[node]
        return [a + b for a, b in zip(local, world_translation(parents[node]))] if node in parents else local

    result = []
    for position, influence_joints, influence_weights in zip(positions, joints, weights):
        assert abs(sum(influence_weights) - 1) < 1e-6
        deformed = [0.0, 0.0, 0.0]
        for joint, weight in zip(influence_joints, influence_weights):
            assert 0 <= joint < len(skin["joints"])
            matrix = inverse_binds[joint]
            bound = [sum(matrix[column * 4 + row] * position[column] for column in range(3)) + matrix[12 + row] for row in range(3)]
            world = world_translation(skin["joints"][joint])
            for axis in range(3):
                deformed[axis] += weight * (bound[axis] + world[axis])
        result.append(tuple(deformed))
    return result


class TextureBudgetTests(unittest.TestCase):
    def test_normal_direction_survives_cancelling_components(self):
        image = Image.new("RGB", (2, 1))
        image.putdata([(255, 128, 128), (0, 127, 128)])
        file = io.BytesIO()
        image.save(file, format="PNG")
        output, _ = budget.resize_image(file.getvalue(), "image/png", 1, "normal")
        with Image.open(io.BytesIO(output)) as decoded:
            pixel = decoded.getpixel((0, 0))
        self.assertEqual(pixel, (128, 128, 255))
        vector = [value / 127.5 - 1 for value in pixel]
        cosine = vector[2] / math.sqrt(sum(value * value for value in vector))
        self.assertLess(math.degrees(math.acos(cosine)), 0.5)

    def test_extension_texture_semantics_and_unknown_slots(self):
        image = Image.new("RGB", (2, 1))
        image.putdata([(0, 0, 0), (255, 255, 255)])
        file = io.BytesIO()
        image.save(file, format="PNG")
        payload = file.getvalue()
        for slot, expected in (("diffuseTransmissionColorTexture", 188), ("diffuseTransmissionTexture", 128)):
            doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(payload)}], "bufferViews": [{"buffer": 0, "byteLength": len(payload)}], "images": [{"bufferView": 0, "mimeType": "image/png"}], "textures": [{"source": 0}], "materials": [{"extensions": {"KHR_materials_diffuse_transmission": {slot: {"index": 0}}}}]}
            output, _ = budget.derive(budget.write_glb(doc, payload, []), 1)
            result, binary, _ = budget.read_glb(output)
            view = result["bufferViews"][result["images"][0]["bufferView"]]
            with Image.open(io.BytesIO(binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]])) as decoded:
                self.assertEqual(decoded.getpixel((0, 0)), (expected,) * 3, slot)
        for slot in ("unknownColorTexture", "unknownNormalTexture", "unknownTexture"):
            doc["materials"] = [{"extensions": {"VENDOR_unknown": {slot: {"index": 0}}}}]
            with self.subTest(slot=slot), self.assertRaisesRegex(ValueError, "explicit color semantics"):
                budget.derive(budget.write_glb(doc, payload, []), 1)

    def test_bound_native_vertices_deform_identically_after_derivation(self):
        source = fixture()
        output, _ = budget.derive(source, 32)
        for time in (0, 0.25, 0.5, 0.75, 1):
            expected = [(time, 0, 0), (1 + time, 1.5 * time, 0), (time, 1 + 2 * time, 0)]
            self.assertEqual(sample_bound_vertices(source, time), expected)
            self.assertEqual(sample_bound_vertices(output, time), expected)
        doc, binary, extra = budget.read_glb(output)
        weights = doc["accessors"][doc["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_0"]]
        view = doc["bufferViews"][weights["bufferView"]]
        changed = bytearray(binary)
        struct.pack_into("<4f", changed, view["byteOffset"] + 16, 0.75, 0.25, 0, 0)
        corrupted = budget.write_glb(doc, bytes(changed), extra)
        self.assertEqual(sample_bound_vertices(corrupted, 0.5)[1], (1.5, 0.25, 0))
        self.assertNotEqual(sample_bound_vertices(output, 0.5)[1], sample_bound_vertices(corrupted, 0.5)[1])

    def test_mixed_shared_views_alignment_and_native_rig_channels(self):
        source = fixture()
        original, original_bin, original_extra = budget.read_glb(source)
        output, report = budget.derive(source, 32)
        doc, binary, extra = budget.read_glb(output)
        self.assertEqual(source, fixture())
        for name in ("accessors", "meshes", "nodes", "skins", "animations", "materials", "textures", "samplers", "extensions", "asset"):
            self.assertEqual(doc[name], original[name], name)
        for index in (0, 1, 2, 3, 4, 6, 7, 8, 9):
            before, after = original["bufferViews"][index], doc["bufferViews"][index]
            self.assertEqual(original_bin[before["byteOffset"]:before["byteOffset"] + before["byteLength"]], binary[after["byteOffset"]:after["byteOffset"] + after["byteLength"]])
            self.assertEqual(after["byteOffset"] % 4, before["byteOffset"] % 4)
        self.assertEqual(doc["bufferViews"][6]["byteOffset"] - doc["bufferViews"][1]["byteOffset"], 4)
        self.assertNotEqual(doc["images"][0]["bufferView"], 1)
        self.assertNotEqual(doc["images"][0]["bufferView"], doc["images"][1]["bufferView"])
        for image in doc["images"]:
            view = doc["bufferViews"][image["bufferView"]]
            self.assertEqual(view["byteOffset"] % 4, 0)
            with Image.open(io.BytesIO(binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]])) as decoded:
                self.assertEqual(decoded.size, (32, 16))
                self.assertEqual(decoded.format, "PNG" if image["mimeType"] == "image/png" else "JPEG")
        self.assertEqual(extra, original_extra)
        self.assertTrue(all(report["parity"].values()))
        self.assertEqual(report["afterDecodedGpuBytesEstimate"]["rgba8Base"], 3 * 32 * 16 * 4)
        self.assertEqual(output, budget.derive(source, 32)[0])

    def test_shared_image_duplicate_and_unresized_jpeg_remain_exact(self):
        original, binary, extras = budget.read_glb(fixture())
        del original["materials"][0]["pbrMetallicRoughness"]["metallicRoughnessTexture"]
        original["materials"][0]["emissiveTexture"] = {"index": 1}
        source = budget.write_glb(original, binary, extras)
        output, _ = budget.derive(source, 2048)
        doc, after, _ = budget.read_glb(output)
        self.assertEqual(doc["images"][0]["bufferView"], doc["images"][1]["bufferView"])
        for index, image in enumerate(doc["images"]):
            old = original["bufferViews"][original["images"][index]["bufferView"]]
            new = doc["bufferViews"][image["bufferView"]]
            self.assertEqual(binary[old["byteOffset"]:old["byteOffset"] + old["byteLength"]], after[new["byteOffset"]:new["byteOffset"] + new["byteLength"]])

    def test_srgb_and_linear_data_are_not_filtered_in_same_color_space(self):
        file = io.BytesIO()
        image = Image.new("RGB", (2, 1))
        image.putdata([(0, 0, 0), (255, 255, 255)])
        image.save(file, format="PNG")
        color, _ = budget.resize_image(file.getvalue(), "image/png", 1, "srgb")
        data, _ = budget.resize_image(file.getvalue(), "image/png", 1, "linear")
        with Image.open(io.BytesIO(color)) as decoded:
            self.assertEqual(decoded.getpixel((0, 0)), (188, 188, 188))
        with Image.open(io.BytesIO(data)) as decoded:
            self.assertEqual(decoded.getpixel((0, 0)), (128, 128, 128))

    def test_normal_vectors_are_renormalized_and_alpha_kept(self):
        image = Image.new("RGBA", (2, 1))
        image.putdata([(255, 128, 128, 60), (128, 255, 128, 60)])
        file = io.BytesIO()
        image.save(file, format="PNG")
        output, _ = budget.resize_image(file.getvalue(), "image/png", 1, "normal")
        with Image.open(io.BytesIO(output)) as decoded:
            r, g, b, alpha = decoded.getpixel((0, 0))
            self.assertEqual(alpha, 60)
            self.assertAlmostEqual(sum((value / 127.5 - 1) ** 2 for value in (r, g, b)), 1, delta=0.02)

    def test_unsupported_inputs_fail_closed(self):
        doc, binary, extra = budget.read_glb(fixture())
        mutations = [lambda d: d["images"][0].update(uri="https://example.invalid/image.png"), lambda d: d["images"][0].update(mimeType="image/ktx2"), lambda d: d["textures"][0].update(extensions={"KHR_texture_basisu": {"source": 0}}), lambda d: d["bufferViews"][0].update(extensions={"EXT_meshopt_compression": {"buffer": 0, "byteOffset": 0}}), lambda d: d["materials"][0]["pbrMetallicRoughness"].update(metallicRoughnessTexture={"index": 0})]
        for mutation in mutations:
            changed = copy.deepcopy(doc)
            mutation(changed)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, "Missing prerequisite"):
                budget.derive(budget.write_glb(changed, binary, extra))
        with self.assertRaises(ValueError):
            budget.derive(fixture()[:-1])

    def test_cli_input_immutability_and_existing_output_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory) / "source.glb", Path(directory) / "out.glb"
            source.write_bytes(fixture())
            command = [sys.executable, str(SCRIPT), str(source), str(destination), "--max-dimension", "32"]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(source.read_bytes(), fixture())
            saved = destination.read_bytes()
            report = json.loads(destination.with_suffix(".provenance.json").read_text())
            self.assertEqual(report["source"]["sha256"], budget.sha256(source.read_bytes()))
            self.assertEqual(report["output"]["sha256"], budget.sha256(saved))
            self.assertNotIn(directory, json.dumps(report))
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(destination.read_bytes(), saved)
            same = [sys.executable, str(SCRIPT), str(source), str(source)]
            self.assertNotEqual(subprocess.run(same, capture_output=True).returncode, 0)
            self.assertEqual(source.read_bytes(), fixture())

    def test_cli_rejects_dangling_provenance_without_orphan_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory) / "source.glb", Path(directory) / "out.glb"
            source.write_bytes(fixture())
            provenance = destination.with_suffix(".provenance.json")
            provenance.symlink_to(Path(directory) / "missing-provenance.json")
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(source), str(destination)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(destination.exists())
            self.assertTrue(provenance.is_symlink())
            self.assertEqual(source.read_bytes(), fixture())

    def test_cli_removes_created_pair_when_provenance_write_fails(self):
        try:
            import resource
            import signal
        except ImportError:
            self.skipTest("Requires POSIX file-size limits")
        doc, binary, extra = budget.read_glb(fixture())
        doc["images"].extend(copy.deepcopy(doc["images"][0]) for _ in range(16))
        source_bytes = budget.write_glb(doc, binary, extra)
        output_bytes, report = budget.derive(source_bytes, 32)
        limit = len(output_bytes) + 16
        self.assertGreater(len(json.dumps(report, indent=2)), limit)

        def limit_files():
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))

        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory) / "source.glb", Path(directory) / "out.glb"
            source.write_bytes(source_bytes)
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(source), str(destination), "--max-dimension", "32"], capture_output=True, preexec_fn=limit_files)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_suffix(".provenance.json").exists())
            self.assertEqual(source.read_bytes(), source_bytes)

if __name__ == "__main__":
    unittest.main(verbosity=2)
