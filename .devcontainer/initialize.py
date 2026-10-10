"""Host-side setup: create only this checkout's ignored, private DB secret."""
import os
import secrets
import stat
from pathlib import Path


def initialize(root):
    state = root / ".preview"
    if state.is_symlink():
        raise RuntimeError("Unsafe preview directory")
    state.mkdir(mode=0o700, exist_ok=True)
    info = state.stat()
    if info.st_uid == os.getuid() or os.getuid() == 0:
        state.chmod(0o700)
    elif info.st_mode & 0o077:
        raise RuntimeError("Unexpected preview directory ownership")
    # On subsequent host runs a different host UID may no longer read 0700.
    # The isolated container bootstrap validates/repairs its entire mounted tree.
    if info.st_uid != os.getuid() and os.getuid() != 0:
        return
    target = state / "db-password"
    if target.is_symlink():
        raise RuntimeError("Unsafe preview secret")
    if not target.exists():
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("Unsafe preview secret")
        if info.st_uid == os.getuid() or os.getuid() == 0:
            os.fchmod(fd, 0o600)
        elif info.st_mode & 0o077:
            raise RuntimeError("Unexpected preview secret ownership")
    finally:
        os.close(fd)


if __name__ == "__main__":
    initialize(Path(__file__).resolve().parent.parent)
