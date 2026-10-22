"""Build on each target OS. Python/Tk is bundled; Codex uses the local installation."""
from pathlib import Path
import platform
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--windowed", "--name", "ComfyUI Codex Helper",
        "--distpath", str(root / "desktop/dist"), "--workpath", str(root / "desktop/build"),
        "--specpath", str(root / "desktop/build"), "--paths", str(root)]
if sys.platform == "win32":
    args.append("--onefile")
else:
    args.extend(["--onedir", "--osx-bundle-identifier", "com.aivideoagent.codexhelper"])
args.append(str(root / "desktop_helper.py"))
subprocess.run(args, cwd=root, check=True)
print("Built for", platform.system(), platform.machine(), "in", root / "desktop/dist")
