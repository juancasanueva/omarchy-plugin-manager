"""Transaction tests use disposable Git repositories, never installed plugins."""
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import signal
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "pinned_update", Path(__file__).resolve().parents[1] / "helpers/pinned_update.py")
u = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(u)
REPO = "https://github.com/acme/plugin"


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.plugin = self.home / ".config/omarchy/plugins/acme.plugin"
        self.plugin.mkdir(parents=True)
        self.remote = Path(self.tmp.name) / "remote"
        self.git("init", "-q", str(self.remote))
        self.git("-C", str(self.remote), "config", "user.email", "fixture@example.invalid")
        self.git("-C", str(self.remote), "config", "user.name", "Fixture")
        self.manifest = dict(schemaVersion=1, id="acme.plugin", name="Fixture",
                             version="1", kinds=["service"], entryPoints={"service": "Main.qml"})
        (self.remote / "manifest.json").write_text(json.dumps(self.manifest))
        (self.remote / ".gitignore").write_text("ignored\n")
        helper_source = Path(SPEC.origin).read_text()
        (self.remote / "Helper.py").write_text(helper_source)
        self.base = self.commit("base")
        self.git("clone", "--no-hardlinks", "-q", str(self.remote), str(self.plugin))
        self.git("-C", str(self.plugin), "remote", "set-url", "origin", REPO)
        (self.remote / "Helper.py").write_text(helper_source + "\n# Updated fixture source.\n")
        self.target = self.commit("verified")
        self.tip = self.commit("unreviewed tip")
        self.request = dict(schemaVersion=1, id="acme.plugin", repository=REPO,
                            verifiedCommit=self.target, expectedLocalHead=self.base)
        self.catalog = {"plugins": [dict(id="acme.plugin", repo=REPO,
            verificationStatus="verified", verificationCommit=self.target, sourceType="community")]}
        outer = self

        class FixtureUpdater(u.Updater):
            def catalog_bytes(self):
                return json.dumps(outer.catalog).encode()

            def fetch(self, stage, sha):
                # In-process transport injection only. The production fetch has
                # no environment/argv escape hatch for repository endpoints.
                self.git(stage, "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--depth=256",
                         "file://" + str(outer.remote), sha, extra_env={"GIT_ALLOW_PROTOCOL": "file"})

            def reload(self):
                outer.reloaded = True

        self.updater = lambda: FixtureUpdater(home=str(self.home))
        self.reloaded = False

    def git(self, *args):
        result = subprocess.run(["/usr/bin/git", *args], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=10, env={"PATH": "/usr/bin:/bin",
            "HOME": self.tmp.name, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"})
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return result.stdout.decode().strip()

    def commit(self, text):
        (self.remote / "Main.qml").write_text(text)
        self.git("-C", str(self.remote), "add", ".")
        self.git("-C", str(self.remote), "commit", "-qm", text)
        return self.git("-C", str(self.remote), "rev-parse", "HEAD")

    def test_scan_sees_entries_another_process_added_after_the_dirfd_opened(self):
        # Regression for the "Staged contents changed" refusal on btrfs: the
        # staging dirfd is opened while the directory is still empty, then git
        # checkout (another process) populates that inode. On btrfs the
        # long-held fd kept reporting an empty listing, so scan() saw nothing
        # and refused a perfectly good checkout. scan() must reopen the inode
        # for enumeration. The directory lives under HOME so the test lands on
        # the same filesystem as real checkouts rather than a tmpfs /tmp.
        with tempfile.TemporaryDirectory(dir=str(Path.home())) as scratch:
            root = Path(scratch) / "checkout"
            root.mkdir(mode=0o700)
            fd = os.open(str(root), u.DIR)
            try:
                subprocess.run(["/usr/bin/touch", "--", str(root / "a.txt"), str(root / "b.txt")],
                               check=True, env={"PATH": "/usr/bin:/bin"})
                (root / "sub").mkdir(mode=0o700)
                subprocess.run(["/usr/bin/touch", "--", str(root / "sub" / "c.txt")],
                               check=True, env={"PATH": "/usr/bin:/bin"})
                result = u.Updater(home=scratch).scan(fd, skip_git=True)
            finally:
                os.close(fd)
        self.assertEqual(set(result), {"a.txt", "b.txt", "sub/c.txt"})

    def test_unverified_request_installs_the_observed_tip_without_the_catalog(self):
        # The user's setting allows an upstream commit nobody reviewed. The
        # helper never consults the catalog for it, but every other check
        # still applies, and the transaction records which kind it was.
        updater = self.updater()

        def never(*_):
            raise AssertionError("the catalog is not consulted for an unverified request")
        updater.catalog_bytes = never
        request = dict(schemaVersion=1, id="acme.plugin", repository=REPO,
                       unverifiedCommit=self.tip, expectedLocalHead=self.base)
        result = updater.execute(request)
        self.assertEqual(result["status"], "updated")
        self.assertEqual((self.plugin / "Main.qml").read_text(), "unreviewed tip")
        self.assertEqual(self.git("-C", str(self.plugin), "rev-parse", "HEAD"), self.tip)
        self.assertTrue(self.reloaded)
        journaled = json.loads((Path(result["backup"]).parent / "request.json").read_text())
        self.assertEqual(journaled, request)
        self.assertNotIn("verifiedCommit", journaled)
        self.assertNotIn("target", journaled)
        # The notification names the kind, without any remote prose.
        calls = []
        updater.run = lambda argv, **kwargs: calls.append(argv) or b""
        updater.notify(u.request_value(request), result)
        self.assertEqual(calls[0][3], "Pinned plugin update (unverified)")
        self.assertEqual(calls[0][4], "acme.plugin: updated")
        calls.clear()
        updater.notify(u.request_value(self.request), result)
        self.assertEqual(calls[0][3], "Pinned plugin update")

    def test_unverified_request_keeps_every_other_refusal(self):
        # A non-fast-forward target refuses exactly as a verified one would.
        self.git("-C", str(self.remote), "checkout", "-q", "--detach", self.base)
        divergent = self.commit("other branch")
        for target in (divergent, self.base):
            self.git("-C", str(self.plugin), "fetch", "-q", str(self.remote), self.target)
            self.git("-C", str(self.plugin), "checkout", "-q", "--detach", self.target)
            request = dict(schemaVersion=1, id="acme.plugin", repository=REPO,
                           unverifiedCommit=target, expectedLocalHead=self.target)
            updater = self.updater()
            updater.catalog_bytes = lambda: (_ for _ in ()).throw(AssertionError("no catalog"))
            with self.subTest(target=target), self.assertRaises(u.Refused):
                updater.execute(request)
            self.assertEqual((self.plugin / "Main.qml").read_text(), "verified")
        # The two shapes are exact: no mixing, no extras, full lowercase SHA-1.
        for bad in (dict(verifiedCommit=self.target, unverifiedCommit=self.tip),
                    dict(unverifiedCommit=self.tip, extra=1), dict(unverifiedCommit=self.tip[:39]),
                    dict(unverifiedCommit="g" * 40), dict()):
            value = dict(schemaVersion=1, id="acme.plugin", repository=REPO, expectedLocalHead=self.base, **bad)
            with self.subTest(bad=bad), self.assertRaises(u.Refused):
                u.request_value(value)
        normalized = u.request_value(dict(schemaVersion=1, id="acme.plugin", repository=REPO,
                                          unverifiedCommit=self.tip.upper(), expectedLocalHead=self.base))
        self.assertEqual(normalized["target"], self.tip)
        self.assertFalse(normalized["verified"])
        self.assertEqual(u.request_value(normalized), normalized, "a normalized request validates again unchanged")
        self.assertTrue(u.request_value(self.request)["verified"])

    def test_installs_verified_commit_not_remote_head_and_keeps_backup(self):
        result = self.updater().execute(self.request)
        self.assertEqual(result["status"], "updated")
        self.assertEqual((self.plugin / "Main.qml").read_text(), "verified")
        self.assertEqual(self.git("-C", str(self.plugin), "rev-parse", "HEAD"), self.target)
        self.assertEqual(self.git("-C", str(self.plugin), "remote", "get-url", "origin"), REPO)
        self.assertEqual((Path(result["backup"]) / "Main.qml").read_text(), "base")
        self.assertTrue(self.reloaded)

    def test_production_transport_contracts_without_network(self):
        updater = u.Updater(home=str(self.home))
        real_popen = subprocess.Popen
        calls = []
        response = b'{"plugins":[]}\n200'

        def spy(argv, **kwargs):
            calls.append((argv, kwargs))
            # Exercise the real bounded supervisor, replacing only its child
            # executable. Neither production transport method is overridden.
            return real_popen(["/usr/bin/python3", "-I", "-S", "-c",
                               "import os; os.write(1, " + repr(response) + ")"], **kwargs)
        with patch.object(subprocess, "Popen", side_effect=spy):
            self.assertEqual(updater.catalog_bytes(), b'{"plugins":[]}')
            curl, options = calls[-1]
            self.assertEqual(curl, ["/usr/bin/curl", "-q", "--fail", "--silent", "--show-error",
                "--proto", "=https", "--noproxy", "*", "--connect-timeout", "5", "--max-time", "20",
                "--max-filesize", str(u.MAX_CATALOG), "--header", "Cache-Control: no-cache",
                "--write-out", "\n%{http_code}", "--", "https://plugins.omarchy.org/catalog.json"])
            self.assertTrue(options["start_new_session"])
            self.assertEqual(options["env"]["GIT_ALLOW_PROTOCOL"], "https")
            for status in (b"301", b"302", b"307", b"308", b"404"):
                response = b'{"plugins":[]}\n' + status
                with self.subTest(status=status), self.assertRaises(u.Refused):
                    updater.catalog_bytes()
            response = b""
            fd = os.open(self.plugin, u.DIR)
            try:
                updater.fetch(fd, self.target)
            finally:
                os.close(fd)
            argv, options = calls[-1]
            self.assertEqual(argv[0], "/usr/bin/git")
            self.assertEqual(argv[argv.index("fetch"):], ["fetch", "--quiet", "--no-tags",
                "--no-recurse-submodules", "--depth=256", "origin", self.target])
            for setting in ("core.hooksPath=/dev/null", "protocol.allow=never",
                            "protocol.https.allow=always", "http.followRedirects=false"):
                self.assertIn(setting, argv)
            self.assertEqual(options["cwd"], f"/proc/self/fd/{fd}")

    def test_packed_nested_head_without_loose_parent_updates(self):
        self.git("-C", str(self.plugin), "branch", "-m", "feature/example")
        self.git("-C", str(self.plugin), "pack-refs", "--all", "--prune")
        self.assertFalse((self.plugin / ".git/refs/heads/feature").exists())
        result = self.updater().execute(self.request)
        self.assertEqual(result["status"], "updated")
        self.assertEqual((self.plugin / "Main.qml").read_text(), "verified")

    def test_packed_fallback_never_bypasses_unsafe_loose_parent(self):
        self.git("-C", str(self.plugin), "branch", "-m", "feature/example")
        self.git("-C", str(self.plugin), "pack-refs", "--all", "--prune")
        parent = self.plugin / ".git/refs/heads/feature"
        parent.symlink_to(self.remote, target_is_directory=True)
        with self.assertRaises((u.Refused, OSError)):
            self.updater().execute(self.request)
        self.assertEqual((self.plugin / "Main.qml").read_text(), "base")

    def test_revocation_refuses_before_changing_checkout(self):
        self.catalog["plugins"][0]["verificationStatus"] = "unverified"
        with self.assertRaises(u.Refused):
            self.updater().execute(self.request)
        self.assertEqual((self.plugin / "Main.qml").read_text(), "base")
        self.assertFalse(self.reloaded)

    def test_exact_tuple_rejections(self):
        entry = self.catalog["plugins"][0]
        for change in ({"repo": "https://github.com/other/plugin"},
                       {"verificationCommit": self.tip}, {"verificationCommit": "a" * 64},
                       {"verificationStatus": None}, {"sourceType": "builtin"}):
            with self.subTest(change=change):
                self.catalog["plugins"] = [{**entry, **change}]
                with self.assertRaises(u.Refused):
                    self.updater().execute(self.request)
        self.catalog["plugins"] = [entry, entry]
        with self.assertRaises(u.Refused):
            self.updater().execute(self.request)
        self.assertEqual((self.plugin / "Main.qml").read_text(), "base")

    def test_repository_boundary(self):
        for origin in (REPO, REPO + ".git", "git@github.com:ACME/plugin.git",
                       "ssh://git@github.com/acme/plugin.git"):
            self.assertEqual(u.repository(origin), REPO)
        for origin in (REPO + "/extra", REPO + "?x=1", REPO + "#x", REPO + "\n",
                       "https://user@github.com/acme/plugin", "https://github.com:443/acme/plugin",
                       "https://evil.test/acme/plugin", "https://github.com/acme/%70lugin",
                       "ssh://root@github.com/acme/plugin", " https://github.com/acme/plugin",
                       "https://github.com/acme/../plugin", "https://github.com/acme\\plugin"):
            self.assertEqual(u.repository(origin), "", origin)

    def test_dirty_index_untracked_ignored_and_symlink_refuse(self):
        for kind in ("dirty", "index", "untracked", "ignored", "symlink", "assume-unchanged"):
            with self.subTest(kind=kind):
                path = self.plugin / "Main.qml"
                if kind == "index":
                    path.write_text("staged change")
                    self.git("-C", str(self.plugin), "add", "Main.qml")
                    path.write_text("base")
                elif kind == "assume-unchanged":
                    self.git("-C", str(self.plugin), "update-index", "--assume-unchanged", "Main.qml")
                elif kind in ("untracked", "ignored"):
                    path = self.plugin / kind
                    path.write_text("user data")
                elif kind == "symlink":
                    path = self.plugin / "link"
                    path.symlink_to(self.remote / "Main.qml")
                else:
                    path.write_text("local edit")
                before = path.read_bytes()
                with self.assertRaises(u.Refused):
                    self.updater().execute(self.request)
                self.assertEqual(path.read_bytes(), before)
                self.assertFalse(self.reloaded)
                # Fixture cleanup restores only this test's own disposable data.
                if kind == "index":
                    self.git("-C", str(self.plugin), "add", "Main.qml")
                elif kind == "assume-unchanged":
                    self.git("-C", str(self.plugin), "update-index", "--no-assume-unchanged", "Main.qml")
                elif kind in ("untracked", "ignored", "symlink"):
                    path.unlink()
                else:
                    path.write_text("base")

    def test_checkout_and_git_directory_symlinks_refuse(self):
        for name in (self.plugin, self.plugin / ".git"):
            saved = name.with_name(name.name + "-saved")
            name.rename(saved)
            name.symlink_to(saved, target_is_directory=True)
            with self.assertRaises((u.Refused, OSError)):
                self.updater().execute(self.request)
            self.assertEqual((self.plugin / "Main.qml").read_text(), "base")
            name.unlink()
            saved.rename(name)

    def test_fetch_wrong_object_unavailable_and_validation_failure_leave_original(self):
        for phase in ("fetch", "wrong-object", "unavailable", "validate"):
            updater = self.updater()
            if phase == "fetch":
                updater.fetch = lambda *_: u.require(False, "fetch failure")
            elif phase == "wrong-object":
                original = updater.fetch
                updater.fetch = lambda stage, sha: original(stage, self.tip)
            elif phase == "unavailable":
                self.request["verifiedCommit"] = "1" * 40
                self.catalog["plugins"][0]["verificationCommit"] = "1" * 40
            else:
                updater.validate = lambda *_: u.require(False, "validator failure")
            with self.subTest(phase=phase), self.assertRaises(u.Refused):
                updater.execute(self.request)
            self.request["verifiedCommit"] = self.target
            self.catalog["plugins"][0]["verificationCommit"] = self.target
            self.assertEqual((self.plugin / "Main.qml").read_text(), "base")
            self.assertFalse(self.reloaded)

    def test_divergence_and_downgrade_refuse(self):
        self.git("-C", str(self.remote), "checkout", "-q", "--detach", self.base)
        divergent = self.commit("other branch")
        for target in (divergent, self.base):
            self.git("-C", str(self.plugin), "fetch", "-q", str(self.remote), self.target)
            self.git("-C", str(self.plugin), "checkout", "-q", "--detach", self.target)
            self.request.update(verifiedCommit=target, expectedLocalHead=self.target)
            self.catalog["plugins"][0]["verificationCommit"] = target
            with self.assertRaises(u.Refused):
                self.updater().execute(self.request)
            self.assertEqual((self.plugin / "Main.qml").read_text(), "verified")

    def test_reauthorization_and_last_minute_local_edits(self):
        for change in ("revoke", "edit", "origin", "head"):
            updater = self.updater()
            calls = 0
            original = updater.catalog_bytes

            def catalog():
                nonlocal calls
                calls += 1
                if calls == 2:
                    if change == "revoke":
                        return b'{"plugins":[]}'
                    if change == "edit":
                        (self.plugin / "Main.qml").write_text("later edit")
                    elif change == "origin":
                        self.git("-C", str(self.plugin), "remote", "set-url", "origin", REPO + "-other")
                    else:
                        (self.plugin / ".git/HEAD").write_text(self.tip + "\n")
                return original()
            updater.catalog_bytes = catalog
            with self.subTest(change=change), self.assertRaises(u.Refused):
                updater.execute(self.request)
            self.assertFalse(updater.published)
            if change == "edit":
                self.assertEqual((self.plugin / "Main.qml").read_text(), "later edit")
                (self.plugin / "Main.qml").write_text("base")
            elif change == "origin":
                self.git("-C", str(self.plugin), "remote", "set-url", "origin", REPO)

    def test_concurrent_request_is_locked(self):
        updater = self.updater()
        original = updater.fetch

        def fetch(stage, sha):
            with self.assertRaisesRegex(u.Refused, "Another pinned update"):
                self.updater().execute(self.request)
            original(stage, sha)
        updater.fetch = fetch
        self.assertEqual(updater.execute(self.request)["status"], "updated")

    def test_cancellation_on_each_side_of_exchange(self):
        updater = self.updater()
        original = updater.checkpoint

        def checkpoint(phase):
            if phase == "before-exchange":
                updater.cancelled = True
            original(phase)
        updater.checkpoint = checkpoint
        with self.assertRaises(u.Refused):
            updater.execute(self.request)
        self.assertEqual((self.plugin / "Main.qml").read_text(), "base")
        updater = self.updater()
        original = updater.checkpoint

        def after(phase):
            if phase == "after-exchange":
                updater.cancelled = True
            original(phase)
        updater.checkpoint = after
        self.assertEqual(updater.execute(self.request)["status"], "updated; reload failed")
        self.assertEqual((self.plugin / "Main.qml").read_text(), "verified")

    def test_reload_failure_and_repeated_update_preserve_backups(self):
        updater = self.updater()
        updater.reload = lambda: u.require(False, "reload failed")
        first = updater.execute(self.request)
        self.assertEqual(first["status"], "updated; reload failed")
        self.request.update(expectedLocalHead=self.target, verifiedCommit=self.tip)
        self.catalog["plugins"][0]["verificationCommit"] = self.tip
        second = self.updater().execute(self.request)
        self.assertEqual(second["status"], "updated")
        self.assertEqual((Path(first["backup"]) / "Main.qml").read_text(), "base")
        self.assertEqual((Path(second["backup"]) / "Main.qml").read_text(), "verified")

    def test_worker_survives_observer_death_and_source_directory_exchange(self):
        observer = os.fork()
        if observer == 0:
            observer_pid = os.getpid()
            spec = importlib.util.spec_from_file_location("installed_helper", self.plugin / "Helper.py")
            installed = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(installed)
            fixture_type = type(self.updater())
            installed_type = type("InstalledUpdater", (installed.Updater,), {
                "catalog_bytes": fixture_type.catalog_bytes, "fetch": fixture_type.fetch,
                "reload": fixture_type.reload})
            updater = installed_type(home=str(self.home))
            checkpoint = updater.checkpoint

            def interrupt(phase):
                if phase == "before-exchange":
                    os.kill(observer_pid, signal.SIGKILL)
                checkpoint(phase)
            updater.checkpoint = interrupt
            # No desktop notification in the disposable runtime harness.
            updater.notify = lambda *_: None
            try:
                installed.launch(self.request, lambda: updater)
            finally:
                os._exit(0)
        _, status = os.waitpid(observer, 0)
        self.assertTrue(os.WIFSIGNALED(status))
        deadline = time.monotonic() + 5
        records = []
        state = self.home / ".config/omarchy/plugin-manager-updates"
        while time.monotonic() < deadline:
            records = list(state.glob("txn-*/result.json")) if state.exists() else []
            if records:
                break
            time.sleep(0.01)
        self.assertEqual(len(records), 1, "independent worker must finish after observer SIGKILL")
        self.assertEqual(json.loads(records[0].read_text())["status"], "updated")
        self.assertEqual((self.plugin / "Main.qml").read_text(), "verified")

    def test_bounded_commands_and_clean_environment(self):
        updater = self.updater()
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream), self.assertRaises(u.Refused):
                updater.run(["/usr/bin/python3", "-I", "-S", "-c",
                             f"import sys; sys.{stream}.write('x'*100000)"], cap=64)
        updater.deadline = time.monotonic() + 0.1
        with self.assertRaises(u.Refused):
            updater.run(["/usr/bin/python3", "-I", "-S", "-c", "import time; time.sleep(30)"])
        child_pid = Path(self.tmp.name) / "descendant-pid"
        updater = self.updater()
        updater.deadline = time.monotonic() + 0.2
        script = ("import subprocess,sys,time; p=subprocess.Popen(['/usr/bin/sleep','30']); "
                  "open(sys.argv[1],'w').write(str(p.pid)); time.sleep(30)")
        with self.assertRaises(u.Refused):
            updater.run(["/usr/bin/python3", "-I", "-S", "-c", script, str(child_pid)])
        pid = int(child_pid.read_text())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.01)
        else:
            self.fail("command left a descendant alive")
        updater = self.updater()
        with patch.dict(os.environ, {"GIT_CONFIG_COUNT": "1", "BASH_ENV": "/untrusted",
                                    "GIT_DIR": "/untrusted", "PATH": "/untrusted"}):
            raw = updater.run(["/usr/bin/python3", "-I", "-S", "-c",
                              "import os,json; print(json.dumps(dict(os.environ)))"])
        environment = json.loads(raw)
        self.assertEqual(environment["PATH"], "/usr/bin:/bin")
        self.assertNotIn("BASH_ENV", environment)
        self.assertNotIn("GIT_DIR", environment)
        with self.assertRaises(u.Refused):
            u.authorize(b'{"plugins":[],"plugins":[]}', self.request)
        with self.assertRaises(u.Refused):
            u.authorize(b" " * (u.MAX_CATALOG + 1), self.request)

    def test_refusal_reports_reason_and_journals_it(self):
        (self.plugin / "untracked.txt").write_text("local edit")
        updater = self.updater()
        with self.assertRaises(u.Refused):
            updater.execute(self.request)
        self.assertEqual(updater.reason, "Dirty, untracked or ignored files present")
        state = self.home / ".config/omarchy/plugin-manager-updates"
        records = list(state.glob("txn-*/refused.json"))
        self.assertEqual(len(records), 1)
        self.assertEqual(json.loads(records[0].read_text()), {"reason": updater.reason})
        self.assertEqual(oct(records[0].stat().st_mode & 0o777), "0o600")
        self.assertEqual((self.plugin / "Main.qml").read_text(), "base")
        # Non-Refused failures expose only the exception class, never its text.
        self.assertEqual(u.reason_text(RuntimeError("/home/secret/path")), "Internal error: RuntimeError")
        self.assertEqual(u.reason_text(u.Refused("bad\x00\x1b\u00e9text" + "x" * 300)), "badtext" + "x" * 193)

    def test_worker_result_carries_reason(self):
        (self.plugin / "untracked.txt").write_text("local edit")
        read_end, write_end = os.pipe()
        observer = os.fork()
        if observer == 0:
            os.close(read_end)
            os.dup2(write_end, 1)
            updater = self.updater()
            updater.notify = lambda *_: None
            try:
                u.launch(self.request, lambda: updater)
            finally:
                os._exit(0)
        os.close(write_end)
        os.waitpid(observer, 0)
        with os.fdopen(read_end, "rb") as pipe:
            result = json.loads(pipe.read())
        self.assertEqual(result["status"], "unchanged; update refused")
        self.assertEqual(result["reason"], "Dirty, untracked or ignored files present")

    def test_unsupported_exchange_is_unchanged(self):
        with patch.object(u, "EXCHANGE", None), self.assertRaises(u.Refused):
            self.updater().execute(self.request)
        self.assertEqual((self.plugin / "Main.qml").read_text(), "base")

    def test_staged_symlink_and_manifest_id_change_refuse(self):
        (self.remote / "link").symlink_to("Main.qml")
        bad = self.commit("symlink snapshot")
        self.request["verifiedCommit"] = bad
        self.catalog["plugins"][0]["verificationCommit"] = bad
        with self.assertRaises(u.Refused):
            self.updater().execute(self.request)
        (self.remote / "link").unlink()
        self.manifest["id"] = "acme.changed"
        (self.remote / "manifest.json").write_text(json.dumps(self.manifest))
        bad = self.commit("changed id")
        self.request["verifiedCommit"] = bad
        self.catalog["plugins"][0]["verificationCommit"] = bad
        with self.assertRaises(u.Refused):
            self.updater().execute(self.request)
        self.assertEqual((self.plugin / "Main.qml").read_text(), "base")


if __name__ == "__main__":
    unittest.main()
