"""Windows-robust temporary directory for V6 tests (test-only helper).

On Windows, a file handle released by a just-exited child process, an
antivirus scanner or the search indexer can make ``rmdir`` fail briefly with
WinError 145 (directory not empty) or WinError 32 (in use). The stock
``tempfile.TemporaryDirectory`` then raises from ``__exit__`` and turns a
passing test into an ERROR. This helper retries cleanup with a short backoff
and never masks an exception raised by the test body itself.

Test-only: it is not imported by any runtime/production module.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
import time
from pathlib import Path

RETRY_DELAYS_S = (0.05, 0.1, 0.2, 0.4, 0.8, 1.6)
LEFTOVER_ENV = "V6_TEST_TEMPDIR_STRICT"


def _clear_readonly(func, path, _exc):
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        pass


def remove_tree_with_retry(path: str | os.PathLike) -> bool:
    """Remove ``path``; return True when gone, False if it could not be removed."""
    target = Path(path)
    for delay in (0.0, *RETRY_DELAYS_S):
        if delay:
            time.sleep(delay)
        if not target.exists():
            return True
        try:
            if sys.version_info >= (3, 12):
                shutil.rmtree(target, onexc=_clear_readonly)
            else:  # pragma: no cover - older interpreters
                shutil.rmtree(target, onerror=_clear_readonly)
        except OSError:
            continue
    return not target.exists()


class robust_tempdir:  # noqa: N801 - mirrors tempfile.TemporaryDirectory naming
    """Drop-in for ``tempfile.TemporaryDirectory()``.

    Supports both ``with robust_tempdir() as folder:`` and the object API
    ``d = robust_tempdir(); d.name; d.cleanup()``. ``cleanup`` is idempotent and
    never raises on transient Windows locks unless V6_TEST_TEMPDIR_STRICT=1.
    """

    def __init__(self, prefix: str = "v6test_"):
        self.name = tempfile.mkdtemp(prefix=prefix)
        self._closed = False

    def cleanup(self) -> None:
        if self._closed:
            return
        self._closed = True
        if not remove_tree_with_retry(self.name):
            message = f"V6_TEST_TEMPDIR_LEFTOVER: could not remove {self.name}"
            if os.environ.get(LEFTOVER_ENV) == "1":
                raise OSError(message)
            print(message, file=sys.stderr)

    def __enter__(self) -> str:
        return self.name

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.cleanup()
        return False  # never swallow exceptions from the test body

    def __repr__(self) -> str:
        return f"<robust_tempdir {self.name!r}>"
