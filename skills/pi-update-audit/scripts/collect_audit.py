# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
CORE_PACKAGE = "@earendil-works/pi-coding-agent"
MAX_COMMITS = 100
MAX_CHANGED_FILES = 300


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(command: list[str], cwd: Path | None = None, timeout: int = 60) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return {
            "ok": result.returncode == 0,
            "code": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except FileNotFoundError:
        return {"ok": False, "code": 127, "stdout": "", "stderr": f"Command not found: {command[0]}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "code": 124, "stdout": "", "stderr": f"Timed out: {' '.join(command)}"}


def warning(stage: str, message: str, source: str | None = None) -> dict[str, str]:
    result = {"stage": stage, "message": message}
    if source:
        result["source"] = source
    return result


def default_state_file() -> Path:
    root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return root / "pi-update-audit" / "state.json"


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema": SCHEMA_VERSION, "last_accepted": None, "pending_before": None}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read audit state {path}: {exc}") from exc
    if data.get("schema") != SCHEMA_VERSION:
        raise RuntimeError(f"Unsupported audit state schema in {path}: {data.get('schema')}")
    return data


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def parse_pi_list(output: str) -> list[dict[str, Any]]:
    packages: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in output.splitlines():
        if line.startswith("  ") and not line.startswith("    "):
            label = line.strip()
            filtered = label.endswith(" (filtered)")
            source = label.removesuffix(" (filtered)")
            current = {"source": source, "filtered": filtered}
        elif line.startswith("    ") and current:
            current["path"] = line.strip()
            packages.append(current)
            current = None
    return packages


def git_output(path: Path, args: list[str], timeout: int = 60) -> dict[str, Any]:
    return run(["git", *args], cwd=path, timeout=timeout)


def resolve_git_ref(path: Path, candidates: list[str]) -> str | None:
    for candidate in candidates:
        result = git_output(path, ["rev-parse", "--verify", candidate])
        if result["ok"]:
            return candidate
    return None


def configured_git_ref(source: str) -> str | None:
    match = re.search(r"@([^/@:]+)$", source)
    return match.group(1) if match else None


def remote_default_ref(path: Path) -> str | None:
    symbolic = git_output(path, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    if symbolic["ok"]:
        return symbolic["stdout"].removeprefix("refs/remotes/")
    return resolve_git_ref(path, ["origin/main", "origin/master"])


def commit_records(path: Path, revision_range: str) -> tuple[list[dict[str, str]], bool]:
    result = git_output(
        path,
        ["log", f"--max-count={MAX_COMMITS + 1}", "--date=short", "--pretty=%H%x1f%ad%x1f%s", revision_range],
    )
    if not result["ok"] or not result["stdout"]:
        return [], False
    rows = result["stdout"].splitlines()
    truncated = len(rows) > MAX_COMMITS
    records = []
    for row in rows[:MAX_COMMITS]:
        parts = row.split("\x1f", 2)
        if len(parts) == 3:
            records.append({"commit": parts[0], "date": parts[1], "subject": parts[2]})
    return records, truncated


def changed_files(path: Path, revision_range: str) -> list[dict[str, str]]:
    result = git_output(path, ["diff", "--name-status", revision_range])
    if not result["ok"]:
        return []
    rows = result["stdout"].splitlines()
    files = []
    for row in rows[:MAX_CHANGED_FILES]:
        parts = row.split("\t")
        if len(parts) >= 2:
            files.append({"status": parts[0], "path": " -> ".join(parts[1:])})
    if len(rows) > MAX_CHANGED_FILES:
        files.append({"status": "...", "path": f"{len(rows) - MAX_CHANGED_FILES} additional files omitted"})
    return files


def package_version_at_ref(path: Path, ref: str) -> str | None:
    result = git_output(path, ["show", f"{ref}:package.json"])
    if not result["ok"]:
        return None
    try:
        value = json.loads(result["stdout"]).get("version")
        return value if isinstance(value, str) else None
    except json.JSONDecodeError:
        return None


def inspect_git_package(package: dict[str, Any], fetch: bool) -> tuple[dict[str, Any], list[dict[str, str]]]:
    path = Path(package["path"])
    source = package["source"]
    warnings: list[dict[str, str]] = []
    current_result = git_output(path, ["rev-parse", "HEAD"])
    if not current_result["ok"]:
        return {**package, "kind": "git", "error": current_result["stderr"]}, [warning("inspect", current_result["stderr"], source)]

    if fetch:
        fetched = git_output(path, ["fetch", "--tags", "--prune", "origin"], timeout=120)
        if not fetched["ok"]:
            warnings.append(warning("fetch", fetched["stderr"] or "git fetch failed", source))

    current = current_result["stdout"]
    status = git_output(path, ["status", "--short"])
    branch = git_output(path, ["branch", "--show-current"])
    package_json = path / "package.json"
    current_version = None
    if package_json.exists():
        try:
            value = json.loads(package_json.read_text()).get("version")
            current_version = value if isinstance(value, str) else None
        except (OSError, json.JSONDecodeError):
            pass

    pin = configured_git_ref(source)
    if pin:
        target_ref = resolve_git_ref(path, [f"refs/tags/{pin}", f"origin/{pin}", pin])
    else:
        target_ref = remote_default_ref(path)

    target = None
    if target_ref:
        target_result = git_output(path, ["rev-parse", target_ref])
        if target_result["ok"]:
            target = target_result["stdout"]
    if not target:
        warnings.append(warning("target", "Could not resolve configured or remote target ref", source))

    update: dict[str, Any] | None = None
    if target and target != current:
        commits, truncated = commit_records(path, f"{current}..{target}")
        counts = git_output(path, ["rev-list", "--left-right", "--count", f"{current}...{target}"])
        ahead = behind = None
        if counts["ok"]:
            values = counts["stdout"].split()
            if len(values) == 2:
                ahead, behind = int(values[0]), int(values[1])
        update = {
            "target": target,
            "target_ref": target_ref,
            "target_version": package_version_at_ref(path, target),
            "ahead": ahead,
            "behind": behind,
            "commits": commits,
            "commits_truncated": truncated,
            "changed_files": changed_files(path, f"{current}..{target}"),
        }

    return {
        **package,
        "kind": "git",
        "current": current,
        "current_version": current_version,
        "branch": branch["stdout"] if branch["ok"] else None,
        "dirty": status["stdout"].splitlines() if status["ok"] and status["stdout"] else [],
        "pinned": pin is not None,
        "configured_ref": pin,
        "update": update,
    }, warnings


def parse_npm_source(source: str) -> tuple[str, str | None]:
    spec = source.removeprefix("npm:")
    if spec.startswith("@"):
        split_at = spec.rfind("@")
        if split_at > spec.find("/"):
            return spec[:split_at], spec[split_at + 1 :]
        return spec, None
    if "@" in spec:
        return tuple(spec.rsplit("@", 1))  # type: ignore[return-value]
    return spec, None


def npm_latest(name: str) -> tuple[str | None, str | None]:
    result = run(["npm", "view", name, "version", "--json"], timeout=60)
    if not result["ok"]:
        return None, result["stderr"] or "npm view failed"
    try:
        value = json.loads(result["stdout"])
        return (value if isinstance(value, str) else None), None
    except json.JSONDecodeError:
        return result["stdout"].strip('"') or None, None


def inspect_npm_package(package: dict[str, Any], query_latest: bool) -> tuple[dict[str, Any], list[dict[str, str]]]:
    path = Path(package["path"])
    source = package["source"]
    name, pin = parse_npm_source(source)
    current_version = None
    try:
        value = json.loads((path / "package.json").read_text()).get("version")
        current_version = value if isinstance(value, str) else None
    except (OSError, json.JSONDecodeError):
        pass
    latest = pin
    error = None
    if query_latest and not pin:
        latest, error = npm_latest(name)
    warnings = [warning("npm", error, source)] if error else []
    return {
        **package,
        "kind": "npm",
        "name": name,
        "current_version": current_version,
        "pinned": pin is not None,
        "configured_ref": pin,
        "latest_version": latest,
        "update_available": bool(latest and current_version and latest != current_version),
    }, warnings


def snapshot_from_inventory(inventory: dict[str, Any]) -> dict[str, Any]:
    packages = []
    for package in inventory["packages"]:
        packages.append({
            "source": package.get("source"),
            "path": package.get("path"),
            "kind": package.get("kind"),
            "current": package.get("current"),
            "current_version": package.get("current_version"),
        })
    return {
        "captured_at": now_iso(),
        "core_version": inventory["core"].get("installed_version"),
        "packages": packages,
    }


def fingerprint(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if not snapshot:
        return None
    return {
        "core_version": snapshot.get("core_version"),
        "packages": sorted(
            [
                (item.get("path"), item.get("current"), item.get("current_version"))
                for item in snapshot.get("packages", [])
            ]
        ),
    }


def collect_inventory(fetch: bool, query_latest: bool) -> dict[str, Any]:
    warnings: list[dict[str, str]] = []
    version_result = run(["pi", "--version"])
    installed_core = version_result["stdout"] if version_result["ok"] else None
    if not version_result["ok"]:
        warnings.append(warning("core", version_result["stderr"] or "pi --version failed"))

    latest_core = None
    if query_latest:
        latest_core, error = npm_latest(CORE_PACKAGE)
        if error:
            warnings.append(warning("core-latest", error, CORE_PACKAGE))

    listed = run(["pi", "list"])
    if not listed["ok"]:
        raise RuntimeError(listed["stderr"] or "pi list failed")

    packages = []
    for package in parse_pi_list(listed["stdout"]):
        path = Path(package["path"])
        if (path / ".git").exists():
            inspected, package_warnings = inspect_git_package(package, fetch)
        elif package["source"].startswith("npm:"):
            inspected, package_warnings = inspect_npm_package(package, query_latest)
        else:
            inspected = {**package, "kind": "local"}
            package_warnings = []
        packages.append(inspected)
        warnings.extend(package_warnings)

    return {
        "collected_at": now_iso(),
        "core": {
            "package": CORE_PACKAGE,
            "installed_version": installed_core,
            "latest_version": latest_core,
            "update_available": bool(installed_core and latest_core and installed_core != latest_core),
        },
        "packages": packages,
        "warnings": warnings,
    }


def compare_after(inventory: dict[str, Any], baseline: dict[str, Any] | None) -> dict[str, Any]:
    if not baseline:
        return {"baseline_available": False, "core_changed": None, "packages": []}
    old_by_path = {item.get("path"): item for item in baseline.get("packages", [])}
    changes = []
    for package in inventory["packages"]:
        old = old_by_path.get(package.get("path"))
        if not old:
            changes.append({"source": package.get("source"), "path": package.get("path"), "change": "added"})
            continue
        old_revision = old.get("current")
        new_revision = package.get("current")
        old_version = old.get("current_version")
        new_version = package.get("current_version")
        if old_revision != new_revision or old_version != new_version:
            detail: dict[str, Any] = {
                "source": package.get("source"),
                "path": package.get("path"),
                "change": "updated",
                "from_revision": old_revision,
                "to_revision": new_revision,
                "from_version": old_version,
                "to_version": new_version,
            }
            if package.get("kind") == "git" and old_revision and new_revision:
                path = Path(package["path"])
                commits, truncated = commit_records(path, f"{old_revision}..{new_revision}")
                detail["commits"] = commits
                detail["commits_truncated"] = truncated
                detail["changed_files"] = changed_files(path, f"{old_revision}..{new_revision}")
            changes.append(detail)
    current_paths = {package.get("path") for package in inventory["packages"]}
    for old in baseline.get("packages", []):
        if old.get("path") not in current_paths:
            changes.append({"source": old.get("source"), "path": old.get("path"), "change": "removed"})
    return {
        "baseline_available": True,
        "baseline_captured_at": baseline.get("captured_at"),
        "core_changed": baseline.get("core_version") != inventory["core"].get("installed_version"),
        "core_from": baseline.get("core_version"),
        "core_to": inventory["core"].get("installed_version"),
        "packages": changes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect read-only Pi core and package update audit data.")
    parser.add_argument("action", choices=["collect", "accept", "status"], nargs="?", default="collect")
    parser.add_argument("--phase", choices=["auto", "before", "after"], default="auto")
    parser.add_argument("--state-file", type=Path, default=default_state_file())
    parser.add_argument("--no-fetch", action="store_true", help="Do not fetch Git remote refs.")
    args = parser.parse_args()

    try:
        state = load_state(args.state_file)
        if args.action == "status":
            print(json.dumps({"status": "ok", "state_file": str(args.state_file), "state": state}, indent=2))
            return 0

        inventory = collect_inventory(fetch=not args.no_fetch, query_latest=args.action == "collect")
        current_snapshot = snapshot_from_inventory(inventory)

        if args.action == "accept":
            state["last_accepted"] = current_snapshot
            state["pending_before"] = None
            save_state(args.state_file, state)
            print(json.dumps({"status": "accepted", "state_file": str(args.state_file), "baseline": current_snapshot}, indent=2))
            return 0

        phase = args.phase
        if phase == "auto":
            pending = state.get("pending_before")
            phase = "after" if pending and fingerprint(pending) != fingerprint(current_snapshot) else "before"

        result: dict[str, Any] = {
            "status": "ok",
            "phase": phase,
            "state_file": str(args.state_file),
            "inventory": inventory,
        }
        if phase == "before":
            state["pending_before"] = current_snapshot
            save_state(args.state_file, state)
            result["baseline"] = current_snapshot
            result["note"] = "Saved the installed state for a later post-update comparison. No checkout or configuration file was changed."
        else:
            baseline = state.get("pending_before") or state.get("last_accepted")
            result["comparison"] = compare_after(inventory, baseline)
            if not baseline:
                result["note"] = "No baseline exists. Perform a current-state compatibility audit, then accept this state."

        print(json.dumps(result, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, indent=2), file=sys.stdout)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
