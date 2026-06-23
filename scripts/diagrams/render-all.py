"""
Render all LumenWipe diagrams to docs/diagrams/output/ (SVG + PNG).
Usage: python scripts/diagrams/render-all.py   (from repo root)
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
OUTPUT = ROOT / "docs" / "diagrams" / "output"
OUTPUT.mkdir(parents=True, exist_ok=True)

scripts = [
    "01-system-architecture.py",
    "02-data-flow.py",
    "03-state-machine.py",
    "04-signing-flow.py",
    "05-defi-adapter-fallback.py",
    "06-execution-plan.py",
    "07-blend-unwind.py",
    "08-asset-conversion-routing.py",
    "09-mediator-flow.py",
]

base = Path(__file__).parent
errors = []

for script in scripts:
    path = base / script
    result = subprocess.run([sys.executable, str(path)], cwd=str(ROOT),
                            capture_output=True, text=True)
    if result.returncode != 0:
        print(f"\n✗ {script}\n{result.stderr}")
        errors.append(script)
    elif result.stdout:
        print(result.stdout.strip())

if errors:
    print(f"\n{len(errors)} script(s) failed: {errors}")
    sys.exit(1)
else:
    print(f"\nAll diagrams rendered → {OUTPUT}")
