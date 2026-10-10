"""Narrow, one-shot root bootstrap; the application always runs as UID/GID 1000.

Preserve secret bytes and database volumes. Refuse symlinks, sockets and FIFOs.
Use descriptors so ownership repair never follows a hostile path out of /state.
"""
import os
import stat
import signal

UID = GID = 1000


def repair_tree(fd):
    os.fchown(fd, UID, GID)
    os.fchmod(fd, 0o700)
    for name in os.listdir(fd):
        child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(child)
            if stat.S_ISDIR(info.st_mode):
                repair_tree(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                os.fchown(child, UID, GID)
                os.fchmod(child, 0o600)
            else:
                raise RuntimeError("Unsafe preview runtime entry")
        finally:
            os.close(child)


def prepare(state="/state", home="/home/node"):
    fd = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        repair_tree(fd)
    finally:
        os.close(fd)
    # Only known home directories: no recursive traversal of VS Code extensions.
    for suffix in ["", ".config", ".config/vscode-dev-containers", ".vscode-server", ".vscode-server-insiders"]:
        target = home if not suffix else os.path.join(home, suffix)
        os.makedirs(target, mode=0o700, exist_ok=True)
        fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(fd, UID, GID)
            os.fchmod(fd, 0o700)
        finally:
            os.close(fd)


if __name__ == "__main__":
    signal.alarm(60)
    prepare()
    signal.alarm(0)
