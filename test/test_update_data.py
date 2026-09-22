"""Read-only status tests: every filesystem fixture is a disposable home."""
import sys
sys.dont_write_bytecode = True
import importlib.util
import io
import json
import os
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
import runpy
import stat
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "pinned_update_status", Path(__file__).resolve().parents[1] / "helpers/pinned_update.py")
u = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(u)


class UpdateDataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir(mode=0o700)
        self.root = self.home / ".config/omarchy"
        self.active = self.root / "plugin-manager-updates"
        self.updater = u.Updater(home=str(self.home))

    def test_missing_config_reports_zero_without_creating_it(self):
        result = self.updater.update_data_status()
        self.assertEqual(result, {
            "schemaVersion": 1, "available": True,
            "paths": {"plugins": str(self.root / "plugins"),
                      "active": str(self.active),
                      "archive": str(self.root / "plugin-manager-updates-archive")},
            "activeCount": 0, "lowerBound": False, "limit": 32, "error": ""})
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertEqual(self.updater.fds, [])

    def observe(self, updater=None):
        # These guards make any accidental update-path entry fail the test.
        with ExitStack() as stack:
            for target in ("mkdir", "rename", "unlink", "rmdir", "fsync", "fchmod", "fork"):
                stack.enter_context(patch.object(u.os, target, side_effect=AssertionError(target)))
            stack.enter_context(patch.object(u.fcntl, "flock", side_effect=AssertionError("flock")))
            stack.enter_context(patch.object(u.subprocess, "Popen", side_effect=AssertionError("spawn")))
            stack.enter_context(patch.object(u.Updater, "open_paths", side_effect=AssertionError("update")))
            worker = updater or u.Updater(home=str(self.home))
            result = worker.update_data_status()
        self.assertEqual(worker.fds, [])
        self.assertLessEqual(len(json.dumps(result).encode()) + 1, 8192)
        return result

    def unavailable(self, result):
        self.assertIs(result["available"], False)
        self.assertIsNone(result["activeCount"])
        self.assertIs(result["lowerBound"], False)
        self.assertTrue(result["error"])
        self.assertLessEqual(len(result["error"]), 200)

    def test_missing_intermediate_and_active_directories(self):
        for directory in (self.home / ".config", self.root, self.active):
            with self.subTest(missing=directory):
                result = self.observe()
                self.assertTrue(result["available"])
                self.assertEqual(result["activeCount"], 0)
                self.assertFalse(directory.exists())
                directory.mkdir(mode=0o700)

    def test_count_boundaries_without_archiving_or_replacing_lock_root(self):
        self.active.mkdir(parents=True, mode=0o700)
        before = self.active.stat()
        for count in (0, 1, 32, 33, 45):
            for number in range(count):
                (self.active / str(number)).touch(exist_ok=True)
            result = self.observe()
            with self.subTest(count=count):
                self.assertTrue(result["available"])
                self.assertEqual(result["activeCount"], min(count, 33))
                self.assertEqual(result["lowerBound"], count > 32)
                self.assertEqual(len(list(self.active.iterdir())), count)
        after = self.active.stat()
        self.assertEqual((before.st_dev, before.st_ino, before.st_mode),
                         (after.st_dev, after.st_ino, after.st_mode))
        self.assertFalse((self.root / u.ARCHIVE_NAME).exists())

    def test_all_direct_entry_types_count_without_opening_them(self):
        self.active.mkdir(parents=True, mode=0o700)
        (self.active / "unknown").write_text("not a journal")
        (self.active / "directory").mkdir()
        (self.active / "directory/nested").touch()
        (self.active / "symlink").symlink_to("missing")
        os.mkfifo(self.active / "fifo")
        (self.active / "<untrusted>\n").touch()
        real_open = u.os.open

        def checked_open(name, flags, *args, **kwargs):
            self.assertNotIn(name, ("plugins", u.ARCHIVE_NAME, "unknown", "directory", "fifo"))
            self.assertEqual(flags & (os.O_CREAT | os.O_WRONLY | os.O_RDWR | os.O_TRUNC), 0)
            return real_open(name, flags, *args, **kwargs)

        # Neither installed plugins nor archives need to be directories at all.
        (self.root / "plugins").symlink_to("missing")
        os.mkfifo(self.root / u.ARCHIVE_NAME)
        with patch.object(u.os, "open", side_effect=checked_open):
            result = self.observe()
        self.assertEqual(result["activeCount"], 5)
        self.assertNotIn("untrusted", json.dumps(result))

    def test_unsafe_components_are_unavailable_not_empty(self):
        for component in (".config", ".config/omarchy", ".config/omarchy/plugin-manager-updates"):
            for kind in ("symlink", "file", "writable", "foreign"):
                with self.subTest(component=component, kind=kind), tempfile.TemporaryDirectory() as tmp:
                    home = Path(tmp) / "home"
                    target = home / component
                    target.parent.mkdir(parents=True)
                    if kind == "symlink":
                        target.symlink_to("missing")
                    elif kind == "file":
                        target.touch()
                    else:
                        target.mkdir(mode=0o700)
                    if kind == "writable":
                        target.chmod(0o777)
                    original = u.os.fstat
                    inode = target.lstat().st_ino

                    def metadata(fd):
                        info = original(fd)
                        if kind == "foreign" and info.st_ino == inode:
                            return SimpleNamespace(st_uid=os.getuid() + 1, st_mode=info.st_mode)
                        return info

                    with patch.object(u.os, "fstat", side_effect=metadata):
                        self.unavailable(self.observe(u.Updater(home=str(home))))

    def test_active_requires_private_mode(self):
        self.active.mkdir(parents=True, mode=0o700)
        for mode in (0o755, 0o750, 0o1700):
            self.active.chmod(mode)
            self.unavailable(self.observe())
            self.assertEqual(stat.S_IMODE(self.active.stat().st_mode), mode)

    def test_unreadable_io_errors_and_missing_home_are_not_zero(self):
        self.active.mkdir(parents=True, mode=0o700)
        for error in (PermissionError("private details"), OSError(5, "private details")):
            with self.subTest(error=error):
                with patch.object(u, "checked_dir", side_effect=error):
                    result = self.observe()
                self.unavailable(result)
                self.assertNotIn("private details", json.dumps(result))
                with patch.object(u.os, "scandir", side_effect=error):
                    self.unavailable(self.observe())
        self.unavailable(self.observe(u.Updater(home=str(self.home / "absent"))))

    def test_changed_root_identity_or_private_mode_is_refused(self):
        self.active.mkdir(parents=True, mode=0o700)
        original = u.Updater.active_transactions
        moved = self.root / "moved"

        def replaced(worker):
            count = original(worker)
            # Explicit fixture race, outside the guarded production observer.
            self.active.rename(moved)
            self.active.mkdir(mode=0o700)
            return count

        with patch.object(u.Updater, "active_transactions", replaced):
            self.unavailable(self.updater.update_data_status())
        self.assertTrue(moved.is_dir())

        def permissions(worker):
            count = original(worker)
            self.active.chmod(0o755)
            return count

        with patch.object(u.Updater, "active_transactions", permissions):
            self.unavailable(self.observe())

    def test_iteration_stops_at_33_without_consuming_more(self):
        self.active.mkdir(parents=True, mode=0o700)

        def entries():
            for number in range(33):
                yield SimpleNamespace(name=str(number))
            self.fail("status consumed a 34th entry")

        with patch.object(u.os, "scandir") as scan:
            scan.return_value.__enter__.return_value = entries()
            self.assertEqual(self.observe()["activeCount"], 33)
            scan.assert_called_once()

    def test_cancellation_deadline_and_mid_scan_failure_close_descriptors(self):
        self.active.mkdir(parents=True, mode=0o700)
        self.updater.cancelled = True
        self.unavailable(self.observe(self.updater))
        self.updater = u.Updater(home=str(self.home))
        self.updater.deadline = time.monotonic() - 1
        self.unavailable(self.observe(self.updater))

        def entries():
            yield SimpleNamespace(name="first")
            raise PermissionError("changed while scanning")

        with patch.object(u.os, "scandir") as scan:
            scan.return_value.__enter__.return_value = entries()
            self.unavailable(self.observe())
        original = u.Updater.checkpoint

        def cancelled(worker, phase):
            if phase == "archive-inventory":
                worker.cancelled = True
            original(worker, phase)

        (self.active / "entry").touch()
        with patch.object(u.Updater, "checkpoint", cancelled):
            self.unavailable(self.observe())

    def test_late_cancellation_is_not_reported_as_available(self):
        original = u.Updater.check_anchors

        def cancelled(worker):
            original(worker)
            worker.cancelled = True

        with patch.object(u.Updater, "check_anchors", cancelled):
            self.unavailable(self.observe())

    def test_home_symlink_and_writable_home_are_unavailable(self):
        alias = Path(self.tmp.name) / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        self.unavailable(self.observe(u.Updater(home=str(alias))))
        self.home.chmod(0o777)
        self.unavailable(self.observe())

    def test_metadata_bounds_and_unsafe_display_paths(self):
        for home in ("relative", "/", "/a/../b", "/a//b", "/a/", "/a\n", "/a\x85", "/a\u202e",
                     "/<a>", "/a&b", "/\udcff", "/" + "a" * 512, "/" + "é" * 256):
            with self.subTest(home=repr(home)), patch.object(u.os, "open") as opened:
                result = self.observe(u.Updater(home=home))
                self.unavailable(result)
                self.assertIsNone(result["paths"])
                opened.assert_not_called()
        # Printable Unicode survives losslessly, even near the byte ceiling.
        home = "/" + "/".join(["é" * 63] * 4)
        with patch.object(u.Updater, "open_update_root", return_value=None):
            result = self.observe(u.Updater(home=home))
        self.assertTrue(result["available"])
        self.assertTrue(result["paths"]["active"].startswith(home))

    def cli(self, args, passwd=None):
        output = io.StringIO()
        with patch.object(sys, "argv", [SPEC.origin, *args]), redirect_stdout(output), \
                patch.object(u.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(self.home)),
                             side_effect=passwd), \
                patch.dict(os.environ, {"HOME": "/not-the-account-home", "XDG_CONFIG_HOME": "/ignored"}), \
                patch.object(u.os, "fork", side_effect=AssertionError("fork")), \
                patch.object(u.os, "mkdir", side_effect=AssertionError("mkdir")), \
                patch.object(u.os, "umask"), self.assertRaises(SystemExit) as exited:
            runpy.run_path(SPEC.origin, run_name="__main__")
        self.assertLessEqual(len(output.getvalue().encode()), 8192)
        return exited.exception.code, json.loads(output.getvalue())

    def test_exact_cli_route_uses_passwd_home_not_environment(self):
        code, result = self.cli(["--update-data-status"])
        self.assertEqual(code, 0)
        self.assertEqual(result, self.observe())
        self.assertEqual(list(self.home.iterdir()), [])
        for args in (["--update-data-status", str(self.home)], ["--update-data-status=other"]):
            code, result = self.cli(args)
            self.assertEqual(code, 1)
            self.assertEqual(result["status"], "unchanged; request refused")
        code, result = self.cli(["--update-data-status"], passwd=KeyError("account missing"))
        self.assertEqual(code, 1)
        self.unavailable(result)
        self.assertIsNone(result["paths"])


if __name__ == "__main__":
    unittest.main()
