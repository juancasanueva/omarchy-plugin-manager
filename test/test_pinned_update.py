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
import stat
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "pinned_update", Path(__file__).resolve().parents[1] / "helpers/pinned_update.py")
u = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(u)
REPO = "https://github.com/acme/plugin"
NEW_REPO = "https://github.com/acme/newplugin"
NEW_ID = "acme.newplugin"


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
        # A second disposable repository nothing has installed yet, so an
        # install can be exercised without touching the update fixture.
        self.new_remote = Path(self.tmp.name) / "new-remote"
        self.git("init", "-q", str(self.new_remote))
        self.git("-C", str(self.new_remote), "config", "user.email", "fixture@example.invalid")
        self.git("-C", str(self.new_remote), "config", "user.name", "Fixture")
        self.new_manifest = dict(schemaVersion=1, id=NEW_ID, name="New Fixture", version="1",
                                 kinds=["bar-widget"], entryPoints={"barWidget": "BarWidget.qml"})
        (self.new_remote / "manifest.json").write_text(json.dumps(self.new_manifest))
        self.new_commits = ()
        self.new_base = self.new_commit("first")
        # The verified snapshot is deliberately not the remote tip.
        self.new_target = self.new_commit("verified snapshot")
        self.new_tip = self.new_commit("unreviewed tip")
        self.install = dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                            verifiedCommit=self.new_target, section="right")
        self.catalog = {"plugins": [
            dict(id="acme.plugin", repo=REPO, verificationStatus="verified",
                 verificationCommit=self.target, sourceType="community"),
            dict(id=NEW_ID, repo=NEW_REPO, verificationStatus="verified",
                 verificationCommit=self.new_target, sourceType="community")]}
        outer = self

        class FixtureUpdater(u.Updater):
            def catalog_bytes(self):
                return json.dumps(outer.catalog).encode()

            def fetch(self, stage, sha):
                # In-process transport injection only. The production fetch has
                # no environment/argv escape hatch for repository endpoints.
                source = outer.new_remote if sha in outer.new_commits else outer.remote
                self.git(stage, "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--depth=256",
                         "file://" + str(source), sha, extra_env={"GIT_ALLOW_PROTOCOL": "file"})

            def reload(self):
                outer.reloaded = True

            def enable(self, plugin_id, section):
                outer.enabled.append((plugin_id, section))

        self.updater = lambda: FixtureUpdater(home=str(self.home))
        self.reloaded = False
        self.enabled = []

    @property
    def new_plugin(self):
        return self.home / ".config/omarchy/plugins" / NEW_ID

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

    def new_commit(self, text):
        (self.new_remote / "BarWidget.qml").write_text(text)
        self.git("-C", str(self.new_remote), "add", ".")
        self.git("-C", str(self.new_remote), "commit", "-qm", text)
        sha = self.git("-C", str(self.new_remote), "rev-parse", "HEAD")
        self.new_commits = (*self.new_commits, sha)
        return sha

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
        # The derived keys carry no authority. A request that arrives already
        # claiming to be verified, or naming another target, has both
        # recomputed from its commit key; nothing on argv can promote an
        # unreviewed commit or swap the commit the checks bind to.
        injected = u.request_value(dict(schemaVersion=1, id="acme.plugin", repository=REPO,
                                        unverifiedCommit=self.tip, expectedLocalHead=self.base,
                                        verified=True, target=self.target))
        self.assertFalse(injected["verified"])
        self.assertEqual(injected["target"], self.tip)
        self.assertNotIn("verifiedCommit", injected)
        with self.assertRaises(u.Refused):
            u.request_value(dict(schemaVersion=1, id="acme.plugin", repository=REPO,
                                 unverifiedCommit=self.tip, expectedLocalHead=self.base, verified=True, extra=1))

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
            # The install path's host commands: absolute argv arrays, the
            # account's own HOME and a fixed OMARCHY_PATH, never the ambient
            # environment, and never a shell string.
            response = b'[{"id":"' + NEW_ID.encode() + b'"}]'
            self.assertIn(NEW_ID, updater.catalog_ids())
            argv, options = calls[-1]
            self.assertEqual(argv, ["/usr/bin/omarchy-plugin-catalog"])
            self.assertEqual(options["env"]["HOME"], str(self.home))
            self.assertEqual(options["env"]["OMARCHY_PATH"], "/usr/share/omarchy")
            self.assertEqual(options["env"]["PATH"], "/usr/bin:/bin")
            with patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-1"}):
                updater.enable(NEW_ID, "right")
                self.assertEqual(calls[-2][0], ["/usr/bin/omarchy-plugin-list", "--json"])
                self.assertEqual(calls[-1][0],
                                 ["/usr/bin/omarchy-plugin-enable", NEW_ID, "--section", "right"])
                self.assertEqual(calls[-1][1]["env"]["WAYLAND_DISPLAY"], "wayland-1")
                self.assertEqual(calls[-1][1]["env"]["XDG_RUNTIME_DIR"], f"/run/user/{os.getuid()}")
                # No section is a plain enable, not a placement: the host
                # refuses --section for a plugin that replaces the whole bar.
                updater.enable(NEW_ID, "")
                self.assertEqual(calls[-1][0], ["/usr/bin/omarchy-plugin-enable", NEW_ID])
                for bad in ("Right", "left right", "../left", "--index"):
                    with self.subTest(section=bad), self.assertRaises(u.Refused):
                        updater.enable(NEW_ID, bad)
            with patch.dict(os.environ, {"WAYLAND_DISPLAY": "not-a-display"}), self.assertRaises(u.Refused):
                updater.enable(NEW_ID, "right")

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

    # ---- Installs -----------------------------------------------------------

    def test_install_publishes_the_verified_commit_not_remote_head_and_enables(self):
        result = self.updater().execute(self.install)
        self.assertEqual(result, {"status": "installed"})
        self.assertNotIn("backup", result, "an install replaces nothing, so it restores nothing")
        self.assertEqual((self.new_plugin / "BarWidget.qml").read_text(), "verified snapshot")
        self.assertEqual(self.git("-C", str(self.new_plugin), "rev-parse", "HEAD"), self.new_target)
        self.assertEqual(self.git("-C", str(self.new_plugin), "remote", "get-url", "origin"), NEW_REPO)
        # A detached checkout: the host's own `omarchy plugin update` has no
        # branch to pull, exactly as after a pinned update.
        self.assertEqual(self.git("-C", str(self.new_plugin), "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
        self.assertTrue(self.reloaded)
        self.assertEqual(self.enabled, [(NEW_ID, "right")])
        state = self.home / ".config/omarchy/plugin-manager-updates"
        transactions = list(state.glob("txn-*"))
        self.assertEqual(len(transactions), 1)
        # The checkout left the transaction; only the journal stays behind.
        self.assertEqual(sorted(p.name for p in transactions[0].iterdir()),
                         ["prepared.json", "published.json", "request.json", "result.json"])
        self.assertEqual(json.loads((transactions[0] / "request.json").read_text()), self.install)
        self.assertEqual(json.loads((transactions[0] / "published.json").read_text()), {"status": "installed"})
        self.assertEqual(json.loads((transactions[0] / "result.json").read_text()), {"status": "installed"})
        # The notification names the shape without any remote prose.
        calls = []
        updater = self.updater()
        updater.run = lambda argv, **kwargs: calls.append(argv) or b""
        updater.notify(u.request_value(self.install), result)
        self.assertEqual(calls[0][3], "Pinned plugin install")
        self.assertEqual(calls[0][4], NEW_ID + ": installed")

    def test_install_without_a_section_still_enables_without_placement(self):
        # A service, an overlay or a whole-bar plugin takes no place in the
        # bar, but it is still switched on: the host's own add enabled every
        # plugin it landed, and an installed plugin nobody turned on is a
        # plugin that appears not to have installed.
        self.install["section"] = ""
        self.assertEqual(self.updater().execute(self.install)["status"], "installed")
        self.assertTrue(self.reloaded)
        self.assertEqual(self.enabled, [(NEW_ID, "")])

    def test_install_refuses_an_existing_plugin_directory_or_symlink(self):
        for kind in ("directory", "symlink", "file"):
            with self.subTest(kind=kind):
                if kind == "directory":
                    self.new_plugin.mkdir()
                elif kind == "symlink":
                    self.new_plugin.symlink_to(self.plugin, target_is_directory=True)
                else:
                    self.new_plugin.write_text("squatter")
                with self.assertRaisesRegex(u.Refused, "Already installed"):
                    self.updater().execute(self.install)
                self.assertFalse(self.reloaded)
                self.assertEqual(self.enabled, [])
                if kind == "directory":
                    self.new_plugin.rmdir()
                else:
                    self.new_plugin.unlink()

    def test_install_refuses_an_id_the_host_already_knows(self):
        updater = self.updater()
        updater.catalog_ids = lambda: {"omarchy.clock", NEW_ID}
        with self.assertRaisesRegex(u.Refused, "already"):
            updater.execute(self.install)
        self.assertFalse(self.new_plugin.exists())
        self.assertEqual(self.enabled, [])
        # The real host catalog is consulted when nothing overrides it, and it
        # does not know this disposable id.
        self.assertNotIn(NEW_ID, self.updater().catalog_ids())

    def test_install_refuses_when_the_catalog_does_not_authorize(self):
        entry = self.catalog["plugins"][1]
        for change in ({"verificationStatus": "unverified"}, {"sourceType": "builtin"},
                       {"repo": "https://github.com/other/newplugin"},
                       {"verificationCommit": self.new_tip}):
            with self.subTest(change=change):
                self.catalog["plugins"] = [{**entry, **change}]
                with self.assertRaises(u.Refused):
                    self.updater().execute(self.install)
                self.assertFalse(self.new_plugin.exists())
        # Revoked between the fetch and publication: nothing is published.
        self.catalog["plugins"] = [entry]
        updater = self.updater()
        calls = 0
        original = updater.catalog_bytes

        def catalog():
            nonlocal calls
            calls += 1
            if calls == 2:
                self.catalog["plugins"] = []
            return original()
        updater.catalog_bytes = catalog
        with self.assertRaises(u.Refused):
            updater.execute(self.install)
        self.assertFalse(updater.published)
        self.assertFalse(self.new_plugin.exists())
        self.assertEqual(self.enabled, [])

    def test_install_refuses_a_manifest_id_that_is_not_the_requested_one(self):
        self.new_manifest["id"] = "acme.other"
        (self.new_remote / "manifest.json").write_text(json.dumps(self.new_manifest))
        bad = self.new_commit("changed id")
        self.install["verifiedCommit"] = bad
        self.catalog["plugins"][1]["verificationCommit"] = bad
        with self.assertRaises(u.Refused):
            self.updater().execute(self.install)
        self.assertFalse(self.new_plugin.exists())
        self.assertEqual(self.enabled, [])

    def test_install_never_replaces_a_target_that_appeared_during_the_transaction(self):
        updater = self.updater()
        original = updater.checkpoint

        def checkpoint(phase):
            original(phase)
            if phase == "before-publication":
                self.new_plugin.mkdir()
                (self.new_plugin / "theirs.txt").write_text("not ours")
        updater.checkpoint = checkpoint
        with self.assertRaises(u.Refused):
            updater.execute(self.install)
        self.assertFalse(updater.published)
        # Whoever won the race keeps their directory untouched.
        self.assertEqual(sorted(p.name for p in self.new_plugin.iterdir()), ["theirs.txt"])
        self.assertEqual(self.enabled, [])
        state = self.home / ".config/omarchy/plugin-manager-updates"
        transactions = list(state.glob("txn-*"))
        self.assertEqual(len(transactions), 1)
        # The staged checkout stays in the unpublished transaction, journaled.
        self.assertTrue((transactions[0] / "checkout/manifest.json").exists())
        self.assertFalse((transactions[0] / "published.json").exists())
        self.assertIn("refused", json.loads((transactions[0] / "refused.json").read_text())["reason"].lower())

    def test_install_without_the_no_replace_syscall_is_unchanged(self):
        with patch.object(u, "NOREPLACE", None), self.assertRaises(u.Refused):
            self.updater().execute(self.install)
        self.assertFalse(self.new_plugin.exists())

    def test_install_enable_failure_keeps_the_published_checkout(self):
        updater = self.updater()
        updater.enable = lambda *_: u.require(False, "enable failed")
        result = updater.execute(self.install)
        self.assertEqual(result, {"status": "installed; enable failed"})
        self.assertEqual((self.new_plugin / "BarWidget.qml").read_text(), "verified snapshot")
        state = self.home / ".config/omarchy/plugin-manager-updates"
        record = next(iter(state.glob("txn-*/result.json")))
        self.assertEqual(json.loads(record.read_text()), {"status": "installed; enable failed"})
        # A rescan failure stops before enable and says so instead.
        self.setUp()
        updater = self.updater()
        updater.reload = lambda: u.require(False, "reload failed")
        self.assertEqual(updater.execute(self.install), {"status": "installed; reload failed"})
        self.assertEqual(self.enabled, [])
        self.assertEqual((self.new_plugin / "BarWidget.qml").read_text(), "verified snapshot")

    def test_install_request_shape_is_exact(self):
        base = dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO, verifiedCommit=self.new_target)
        for bad in (dict(section="bogus"), dict(section="Right"), dict(section=None), dict(section=0),
                    dict(), dict(section="left", expectedLocalHead=self.new_base),
                    dict(section="left", extra=1), dict(section="left", unverifiedCommit=self.new_tip)):
            with self.subTest(bad=bad), self.assertRaises(u.Refused):
                u.request_value({**base, **bad})
        for section in ("", "left", "center", "right"):
            value = u.request_value({**base, "section": section})
            self.assertTrue(value["install"])
            self.assertTrue(value["verified"])
            self.assertEqual(value["target"], self.new_target)
            self.assertEqual(value["section"], section)
            self.assertNotIn("expectedLocalHead", value)
            self.assertEqual(u.request_value(value), value, "a normalized request validates again unchanged")
        # Neither update shape gains a section, and the derived keys stay derived.
        with self.assertRaises(u.Refused):
            u.request_value({**self.request, "section": "left"})
        injected = u.request_value({**base, "section": "left", "install": False, "verified": False,
                                    "target": self.new_tip})
        self.assertTrue(injected["install"])
        self.assertEqual(injected["target"], self.new_target)

    def test_install_refusal_is_reported_as_its_own_shape(self):
        self.new_plugin.mkdir()
        read_end, write_end = os.pipe()
        observer = os.fork()
        if observer == 0:
            os.close(read_end)
            os.dup2(write_end, 1)
            updater = self.updater()
            updater.notify = lambda *_: None
            try:
                u.launch(self.install, lambda: updater)
            finally:
                os._exit(0)
        os.close(write_end)
        os.waitpid(observer, 0)
        with os.fdopen(read_end, "rb") as pipe:
            result = json.loads(pipe.read())
        self.assertEqual(result["status"], "unchanged; install refused")
        self.assertEqual(result["reason"], "Already installed")
        self.assertNotIn("backup", result)



class CatalogCacheTests(unittest.TestCase):
    """The Browse catalog cache: descriptor-relative reads and publication only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir(mode=0o700)
        self.cache_dir = self.home / ".cache/omarchy-plugin-manager"
        self.remote = {"generatedAt": "remote", "plugins": [
            dict(id="acme.clock", name="Clock", addedAt="2026-08-20",
                 listedAt="2026-08-20T12:34:56.789Z")]}
        self.stats = {"plugins": {"acme.clock": {"hearts": 42}}}
        self.fetches = []
        outer = self

        class FixtureUpdater(u.Updater):
            def catalog_bytes(self):
                outer.fetches.append("catalog")
                if isinstance(outer.remote, BaseException):
                    raise outer.remote
                return outer.remote if isinstance(outer.remote, bytes) else json.dumps(outer.remote).encode()

            def stats_bytes(self):
                outer.fetches.append("stats")
                if isinstance(outer.stats, BaseException):
                    raise outer.stats
                return outer.stats if isinstance(outer.stats, bytes) else json.dumps(outer.stats).encode()

        self.updater = lambda: FixtureUpdater(home=str(self.home))

    def serve(self, force=False):
        return self.updater().serve_catalog({"schemaVersion": 1, "catalog": {"force": force}})

    def cached(self, value, age=0, mode=0o600):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        path = self.cache_dir / "catalog.json"
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        path.write_bytes(data)
        path.chmod(mode)
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
        return data

    def temps(self):
        return sorted(p.name for p in self.cache_dir.iterdir() if p.name.startswith(".catalog.json.tmp."))

    def compatible(self, plugins=({"id": "cached", "addedAt": None, "listedAt": None},)):
        return {"projectionSchemaVersion": 2, "generatedAt": "cached", "plugins": list(plugins)}

    def test_catalog_request_shape_is_exact(self):
        good = {"schemaVersion": 1, "catalog": {"force": True}}
        self.assertEqual(u.catalog_request(good), good)
        self.assertEqual(u.request_kind(good), "catalog")
        self.assertEqual(u.catalog_request({"schemaVersion": 1, "catalog": {"force": False}})["catalog"]["force"], False)
        for bad in [
            {"schemaVersion": 2, "catalog": {"force": True}},
            {"schemaVersion": "1", "catalog": {"force": True}},
            {"schemaVersion": 1, "catalog": {}},
            {"schemaVersion": 1, "catalog": {"force": 1}},
            {"schemaVersion": 1, "catalog": {"force": "true"}},
            {"schemaVersion": 1, "catalog": {"force": True, "extra": 1}},
            {"schemaVersion": 1, "catalog": True},
            {"schemaVersion": 1, "catalog": {"force": True}, "id": "acme.plugin"},
            {"schemaVersion": 1, "catalog": {"force": True}, "verifiedCommit": "a" * 40, "section": ""},
            {"catalog": {"force": True}},
            [],
        ]:
            with self.subTest(bad=bad), self.assertRaises(u.Refused):
                u.catalog_request(bad)
        # The transaction shapes never accept a catalog key, and a catalog
        # request never reaches the transaction validator with a plugin id.
        with self.assertRaises(u.Refused):
            u.request_value(good)
        with self.assertRaises(u.Refused):
            u.request_value({"schemaVersion": 1, "id": "acme.plugin", "repository": REPO,
                             "verifiedCommit": "a" * 40, "section": "", "catalog": {"force": True}})

    def test_fresh_compatible_cache_is_served_without_fetching(self):
        data = self.cached(self.compatible(), age=21599)
        self.assertEqual(self.serve(), data)
        self.assertEqual(self.fetches, [])

    def test_force_refetches_and_replaces_the_cache_atomically(self):
        self.cached(self.compatible())
        before = os.stat(self.cache_dir / "catalog.json")
        served = self.serve(force=True)
        projected = json.loads(served)
        self.assertEqual(projected["projectionSchemaVersion"], 2)
        self.assertEqual(projected["generatedAt"], "remote")
        self.assertEqual(projected["plugins"][0]["marketplaceHearts"], 42)
        self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), served)
        after = os.stat(self.cache_dir / "catalog.json")
        self.assertNotEqual(before.st_ino, after.st_ino, "publication renames a new file into place")
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o600)
        self.assertEqual(self.temps(), [])
        self.assertEqual(self.fetches, ["catalog", "stats"])

    def test_stale_cache_is_refetched(self):
        self.cached(self.compatible(), age=21601)
        served = self.serve()
        self.assertEqual(json.loads(served)["generatedAt"], "remote")
        self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), served)

    def test_fetch_failure_serves_the_usable_cache_untouched(self):
        data = self.cached(self.compatible(), age=30000)
        self.remote = u.Refused("Command failed: curl")
        self.assertEqual(self.serve(), data)
        self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), data)
        self.assertEqual(self.temps(), [])
        self.remote = OSError("no curl")
        self.assertEqual(self.serve(force=True), data)

    def test_fetch_failure_without_a_cache_is_refused(self):
        self.remote = u.Refused("Command failed: curl")
        with self.assertRaises(u.Refused):
            self.serve()
        self.assertTrue(self.cache_dir.is_dir())
        self.assertFalse((self.cache_dir / "catalog.json").exists())
        self.assertEqual(self.temps(), [])

    def test_missing_directories_are_created_private(self):
        self.assertFalse((self.home / ".cache").exists())
        self.serve()
        for path in (self.home / ".cache", self.cache_dir):
            info = os.lstat(path)
            self.assertTrue(stat.S_ISDIR(info.st_mode))
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o700, path)
        # An existing directory with the old mkdir -p mode is still accepted:
        # owned by the account and writable by nobody else.
        (self.home / ".cache").chmod(0o755)
        self.cache_dir.chmod(0o755)
        self.assertEqual(json.loads(self.serve(force=True))["generatedAt"], "remote")

    def test_unwritable_home_is_a_typed_refusal(self):
        # A home that cannot take a new directory is a plain refusal, the same
        # one a symlink or foreign owner produces: never a raw traceback class.
        self.home.chmod(0o500)
        self.addCleanup(self.home.chmod, 0o700)
        with self.assertRaises(u.Refused) as caught:
            self.serve()
        self.assertEqual(str(caught.exception), "Cache directory unavailable")
        self.assertFalse((self.home / ".cache").exists())

    def test_non_finite_numbers_never_reach_the_cache(self):
        # jq wrote 1e999 back out as a JSON number; Python's float overflows to
        # infinity, which json.dumps would serialize as a bare Infinity token
        # no JSON parser accepts. That projection must fail the refresh, not
        # replace a good cache with bytes the panel can never read again.
        good = self.compatible([{"id": "acme.clock"}])
        self.cached(good, age=u.CACHE_TTL + 1)
        self.remote = b'{"plugins":[{"id":"acme.clock","stars":1e999}]}'
        served = self.serve()
        self.assertEqual(json.loads(served), good)
        self.assertEqual(json.loads((self.cache_dir / "catalog.json").read_bytes()), good)
        with self.assertRaises(u.Refused):
            u.project_catalog(self.remote, None)

    def test_incompatible_cache_is_replaced_despite_its_age(self):
        for value in [
            {"generatedAt": "legacy", "plugins": [{"id": "legacy"}]},
            {"projectionSchemaVersion": 99, "generatedAt": "wrong", "plugins": []},
            {"projectionSchemaVersion": 2, "generatedAt": "wrong", "plugins": {}},
            b"{not-json",
        ]:
            with self.subTest(value=value):
                self.fetches = []
                data = self.cached(value)
                served = self.serve()
                self.assertEqual(self.fetches, ["catalog", "stats"])
                self.assertEqual(json.loads(served)["generatedAt"], "remote")
                self.assertNotEqual(served, data)
                # And when the refresh fails there is nothing usable to fall back on.
                data = self.cached(value)
                self.remote = u.Refused("Command failed: curl")
                with self.assertRaises(u.Refused):
                    self.serve()
                self.remote = {"generatedAt": "remote", "plugins": [dict(id="acme.clock")]}
                self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), data)
                self.assertEqual(self.temps(), [])

    def test_oversized_or_malformed_catalog_bodies_keep_the_bounded_cache(self):
        data = self.cached(self.compatible(), age=30000)
        for body in [
            json.dumps({"generatedAt": "remote", "plugins": [
                {"id": "oversized", "description": "x" * u.MAX_CATALOG}]}).encode(),
            b'{"generatedAt":"remote","plugins":{}}',
            b'{"generatedAt":"remote","plugins":[1]}',
            b'{"generatedAt":"remote","plugins":[{"name":"no id"}]}',
            b'{"generatedAt":"remote","plugins":[{"id":7}]}',
            b'[]',
            b'{not-json',
        ]:
            with self.subTest(body=body[:40]):
                self.remote = body
                self.assertEqual(self.serve(), data)
                self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), data)
                self.assertEqual(self.temps(), [])

    def test_oversized_projection_is_refused_before_replacing_the_cache(self):
        data = self.cached(self.compatible(), age=30000)
        body = json.dumps({"generatedAt": "remote", "plugins": [{"id": "repeat"}] * 40000}).encode()
        self.assertLess(len(body), u.MAX_CATALOG)
        self.remote = body
        self.assertEqual(self.serve(), data)
        self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), data)
        self.assertEqual(self.temps(), [])

    def test_oversized_cache_is_never_served(self):
        self.cached(b"x" * (u.MAX_CATALOG + 1))
        self.remote = u.Refused("Command failed: curl")
        with self.assertRaises(u.Refused):
            self.serve()

    def test_stats_are_joined_by_id_and_unavailable_stats_read_as_missing(self):
        for name, stats, expected in [
            ("valid", {"plugins": {"acme.clock": {"hearts": 42}}}, 42),
            ("other id", {"plugins": {"acme.other": {"hearts": 42}}}, None),
            ("false hearts", {"plugins": {"acme.clock": {"hearts": False}}}, None),
            ("null hearts", {"plugins": {"acme.clock": {"hearts": None}}}, None),
            ("record is not an object", {"plugins": {"acme.clock": 5}}, None),
            ("plugins is not an object", {"plugins": []}, None),
            ("malformed", b"{not-json", None),
            ("oversized", b'{"plugins":{"acme.clock":{"hearts":42}},"padding":"' + b"x" * u.MAX_STATS + b'"}', None),
            ("fetch refused", u.Refused("Command failed: curl"), None),
            ("fetch error", OSError("no curl"), None),
        ]:
            with self.subTest(name=name):
                self.stats = stats
                projection = json.loads(self.serve(force=True))
                projected = projection["plugins"][0]
                self.assertEqual(projected["marketplaceHearts"], expected)
                self.assertEqual(projected["addedAt"], "2026-08-20")
                self.assertEqual(projected["listedAt"], "2026-08-20T12:34:56.789Z")

    def test_projection_keeps_the_exact_field_set_in_order(self):
        self.remote = {"plugins": [{"id": "acme.clock", "name": "Relój", "stars": 3,
                                    "secret": "dropped", "sourceType": "builtin"}]}
        self.stats = {"plugins": {}}
        served = self.serve(force=True)
        self.assertNotIn(b"\n", served)
        self.assertNotIn(b": ", served)
        self.assertIn("Relój".encode(), served)
        projection = json.loads(served)
        self.assertEqual(list(projection), ["projectionSchemaVersion", "generatedAt", "plugins"])
        self.assertIsNone(projection["generatedAt"])
        entry = projection["plugins"][0]
        self.assertEqual(list(entry), [
            "id", "name", "description", "author", "version", "category", "tags", "kind", "repo",
            "installCommand", "installAvailable", "installNote", "verificationStatus", "sourceType",
            "stars", "addedAt", "listedAt", "marketplaceHearts", "accent", "initials", "license",
            "previewThumbnail", "listingValidatedBranch", "verificationCommit"])
        self.assertEqual(entry["stars"], 3)
        self.assertEqual(entry["sourceType"], "builtin")
        self.assertIsNone(entry["description"])
        self.assertNotIn("secret", entry)

    def test_symlinked_cache_directories_are_refused(self):
        elsewhere = Path(self.tmp.name) / "elsewhere"
        elsewhere.mkdir(mode=0o700)
        (self.home / ".cache").mkdir(mode=0o700)
        self.cache_dir.symlink_to(elsewhere)
        with self.assertRaises(u.Refused):
            self.serve(force=True)
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertEqual(self.fetches, [])
        self.cache_dir.unlink()
        (self.home / ".cache").rmdir()
        (self.home / ".cache").symlink_to(elsewhere)
        with self.assertRaises(u.Refused):
            self.serve(force=True)
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertEqual(self.fetches, [])

    def test_shared_writable_cache_directories_are_refused(self):
        self.cache_dir.mkdir(parents=True)
        for path, mode in [(self.cache_dir, 0o775), (self.cache_dir, 0o777), (self.home / ".cache", 0o777)]:
            with self.subTest(path=path.name, mode=oct(mode)):
                path.chmod(mode)
                with self.assertRaises(u.Refused):
                    self.serve(force=True)
                self.assertFalse((self.cache_dir / "catalog.json").exists())
                path.chmod(0o700)
        self.assertEqual(self.fetches, [])

    def test_symlink_at_the_cache_file_is_never_followed(self):
        decoy = Path(self.tmp.name) / "decoy.json"
        decoy_data = json.dumps(self.compatible([{"id": "decoy"}])).encode()
        decoy.write_bytes(decoy_data)
        self.cache_dir.mkdir(parents=True, mode=0o700)
        (self.cache_dir / "catalog.json").symlink_to(decoy)
        served = self.serve()
        self.assertNotEqual(served, decoy_data)
        self.assertEqual(json.loads(served)["generatedAt"], "remote")
        self.assertEqual(decoy.read_bytes(), decoy_data, "nothing is written through the link")
        self.assertFalse((self.cache_dir / "catalog.json").is_symlink())
        self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), served)
        # A world-readable cache is still the account's own file and is served;
        # one anybody else can write is not, whatever it contains.
        (self.cache_dir / "catalog.json").chmod(0o644)
        self.assertEqual(self.serve(), served)
        (self.cache_dir / "catalog.json").chmod(0o666)
        self.fetches = []
        self.serve()
        self.assertEqual(self.fetches, ["catalog", "stats"])

    def test_temp_file_is_removed_when_publication_fails(self):
        data = self.cached(self.compatible(), age=30000)
        with patch.object(os, "rename", side_effect=OSError("refused")):
            self.assertEqual(self.serve(), data)
        self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), data)
        self.assertEqual(self.temps(), [])
        (self.cache_dir / "catalog.json").unlink()
        with patch.object(os, "rename", side_effect=OSError("refused")), self.assertRaises(u.Refused):
            self.serve()
        self.assertEqual(self.temps(), [])

    def test_stats_fetch_uses_the_locked_down_transport(self):
        updater = u.Updater(home=str(self.home))
        real_popen = subprocess.Popen
        calls = []
        response = b'{"plugins":{}}\n200'

        def spy(argv, **kwargs):
            calls.append((argv, kwargs))
            return real_popen(["/usr/bin/python3", "-I", "-S", "-c",
                               "import os; os.write(1, " + repr(response) + ")"], **kwargs)
        with patch.object(subprocess, "Popen", side_effect=spy):
            self.assertEqual(updater.stats_bytes(), b'{"plugins":{}}')
            curl, options = calls[-1]
            self.assertEqual(curl, ["/usr/bin/curl", "-q", "--fail", "--silent", "--show-error",
                "--proto", "=https", "--noproxy", "*", "--connect-timeout", "5", "--max-time", "15",
                "--max-filesize", str(u.MAX_STATS), "--header", "Cache-Control: no-cache",
                "--write-out", "\n%{http_code}", "--", "https://api.omarchyplugins.com/v1/stats"])
            self.assertTrue(options["start_new_session"])
            for status in (b"301", b"302", b"404"):
                response = b'{"plugins":{}}\n' + status
                with self.subTest(status=status), self.assertRaises(u.Refused):
                    updater.stats_bytes()

    def test_cli_refuses_a_malformed_catalog_request_with_an_empty_stdout(self):
        for request in ['{"schemaVersion":1,"catalog":{"force":"yes"}}',
                        '{"schemaVersion":1,"catalog":{"force":true},"id":"acme.plugin"}']:
            with self.subTest(request=request):
                result = subprocess.run(["/usr/bin/python3", "-I", "-S", SPEC.origin, request],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
                    env={"PATH": "/usr/bin:/bin", "HOME": str(self.home)})
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"Invalid catalog request", result.stderr)
        self.assertFalse((self.home / ".cache").exists())


if __name__ == "__main__":
    unittest.main()
