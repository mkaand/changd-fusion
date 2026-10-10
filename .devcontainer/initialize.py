"""Host-side setup: create only this checkout's ignored, private DB secret."""
import os
import secrets
from pathlib import Path


def initialize(root):
    state = root / ".preview"
    if state.is_symlink():
        raise RuntimeError("Unsafe preview directory")
    state.mkdir(mode=0o700, exist_ok=True)
    state.chmod(0o700)
    target = state / "db-password"
    if target.is_symlink():
        raise RuntimeError("Unsafe preview secret")
    if not target.exists():
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    target.chmod(0o600)


if __name__ == "__main__":
    initialize(Path(__file__).resolve().parent.parent)
