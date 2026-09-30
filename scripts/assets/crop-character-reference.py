#!/usr/bin/env python3
"""Create isolated, hash-attributed input crops from approved Wild Crown character plates.

This script only reads local concept plates. It does not call any provider.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "asset-source" / "references"
SOURCES = {
    "aren": ("docs/production/visual-review/plates/C01.png", (20, 35, 430, 960)),
    "asha": ("docs/production/visual-review/plates/C02.png", (105, 515, 755, 1030)),
}
EXPECTED_SIZE = (1536, 1100)

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
records = []
for asset_id, (relative_source, crop_box) in SOURCES.items():
    source = ROOT / relative_source
    source_bytes = source.read_bytes()
    with Image.open(source) as image:
        if image.size != EXPECTED_SIZE:
            raise ValueError(f"{relative_source}: expected {EXPECTED_SIZE}, got {image.size}")
        crop = image.convert("RGB").crop(crop_box)
        destination = OUT / f"{asset_id}-approved-concept.png"
        crop.save(destination, format="PNG", optimize=True)
    output_bytes = destination.read_bytes()
    records.append({
        "assetId": asset_id,
        "source": relative_source,
        "sourceSha256": sha256(source_bytes),
        "cropBoxPixels": list(crop_box),
        "dimensions": list(crop.size),
        "output": destination.relative_to(ROOT).as_posix(),
        "outputSha256": sha256(output_bytes),
        "providerDispatch": False,
        "modelReady": False,
    })
manifest = {"schemaVersion": 1, "sourceStatus": "approved-concept-crop-not-model", "references": records}
manifest_path = OUT / "reference-manifest.json"
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest, indent=2))
