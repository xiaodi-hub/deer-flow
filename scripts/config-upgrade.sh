#!/usr/bin/env bash
#
# config-upgrade.sh - Upgrade split config/ from config.example/

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${DEER_FLOW_CONFIG_DIR:-$REPO_ROOT/config}"
EXAMPLE_DIR="$REPO_ROOT/config.example"

if [ ! -d "$EXAMPLE_DIR" ]; then
    echo "✗ config.example/ not found at $EXAMPLE_DIR"
    exit 1
fi

if [ ! -d "$CONFIG_DIR" ]; then
    echo "No config/ directory found — creating from config.example/..."
    mkdir -p "$(dirname "$CONFIG_DIR")"
    cp -R "$EXAMPLE_DIR" "$CONFIG_DIR"
    echo "OK config/ created. Please review and set your API keys."
    exit 0
fi

cd "$REPO_ROOT/backend" && CONFIG_DIR_PATH="$CONFIG_DIR" EXAMPLE_DIR_PATH="$EXAMPLE_DIR" uv run python - <<'PY'
import copy
import os
import shutil
from pathlib import Path

import yaml

config_dir = Path(os.environ["CONFIG_DIR_PATH"])
example_dir = Path(os.environ["EXAMPLE_DIR_PATH"])

backup = config_dir.with_name(config_dir.name + ".bak")
if backup.exists():
    shutil.rmtree(backup)
shutil.copytree(config_dir, backup)
print(f"Backed up to {backup}")


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return data


def merge(target: dict, source: dict, path: str = "") -> list[str]:
    added: list[str] = []
    for key, value in source.items():
        key_path = f"{path}.{key}" if path else key
        if key not in target:
            target[key] = copy.deepcopy(value)
            added.append(key_path)
        elif isinstance(value, dict) and isinstance(target[key], dict):
            added.extend(merge(target[key], value, key_path))
    return added


all_added: list[str] = []
for example_file in sorted(example_dir.glob("*.yaml")):
    target_file = config_dir / example_file.name
    example_data = load(example_file)
    target_data = load(target_file)
    if not target_file.exists():
        shutil.copy2(example_file, target_file)
        all_added.append(example_file.name)
        continue
    added = merge(target_data, example_data)
    if example_file.name == "app.yaml" and "config_version" in example_data:
        target_data["config_version"] = example_data["config_version"]
    if added or example_file.name == "app.yaml":
        target_file.write_text(
            yaml.safe_dump(target_data, default_flow_style=False, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
    all_added.extend(f"{example_file.name}:{item}" for item in added)

if all_added:
    print(f"Added {len(all_added)} field/file item(s):")
    for item in all_added:
        print(f"  + {item}")
else:
    print("OK config/ is already up to date.")
PY
