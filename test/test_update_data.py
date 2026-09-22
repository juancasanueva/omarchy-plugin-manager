"""Status and internal deletion tests: filesystem fixtures are disposable homes."""
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


class CompletedDeletionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.root = self.home / ".config/omarchy"
        self.active = self.root / "plugin-manager-updates"
        self.archive = self.root / u.ARCHIVE_NAME
        self.active.mkdir(parents=True, mode=0o700)
        self.archive.mkdir(mode=0o700)
        self.plugin = self.root / "plugins/acme.plugin"
        self.plugin.mkdir(parents=True)
        (self.plugin / "sentinel").write_text("installed")
        self.outside = Path(self.tmp.name) / "sentinel"
        self.outside.write_text("outside")
        self.worker = u.Updater(home=str(self.home))

    def fixture(self, number=1, archived=False, install=False):
        name = "txn-%024x" % number
        tx = (self.archive if archived else self.active) / name
        tx.mkdir(mode=0o700)
        request = dict(schemaVersion=1, id="acme.plugin",
                       repository="https://github.com/acme/plugin", verifiedCommit="b" * 40)
        prepared = {"replacement": [tx.stat().st_dev, self.plugin.stat().st_ino]}
        result = {"status": "installed"}
        if install:
            request["section"] = "right"
        else:
            request["expectedLocalHead"] = "a" * 40
            backup = tx / "checkout"
            (backup / "nested").mkdir(parents=True)
            (backup / "nested/data").write_bytes(b"retained original")
            prepared["original"] = [backup.stat().st_dev, backup.stat().st_ino]
            result = {"status": "updated", "backup": str(self.active / name / "checkout")}
        for key, value in (("request", request), ("prepared", prepared),
                           ("published", result), ("result", result)):
            (tx / (key + ".json")).write_text(json.dumps(value))
            (tx / (key + ".json")).chmod(0o600)
        return tx

    def remove(self, tx, budget=None):
        with u.CleanupLock(self.worker) as lock:
            parent = lock.parent(archived=tx.parent == self.archive)
            return u.remove_completed(lock, parent, tx.name, budget or u.CleanupBudget())

    def assert_sentinels(self):
        self.assertEqual(self.outside.read_text(), "outside")
        self.assertEqual((self.plugin / "sentinel").read_text(), "installed")
        self.assertEqual(self.worker.fds, [])

    def test_completed_active_and_archived_backups_are_removed(self):
        roots = [self.active.stat().st_ino, self.archive.stat().st_ino]
        for archived in (False, True):
            for install in (False, True):
                tx = self.fixture(archived=archived, install=install)
                result = self.remove(tx)
                self.assertEqual(result, {"status": "removed", "transactionRemoved": True, "error": ""})
                self.assertFalse(tx.exists())
        self.assertEqual(roots, [self.active.stat().st_ino, self.archive.stat().st_ino])
        self.assert_sentinels()

    def unchanged(self, tx, action=None, budget=None):
        before = self.snapshot(tx)
        result = action() if action else self.remove(tx, budget)
        self.assertEqual(result["status"], "refused", result)
        self.assertFalse(result["transactionRemoved"])
        self.assertTrue(result["error"])
        self.assertEqual(self.snapshot(tx), before)
        self.assert_sentinels()
        return result

    @staticmethod
    def snapshot(tx):
        # Fixture observation only; never follow planted symlinks or read FIFOs.
        result = {}
        for path in (tx, *tx.rglob("*")):
            info = path.lstat()
            result[str(path.relative_to(tx))] = (info.st_ino, info.st_mode, info.st_nlink,
                path.read_bytes() if stat.S_ISREG(info.st_mode) and info.st_size < 65536 else info.st_size)
        return result

    def test_failed_unresolved_malformed_and_unknown_content_stay_untouched(self):
        for number, kind in enumerate(("failed", "unresolved", "malformed", "refused", "extra",
                                       "marker", "index-directory", "journal-directory", "install-checkout"), 10):
            with self.subTest(kind=kind):
                tx = self.fixture(number, install=kind == "install-checkout")
                if kind == "failed":
                    (tx / "result.json").write_text('{"status":"updated; reload failed"}')
                elif kind == "unresolved":
                    (tx / "result.json").unlink()
                elif kind == "malformed":
                    (tx / "request.json").write_text("not json")
                elif kind in ("refused", "extra", "marker"):
                    (tx / {"refused": "refused.json", "extra": "unknown", "marker": u.CLEANUP_MARKER}[kind]).touch()
                elif kind == "index-directory":
                    (tx / "index-before").mkdir()
                elif kind == "journal-directory":
                    (tx / "result.json").unlink()
                    (tx / "result.json").mkdir()
                else:
                    (tx / "checkout").mkdir()
                self.unchanged(tx)

    def test_unsafe_recursive_entries_are_never_followed(self):
        for number, kind in enumerate(("symlink", "dir-symlink", "fifo", "hardlink",
                                       "writable-file", "writable-dir", "special-mode"), 30):
            with self.subTest(kind=kind):
                tx = self.fixture(number)
                path = tx / "checkout/nested/unsafe"
                if kind == "symlink":
                    path.symlink_to(self.outside)
                elif kind == "dir-symlink":
                    path.symlink_to(self.plugin, target_is_directory=True)
                elif kind == "fifo":
                    os.mkfifo(path)
                elif kind == "hardlink":
                    os.link(self.outside, path)
                elif kind == "writable-dir":
                    path.mkdir()
                    path.chmod(0o777)
                else:
                    path.touch()
                    path.chmod(0o666 if kind == "writable-file" else 0o4644)
                self.unchanged(tx)

    def test_foreign_owner_device_and_bind_mount_are_refused(self):
        tx = self.fixture()
        inode = (tx / "checkout/nested/data").stat().st_ino
        fstat = u.os.fstat
        for field in ("st_uid", "st_dev"):
            def changed(fd):
                info = fstat(fd)
                if info.st_ino != inode:
                    return info
                values = {key: getattr(info, key) for key in dir(info) if key.startswith("st_")}
                values[field] += 1
                return SimpleNamespace(**values)
            with self.subTest(field=field), patch.object(u.os, "fstat", side_effect=changed):
                self.unchanged(tx)
        mount = u.cleanup_mount_id
        for target in (inode, (tx / "checkout").stat().st_ino, tx.stat().st_ino):
            with self.subTest(mounted_inode=target), patch.object(u, "cleanup_mount_id",
                    side_effect=lambda fd: mount(fd) + (fstat(fd).st_ino == target)):
                self.unchanged(tx)
        with patch.object(u, "cleanup_mount_id", side_effect=u.Refused("Mount identity unavailable")):
            with self.assertRaises(u.Refused):
                self.remove(tx)
        self.assert_sentinels()

    def test_fdinfo_is_bounded_and_fail_closed(self):
        for raw in (b"", b"mnt_id: 1\nmnt_id: 2\n", b"mnt_id: nope\n", b"x" * 4097):
            with self.subTest(raw=raw[:30]), patch.object(u.os, "read", return_value=raw), \
                    self.assertRaises(u.Refused):
                fd = os.open(self.active, u.DIR)
                try:
                    u.cleanup_mount_id(fd)
                finally:
                    os.close(fd)
        fd = os.open(self.active, u.DIR)
        try:
            self.assertGreater(u.cleanup_mount_id(fd), 0)
        finally:
            os.close(fd)

    def test_per_file_and_total_byte_boundaries(self):
        tx = self.fixture()
        data = tx / "checkout/nested/data"
        with data.open("wb") as stream:
            stream.truncate(32 * 1024 * 1024 + 1)
        self.unchanged(tx)
        with data.open("wb") as stream:
            stream.truncate(32 * 1024 * 1024)
        self.assertEqual(self.remove(tx)["status"], "removed")
        tx = self.fixture(2)
        for number in range(4):
            with (tx / "checkout" / str(number)).open("wb") as stream:
                stream.truncate(32 * 1024 * 1024)
        self.unchanged(tx)  # Journals and nested data put this over 128 MiB.
        total = sum(p.stat().st_size for p in tx.rglob("*") if p.is_file())
        with (tx / "checkout/0").open("r+b") as stream:
            stream.truncate(32 * 1024 * 1024 - (total - 128 * 1024 * 1024))
        self.assertEqual(self.remove(tx)["status"], "removed")

    def test_depth_and_entry_boundaries(self):
        tx = self.fixture()
        current = tx / "checkout/nested"
        for number in range(18):
            current = current / str(number)
            current.mkdir()
        (current / "file").touch()
        self.assertEqual(self.remove(tx)["status"], "removed")
        tx = self.fixture(2)
        current = tx / "checkout"
        for number in range(20):
            current = current / str(number)
            current.mkdir()
        self.unchanged(tx)
        # Many arbitrary top-level names would already fail the allowlist.
        tx = self.fixture(4)
        for number in range(4090):
            (tx / "checkout" / str(number)).touch()
        self.unchanged(tx)  # 4 journals + checkout + nested + data + 4090.
        (tx / "checkout/0").unlink()
        self.assertEqual(self.remove(tx)["status"], "removed")

    def test_operation_budgets_are_consumed_across_candidates_and_refusals(self):
        tx = self.fixture()
        for key in ("work", "entries", "metadata", "bytes"):
            with self.subTest(key=key):
                self.unchanged(tx, budget=u.CleanupBudget(**{key: 0}))
        self.unchanged(tx, budget=u.CleanupBudget(seconds=-1))
        budget = u.CleanupBudget()
        with u.CleanupLock(self.worker) as lock:
            initial = budget.remaining["entries"]
            result = u.remove_completed(lock, lock.parent(), tx.name, budget)
            self.assertEqual(result["status"], "removed")
            cost = initial - budget.remaining["entries"]
            self.assertGreater(cost, 14)  # Two full passes plus shallow mutation rechecks.
            budget.remaining["entries"] = cost
            tx = self.fixture(2)
            result = u.remove_completed(lock, lock.parent(), tx.name, budget)
            self.assertEqual(result["status"], "removed")
            tx = self.fixture(3)
            result = u.remove_completed(lock, lock.parent(), tx.name, budget)
            self.assertEqual(result["status"], "refused")
            self.assertLess(budget.remaining["entries"], 0)
            self.assertEqual(u.remove_completed(lock, lock.parent(), tx.name, budget)["status"], "refused")

    def test_lock_excludes_update_workers_in_both_directions(self):
        def close(worker):
            for fd in reversed(worker.fds):
                os.close(fd)
            worker.fds.clear()
        updater = u.Updater(home=str(self.home))
        with u.CleanupLock(self.worker):
            try:
                with self.assertRaises(u.Refused):
                    updater.open_paths("acme.plugin")
            finally:
                close(updater)
        updater = u.Updater(home=str(self.home))
        try:
            updater.open_paths("acme.plugin")
            with self.assertRaises(BlockingIOError):
                with u.CleanupLock(self.worker):
                    self.fail("cleanup bypassed update lock")
        finally:
            close(updater)
        with u.CleanupLock(self.worker) as lock:
            lock.check()  # The failed attempt leaked neither locks nor descriptors.
        self.assert_sentinels()

    def test_missing_roots_are_not_created_and_wrong_parent_or_name_is_refused(self):
        tx = self.fixture()
        with u.CleanupLock(self.worker) as lock:
            for name in ("..", ".", "txn-nope", "../" + tx.name, "/" + tx.name):
                result = u.remove_completed(lock, lock.parent(), name, u.CleanupBudget())
                self.assertEqual(result["status"], "refused")
            fd = os.open(self.plugin, u.DIR)
            try:
                result = u.remove_completed(lock, fd, tx.name, u.CleanupBudget())
                self.assertEqual(result["status"], "refused")
            finally:
                os.close(fd)
        self.archive.rmdir()
        with u.CleanupLock(self.worker) as lock:
            with self.assertRaises(FileNotFoundError):
                lock.parent(archived=True)
        self.assertFalse(self.archive.exists())
        self.active.rename(self.root / "saved-active")
        with self.assertRaises(u.Refused):
            with u.CleanupLock(self.worker):
                pass
        self.assertFalse(self.active.exists())
        self.assert_sentinels()

    def test_evidence_and_candidate_replacements_before_mutation_are_refused(self):
        for number, kind in enumerate(("record", "candidate", "active", "archive"), 80):
            tx = self.fixture(number, archived=kind == "archive")
            completed = self.worker.completed_record
            changed = False
            def replace(fd, name):
                nonlocal changed
                evidence = completed(fd, name)
                if not changed:
                    changed = True
                    if kind == "record":
                        (tx / "result.json").write_text('{"status":"updated; reload failed"}')
                    else:
                        path = {"candidate": tx, "active": self.active, "archive": self.archive}[kind]
                        path.rename(path.with_name(path.name + "-saved"))
                        path.mkdir(mode=0o700)
                return evidence
            with patch.object(self.worker, "completed_record", side_effect=replace):
                result = self.remove(tx)
            self.assertEqual(result["status"], "refused", result)
            self.assertFalse((tx / u.CLEANUP_MARKER).exists())
            self.assert_sentinels()

    def test_cancellation_before_and_after_marker(self):
        tx = self.fixture()
        with u.CleanupLock(self.worker) as lock:
            parent = lock.parent()
            before = self.snapshot(tx)
            self.worker.cancelled = True
            result = u.remove_completed(lock, parent, tx.name, u.CleanupBudget())
            self.assertEqual(result["status"], "refused")
            self.worker.cancelled = False
            self.worker.deadline = time.monotonic() - 1
            result = u.remove_completed(lock, parent, tx.name, u.CleanupBudget())
            self.assertEqual(result["status"], "refused")
            self.assertEqual(self.snapshot(tx), before)
        self.worker.deadline = time.monotonic() + 120
        fsync = u.os.fsync
        def cancel(fd):
            fsync(fd)
            if (tx / u.CLEANUP_MARKER).exists():
                self.worker.cancelled = True
        with patch.object(u.os, "fsync", side_effect=cancel):
            result = self.remove(tx)
        self.assertEqual(result["status"], "partial")
        self.assertTrue((tx / "checkout/nested/data").exists())
        self.assertTrue((tx / u.CLEANUP_MARKER).exists())
        self.worker.cancelled = False
        self.unchanged(tx)
        fd = os.open(tx, u.DIR)
        try:
            with self.assertRaisesRegex(u.Refused, "Interrupted cleanup"):
                self.worker.completed_record(fd, tx.name)
        finally:
            os.close(fd)

    def test_unlink_rmdir_and_fsync_failures_report_partial_and_preserve_evidence(self):
        for number, operation in enumerate(("unlink", "rmdir", "fsync"), 100):
            tx = self.fixture(number)
            with patch.object(u.os, operation, side_effect=OSError(5, "private path")):
                result = self.remove(tx)
            self.assertEqual(result["status"], "partial", result)
            self.assertNotIn("private path", result["error"])
            self.assertFalse(result["transactionRemoved"])
            self.assertTrue((tx / u.CLEANUP_MARKER).exists())
            for journal in u.CLEANUP_JOURNALS:
                self.assertTrue((tx / journal).exists())
            self.assertTrue((tx / "checkout").exists())
            self.unchanged(tx)

    def test_backup_first_marker_last_and_final_sync_failure_is_truthful(self):
        tx = self.fixture()
        events = []
        unlink, rmdir, fsync = u.os.unlink, u.os.rmdir, u.os.fsync
        def remove_file(name, **kwargs):
            events.append(name)
            unlink(name, **kwargs)
        def remove_dir(name, **kwargs):
            events.append(name)
            rmdir(name, **kwargs)
        def sync(fd):
            if not tx.exists():
                raise OSError(5, "final parent sync")
            fsync(fd)
        with patch.object(u.os, "unlink", side_effect=remove_file), \
                patch.object(u.os, "rmdir", side_effect=remove_dir), \
                patch.object(u.os, "fsync", side_effect=sync):
            result = self.remove(tx)
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["transactionRemoved"])
        self.assertFalse(tx.exists())
        self.assertEqual(events[:3], ["data", "nested", "checkout"])
        self.assertEqual(events[-2:], [u.CLEANUP_MARKER, tx.name])
        self.assert_sentinels()

    def test_descriptor_bound_and_all_descriptors_close(self):
        tx = self.fixture()
        current = tx / "checkout/nested"
        for number in range(18):
            current = current / str(number)
            current.mkdir()
        for number in range(60):
            (tx / "checkout" / str(number)).touch()
        baseline = len(os.listdir("/proc/self/fd"))
        high = baseline
        original = u.os.open
        def opened(*args, **kwargs):
            nonlocal high
            fd = original(*args, **kwargs)
            high = max(high, len(os.listdir("/proc/self/fd")))
            return fd
        with patch.object(u.os, "open", side_effect=opened):
            self.assertEqual(self.remove(tx)["status"], "removed")
        self.assertLessEqual(high - baseline, 55)
        self.assertEqual(len(os.listdir("/proc/self/fd")), baseline)
        tx = self.fixture(2)
        before = self.snapshot(tx)
        with patch.object(u.os, "scandir", side_effect=OSError(5, "scan")):
            self.assertEqual(self.remove(tx)["status"], "refused")
        self.assertEqual(self.snapshot(tx), before)
        self.assertEqual(len(os.listdir("/proc/self/fd")), baseline)

    def test_mid_deletion_changes_stop_without_following_replacements(self):
        for number, kind in enumerate(("file", "directory", "candidate", "mode", "mount", "cancel"), 120):
            with self.subTest(kind=kind):
                tx = self.fixture(number)
                data = tx / "checkout/nested/data"
                sync, mount = u.os.fsync, u.cleanup_mount_id
                changed = False
                def mutate(fd):
                    nonlocal changed
                    sync(fd)
                    if changed or not (tx / u.CLEANUP_MARKER).exists():
                        return
                    changed = True
                    if kind == "file":
                        data.rename(data.with_name("saved"))
                        data.symlink_to(self.outside)
                    elif kind == "directory":
                        data.parent.rename(tx / "checkout/saved")
                        (tx / "checkout/nested").symlink_to(self.plugin, target_is_directory=True)
                    elif kind == "candidate":
                        tx.rename(tx.with_name(tx.name + "-saved"))
                        tx.mkdir(mode=0o700)
                    elif kind == "mode":
                        (tx / "checkout").chmod(0o777)
                    elif kind == "cancel":
                        self.worker.cancelled = True
                checkout_inode = (tx / "checkout").stat().st_ino
                def mounted(fd):
                    return mount(fd) + (kind == "mount" and changed and
                                        os.fstat(fd).st_ino == checkout_inode)
                with patch.object(u.os, "fsync", side_effect=mutate), \
                        patch.object(u, "cleanup_mount_id", side_effect=mounted):
                    result = self.remove(tx)
                self.worker.cancelled = False
                self.assertEqual(result["status"], "partial", result)
                remaining = tx.with_name(tx.name + "-saved") if kind == "candidate" else tx
                self.assertTrue((remaining / u.CLEANUP_MARKER).exists())
                self.assertTrue((remaining / "result.json").exists())
                self.assert_sentinels()

    def test_cancellation_after_first_unlink_keeps_journals_and_prevents_retry(self):
        tx = self.fixture()
        unlink = u.os.unlink
        def cancel(name, **kwargs):
            unlink(name, **kwargs)
            self.worker.cancelled = True
        with patch.object(u.os, "unlink", side_effect=cancel):
            result = self.remove(tx)
        self.worker.cancelled = False
        self.assertEqual(result["status"], "partial")
        self.assertFalse((tx / "checkout/nested/data").exists())
        self.assertTrue((tx / "checkout").exists())
        self.assertTrue((tx / "result.json").exists())
        self.unchanged(tx)

    def test_marker_creation_and_final_directory_failures_have_distinct_outcomes(self):
        tx = self.fixture()
        opened = u.os.open
        def no_marker(name, *args, **kwargs):
            if name == u.CLEANUP_MARKER:
                raise PermissionError("marker unavailable")
            return opened(name, *args, **kwargs)
        with patch.object(u.os, "open", side_effect=no_marker):
            self.unchanged(tx)
        rmdir = u.os.rmdir
        def no_final(name, **kwargs):
            if name == tx.name:
                raise OSError(5, "final rmdir")
            rmdir(name, **kwargs)
        with patch.object(u.os, "rmdir", side_effect=no_final):
            result = self.remove(tx)
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["transactionRemoved"])
        self.assertEqual(list(tx.iterdir()), [])  # No marker, but no success journals either.
        self.unchanged(tx)

    def test_late_unknown_contents_are_not_removed_and_budget_can_stop_partial_work(self):
        tx = self.fixture()
        sync = u.os.fsync
        def new_entry(fd):
            sync(fd)
            if (tx / u.CLEANUP_MARKER).exists() and not (tx / "unknown").exists():
                (tx / "unknown").write_text("not ours")
        with patch.object(u.os, "fsync", side_effect=new_entry):
            result = self.remove(tx)
        self.assertEqual(result["status"], "partial")
        self.assertEqual((tx / "unknown").read_text(), "not ours")
        self.assertTrue((tx / u.CLEANUP_MARKER).exists())
        self.assertTrue((tx / "result.json").exists())
        self.unchanged(tx)
        tx = self.fixture(2)
        budget = u.CleanupBudget()
        def exhausted(fd):
            sync(fd)
            if (tx / u.CLEANUP_MARKER).exists():
                budget.remaining["work"] = 0
        with patch.object(u.os, "fsync", side_effect=exhausted):
            result = self.remove(tx, budget)
        self.assertEqual(result["status"], "partial")
        self.assertTrue((tx / "result.json").exists())
        self.unchanged(tx)

    def test_no_cleanup_path_enters_update_archival_or_subprocesses(self):
        tx = self.fixture(archived=True)
        with patch.object(u.Updater, "open_paths", side_effect=AssertionError("update")), \
                patch.object(u.Updater, "archive_at_capacity", side_effect=AssertionError("archive")), \
                patch.object(u.subprocess, "Popen", side_effect=AssertionError("spawn")):
            self.assertEqual(self.remove(tx)["status"], "removed")

    def test_real_successful_worker_artifacts_include_indexes_and_nested_backup(self):
        spec = importlib.util.spec_from_file_location("update_fixture", Path(__file__).with_name("test_pinned_update.py"))
        fixtures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixtures)
        fixture = fixtures.TransactionTests("runTest")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        worker = fixture.updater()
        self.assertEqual(worker.execute(fixture.request)["status"], "updated")
        active = fixture.home / ".config/omarchy/plugin-manager-updates"
        tx = next(active.iterdir())
        for name in ("index-before", "index-final"):
            self.assertEqual((tx / name).read_bytes()[:4], b"DIRC")
        self.assertTrue((tx / "checkout/.git/objects").is_dir())
        archive = active.parent / u.ARCHIVE_NAME
        archive.mkdir(mode=0o700)
        tx = tx.rename(archive / tx.name)
        installed = (fixture.plugin / "Helper.py").read_bytes()
        with u.CleanupLock(u.Updater(home=str(fixture.home))) as lock:
            result = u.remove_completed(lock, lock.parent(archived=True), tx.name, u.CleanupBudget())
        self.assertEqual(result["status"], "removed", result)
        self.assertEqual((fixture.plugin / "Helper.py").read_bytes(), installed)
        self.assertEqual(fixture.updater().execute(fixture.install)["status"], "installed")
        tx = next(active.iterdir())
        with u.CleanupLock(u.Updater(home=str(fixture.home))) as lock:
            result = u.remove_completed(lock, lock.parent(), tx.name, u.CleanupBudget())
        self.assertEqual(result["status"], "removed", result)
        self.assertTrue(fixture.new_plugin.is_dir())


class CleanupCommandTests(unittest.TestCase):
    # Reuse disposable history builders, not the primitive test cases.
    setUp = CompletedDeletionTests.setUp
    fixture = CompletedDeletionTests.fixture
    assert_sentinels = CompletedDeletionTests.assert_sentinels
    def test_command_removes_both_roots_and_preserves_other_history(self):
        good = [self.fixture(1), self.fixture(2, archived=True, install=True)]
        bad = self.fixture(3, archived=True)
        (bad / u.CLEANUP_MARKER).touch()
        (self.active / "unknown").touch()
        failed = self.fixture(4)
        (failed / "result.json").write_text('{"status":"updated; reload failed"}')
        incomplete = self.fixture(5, archived=True)
        (incomplete / "result.json").unlink()
        malformed = self.fixture(6)
        (malformed / "request.json").write_text("not json")
        unsafe = self.fixture(7, archived=True)
        (unsafe / "checkout/unsafe").symlink_to(self.outside)
        snapshots = {tx: CompletedDeletionTests.snapshot(tx)
                     for tx in (bad, failed, incomplete, malformed, unsafe)}
        result = u.cleanup_completed(self.worker)
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual((result["discovered"], result["visited"], result["removed"],
                          result["preserved"], result["partial"]), (8, 8, 2, 6, 0))
        self.assertTrue(result["discoveryComplete"])
        self.assertTrue(result["refreshRequired"])
        for tx, before in snapshots.items():
            self.assertEqual(CompletedDeletionTests.snapshot(tx), before)
        self.assertTrue(all(not tx.exists() for tx in good))
        self.assert_sentinels()

    def test_missing_and_archive_only_storage_create_only_the_lock_root(self):
        self.active.rmdir()
        tx = self.fixture(archived=True)
        with patch.object(u.Updater, "open_paths", side_effect=AssertionError("update")), \
                patch.object(u.subprocess, "Popen", side_effect=AssertionError("spawn")):
            result = u.cleanup_completed(self.worker)
        self.assertEqual(result["removed"], 1, result)
        self.assertFalse(tx.exists())
        self.assertEqual(stat.S_IMODE(self.active.stat().st_mode), 0o700)
        self.active.rmdir()
        self.archive.rmdir()
        self.assertEqual(u.cleanup_completed(u.Updater(home=str(self.home)))["status"], "complete")
        self.assertFalse(self.active.exists())
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(u.cleanup_completed(u.Updater(home=home))["status"], "complete")
            self.assertEqual(list(Path(home).iterdir()), [])

    def test_unsafe_roots_and_creation_races_fail_without_deleting(self):
        self.active.rmdir()
        tx = self.fixture(archived=True)
        self.archive.chmod(0o755)
        result = u.cleanup_completed(self.worker)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(self.active.exists())
        self.archive.chmod(0o700)
        with patch.object(u.os, "mkdir", side_effect=FileExistsError("raced")):
            self.assertEqual(u.cleanup_completed(u.Updater(home=str(self.home)))["status"], "failed")
        self.assertFalse(self.active.exists())
        self.active.symlink_to(self.archive, target_is_directory=True)
        self.assertEqual(u.cleanup_completed(u.Updater(home=str(self.home)))["status"], "failed")
        self.assertTrue(tx.exists())

    def test_one_shared_lock_excludes_another_worker_and_never_opens_plugins(self):
        self.fixture()
        self.fixture(2, archived=True)
        remove, opened = u.remove_completed, u.os.open
        locks, budgets = set(), set()
        def checked_open(name, *args, **kwargs):
            self.assertNotEqual(name, "plugins")
            return opened(name, *args, **kwargs)
        def checked_remove(lock, parent, name, budget):
            locks.add(id(lock))
            budgets.add(id(budget))
            with self.assertRaises(BlockingIOError), u.CleanupLock(u.Updater(home=str(self.home))):
                self.fail("second lock admitted")
            return remove(lock, parent, name, budget)
        with patch.object(u.os, "open", side_effect=checked_open), \
                patch.object(u, "remove_completed", side_effect=checked_remove):
            result = u.cleanup_completed(self.worker)
        self.assertEqual(result["removed"], 2, result)
        self.assertEqual((len(locks), len(budgets)), (1, 1))
        with u.CleanupLock(u.Updater(home=str(self.home))):
            refused = u.cleanup_completed(u.Updater(home=str(self.home)))
        self.assertEqual(refused["status"], "failed")
        self.assert_sentinels()

    def test_discovery_caps_early_stop_and_charged_name_metadata(self):
        budget = u.CleanupBudget()
        def entries():
            for number in range(257):
                yield SimpleNamespace(name="unknown-%d" % number)
            self.fail("unbounded discovery")
        with patch.object(u.os, "scandir") as scan, patch.object(u, "CleanupBudget", return_value=budget):
            scan.return_value.__enter__.return_value = entries()
            result = u.cleanup_completed(self.worker)
        self.assertEqual(result["status"], "limited")
        self.assertFalse(result["discoveryComplete"])
        self.assertEqual((result["discovered"], result["preserved"]), (256, 256))
        self.assertEqual(budget.remaining["entries"], 32768 - 257)
        self.assertLess(budget.remaining["metadata"], 4 * 1024 * 1024 - 257 * 128)
        scan.assert_called_once()

    def test_archive_discovery_and_total_caps_apply_before_sorting(self):
        for n in range(257):
            (self.archive / str(n)).touch()
        result = u.cleanup_completed(self.worker)
        self.assertEqual(result["status"], "limited")
        self.assertEqual(result["discovered"], 256)
        self.assertFalse(result["discoveryComplete"])
        with patch.object(u, "CLEANUP_DISCOVERY_TOTAL", 3):
            result = u.cleanup_completed(u.Updater(home=str(self.home)))
        self.assertEqual(result["discovered"], 3)
        self.assertFalse(result["discoveryComplete"])

    def test_candidate_limit_is_shared_and_refusals_do_not_reset_it(self):
        for n in range(129):
            ((self.active if n < 64 else self.archive) / ("txn-%024x" % n)).mkdir(mode=0o700)
        with patch.object(u, "remove_completed", wraps=u.remove_completed) as remove:
            result = u.cleanup_completed(self.worker)
        self.assertEqual(result["status"], "limited")
        self.assertTrue(result["discoveryComplete"])
        self.assertEqual((result["discovered"], result["visited"], result["preserved"]), (129, 128, 128))
        self.assertEqual(remove.call_count, 128)

    def test_one_budget_spans_discovery_candidates_and_refusals(self):
        self.fixture()
        self.fixture(2, archived=True)
        budget = u.CleanupBudget(metadata=70000)
        with patch.object(u, "CleanupBudget", return_value=budget), \
                patch.object(u, "remove_completed", wraps=u.remove_completed) as remove:
            result = u.cleanup_completed(self.worker)
        self.assertEqual((result["status"], result["removed"], result["preserved"]), ("limited", 1, 1))
        self.assertEqual(remove.call_count, 2)
        budget = u.CleanupBudget(entries=0)
        with patch.object(u, "CleanupBudget", return_value=budget), \
                patch.object(u, "remove_completed") as remove:
            result = u.cleanup_completed(u.Updater(home=str(self.home)))
        self.assertEqual(result["status"], "limited")
        remove.assert_not_called()
        self.assertEqual(result["visited"], 0)

    def test_partial_stops_and_final_sync_removal_is_not_confirmed_success(self):
        first = self.fixture()
        second = self.fixture(2, archived=True)
        sync = u.os.fsync
        def failed_sync(fd):
            if not first.exists():
                raise OSError(5, "final sync")
            sync(fd)
        with patch.object(u.os, "fsync", side_effect=failed_sync):
            result = u.cleanup_completed(self.worker)
        self.assertEqual((result["status"], result["removed"], result["partial"],
                          result["removedUnsynced"], result["visited"]), ("partial", 0, 1, 1, 1))
        self.assertTrue(second.exists())
        self.assertTrue(result["error"])

    def test_later_partial_or_fatal_failure_preserves_prior_removal_counts(self):
        self.fixture()
        tx = self.fixture(2, archived=True)
        sync = u.os.fsync
        def fail_after_marker(fd):
            if (tx / u.CLEANUP_MARKER).exists():
                raise OSError(5, "partial")
            sync(fd)
        with patch.object(u.os, "fsync", side_effect=fail_after_marker):
            result = u.cleanup_completed(self.worker)
        self.assertEqual((result["status"], result["removed"], result["partial"]), ("partial", 1, 1))
        self.assertTrue((tx / "result.json").exists())
        self.fixture(3)
        flock = u.fcntl.flock
        def lose_lock(*args):
            if not (self.active / ("txn-%024x" % 3)).exists():
                raise BlockingIOError("transient lock loss")
            return flock(*args)
        with patch.object(u.fcntl, "flock", side_effect=lose_lock):
            result = u.cleanup_completed(u.Updater(home=str(self.home)))
        self.assertEqual((result["status"], result["removed"]), ("failed", 1))
        self.assertTrue(result["error"])

    def test_transient_lock_error_inside_primitive_is_fatal_not_a_skip(self):
        self.fixture()
        self.fixture(2, archived=True)
        remove = u.remove_completed
        def transient(lock, *args):
            with patch.object(u.fcntl, "flock", side_effect=BlockingIOError("busy")):
                return remove(lock, *args)
        with patch.object(u, "remove_completed", side_effect=transient) as called:
            result = u.cleanup_completed(self.worker)
        self.assertEqual((result["status"], result["preserved"]), ("failed", 1))
        self.assertEqual(called.call_count, 1)

    def test_cancellation_deadline_and_unknown_outcomes_do_not_become_success(self):
        self.fixture()
        self.worker.cancelled = True
        self.assertEqual(u.cleanup_completed(self.worker)["status"], "cancelled")
        with patch.object(u, "CleanupBudget", return_value=u.CleanupBudget(seconds=-1)):
            self.assertEqual(u.cleanup_completed(u.Updater(home=str(self.home)))["status"], "limited")
        with patch.object(u, "remove_completed", side_effect=RuntimeError("lost observation")):
            result = u.cleanup_completed(u.Updater(home=str(self.home)))
        self.assertEqual((result["status"], result["unknown"], result["removed"]), ("unknown", 1, 0))
        self.assertTrue(result["refreshRequired"])

    def test_foreground_signals_output_loss_and_strict_schema(self):
        tx = self.fixture()
        unlink = u.os.unlink
        handlers = {sig: u.signal.getsignal(sig) for sig in (u.signal.SIGTERM, u.signal.SIGINT, u.signal.SIGHUP)}
        def cancel(name, **kwargs):
            unlink(name, **kwargs)
            u.signal.raise_signal(u.signal.SIGTERM)
        output = io.StringIO()
        with patch.object(u, "Updater", return_value=self.worker), redirect_stdout(output), \
                patch.object(u.os, "unlink", side_effect=cancel):
            self.assertEqual(u.serve_cleanup_completed(), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "partial")
        self.assertTrue((tx / "result.json").exists())
        self.assertEqual(set(result), {"schemaVersion", "status", "discovered", "visited", "removed",
            "preserved", "partial", "removedUnsynced", "unknown", "discoveryComplete", "refreshRequired", "error"})
        self.assertEqual(result["visited"], sum(result[k] for k in ("removed", "preserved", "partial", "unknown")))
        for sig, handler in handlers.items():
            self.assertEqual(u.signal.getsignal(sig), handler)
        with patch.object(u, "Updater", return_value=u.Updater(home=str(self.home))), \
                patch.object(sys.stdout, "write", side_effect=BrokenPipeError), \
                patch.object(u, "cleanup_completed", wraps=u.cleanup_completed) as cleanup:
            self.assertEqual(u.serve_cleanup_completed(), 1)
            cleanup.assert_called_once()

    def test_exact_cli_has_no_path_or_option_overrides(self):
        cli = UpdateDataTests.cli
        code, result = cli(self, ["--cleanup-completed"])
        self.assertEqual((code, result["status"]), (0, "complete"))
        for args in (["--cleanup-completed", str(self.home)], ["--cleanup-completed=/tmp"],
                     ["--cleanup-completed", "--update-data-status"], ["--cleanup-completed", "--force"]):
            code, result = cli(self, args)
            self.assertEqual((code, result["status"]), (1, "unchanged; request refused"))

    def test_initialization_failure_has_bounded_json_and_exit_one(self):
        code, result = UpdateDataTests.cli(self, ["--cleanup-completed"], passwd=KeyError("missing"))
        self.assertEqual((code, result["status"], result["removed"]), (1, "failed", 0))
        self.assertTrue(result["error"])

    def test_all_cancellation_signals_before_mutation_and_flush_failure(self):
        self.fixture()
        spend = u.CleanupBudget.spend
        for sig in (u.signal.SIGTERM, u.signal.SIGINT, u.signal.SIGHUP):
            worker = u.Updater(home=str(self.home))
            def cancel(budget, worker, **costs):
                u.signal.raise_signal(sig)
                spend(budget, worker, **costs)
            output = io.StringIO()
            with patch.object(u, "Updater", return_value=worker), redirect_stdout(output), \
                    patch.object(u.CleanupBudget, "spend", cancel):
                self.assertEqual(u.serve_cleanup_completed(), 1)
            result = json.loads(output.getvalue())
            self.assertEqual((result["status"], result["visited"]), ("cancelled", 0))
        output = io.StringIO()
        worker = u.Updater(home=str(self.home))
        with patch.object(u, "Updater", return_value=worker), redirect_stdout(output), \
                patch.object(output, "flush", side_effect=BrokenPipeError):
            self.assertEqual(u.serve_cleanup_completed(), 1)
        self.assertEqual(json.loads(output.getvalue())["removed"], 1)
        self.assertEqual(list(self.active.iterdir()), [])

    def test_late_scan_failure_keeps_unknown_remaining_not_a_zero_recount(self):
        (self.active / "unknown").touch()
        scan = u.os.scandir
        calls = 0
        def fail_archive(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise PermissionError("archive changed")
            return scan(fd)
        with patch.object(u.os, "scandir", side_effect=fail_archive):
            result = u.cleanup_completed(self.worker)
        self.assertEqual((result["status"], result["discovered"], result["visited"]), ("failed", 1, 0))
        self.assertFalse(result["discoveryComplete"])
        self.assertNotIn("activeCount", result)
        self.assertTrue(result["refreshRequired"])

    def test_real_worker_indexes_in_both_roots(self):
        spec = importlib.util.spec_from_file_location("cleanup_fixture", Path(__file__).with_name("test_pinned_update.py"))
        fixtures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixtures)
        fixture = fixtures.TransactionTests("runTest")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.assertEqual(fixture.updater().execute(fixture.request)["status"], "updated")
        active = fixture.home / ".config/omarchy/plugin-manager-updates"
        archive = active.parent / u.ARCHIVE_NAME
        archive.mkdir(mode=0o700)
        tx = next(active.iterdir())
        self.assertEqual((tx / "index-before").read_bytes()[:4], b"DIRC")
        tx.rename(archive / tx.name)
        fixture.request.update(expectedLocalHead=fixture.target, verifiedCommit=fixture.tip)
        fixture.catalog["plugins"][0]["verificationCommit"] = fixture.tip
        self.assertEqual(fixture.updater().execute(fixture.request)["status"], "updated")
        self.assertEqual((next(active.iterdir()) / "index-final").read_bytes()[:4], b"DIRC")
        installed = (fixture.plugin / "Helper.py").read_bytes()
        result = u.cleanup_completed(u.Updater(home=str(fixture.home)))
        self.assertEqual((result["status"], result["removed"]), ("complete", 2), result)
        self.assertEqual((fixture.plugin / "Helper.py").read_bytes(), installed)


if __name__ == "__main__":
    unittest.main()
