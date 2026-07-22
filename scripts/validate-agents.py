#!/usr/bin/env python3
"""Validate local pi agent definitions against the configured subagent runtime."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENTS_DIR = ROOT / "agents"
SETTINGS_PATH = ROOT / "settings.json"
SUPPORTED_FIELDS = {
    "name",
    "description",
    "model",
    "thinking",
    "tools",
    "skill",
    "skills",
    "session-mode",
    "spawning",
    "deny-tools",
    "auto-exit",
    "interactive",
    "cwd",
    "cli",
    "disable-model-invocation",
    "system-prompt",
}

KNOWN_TOOLS = {
    "read",
    "bash",
    "write",
    "edit",
    "grep",
    "find",
    "ls",
    "todo",
    "execute_command",
    "web_search",
    "web_fetch",
    "deep_research",
    "subagent",
    "subagent_interrupt",
    "subagents_list",
    "subagent_resume",
}

CONTROL_TOOLS = {"caller_ping", "subagent_done"}
SPAWNING_TOOLS = {"subagent", "subagent_interrupt", "subagents_list", "subagent_resume"}
REQUIRED_AGENTS = {
    "spec",
    "planner",
    "scout",
    "worker",
    "reviewer",
    "researcher",
    "visual-tester",
}


def parse_frontmatter(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text()
    match = re.match(r"^---\n(.*?)\n---\n?", text, re.DOTALL)
    if not match:
        raise ValueError("missing frontmatter")

    values: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"invalid frontmatter line: {line}")
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip()
    return values, text[match.end():]


def csv(value: str | None) -> set[str]:
    return {item.strip() for item in (value or "").split(",") if item.strip()}


def disabled_skill_package_names() -> set[str]:
    settings = json.loads(SETTINGS_PATH.read_text())
    names = set()
    for package in settings.get("packages", []):
        if not isinstance(package, dict) or package.get("skills") != []:
            continue
        source = package.get("source", "").rstrip("/")
        if source:
            names.add(source.rsplit("/", 1)[-1].split("@", 1)[0])
    return names


def discover_skills() -> set[str]:
    names = set()
    disabled_packages = disabled_skill_package_names()
    roots = [ROOT / "skills", ROOT / "git", ROOT / "npm"]
    for search_root in roots:
        if not search_root.exists():
            continue
        for path in search_root.rglob("SKILL.md"):
            if disabled_packages.intersection(path.parts):
                continue
            try:
                frontmatter, _ = parse_frontmatter(path)
            except ValueError:
                continue
            if frontmatter.get("name"):
                names.add(frontmatter["name"])
    return names


def validate_agent(path: Path, known_skills: set[str]) -> tuple[list[str], list[str], str | None]:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        frontmatter, body = parse_frontmatter(path)
    except ValueError as exc:
        return [str(exc)], warnings, None

    name = frontmatter.get("name")
    if not name:
        errors.append("missing name")
    elif name != path.stem:
        errors.append(f"name '{name}' does not match filename")

    unsupported = set(frontmatter) - SUPPORTED_FIELDS
    if unsupported:
        errors.append(f"unsupported frontmatter: {', '.join(sorted(unsupported))}")

    tools = csv(frontmatter.get("tools"))
    if not tools:
        errors.append("missing least-privilege tools allowlist")
    unknown_tools = tools - KNOWN_TOOLS
    if unknown_tools:
        errors.append(f"unknown tools: {', '.join(sorted(unknown_tools))}")

    skills = csv(frontmatter.get("skill")) | csv(frontmatter.get("skills"))
    missing_skills = skills - known_skills
    if missing_skills:
        errors.append(f"unknown skills: {', '.join(sorted(missing_skills))}")

    if frontmatter.get("spawning") == "false" and tools & SPAWNING_TOOLS:
        errors.append("spawning is false but spawning tools are allowlisted")

    referenced_tools = {
        tool for tool in KNOWN_TOOLS | CONTROL_TOOLS
        if re.search(rf"\b{re.escape(tool)}\s*\(", body)
    }
    unavailable_references = referenced_tools - tools - CONTROL_TOOLS
    if unavailable_references:
        errors.append(f"prompt invokes unavailable tools: {', '.join(sorted(unavailable_references))}")

    if "read_artifact" in body or "write_artifact" in body:
        errors.append("prompt references unsupported artifact APIs")
    instructs_done = re.search(r"(?<!do not )call\s+`?subagent_done", body, re.IGNORECASE)
    if frontmatter.get("auto-exit") == "true" and instructs_done:
        warnings.append("auto-exit agent also instructs subagent_done")
    if frontmatter.get("spawning") == "false" and re.search(r"\bspawn\s+(?:a|an|the)?\s*(?:subagent|scout|worker|planner|reviewer)", body, re.IGNORECASE):
        warnings.append("non-spawning agent appears to instruct nested delegation")

    visible_name = None if frontmatter.get("disable-model-invocation") == "true" else name
    return errors, warnings, visible_name


def main() -> int:
    known_skills = discover_skills()
    all_errors: list[str] = []
    all_warnings: list[str] = []
    names = set()

    for path in sorted(AGENTS_DIR.glob("*.md")):
        errors, warnings, name = validate_agent(path, known_skills)
        if name:
            names.add(name)
        all_errors.extend(f"{path.relative_to(ROOT)}: {message}" for message in errors)
        all_warnings.extend(f"{path.relative_to(ROOT)}: {message}" for message in warnings)

    missing_agents = REQUIRED_AGENTS - names
    if missing_agents:
        all_errors.append(f"missing required agents: {', '.join(sorted(missing_agents))}")

    for warning in all_warnings:
        print(f"WARN: {warning}")
    for error in all_errors:
        print(f"ERROR: {error}")

    if all_errors:
        print(f"\nAgent validation failed: {len(all_errors)} error(s), {len(all_warnings)} warning(s).")
        return 1

    print(f"Agent validation passed: {len(names)} agents, {len(all_warnings)} warning(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
