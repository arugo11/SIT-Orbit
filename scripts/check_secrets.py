import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IGNORE_PARTS = {".git", ".venv", "node_modules", ".next", "dist"}
IGNORE_FILES = {Path(__file__).resolve(), ROOT / "uv.lock", ROOT / "pnpm-lock.yaml"}
PATTERNS = {
    "OpenAI-style key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "GitHub token": re.compile(r"\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b"),
    "Private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
}


def candidates():
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.resolve() in IGNORE_FILES:
            continue
        if any(part in IGNORE_PARTS for part in path.parts):
            continue
        yield path


def main() -> int:
    findings: list[str] = []
    for path in candidates():
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for name, pattern in PATTERNS.items():
            if pattern.search(content):
                findings.append(f"{path.relative_to(ROOT)}: {name}")

    if findings:
        print("Potential secrets found:")
        for finding in findings:
            print(f"- {finding}")
        return 1

    print("No obvious secrets found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
