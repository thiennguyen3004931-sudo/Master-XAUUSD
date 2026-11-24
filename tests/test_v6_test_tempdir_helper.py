import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from tests import v6_test_tempdir as helper
except ImportError:  # discover -s tests imports modules top-level
    import v6_test_tempdir as helper


class RobustTempdirTests(unittest.TestCase):
    def test_context_manager_creates_and_removes(self):
        with helper.robust_tempdir() as folder:
            p = Path(folder)
            self.assertTrue(p.is_dir())
            (p / "sub").mkdir()
            (p / "sub" / "f.txt").write_text("x", encoding="utf-8")
        self.assertFalse(p.exists())

    def test_object_api_and_idempotent_cleanup(self):
        d = helper.robust_tempdir()
        p = Path(d.name)
        self.assertTrue(p.is_dir())
        d.cleanup()
        d.cleanup()
        self.assertFalse(p.exists())

    def test_body_exception_is_not_swallowed(self):
        with self.assertRaises(ValueError):
            with helper.robust_tempdir() as folder:
                p = Path(folder)
                raise ValueError("boom")
        self.assertFalse(p.exists())

    def test_transient_rmtree_error_is_retried(self):
        real = helper.shutil.rmtree
        calls = {"n": 0}

        def flaky(path, *a, **kw):
            calls["n"] += 1
            if calls["n"] < 3:
                raise OSError(145, "The directory is not empty")
            return real(path, *a, **kw)

        with mock.patch.object(helper, "RETRY_DELAYS_S", (0.0, 0.0, 0.0)), \
                mock.patch.object(helper.shutil, "rmtree", side_effect=flaky):
            with helper.robust_tempdir() as folder:
                p = Path(folder)
        self.assertEqual(calls["n"], 3)
        self.assertFalse(p.exists())

    def test_persistent_failure_strict_mode_raises(self):
        with mock.patch.object(helper, "RETRY_DELAYS_S", (0.0,)), \
                mock.patch.object(helper.shutil, "rmtree", side_effect=OSError(32, "in use")), \
                mock.patch.dict(os.environ, {helper.LEFTOVER_ENV: "1"}):
            d = helper.robust_tempdir()
            with self.assertRaises(OSError):
                d.cleanup()
        helper.shutil.rmtree(d.name, ignore_errors=True)

    def test_persistent_failure_default_mode_reports_without_raising(self):
        env = {k: v for k, v in os.environ.items() if k != helper.LEFTOVER_ENV}
        with mock.patch.object(helper, "RETRY_DELAYS_S", (0.0,)), \
                mock.patch.object(helper.shutil, "rmtree", side_effect=OSError(32, "in use")), \
                mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(helper.sys, "stderr") as err:
            d = helper.robust_tempdir()
            d.cleanup()
        self.assertTrue(any("V6_TEST_TEMPDIR_LEFTOVER" in str(c) for c in err.write.call_args_list))
        helper.shutil.rmtree(d.name, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
