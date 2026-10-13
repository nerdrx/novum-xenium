#!/usr/bin/env python3
"""Collect license and notice files shipped in the Go module cache."""

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "android/app/src/main/assets/third-party-go-notices.txt"
def is_notice(name):
    name = name.lower()
    return any(
        name == stem or name.startswith((stem + ".", stem + "-"))
        for stem in ("license", "copying", "notice")
    ) or name in {
        "copyright",
        "patents",
    }


def modules():
    raw = subprocess.check_output(["go", "list", "-m", "-json", "all"], text=True)
    decoder = json.JSONDecoder()
    result = []
    offset = 0
    while offset < len(raw):
        while offset < len(raw) and raw[offset].isspace():
            offset += 1
        if offset == len(raw):
            break
        module, offset = decoder.raw_decode(raw, offset)
        result.append(module)
    return result


def main():
    blocks = [
        "Third-party Go license and notice files as distributed with module cache.",
        "This collection is informational and is not a legal license audit.",
    ]
    for module in modules():
        if not module.get("Dir"):
            continue
        module_dir = Path(module["Dir"])
        if not module_dir.is_dir():
            continue
        files = sorted(
            path
            for path in module_dir.iterdir()
            if path.is_file() and is_notice(path.name)
        )
        blocks.append(f"\n\n===== {module['Path']} {module.get('Version', '')} =====")
        if not files:
            blocks.append("No root-level license or notice file found in module cache.")
            continue
        for path in files:
            blocks.append(f"\n--- {path.name} ---\n")
            blocks.append(path.read_text(encoding="utf-8", errors="replace"))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(blocks).rstrip() + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
