#!/usr/bin/env python3
"""Cross-platform config bootstrap script for DeerFlow."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


def copy_if_missing(src: Path, dst: Path) -> None:
    if dst.exists():
        return
    if not src.exists():
        raise FileNotFoundError(f"Missing template file: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def main() -> int:
    project_root = Path(__file__).resolve().parent.parent

    existing_config = [
        project_root / "config",
    ]

    if any(path.exists() for path in existing_config):
        print(
            "Error: configuration file already exists "
            "(config/). Aborting."
        )
        return 1

    try:
        if not (project_root / "config.example").is_dir():
            raise FileNotFoundError(f"Missing template directory: {project_root / 'config.example'}")
        shutil.copytree(project_root / "config.example", project_root / "config")
        copy_if_missing(project_root / ".env.example", project_root / ".env")
        copy_if_missing(
            project_root / "frontend" / ".env.example",
            project_root / "frontend" / ".env",
        )
    except (FileNotFoundError, OSError) as exc:
        print("Error while generating configuration files:")
        print(f"  {exc}")
        if isinstance(exc, PermissionError):
            print(
                "Hint: Check file permissions and ensure the files are not "
                "read-only or locked by another process."
            )
        return 1

    print("✓ Configuration files generated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
