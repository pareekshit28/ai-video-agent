"""Process locks on the shared storage volume; the OS releases them on exit."""
import asyncio
import errno
import os
import time


class StorageLock:
    def __init__(self, path, timeout=120):
        self.path, self.timeout, self.stream = path, timeout, None

    async def __aenter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        try:
            if os.name == "nt" and self.path.stat().st_size == 0:
                self.stream.write(b"\0")
                self.stream.flush()
            deadline = time.monotonic() + self.timeout
            while True:
                try:
                    if os.name == "nt":
                        import msvcrt
                        self.stream.seek(0)
                        msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return self
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    if time.monotonic() >= deadline:
                        raise ValueError("Another pod is updating this project or scene. Try again shortly.") from error
                    await asyncio.sleep(0.05)
        except BaseException:
            self.stream.close()
            self.stream = None
            raise

    async def __aexit__(self, *error):
        try:
            if os.name == "nt":
                import msvcrt
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        finally:
            self.stream.close()
            self.stream = None
        # Keep the lock file: unlinking it could let two processes lock different inodes.
