#!/usr/bin/env python3
"""Offline, texture-only GLB derivative. Never writes the source or a manifest."""
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import math
from pathlib import Path
import struct
import sys

from PIL import Image, __version__ as PILLOW_VERSION

ROOT = Path(__file__).resolve().parents[2]
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
COLOR_SLOTS = {"baseColorTexture", "emissiveTexture", "diffuseTexture", "specularGlossinessTexture", "specularColorTexture", "sheenColorTexture", "diffuseTransmissionColorTexture"}
LINEAR_SLOTS = {"metallicRoughnessTexture", "occlusionTexture", "clearcoatTexture", "clearcoatRoughnessTexture", "transmissionTexture", "thicknessTexture", "sheenRoughnessTexture", "specularTexture", "anisotropyTexture", "iridescenceTexture", "iridescenceThicknessTexture", "diffuseTransmissionTexture"}
NORMAL_SLOTS = {"normalTexture", "clearcoatNormalTexture"}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_glb(data):
    if len(data) < 20 or struct.unpack_from("<III", data) != (0x46546C67, 2, len(data)):
        raise ValueError("Expected a complete glTF 2.0 binary GLB")
    chunks, offset = [], 12
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("Truncated GLB chunk header")
        length, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        if length % 4 or offset + length > len(data):
            raise ValueError("Invalid GLB chunk length/alignment")
        chunks.append((kind, data[offset:offset + length]))
        offset += length
    if [kind for kind, _ in chunks].count(JSON_CHUNK) != 1 or chunks[0][0] != JSON_CHUNK or [kind for kind, _ in chunks].count(BIN_CHUNK) != 1 or chunks[1][0] != BIN_CHUNK:
        raise ValueError("Requires one leading JSON chunk followed by one embedded BIN chunk")
    doc = json.loads(chunks[0][1])
    buffers = doc.get("buffers", [])
    if len(buffers) != 1 or "uri" in buffers[0]:
        raise ValueError("Missing prerequisite: consolidate external/multiple buffers into one embedded buffer")
    length = buffers[0]["byteLength"]
    if not isinstance(length, int) or length < 0 or not 0 <= len(chunks[1][1]) - length <= 3:
        raise ValueError("Embedded buffer byteLength does not match BIN chunk")
    for view in doc.get("bufferViews", []):
        start, size = view.get("byteOffset", 0), view.get("byteLength")
        if view.get("buffer") != 0 or not isinstance(start, int) or not isinstance(size, int) or start < 0 or size < 0 or start + size > length:
            raise ValueError("Invalid embedded bufferView range")
    return doc, chunks[1][1][:length], chunks[2:]


def write_glb(doc, binary, extra_chunks):
    encoded = json.dumps(doc, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\0" * (-len(binary) % 4)
    chunks = [(JSON_CHUNK, encoded), (BIN_CHUNK, binary), *extra_chunks]
    body = b"".join(struct.pack("<II", len(payload), kind) + payload for kind, payload in chunks)
    return struct.pack("<III", 0x46546C67, 2, len(body) + 12) + body


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def image_semantics(doc):
    usages = [set() for _ in doc.get("images", [])]
    textures = doc.get("textures", [])
    for material in doc.get("materials", []):
        for obj in walk(material):
            for slot, info in obj.items():
                if slot.endswith("Texture") and isinstance(info, dict) and "index" in info:
                    index = info["index"]
                    if not isinstance(index, int) or not 0 <= index < len(textures):
                        raise ValueError("Invalid material texture index")
                    source = textures[index].get("source")
                    if not isinstance(source, int) or not 0 <= source < len(usages):
                        raise ValueError("Missing prerequisite: embedded PNG/JPEG texture source")
                    if slot not in COLOR_SLOTS | LINEAR_SLOTS | NORMAL_SLOTS:
                        raise ValueError("Missing prerequisite: explicit color semantics for material texture slot " + slot)
                    usages[source].add("srgb" if slot in COLOR_SLOTS else "normal" if slot in NORMAL_SLOTS else "linear")
    for usage in usages:
        if len(usage) > 1:
            raise ValueError("Missing prerequisite: separate images shared between incompatible color/data/normal slots")
    return [next(iter(usage), "linear") for usage in usages]


def gpu_bytes(size):
    width, height = size
    base, mipmapped = width * height * 4, 0
    while True:
        mipmapped += width * height * 4
        if width == height == 1:
            return {"rgba8Base": base, "rgba8FullMipChain": mipmapped}
        width, height = max(1, width // 2), max(1, height // 2)


def resize_image(payload, mime, maximum, semantics):
    expected = {"image/png": "PNG", "image/jpeg": "JPEG"}.get(mime)
    if expected is None:
        raise ValueError("Missing prerequisite: decoder/encoder for embedded image MIME " + str(mime))
    with Image.open(io.BytesIO(payload)) as source:
        if source.format != expected or source.mode not in {"RGB", "RGBA", "L", "LA", "P"} or getattr(source, "n_frames", 1) != 1:
            raise ValueError("Missing prerequisite: matching single-frame 8-bit PNG/JPEG image")
        if expected == "PNG" and payload[24] != 8:
            raise ValueError("Missing prerequisite: explicit non-8-bit PNG conversion policy")
        before = source.size
        scale = min(1, maximum / max(before))
        after = tuple(max(1, int(dimension * scale + 0.5)) for dimension in before)
        mode = "RGBA" if "A" in source.mode or "transparency" in source.info else "RGB"
        image = source.convert(mode)
        if after != before:
            if semantics == "srgb":
                # glTF color RGB is sRGB, alpha and packed data channels are linear.
                lut = [v / 255 / 12.92 if v / 255 <= 0.04045 else ((v / 255 + 0.055) / 1.055) ** 2.4 for v in range(256)]
                channels = []
                for channel in image.split()[:3]:
                    linear = channel.point(lut, "F").resize(after, Image.Resampling.LANCZOS)
                    encoded = bytearray()
                    for value in linear.get_flattened_data():
                        value = max(0, min(1, value))
                        srgb = value * 12.92 if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055
                        encoded.append(int(srgb * 255 + 0.5))
                    channels.append(Image.frombytes("L", after, bytes(encoded)))
                if mode == "RGBA":
                    channels.append(image.getchannel("A").resize(after, Image.Resampling.LANCZOS))
                image = Image.merge(mode, channels)
            elif semantics == "normal":
                # Keep signed direction components in float until normalization.
                channels = [channel.convert("F").resize(after, Image.Resampling.LANCZOS) for channel in image.split()[:3]]
                stride = len(mode)
                pixels = bytearray(after[0] * after[1] * stride)
                values = [memoryview(channel.tobytes()).cast("f") for channel in channels]
                for index, components in enumerate(zip(*values)):
                    vector = [value / 127.5 - 1 for value in components]
                    length = math.sqrt(sum(value * value for value in vector))
                    vector = [value / length for value in vector] if length else [0, 0, 1]
                    for axis, value in enumerate(vector):
                        pixels[index * stride + axis] = max(0, min(255, int((value + 1) * 127.5 + 0.5)))
                if mode == "RGBA":
                    pixels[3::4] = image.getchannel("A").resize(after, Image.Resampling.LANCZOS).tobytes()
                image = Image.frombytes(mode, after, bytes(pixels))
            else:
                # Resize channels independently: alpha must not premultiply packed PBR data.
                image = Image.merge(mode, [channel.resize(after, Image.Resampling.LANCZOS) for channel in image.split()])
        output = io.BytesIO()
        if after == before:
            result = payload  # No avoidable lossy JPEG generation or metadata changes.
        else:
            image.save(output, format=expected, **({"quality": 95, "subsampling": 0, "optimize": False, "progressive": False} if expected == "JPEG" else {"compress_level": 9, "optimize": False}))
            result = output.getvalue()
        return result, {"before": {"dimensions": list(before), "encodedBytes": len(payload), "decodedGpuBytesEstimate": gpu_bytes(before)}, "after": {"dimensions": list(after), "encodedBytes": len(result), "decodedGpuBytesEstimate": gpu_bytes(after)}, "semantics": semantics, "mimeType": mime}


def derive(data, maximum=2048):
    if not isinstance(maximum, int) or maximum < 1:
        raise ValueError("max dimension must be a positive integer")
    original, binary, extra = read_glb(data)
    doc = copy.deepcopy(original)  # Preserve every field, not a mesh-only exporter whitelist.
    for parent in walk(doc):
        for obj in walk(parent.get("extensions", {})):
            if "buffer" in obj or "byteOffset" in obj:
                raise ValueError("Missing prerequisite: relocation policy for extension-owned binary offsets")
    for texture in doc.get("textures", []):
        if "KHR_texture_basisu" in texture.get("extensions", {}) or "EXT_texture_webp" in texture.get("extensions", {}) or "EXT_texture_avif" in texture.get("extensions", {}):
            raise ValueError("Missing prerequisite: compressed/alternate texture decoder and encoder")
    images, views = doc.get("images", []), doc.get("bufferViews", [])
    image_views = set()
    for image in images:
        if "uri" in image or not isinstance(image.get("bufferView"), int) or not 0 <= image["bufferView"] < len(views):
            raise ValueError("Missing prerequisite: embed every external image as a PNG/JPEG bufferView")
        image_views.add(image["bufferView"])
    outside_images = {key: value for key, value in doc.items() if key != "images"}
    referenced = {obj["bufferView"] for obj in walk(outside_images) if "bufferView" in obj}
    retained = set(range(len(views))) - image_views | referenced
    if any(not isinstance(index, int) or not 0 <= index < len(views) for index in retained):
        raise ValueError("Invalid non-image bufferView reference")
    # Merge overlapping ranges so aliased/interleaved data retains shared byte layout.
    ranges = sorted((views[index].get("byteOffset", 0), views[index].get("byteOffset", 0) + views[index]["byteLength"]) for index in retained)
    groups = []
    for start, end in ranges:
        if groups and start <= groups[-1][1]:
            groups[-1][1] = max(end, groups[-1][1])
        else:
            groups.append([start, end])
    rebuilt, mappings = bytearray(), []
    for start, end in groups:
        rebuilt.extend(b"\0" * ((start - len(rebuilt)) % 4))
        mappings.append((start, end, len(rebuilt)))
        rebuilt.extend(binary[start:end])
    for index in retained:
        start = views[index].get("byteOffset", 0)
        end = start + views[index]["byteLength"]
        group = next((group for group in mappings if group[0] <= start and end <= group[1]), None)
        if group is None:
            raise ValueError("Non-image range was not preserved")
        views[index]["byteOffset"] = group[2] + start - group[0]
    records, encoded_views = [], {}
    for index, (image, semantics) in enumerate(zip(images, image_semantics(doc))):
        old_index = image["bufferView"]
        old = original["bufferViews"][old_index]
        start = old.get("byteOffset", 0)
        payload = binary[start:start + old["byteLength"]]
        encoded, record = resize_image(payload, image.get("mimeType"), maximum, semantics)
        key = (old_index, image.get("mimeType"), semantics)
        if key in encoded_views:
            image["bufferView"] = encoded_views[key]
        else:
            rebuilt.extend(b"\0" * (-len(rebuilt) % 4))
            replacement = copy.deepcopy(old)
            replacement.update(byteOffset=len(rebuilt), byteLength=len(encoded))
            if old_index in retained or old_index in encoded_views.values():
                image["bufferView"] = len(views)
                views.append(replacement)
            else:
                views[old_index] = replacement
            encoded_views[key] = image["bufferView"]
            rebuilt.extend(encoded)
        records.append({"image": index, "sourceBufferView": old_index, "outputBufferView": image["bufferView"], **record})
    doc["buffers"][0]["byteLength"] = len(rebuilt)
    output = write_glb(doc, bytes(rebuilt), extra)
    persisted, persisted_binary, persisted_extra = read_glb(output)
    parity = {name: original.get(name) == persisted.get(name) for name in ("meshes", "accessors", "nodes", "skins", "animations", "materials", "textures", "samplers", "scenes")}
    parity["nonImageBufferViewBytes"] = all(binary[original["bufferViews"][i].get("byteOffset", 0):original["bufferViews"][i].get("byteOffset", 0) + original["bufferViews"][i]["byteLength"]] == persisted_binary[persisted["bufferViews"][i].get("byteOffset", 0):persisted["bufferViews"][i].get("byteOffset", 0) + persisted["bufferViews"][i]["byteLength"]] for i in retained)
    expected = copy.deepcopy(original)
    expected["buffers"][0]["byteLength"] = persisted["buffers"][0]["byteLength"]
    expected["bufferViews"] = copy.deepcopy(persisted["bufferViews"])
    for i, image in enumerate(expected.get("images", [])):
        image["bufferView"] = persisted["images"][i]["bufferView"]
    parity["allOtherJsonFields"] = expected == persisted
    parity["extraChunks"] = extra == persisted_extra
    for i, old in enumerate(original.get("bufferViews", [])):
        normalized = copy.deepcopy(persisted["bufferViews"][i])
        for field in ("byteOffset", "byteLength"):
            normalized.pop(field, None)
        baseline = {key: value for key, value in old.items() if key not in {"byteOffset", "byteLength"}}
        if normalized != baseline or (i in retained and persisted["bufferViews"][i]["byteLength"] != old["byteLength"]):
            raise ValueError("bufferView structure changed beyond image range relocation")
    if not all(parity.values()):
        raise ValueError("Source/output geometry, rig or document parity failed")
    report = {"schemaVersion": 1, "operation": "offline-texture-only-derivative", "maxDimension": maximum, "tool": {"path": "scripts/assets/derive-texture-budget.py", "pillowVersion": PILLOW_VERSION}, "source": {"sha256": sha256(data), "bytes": len(data)}, "output": {"sha256": sha256(output), "bytes": len(output)}, "images": records, "parity": parity, "counts": {name: len(original.get(name, [])) for name in ("meshes", "accessors", "nodes", "skins", "animations")}, "nonImageBufferViewsPreserved": len(retained), "providerDispatch": False, "modelReady": False, "runtimeManifestUpdated": False, "productionAcceptance": "NOT_ESTABLISHED", "limitations": ["Geometry is frozen, including source high-poly counts; no triangle/LOD budget pass.", "Decoded GPU bytes are RGBA8 estimates, not measured VRAM or performance.", "Source rig/animation quality is unchanged, not accepted by this operation.", "Culling, LODs, runtime visual review and locked-hardware profiling remain open."]}
    report["tool"].update(algorithmRevision=2, scriptSha256=sha256(Path(__file__).read_bytes()))
    for phase in ("before", "after"):
        report[phase + "DecodedGpuBytesEstimate"] = {key: sum(record[phase]["decodedGpuBytesEstimate"][key] for record in records) for key in ("rgba8Base", "rgba8FullMipChain")}
    return output, report


def portable_path(path):
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.name  # Never persist machine-local absolute paths or signed URLs.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-dimension", type=int, default=2048)
    args = parser.parse_args()
    provenance = args.output.with_suffix(".provenance.json")
    if (args.source.resolve() == args.output.resolve()
            or args.output.exists() or args.output.is_symlink()
            or provenance.exists() or provenance.is_symlink()
            or args.source.resolve() == provenance.resolve()):
        parser.error("Never overwrite the input, an existing output or provenance")
    source = args.source.read_bytes()
    output, report = derive(source, args.max_dimension)
    report["source"]["path"] = portable_path(args.source)
    report["output"]["path"] = portable_path(args.output)
    if args.source.read_bytes() != source:
        raise ValueError("Input changed during derivation")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    created = []
    published = False
    try:
        with args.output.open("xb") as file:
            created.append(args.output)
            file.write(output)
        with provenance.open("x", encoding="utf-8") as file:
            created.append(provenance)
            json.dump(report, file, indent=2, allow_nan=False)
            file.write("\n")
        published = True
    finally:
        if not published:
            for path in reversed(created):
                path.unlink(missing_ok=True)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print("Texture derivative refused: " + str(error), file=sys.stderr)
        sys.exit(1)
