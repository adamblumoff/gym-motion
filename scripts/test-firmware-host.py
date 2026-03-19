from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "out" / "firmware-host-tests"


def find_compiler() -> str:
    candidates = []
    preferred = os.environ.get("CXX")
    if preferred:
        candidates.append(preferred)
    candidates.extend(["g++", "clang++", "c++"])
    if os.name == "nt":
        candidates.extend(
            [
                r"C:\Program Files\LLVM\bin\clang++.exe",
            ]
        )

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
        if os.path.isfile(candidate):
            return candidate

    raise SystemExit(
        "No C++ compiler found for firmware host tests. Set CXX or install g++/clang++."
    )


def main() -> int:
    compiler = find_compiler()
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    output = BUILD_DIR / ("firmware-host-tests.exe" if os.name == "nt" else "firmware-host-tests")

    command = [
        compiler,
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-pedantic",
        "-I",
        str(ROOT / "firmware"),
        "-I",
        str(ROOT / "firmware" / "third_party"),
        str(ROOT / "firmware" / "runtime_host_protocol.cpp"),
        str(ROOT / "firmware" / "host_tests" / "runtime_host_protocol.test.cpp"),
        "-o",
        str(output),
    ]

    subprocess.run(command, check=True)
    subprocess.run([str(output)], check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
