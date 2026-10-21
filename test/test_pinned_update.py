"""Transaction tests use disposable Git repositories, never installed plugins."""
import sys
sys.dont_write_bytecode = True
import importlib.util
import io
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


class BulkFixtureUpdater:
    home = None
    state = None
    reason = ""
    backup = ""

    def open_update_lock(self):
        pass

    def catalog_bytes(self):
        return b'{"plugins":[]}'

    def authorize_update(self, prepared, catalog):
        pass


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
        # The branch a listing says the marketplace validated, for the install
        # shape that has no reviewed commit to name.
        self.git("-C", str(self.new_remote), "branch", "-f", "validated", self.new_tip)
        self.tip_install = dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                                branch="validated", section="right")
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

            def ls_remote(self, stage, branch):
                # Same in-process transport injection as fetch; the production
                # lookup asks the configured origin over HTTPS and nothing else.
                return self.git(stage, "-c", "protocol.file.allow=always", "ls-remote",
                                "--exit-code", "--", "file://" + str(outer.new_remote),
                                "refs/heads/" + branch, extra_env={"GIT_ALLOW_PROTOCOL": "file"})

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

    def test_bulk_update_can_defer_shell_reload_until_the_queue_finishes(self):
        # Raw requests may not defer the reload; only the bulk queue marks
        # normalized items after validation.
        with self.assertRaises(u.Refused):
            u.request_value({**self.request, "deferReload": True})
        with self.assertRaises(u.Refused):
            u.request_value({**self.install, "deferReload": True})
        with self.assertRaises(u.Refused):
            u.request_value({**self.request, "deferReload": "true"})
        request = u.bulk_request_value({"schemaVersion": 1,
                                        "bulkUpdates": [self.request]})["bulkUpdates"][0]
        self.assertTrue(request["deferReload"])
        result = self.updater().execute(request)
        self.assertEqual(result["status"], "updated")
        self.assertFalse(self.reloaded)
        journaled = json.loads((Path(result["backup"]).parent / "request.json").read_text())
        self.assertNotIn("deferReload", journaled)
        self.assertEqual(journaled, self.request)

    @patch.object(u.Updater, "notify")
    def test_completed_bulk_transaction_archives_at_capacity_and_cleans_up(self, _notify):
        # The journal carries no runtime-only flag, so the archive and
        # cleanup paths that re-validate it accept bulk history.
        bulk = u.bulk_request_value({"schemaVersion": 1,
                                     "bulkUpdates": [self.request]})["bulkUpdates"]
        result = u.execute_bulk_updates(bulk, lambda: self.updater())
        self.assertEqual(result["status"], "bulk complete")
        self.assertEqual([item["status"] for item in result["updates"]], ["updated"])
        state = self.home / ".config/omarchy/plugin-manager-updates"
        names = [p.name for p in state.iterdir()]
        self.assertEqual(len(names), 1)
        name = names[0]
        for number in range(31):
            (state / ("pending-%d" % number)).mkdir(mode=0o700)
        updater = self.updater()
        try:
            updater.open_paths("acme.plugin")
        finally:
            for fd in reversed(updater.fds):
                os.close(fd)
            updater.fds.clear()
        self.assertFalse((state / name).exists())
        self.assertTrue((self.home / ".config/omarchy/plugin-manager-updates-archive" / name).exists())
        result = u.cleanup_completed(self.updater())
        self.assertEqual(result["status"], "complete")

    def test_bulk_summary_is_consumed_once_then_gone(self):
        home = str(self.home)
        self.assertEqual(u.consume_bulk_summary(home), {})
        result = {"status": "bulk complete", "updates": [{"id": "acme.plugin", "status": "updated", "reason": ""}],
                  "rescan": "complete", "nonce": "1-2"}
        u.write_bulk_summary(home, result)
        path = self.home / ".config/omarchy/plugin-manager-bulk-summary.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0)
        self.assertEqual(u.consume_bulk_summary(home),
                         {"schemaVersion": 1, "nonce": "1-2", "status": "bulk complete",
                          "updates": result["updates"], "rescan": "complete"})
        self.assertEqual(u.consume_bulk_summary(home), {})
        path.write_text("{oops")
        self.assertEqual(u.consume_bulk_summary(home), {})
        self.assertFalse(path.exists())

    def test_two_real_bulk_updates_publish_with_backups_and_exclude_cleanup_until_summary(self):
        self.git("clone", "--no-hardlinks", "-q", str(self.new_remote), str(self.new_plugin))
        self.git("-C", str(self.new_plugin), "checkout", "-q", "--detach", self.new_base)
        self.git("-C", str(self.new_plugin), "remote", "set-url", "origin", NEW_REPO)
        requests = u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [self.request,
            dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                 verifiedCommit=self.new_target, expectedLocalHead=self.new_base)]})["bulkUpdates"]
        notifications = []
        summary = u.write_bulk_summary

        def assert_cleanup_excluded():
            with self.assertRaises(BlockingIOError), u.CleanupLock(self.updater()):
                self.fail("cleanup admitted during a batch")

        def notify(updater, request, result):
            self.assertTrue(self.reloaded)
            self.assertTrue((self.home / ".config/omarchy" / u.BULK_SUMMARY_NAME).exists())
            self.assertEqual(self.git("-C", str(self.plugin), "rev-parse", "HEAD"), self.target)
            self.assertEqual(self.git("-C", str(self.new_plugin), "rev-parse", "HEAD"), self.new_target)
            self.assertIn("backup", result)
            notifications.append(request["id"])

        def write_summary(home, result):
            assert_cleanup_excluded()
            summary(home, result)

        with patch.object(u.Updater, "notify", notify), patch.object(u, "write_bulk_summary", write_summary):
            result = u.execute_bulk_updates(requests, self.updater)
        self.assertEqual([item["status"] for item in result["updates"]], ["updated", "updated"])
        self.assertEqual(notifications, ["acme.plugin", NEW_ID])
        state = self.home / ".config/omarchy/plugin-manager-updates"
        backups = {}
        for transaction in state.iterdir():
            request = json.loads((transaction / "request.json").read_text())
            backups[request["id"]] = self.git("-C", str(transaction / "checkout"), "rev-parse", "HEAD")
        self.assertEqual(backups, {"acme.plugin": self.base, NEW_ID: self.new_base})
        with u.CleanupLock(self.updater()):
            pass
        self.assertEqual(u.cleanup_completed(self.updater())["status"], "complete")

    def assert_late_update_refused(self, mutate, reason):
        updater = self.updater()
        try:
            prepared = updater.prepare_update(u.request_value(self.request))
            mutate()
            with self.assertRaisesRegex(u.Refused, reason):
                updater.publish_update(prepared)
            self.assertFalse(updater.published)
        finally:
            updater.close()

    def two_bulk_requests(self):
        self.git("clone", "--no-hardlinks", "-q", str(self.new_remote), str(self.new_plugin))
        self.git("-C", str(self.new_plugin), "checkout", "-q", "--detach", self.new_base)
        self.git("-C", str(self.new_plugin), "remote", "set-url", "origin", NEW_REPO)
        return u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [self.request,
            dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                 verifiedCommit=self.new_target, expectedLocalHead=self.new_base)]})["bulkUpdates"]

    @patch.object(u.Updater, "notify")
    def test_bulk_catalog_delay_never_separates_real_exchanges(self, _notify):
        requests = self.two_bulk_requests()
        exchanges = []
        catalog_after_exchange = []
        fixture = type(self.updater())

        class DelayedUpdater(fixture):
            def catalog_bytes(worker):
                catalog_after_exchange.append(bool(exchanges))
                time.sleep(0.25)
                return super().catalog_bytes()

            def exchange(worker, plugin_id):
                super().exchange(plugin_id)
                exchanges.append(time.monotonic())

        result = u.execute_bulk_updates(requests, lambda: DelayedUpdater(home=str(self.home)))
        self.assertEqual([item["status"] for item in result["updates"]], ["updated", "updated"])
        self.assertEqual(self.git("-C", str(self.plugin), "rev-parse", "HEAD"), self.target)
        self.assertEqual(self.git("-C", str(self.new_plugin), "rev-parse", "HEAD"), self.new_target)
        self.assertEqual(len(exchanges), 2)
        gap = exchanges[1] - exchanges[0]
        print("250ms catalog delay; real exchange gap %.6fs; catalog after exchange %s" %
              (gap, catalog_after_exchange), flush=True)
        self.assertFalse(any(catalog_after_exchange), "network work ran between real exchanges")

    @patch.object(u.Updater, "notify")
    def test_bulk_final_catalog_refuses_revocation_during_later_preparation(self, _notify):
        requests = self.two_bulk_requests()
        fixture = type(self.updater())
        outer = self

        class RevokingUpdater(fixture):
            def fetch(worker, stage, sha):
                super().fetch(stage, sha)
                if sha == outer.new_target:
                    outer.catalog["plugins"][0]["verificationStatus"] = "unverified"

        result = u.execute_bulk_updates(requests, lambda: RevokingUpdater(home=str(self.home)))
        self.assertEqual([item["status"] for item in result["updates"]],
                         ["unchanged; update refused", "updated"])
        self.assertIn("not verified", result["updates"][0]["reason"])
        self.assertEqual(self.git("-C", str(self.plugin), "rev-parse", "HEAD"), self.base)
        state = self.home / ".config/omarchy/plugin-manager-updates"
        refused = [json.loads((transaction / "refused.json").read_text())
                   for transaction in state.iterdir() if (transaction / "refused.json").exists()]
        self.assertEqual(refused, [{"reason": result["updates"][0]["reason"]}])

    def test_competing_refused_bulk_preserves_the_lock_owners_summary(self):
        requests = u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [self.request]})["bulkUpdates"]
        observed = []
        summary = self.home / ".config/omarchy" / u.BULK_SUMMARY_NAME

        def notify(worker, request, notification):
            before = json.loads(summary.read_text())
            read_end, write_end = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read_end)
                result = u.execute_bulk_updates(requests, self.updater)
                os.write(write_end, json.dumps(result).encode())
                os.close(write_end)
                os._exit(0)
            os.close(write_end)
            with os.fdopen(read_end) as stream:
                competing = json.load(stream)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(status, 0)
            observed.append((before, competing, json.loads(summary.read_text())))

        def quiet_refusal(worker, request, result):
            if result["status"] == "updated":
                notify(worker, request, result)

        with patch.object(u.Updater, "notify", quiet_refusal):
            result = u.execute_bulk_updates(requests, self.updater)
        self.assertEqual(result["updates"][0]["status"], "updated")
        self.assertEqual(len(observed), 1)
        before, competing, after = observed[0]
        self.assertEqual(competing["updates"][0]["reason"], "Another pinned update is running")
        print("Competing bulk summary nonces; owner %s; refused %s; stored %s" %
              (result["nonce"], competing["nonce"], after["nonce"]), flush=True)
        self.assertEqual(before["nonce"], result["nonce"])
        self.assertEqual(after, before, "the refused worker overwrote the owner's recovery summary")

    def assert_bulk_late_update_refused(self, mutate, reason):
        requests = self.two_bulk_requests()
        fixture = type(self.updater())

        class EditingUpdater(fixture):
            def exchange(worker, plugin_id):
                super().exchange(plugin_id)
                if plugin_id == "acme.plugin":
                    mutate()

        with patch.object(u.Updater, "notify"):
            result = u.execute_bulk_updates(requests, lambda: EditingUpdater(home=str(self.home)))
        self.assertEqual([item["status"] for item in result["updates"]],
                         ["updated", "unchanged; update refused"])
        self.assertIn(reason, result["updates"][1]["reason"])

    def test_bulk_publication_rechecks_local_files_after_the_first_exchange(self):
        self.assert_bulk_late_update_refused(
            lambda: (self.new_plugin / "BarWidget.qml").write_text("local edit"), "Dirty")
        self.assertEqual((self.new_plugin / "BarWidget.qml").read_text(), "local edit")

    def test_bulk_publication_rechecks_head_after_the_first_exchange(self):
        self.assert_bulk_late_update_refused(
            lambda: (self.new_plugin / ".git/HEAD").write_text(self.new_tip + "\n"), "HEAD changed")
        self.assertEqual((self.new_plugin / ".git/HEAD").read_text(), self.new_tip + "\n")

    def test_bulk_publication_rechecks_origin_after_the_first_exchange(self):
        self.assert_bulk_late_update_refused(
            lambda: self.git("-C", str(self.new_plugin), "remote", "set-url", "origin", REPO), "origin changed")
        self.assertEqual(self.git("-C", str(self.new_plugin), "remote", "get-url", "origin"), REPO)

    def test_bulk_publication_rechecks_anchors_after_the_first_exchange(self):
        def replace():
            self.new_plugin.rename(self.new_plugin.with_suffix(".saved"))
            self.new_plugin.mkdir()
            (self.new_plugin / "keep").write_text("replacement")

        self.assert_bulk_late_update_refused(replace, "Directory identity changed")
        self.assertEqual((self.new_plugin / "keep").read_text(), "replacement")

    def test_cleanup_lock_refuses_bulk_without_losing_its_notification(self):
        state = self.home / ".config/omarchy/plugin-manager-updates"
        state.mkdir(mode=0o700)
        notifications = []

        def notify(updater, request, result):
            notifications.append((result, (state.parent / u.BULK_SUMMARY_NAME).exists()))

        requests = u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [self.request]})["bulkUpdates"]
        with u.CleanupLock(self.updater()), patch.object(u.Updater, "notify", notify):
            result = u.execute_bulk_updates(requests, self.updater)
        self.assertEqual(result["updates"][0]["reason"], "Another pinned update is running")
        self.assertEqual(notifications, [({"status": "unchanged; update refused",
                                          "reason": "Another pinned update is running", "backup": ""}, False)])
        self.assertEqual(list(state.iterdir()), [])
        self.assertEqual(self.git("-C", str(self.plugin), "rev-parse", "HEAD"), self.base)

    def test_publication_refuses_late_local_edit(self):
        self.assert_late_update_refused(lambda: (self.plugin / "Main.qml").write_text("local edit"), "Dirty")
        self.assertEqual((self.plugin / "Main.qml").read_text(), "local edit")

    def test_publication_refuses_late_head_change(self):
        self.assert_late_update_refused(lambda: (self.plugin / ".git/HEAD").write_text(self.tip + "\n"), "HEAD changed")
        self.assertEqual((self.plugin / ".git/HEAD").read_text().strip(), self.tip)

    def test_publication_refuses_late_origin_change(self):
        self.assert_late_update_refused(
            lambda: self.git("-C", str(self.plugin), "remote", "set-url", "origin", NEW_REPO), "origin changed")
        self.assertEqual(self.git("-C", str(self.plugin), "remote", "get-url", "origin"), NEW_REPO)

    def test_publication_refuses_replaced_directory(self):
        def replace():
            self.plugin.rename(self.plugin.with_suffix(".saved"))
            self.plugin.mkdir()
            (self.plugin / "keep").write_text("replacement")
        self.assert_late_update_refused(replace, "Directory identity changed")
        self.assertEqual((self.plugin / "keep").read_text(), "replacement")

    def test_publication_refuses_revoked_authorization(self):
        self.assert_late_update_refused(
            lambda: self.catalog["plugins"][0].update(verificationStatus="unverified"), "not verified")
        self.assertEqual(self.git("-C", str(self.plugin), "rev-parse", "HEAD"), self.base)

    def test_bulk_signal_during_publication_applies_checked_update_and_rescans(self):
        class SignalledUpdater(type(self.updater())):
            def checkpoint(self, phase):
                if phase == "before-exchange":
                    os.kill(os.getpid(), signal.SIGTERM)
                super().checkpoint(phase)

            def notify(self, request, result):
                pass

        request = u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [self.request]})
        output = io.TextIOWrapper(io.BytesIO())
        with patch.object(u.sys, "stdout", output):
            u.launch(request, lambda: SignalledUpdater(home=str(self.home)))
        result = json.loads(output.buffer.getvalue())
        self.assertEqual([item["status"] for item in result["updates"]], ["updated"])
        self.assertEqual(result["rescan"], "complete")
        self.assertEqual(self.git("-C", str(self.plugin), "rev-parse", "HEAD"), self.target)

    def test_summary_reader_during_write_sees_complete_previous_outcome(self):
        old = {"nonce": "old", "updates": [], "rescan": "not needed"}
        new = {"nonce": "new", "updates": [], "rescan": "not needed"}
        u.write_bulk_summary(str(self.home), old)
        write = os.write
        observed = []

        def interleaved_write(fd, data):
            if not observed:
                observed.append(u.consume_bulk_summary(str(self.home)))
            return write(fd, data)

        with patch.object(u.os, "write", interleaved_write):
            u.write_bulk_summary(str(self.home), new)
        self.assertEqual(observed[0].get("nonce"), "old")
        self.assertEqual(u.consume_bulk_summary(str(self.home)).get("nonce"), "new")

    def test_failed_summary_write_preserves_previous_outcome_and_removes_temp(self):
        result = {"nonce": "old", "updates": [], "rescan": "not needed"}
        u.write_bulk_summary(str(self.home), result)
        root = self.home / ".config/omarchy"
        before = set(root.iterdir())
        with patch.object(u.os, "write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                u.write_bulk_summary(str(self.home), {**result, "nonce": "new"})
        self.assertEqual(set(root.iterdir()), before)
        self.assertEqual(u.consume_bulk_summary(str(self.home)).get("nonce"), "old")

    def test_claimed_summary_reader_cannot_delete_newer_outcome(self):
        old = {"nonce": "old", "updates": [], "rescan": "not needed"}
        u.write_bulk_summary(str(self.home), old)
        read = u.read_file
        published = []

        def interleaved_read(parent, name, cap, **kwargs):
            result = read(parent, name, cap, **kwargs)
            if not published:
                published.append(True)
                u.write_bulk_summary(str(self.home), {**old, "nonce": "new"})
            return result

        with patch.object(u, "read_file", interleaved_read):
            self.assertEqual(u.consume_bulk_summary(str(self.home)).get("nonce"), "old")
        self.assertEqual(u.consume_bulk_summary(str(self.home)).get("nonce"), "new")

    def test_live_summary_drain_preserves_another_batches_report(self):
        result = {"nonce": "2-2", "updates": [], "rescan": "complete"}
        u.write_bulk_summary(str(self.home), result)
        self.assertEqual(u.consume_bulk_summary(str(self.home), "1-1"), {})
        self.assertEqual(u.consume_bulk_summary(str(self.home)).get("nonce"), "2-2")
        u.write_bulk_summary(str(self.home), {**result, "nonce": "1-1"})
        self.assertEqual(u.consume_bulk_summary(str(self.home), "1-1"), {})
        self.assertEqual(u.consume_bulk_summary(str(self.home)), {})

    def test_live_summary_drain_preserves_the_report_without_no_replace_support(self):
        result = {"nonce": "2-2", "updates": [], "rescan": "complete"}
        u.write_bulk_summary(str(self.home), result)
        with patch.object(u, "NOREPLACE", None):
            self.assertEqual(u.consume_bulk_summary(str(self.home), "1-1"), {})
        self.assertEqual(u.consume_bulk_summary(str(self.home)).get("nonce"), "2-2")

    def test_concurrent_summary_consumers_do_not_replay_a_live_report(self):
        home = str(self.home)
        read = u.read_file
        flock = u.fcntl.flock
        for newer in (False, True):
            for recovery in (False, True):
                with self.subTest(newer=newer, recovery=recovery):
                    result = {"nonce": "2-2", "updates": [], "rescan": "complete"}
                    u.write_bulk_summary(home, result)
                    expected_nonce = "3-3" if newer else "2-2"
                    start_read, start_write = os.pipe()
                    event_read, event_write = os.pipe()
                    result_read, result_write = os.pipe()
                    child = os.fork()
                    if child == 0:
                        os.close(start_write)
                        os.close(event_read)
                        os.close(result_read)
                        signal.alarm(10)
                        try:
                            os.read(start_read, 1)

                            def observed_flock(fd, operation):
                                try:
                                    return flock(fd, operation | u.fcntl.LOCK_NB)
                                except BlockingIOError:
                                    os.write(event_write, b"W")
                                    return flock(fd, operation)

                            with patch.object(u.fcntl, "flock", observed_flock):
                                consumed = u.consume_bulk_summary(
                                    home, None if recovery else expected_nonce)
                            os.write(event_write, b"D")
                            os.write(result_write, json.dumps(consumed).encode())
                            os._exit(0)
                        except BaseException:
                            os._exit(1)
                    os.close(start_read)
                    os.close(event_write)
                    os.close(result_write)
                    reaped = False
                    try:
                        def interleaved_read(parent, name, cap, **kwargs):
                            value = read(parent, name, cap, **kwargs)
                            if newer:
                                u.write_bulk_summary(home, {**result, "nonce": expected_nonce})
                            os.write(start_write, b"S")
                            self.assertIn(os.read(event_read, 1), (b"W", b"D"))
                            return value

                        with patch.object(u, "read_file", interleaved_read):
                            self.assertEqual(u.consume_bulk_summary(home, "1-1"), {})
                        _, status = os.waitpid(child, 0)
                        reaped = True
                        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                        consumed = json.loads(os.read(result_read, u.MAX_BULK_SUMMARY))
                        if recovery:
                            self.assertEqual(consumed.get("nonce"), expected_nonce)
                        else:
                            self.assertEqual(consumed, {})
                        self.assertEqual(u.consume_bulk_summary(home), {},
                                         "a concurrent consumer left an already handled report for replay")
                    finally:
                        if not reaped:
                            try:
                                os.kill(child, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            os.waitpid(child, 0)
                        for fd in (start_write, event_read, result_read):
                            os.close(fd)

    def test_live_summary_drain_cannot_replace_a_newer_report_when_restoring(self):
        result = {"nonce": "2-2", "updates": [], "rescan": "complete"}
        u.write_bulk_summary(str(self.home), result)
        read = u.read_file
        published = []

        def interleaved_read(parent, name, cap, **kwargs):
            value = read(parent, name, cap, **kwargs)
            if not published:
                published.append(True)
                u.write_bulk_summary(str(self.home), {**result, "nonce": "3-3"})
            return value

        with patch.object(u, "read_file", interleaved_read):
            self.assertEqual(u.consume_bulk_summary(str(self.home), "1-1"), {})
        self.assertEqual(u.consume_bulk_summary(str(self.home)).get("nonce"), "3-3")

    def test_live_summary_drain_cli_checks_the_nonce_and_preserves_unseen_reports(self):
        result = {"nonce": "2-2", "updates": [], "rescan": "complete"}
        u.write_bulk_summary(str(self.home), result)
        entry = Path(SPEC.origin).read_text().split('if __name__ == "__main__":', 1)[1]
        namespace = {**vars(u), "Updater": self.updater}
        summary = self.home / ".config/omarchy" / u.BULK_SUMMARY_NAME
        before = summary.read_bytes()
        for nonce in ("../2-2", "2-2\n", "2-2;false", "1" * 65, "1-1", "2-2"):
            with self.subTest(nonce=nonce):
                output = io.StringIO()
                with patch.object(sys, "argv", [SPEC.origin, "--drain-bulk-summary", nonce]), \
                        patch.object(sys, "stdout", output):
                    with self.assertRaises(SystemExit) as caught:
                        exec(compile("if True:" + entry, SPEC.origin, "exec"), namespace)
                self.assertEqual(caught.exception.code, 0)
                self.assertEqual(output.getvalue(), "{}\n")
                if nonce == "2-2":
                    self.assertFalse(summary.exists())
                else:
                    self.assertEqual(summary.read_bytes(), before)

    def test_live_summary_drain_restoration_does_not_block_a_new_summary_writer(self):
        result = {"nonce": "2-2", "updates": [], "rescan": "complete"}
        u.write_bulk_summary(str(self.home), result)
        unlink = os.unlink
        published = []

        def interleaved_unlink(name, **kwargs):
            if str(name).endswith(".claimed") and not published:
                published.append(True)
                u.write_bulk_summary(str(self.home), {**result, "nonce": "3-3"})
            return unlink(name, **kwargs)

        with patch.object(u.os, "unlink", interleaved_unlink):
            self.assertEqual(u.consume_bulk_summary(str(self.home), "1-1"), {})
        self.assertEqual(u.consume_bulk_summary(str(self.home)).get("nonce"), "3-3")

    def test_detached_bulk_executor_finishes_bound_updates_after_publication_reload(self):
        requests = [
            dict(schemaVersion=1, id="acme.plugin", repository=REPO,
                 verifiedCommit=self.target, expectedLocalHead=self.base),
            dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                 unverifiedCommit=self.new_tip, expectedLocalHead=self.new_base),
            dict(schemaVersion=1, id="acme.third", repository=REPO,
                 verifiedCommit=self.target, expectedLocalHead=self.base),
            dict(schemaVersion=1, id="acme.fourth", repository=REPO,
                 verifiedCommit=self.target, expectedLocalHead=self.base),
        ]
        calls = []

        class FixtureUpdater(BulkFixtureUpdater):
            def __init__(self):
                self.deadline = time.monotonic() + 100
                self.cancelled = False

            def prepare_update(self, request, update_lock=None):
                calls.append((request["id"], request["deferReload"]))
                if request["id"] in ("acme.third", "acme.fourth"):
                    raise u.Refused("Target moved")
                return request

            def publish_update(self, request):
                return {"status": "updated"}

            def close(self):
                pass

            def notify(self, request, result):
                if request["id"] in ("acme.plugin", NEW_ID):
                    self.deadline = 0

            def reload(self):
                self.assert_fresh_deadline()
                calls.append(("rescan", None))

            def assert_fresh_deadline(self):
                if self.deadline <= time.monotonic():
                    raise u.Refused("Expired deadline")

        result = u.execute_bulk_updates(u.bulk_request_value({"schemaVersion": 1,
                                                              "bulkUpdates": requests})["bulkUpdates"], FixtureUpdater)
        self.assertEqual(calls, [("acme.plugin", True), (NEW_ID, True), ("acme.third", True),
                                 ("acme.fourth", True), ("rescan", None)])
        self.assertEqual([item["status"] for item in result["updates"]],
                         ["updated", "updated", "unchanged; update refused", "unchanged; update refused"])
        self.assertEqual(result["rescan"], "complete")

    def test_detached_bulk_executor_retries_failed_shell_rescan(self):
        rescan_budget = (u.BULK_RESCAN_ATTEMPTS * u.BULK_RESCAN_TIMEOUT
                         + (u.BULK_RESCAN_ATTEMPTS - 1) * u.BULK_RESCAN_PAUSE)
        self.assertGreaterEqual(u.bulk_result_timeout(1) - u.UPDATE_RESULT_TIMEOUT, rescan_budget)
        calls = []
        failures = [1]

        class FixtureUpdater(BulkFixtureUpdater):
            def __init__(self):
                self.deadline = time.monotonic() + 100
                self.cancelled = False

            def prepare_update(self, request, update_lock=None):
                return request

            def publish_update(self, request):
                return {"status": "updated"}

            def notify(self, request, result):
                pass

            def reload(self):
                calls.append(self.deadline > time.monotonic())
                if len(calls) <= failures[0]:
                    raise u.Refused("Shell is still starting")

            def close(self):
                pass

        result = u.execute_bulk_updates([u.request_value(self.request)], FixtureUpdater)
        self.assertEqual(calls, [True, True])
        self.assertEqual(result["rescan"], "complete")

        calls.clear()
        failures[0] = 3
        result = u.execute_bulk_updates([u.request_value(self.request)], FixtureUpdater)
        self.assertEqual(len(calls), u.BULK_RESCAN_ATTEMPTS)
        self.assertEqual(result["rescan"], "failed")

    def test_bulk_executor_stops_before_new_items_once_cancelled(self):
        updates = u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [
            self.request,
            dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                 unverifiedCommit=self.new_tip, expectedLocalHead=self.new_base),
        ]})["bulkUpdates"]
        calls = []

        class FixtureUpdater(BulkFixtureUpdater):
            def prepare_update(self, request, update_lock=None):
                calls.append(request["id"])
                return request

            def publish_update(self, request):
                return {"status": "updated"}

            def notify(self, request, result):
                pass

            def close(self):
                pass

        result = u.execute_bulk_updates(updates, FixtureUpdater, stop={"cancelled": True})
        self.assertEqual(calls, [])
        self.assertEqual([(item["id"], item["status"], item["reason"]) for item in result["updates"]],
                         [(updates[0]["id"], "unchanged; update refused", "Stopped: cancelled"),
                          (updates[1]["id"], "unchanged; update refused", "Stopped: cancelled")])

        stop = {"cancelled": False}

        class FlippingUpdater(FixtureUpdater):
            def prepare_update(self, request, update_lock=None):
                calls.append(request["id"])
                stop["cancelled"] = True
                self.cancelled = True
                return request

            def publish_update(self, request):
                u.require(not self.cancelled, "Prepared update inherited cancellation")
                return {"status": "updated"}

            def reload(self):
                pass

        result = u.execute_bulk_updates(updates, FlippingUpdater, stop=stop)
        self.assertEqual(calls, [updates[0]["id"]])
        self.assertEqual([(item["id"], item["status"], item["reason"]) for item in result["updates"]],
                         [(updates[0]["id"], "updated", ""),
                          (updates[1]["id"], "unchanged; update refused", "Stopped: cancelled")])

    def test_bulk_executor_stops_only_on_the_exact_capacity_reason(self):
        updates = u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [
            self.request,
            dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                 unverifiedCommit=self.new_tip, expectedLocalHead=self.new_base),
        ]})["bulkUpdates"]
        calls = []
        reasons = {}

        fail_prepare = [True]

        class FixtureUpdater(BulkFixtureUpdater):
            def prepare_update(self, request, update_lock=None):
                calls.append(request["id"])
                if fail_prepare[0]:
                    raise u.Refused(reasons[request["id"]])
                return request

            def publish_update(self, request):
                return {"status": "unchanged; update refused", "reason": reasons[request["id"]]}

            def notify(self, request, result):
                pass

            def close(self):
                pass

        reasons.update({updates[0]["id"]: u.CAPACITY_REASON, updates[1]["id"]: "Target moved"})
        result = u.execute_bulk_updates(updates, FixtureUpdater)
        self.assertEqual(calls, [updates[0]["id"]])
        self.assertEqual([(item["id"], item["status"], item["reason"]) for item in result["updates"]],
                         [(updates[0]["id"], "unchanged; update refused", u.CAPACITY_REASON),
                          (updates[1]["id"], "unchanged; update refused", "Stopped: transaction limit")])

        calls.clear()
        fail_prepare[0] = False
        reasons.update({updates[0]["id"]: "Transaction limit: review x", updates[1]["id"]: "Target moved"})
        result = u.execute_bulk_updates(updates, FixtureUpdater)
        self.assertEqual(calls, [updates[0]["id"], updates[1]["id"]],
                                "a near-miss reason must not stop the batch")
        self.assertNotIn("Stopped: transaction limit",
                         [item["reason"] for item in result["updates"]])

    def test_bulk_executor_vets_every_item_before_any_exchange(self):
        updates = u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [
            self.request,
            dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                 unverifiedCommit=self.new_tip, expectedLocalHead=self.new_base),
            dict(schemaVersion=1, id="acme.third", repository=REPO,
                 verifiedCommit=self.target, expectedLocalHead=self.base),
        ]})["bulkUpdates"]
        calls = []

        class FixtureUpdater(BulkFixtureUpdater):
            def prepare_update(self, request, update_lock=None):
                calls.append(("vet", request["id"]))
                if request["id"] == "acme.third":
                    raise u.Refused("Target moved")
                return request

            def publish_update(self, request):
                calls.append(("exchange", request["id"]))
                return {"status": "updated"}

            def notify(self, request, result):
                calls.append(("notify", request["id"], result.copy()))

            def close(self):
                pass

        result = u.execute_bulk_updates(updates, FixtureUpdater)
        vets = [call for call in calls if call[0] == "vet"]
        exchanges = [call for call in calls if call[0] == "exchange"]
        self.assertEqual([call[1] for call in vets],
                         [updates[0]["id"], updates[1]["id"], updates[2]["id"]])
        self.assertEqual([call[1] for call in exchanges],
                         [updates[0]["id"], updates[1]["id"]])
        self.assertLess(max(calls.index(call) for call in vets),
                        min(calls.index(call) for call in exchanges))
        notifications = [call for call in calls if call[0] == "notify"]
        self.assertEqual(len(notifications), 3)
        self.assertEqual(notifications[0][2], {"status": "unchanged; update refused",
                                             "reason": "Target moved", "backup": ""})
        self.assertLess(max(calls.index(call) for call in exchanges),
                        min(calls.index(call) for call in notifications))
        self.assertEqual([(item["id"], item["status"]) for item in result["updates"]],
                         [(updates[0]["id"], "updated"),
                          (updates[1]["id"], "updated"),
                          (updates[2]["id"], "unchanged; update refused")])

    def test_bulk_request_binds_unique_updates_and_rejects_installs(self):
        requests = u.bulk_request_value({"schemaVersion": 1,
            "bulkUpdates": [self.request, dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO,
                unverifiedCommit=self.new_tip, expectedLocalHead=self.new_base)]})
        self.assertEqual([item["id"] for item in requests["bulkUpdates"]], ["acme.plugin", NEW_ID])
        self.assertTrue(all(item["deferReload"] for item in requests["bulkUpdates"]))
        with self.assertRaises(u.Refused):
            u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [self.request, self.request]})
        with self.assertRaises(u.Refused):
            u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": [self.install]})
        with self.assertRaises(u.Refused):
            u.bulk_request_value({"schemaVersion": 1, "bulkUpdates": []})
        many = [dict(schemaVersion=1, id=f"acme.plugin-{index}", repository=REPO,
                     verifiedCommit=self.target, expectedLocalHead=self.base) for index in range(40)]
        self.assertEqual(len(u.bulk_request_value({"schemaVersion": 1,
                                                    "bulkUpdates": many})["bulkUpdates"]), 40)

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
                "--max-filesize", str(64 * 1024 * 1024), "--header", "Cache-Control: no-cache",
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

    def test_host_calls_get_a_utf8_locale_so_qt_warnings_stay_off_stdout(self):
        # Quickshell warns on stdout, ahead of the JSON, whenever the locale
        # is not UTF-8. Under the helper's LC_ALL=C that made every plugin
        # list unreadable, so a fresh install was never enabled.
        updater = u.Updater(home=str(self.home))
        real_popen = subprocess.Popen
        calls = []
        warning = b'WARN: Detected locale "C" with character encoding "ANSI_X3.4-1968", which is not UTF-8.\n'

        def host(argv, **kwargs):
            calls.append((argv, kwargs))
            utf8 = "UTF-8" in kwargs["env"].get("LC_ALL", "")
            out = (b"" if utf8 else warning) + (
                b'[{"id":"' + NEW_ID.encode() + b'"}]' if argv[0].endswith("plugin-list") else b"ok")
            return real_popen(["/usr/bin/python3", "-I", "-S", "-c",
                               "import os; os.write(1, " + repr(out) + ")"], **kwargs)

        with patch.object(subprocess, "Popen", side_effect=host), \
                patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-1"}):
            updater.reload()
            updater.enable(NEW_ID, "right")
        self.assertEqual([argv[0] for argv, _ in calls], ["/usr/bin/qs", "/usr/bin/omarchy-plugin-list",
                                                          "/usr/bin/omarchy-plugin-enable"])
        for _, options in calls:
            self.assertEqual(options["env"]["LC_ALL"], "C.UTF-8")

    def test_enable_that_outlasts_the_ipc_timeout_counts_once_the_shell_shows_it(self):
        # The shell's IPC wrapper reports "not responding" after two seconds
        # even though the enable still lands; only the shell's state decides.
        updater = u.Updater(home=str(self.home))
        real_popen = subprocess.Popen

        def host(enabled):
            def run(argv, **kwargs):
                if argv[0].endswith("plugin-enable"):
                    script = "import os, sys; os.write(2, b'omarchy-shell is not responding\\n'); sys.exit(1)"
                else:
                    out = json.dumps([{"id": NEW_ID, "enabled": enabled}]).encode()
                    script = "import os; os.write(1, " + repr(out) + ")"
                return real_popen(["/usr/bin/python3", "-I", "-S", "-c", script], **kwargs)
            return run

        with patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-1"}), \
                patch.object(u.time, "sleep"):
            with patch.object(subprocess, "Popen", side_effect=host(True)):
                updater.enable(NEW_ID, "right")
            with patch.object(subprocess, "Popen", side_effect=host(False)), \
                    self.assertRaises(u.Refused):
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

    def test_real_install_and_update_journals_allow_the_next_transaction_at_capacity(self):
        state = self.home / ".config/omarchy/plugin-manager-updates"
        archive = self.home / ".config/omarchy/plugin-manager-updates-archive"
        # All four histories come from execute(), not just synthetic schemas.
        for request in (self.install, self.request):
            result = self.updater().execute(request)
            self.assertIn(result["status"], ("installed", "updated"))
        self.request.pop("verifiedCommit")
        self.request.update(unverifiedCommit=self.tip, expectedLocalHead=self.target)
        self.assertEqual(self.updater().execute(self.request)["status"], "updated")
        tip_request = {**self.tip_install, "id": "acme.other"}
        self.new_manifest["id"] = tip_request["id"]
        (self.new_remote / "manifest.json").write_text(json.dumps(self.new_manifest))
        self.new_tip = self.new_commit("another plugin")
        self.git("-C", str(self.new_remote), "branch", "-f", "validated", self.new_tip)
        self.assertEqual(self.updater().execute(tip_request)["status"], "installed")
        histories = {tx.name: (tx / "result.json").read_bytes() for tx in state.iterdir()}
        for i in range(28):
            (state / ("pending-%d" % i)).mkdir(mode=0o700)
        # The installed HEAD has changed since older records were written.
        # Archival must use their journals, not compare them to today's HEAD.
        later = self.commit("later update")
        request = {**self.request, "expectedLocalHead": self.tip, "unverifiedCommit": later}
        self.assertEqual(self.updater().execute(request)["status"], "updated")
        self.assertEqual(len(list(state.iterdir())), 29)
        for name, raw in histories.items():
            self.assertEqual((archive / name / "result.json").read_bytes(), raw)

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
            u.authorize(b" " * (u.MAX_RAW_CATALOG + 1), self.request)

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

    def test_unverified_install_request_shape_is_exact(self):
        base = dict(schemaVersion=1, id=NEW_ID, repository=NEW_REPO, section="right")
        for good in ("main", "release/1.0", "dev_main", "v2", "a" * 200):
            value = u.request_value({**base, "branch": good})
            self.assertTrue(value["install"])
            self.assertFalse(value["verified"], "there is no reviewed snapshot behind it")
            self.assertEqual(value["target"], "", "the commit is resolved later, from the branch")
            self.assertEqual(value["branch"], good)
            self.assertEqual(u.request_kind(value), "install")
            self.assertEqual(u.request_value(value), value, "a normalized request validates again unchanged")
            self.assertEqual(u.journal_value(value), {**base, "branch": good})
        # Branch names are validated the way the panel validates them: no
        # option shape, no traversal, no reflog syntax, no lock file.
        for bad in ("", "-main", "--upload-pack=x", "/main", ".main", "main/", "main.",
                    "main.lock", "a..b", "a//b", "ma@{in", "a" * 201, "ma in", "main\n",
                    "ma;in", "réf", None, 7, True):
            with self.subTest(bad=bad), self.assertRaises(u.Refused):
                u.request_value({**base, "branch": bad})
        # The four shapes are exact: no mixing, no extras.
        for bad in (dict(branch="main", verifiedCommit=self.new_target),
                    dict(branch="main", unverifiedCommit=self.new_tip),
                    dict(branch="main", expectedLocalHead=self.new_base),
                    dict(branch="main", extra=1)):
            with self.subTest(bad=bad), self.assertRaises(u.Refused):
                u.request_value({**base, **bad})
        for section in ("", "left", "center"):
            self.assertEqual(u.request_value({**base, "branch": "main", "section": section})["section"], section)
        for section in ("bogus", "Right", None, 0):
            with self.subTest(section=section), self.assertRaises(u.Refused):
                u.request_value({**base, "branch": "main", "section": section})
        # The derived keys carry no authority: a request that arrives claiming
        # to be verified, or naming a target, has both recomputed.
        injected = u.request_value({**base, "branch": "main", "verified": True,
                                    "install": False, "target": self.new_target})
        self.assertFalse(injected["verified"])
        self.assertTrue(injected["install"])
        self.assertEqual(injected["target"], "")

    def test_unverified_install_resolves_the_branch_tip_and_pins_that_commit(self):
        updater = self.updater()

        def never(*_):
            raise AssertionError("the catalog is not consulted for an unverified install")
        updater.catalog_bytes = never
        fetched, original = [], updater.fetch
        updater.fetch = lambda stage, sha: fetched.append(sha) or original(stage, sha)

        result = updater.execute(self.tip_install)
        self.assertEqual(result, {"status": "installed"})
        self.assertEqual(fetched, [self.new_tip], "only the resolved commit is ever fetched")
        self.assertEqual((self.new_plugin / "BarWidget.qml").read_text(), "unreviewed tip")
        self.assertEqual(self.git("-C", str(self.new_plugin), "rev-parse", "HEAD"), self.new_tip)
        # Detached on the commit, not on the branch it came from.
        self.assertEqual(self.git("-C", str(self.new_plugin), "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
        self.assertEqual(self.git("-C", str(self.new_plugin), "remote", "get-url", "origin"), NEW_REPO)
        self.assertTrue(self.reloaded)
        self.assertEqual(self.enabled, [(NEW_ID, "right")])
        # The journal records the shape the panel sent, with no derived key.
        state = self.home / ".config/omarchy/plugin-manager-updates"
        journaled = json.loads(next(iter(state.glob("txn-*/request.json"))).read_text())
        self.assertEqual(journaled, self.tip_install)
        self.assertNotIn("target", journaled)
        calls = []
        updater.run = lambda argv, **kwargs: calls.append(argv) or b""
        updater.notify(u.request_value(self.tip_install), result)
        self.assertEqual(calls[0][3], "Pinned plugin install (unverified)")
        self.assertEqual(calls[0][4], NEW_ID + ": installed")

    def test_unverified_install_refuses_an_unreadable_branch_reference(self):
        for raw in (b"", b"\n", b"x" * 40 + b"\trefs/heads/validated\n",
                    self.new_tip.encode() + b"\trefs/heads/other\n",
                    self.new_tip.encode() + b"\trefs/tags/validated\n",
                    self.new_tip.encode() + b" refs/heads/validated\n",
                    self.new_tip.encode() + b"\n",
                    self.new_tip.encode() + b"\trefs/heads/validated\n"
                    + self.new_base.encode() + b"\trefs/heads/validated\n"):
            with self.subTest(raw=raw):
                updater = self.updater()
                updater.ls_remote = lambda stage, branch, raw=raw: raw
                with self.assertRaises(u.Refused):
                    updater.execute(self.tip_install)
                self.assertFalse(self.new_plugin.exists())
                self.assertEqual(self.enabled, [])
        # Nothing downstream accepts anything but a full SHA-1, so a resolver
        # that handed back a name could still not make git see a branch.
        updater = self.updater()
        updater.resolve_tip = lambda stage, branch: "validated"
        with self.assertRaises(u.Refused):
            updater.execute(self.tip_install)
        self.assertFalse(self.new_plugin.exists())

    def test_unverified_install_keeps_every_other_install_refusal(self):
        # No catalog authorization to lose, but the host's id check, the
        # manifest check and the no-replace publication all still apply.
        updater = self.updater()
        updater.catalog_ids = lambda: {NEW_ID}
        with self.assertRaisesRegex(u.Refused, "already"):
            updater.execute(self.tip_install)
        self.assertFalse(self.new_plugin.exists())

        self.new_plugin.mkdir()
        with self.assertRaisesRegex(u.Refused, "Already installed"):
            self.updater().execute(self.tip_install)
        self.new_plugin.rmdir()

        self.new_manifest["id"] = "acme.other"
        (self.new_remote / "manifest.json").write_text(json.dumps(self.new_manifest))
        self.new_commit("changed id")
        self.git("-C", str(self.new_remote), "branch", "-f", "validated", "HEAD")
        with self.assertRaises(u.Refused):
            self.updater().execute(self.tip_install)
        self.assertFalse(self.new_plugin.exists())
        self.assertEqual(self.enabled, [])

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
        return {"projectionSchemaVersion": 3, "generatedAt": "cached", "plugins": list(plugins)}

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

    def test_force_discovers_new_listings_and_replaces_the_cache_atomically(self):
        self.cached(self.compatible([{"id": "acme.clock"}]))
        self.remote["plugins"].append({"id": "acme.new", "name": "New listing"})
        before = os.stat(self.cache_dir / "catalog.json")
        served = self.serve(force=True)
        projected = json.loads(served)
        self.assertEqual(projected["projectionSchemaVersion"], 3)
        self.assertEqual(projected["generatedAt"], "remote")
        self.assertEqual([entry["id"] for entry in projected["plugins"]], ["acme.clock", "acme.new"])
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
        self.assertEqual(self.serve(), data)

    def test_forced_refresh_failures_refuse_without_replacing_cached_bytes(self):
        for age in (0, u.CACHE_TTL + 1):
            for phase in ("fetch", "project", "publish"):
                with self.subTest(age=age, phase=phase):
                    data = self.cached(self.compatible(), age=age)
                    before = (self.cache_dir / "catalog.json").stat()
                    target = {"fetch": "catalog_bytes", "project": "project_catalog",
                              "publish": "create_file"}[phase]
                    updater = self.updater()
                    owner = updater if phase == "fetch" else u
                    with patch.object(owner, target, side_effect=u.Refused(phase + " failed")):
                        with self.assertRaisesRegex(u.Refused, "Could not fetch the catalog: " + phase + " failed"):
                            updater.serve_catalog({"schemaVersion": 1, "catalog": {"force": True}})
                    after = (self.cache_dir / "catalog.json").stat()
                    self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), data)
                    self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))
                    self.assertEqual(updater.fds, [])
                    self.assertEqual(self.temps(), [])

    def test_forced_refresh_cli_exits_with_bounded_error_and_no_cached_stdout(self):
        self.cached(self.compatible())
        self.remote = u.Refused("Command failed: curl" + "x" * 300 + "\n")
        request = {"schemaVersion": 1, "catalog": {"force": True}}
        stdout, stderr = io.TextIOWrapper(io.BytesIO()), io.StringIO()
        self.addCleanup(stdout.close)
        # Execute the real CLI entry point with only the updater/home and I/O
        # replaced; no live network or account cache is involved.
        entry = Path(SPEC.origin).read_text().split('if __name__ == "__main__":', 1)[1]
        namespace = {**vars(u), "Updater": self.updater}
        with patch.object(sys, "argv", [SPEC.origin, json.dumps(request)]), \
                patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr), \
                patch.object(u.os, "umask"):
            with self.assertRaises(SystemExit) as caught:
                exec(compile("if True:" + entry, SPEC.origin, "exec"), namespace)
        self.assertEqual(caught.exception.code, 1)
        self.assertEqual(stdout.buffer.getvalue(), b"")
        self.assertTrue(stderr.getvalue().startswith("Could not fetch the catalog: Command failed: curl"))
        self.assertLessEqual(len(stderr.getvalue()), 201)
        self.assertEqual(stderr.getvalue().count("\n"), 1)

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

    def test_raw_catalog_above_old_cap_is_projected_and_cached(self):
        self.remote["unusedMetadata"] = "x" * (8 * 1024 * 1024)
        raw = json.dumps(self.remote).encode()
        self.assertGreater(len(raw), 8 * 1024 * 1024)
        self.assertLess(len(raw), 16 * 1024 * 1024)
        served = self.serve(force=True)
        self.assertLess(len(served), 8 * 1024 * 1024)
        projected = json.loads(served)
        self.assertEqual(projected["plugins"][0]["id"], "acme.clock")
        self.assertEqual(projected["plugins"][0]["marketplaceHearts"], 42)
        self.assertNotIn("unusedMetadata", projected)
        self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), served)

    def test_raw_cap_applies_to_projection_and_listing_authorization(self):
        request = {"id": "acme.clock", "repository": REPO, "verifiedCommit": "a" * 40}
        entry = dict(id=request["id"], repo=REPO, verificationCommit="a" * 40,
                     verificationStatus="verified", sourceType="community")
        # 64 MiB leaves months of headroom: the raw catalog grew by about
        # 2,500 listings a month through September 2026.
        raw = json.dumps({"plugins": [entry]}).encode().ljust(64 * 1024 * 1024)
        self.assertIsNone(u.authorize(raw, request))
        self.assertEqual(json.loads(u.project_catalog(raw, None))["plugins"][0]["id"], request["id"])
        for consume in (lambda body: u.authorize(body, request),
                        lambda body: u.project_catalog(body, None)):
            with self.assertRaisesRegex(u.Refused, "JSON exceeds limit"):
                consume(raw + b" ")
        # A larger byte budget grants no new install/update authority.
        for change, reason in [
            ({"verificationStatus": "unverified"}, "Listing is not verified"),
            ({"sourceType": "builtin"}, "Not a community snapshot"),
            ({"repo": "https://github.com/other/plugin"}, "Repository changed"),
            ({"verificationCommit": "b" * 40}, "Verified snapshot changed"),
        ]:
            with self.subTest(change=change):
                body = json.dumps({"plugins": [{**entry, **change}]}).encode().ljust(8 * 1024 * 1024 + 1)
                with self.assertRaisesRegex(u.Refused, reason):
                    u.authorize(body, request)
        # The marketplace passed 5,000 listings in October 2026. Only the byte
        # budget bounds the catalog: a large one still authorizes the listing.
        others = [dict(entry, id=f"acme.plugin{n}") for n in range(5200)]
        self.assertIsNone(u.authorize(json.dumps({"plugins": others + [entry]}).encode(), request))

    def test_catalog_stream_cap_is_enforced_without_curl_cooperation(self):
        updater = u.Updater(home=str(self.home))
        real_popen = subprocess.Popen
        size = u.MAX_RAW_CATALOG

        def producer(argv, **kwargs):
            # Simulate an undeclared/chunked body: the actual stream reader,
            # not curl's Content-Length check, must enforce the same budget.
            return real_popen(["/usr/bin/python3", "-I", "-S", "-B", "-c",
                "import sys; sys.stdout.buffer.write(b' ' * " + str(size) +
                " + b'\\n200')"], **kwargs)

        with patch.object(subprocess, "Popen", side_effect=producer):
            self.assertEqual(len(updater.catalog_bytes()), size)
            size += 1
            with self.assertRaisesRegex(u.Refused, "Command output exceeds limit"):
                updater.catalog_bytes()

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
        body = json.dumps({"generatedAt": "remote", "plugins": [{"id": "repeat"}] * 80000}).encode()
        self.assertEqual(u.MAX_CATALOG, 16 * 1024 * 1024)
        self.assertLess(len(body), u.MAX_CATALOG)
        with self.assertRaisesRegex(u.Refused, "Projection exceeds limit"):
            u.project_catalog(body, None)
        self.remote = body
        self.assertEqual(self.serve(), data)
        self.assertEqual((self.cache_dir / "catalog.json").read_bytes(), data)
        self.assertEqual(self.temps(), [])

    def test_oversized_cache_is_never_served(self):
        oversized = json.dumps(self.compatible()).encode().ljust(u.MAX_CATALOG + 1)
        self.assertFalse(u.usable_projection(oversized))
        self.cached(oversized)
        self.remote = u.Refused("Command failed: curl")
        with self.assertRaises(u.Refused):
            self.serve()

    def test_stats_are_joined_by_id_and_unavailable_stats_read_as_missing(self):
        for name, stats, expected in [
            ("valid", {"plugins": {"acme.clock": {"hearts": 42, "views": 80, "copies": 12}}}, (42, 80, 12)),
            ("other id", {"plugins": {"acme.other": {"hearts": 42, "views": 80, "copies": 12}}}, (None, None, None)),
            ("false values", {"plugins": {"acme.clock": {"hearts": False, "views": False, "copies": False}}}, (None, None, None)),
            ("null values", {"plugins": {"acme.clock": {"hearts": None, "views": None, "copies": None}}}, (None, None, None)),
            ("record is not an object", {"plugins": {"acme.clock": 5}}, (None, None, None)),
            ("plugins is not an object", {"plugins": []}, (None, None, None)),
            ("malformed", b"{not-json", (None, None, None)),
            ("oversized", b'{"plugins":{"acme.clock":{"hearts":42,"views":80,"copies":12}},"padding":"' + b"x" * u.MAX_STATS + b'"}', (None, None, None)),
            ("fetch refused", u.Refused("Command failed: curl"), (None, None, None)),
            ("fetch error", OSError("no curl"), (None, None, None)),
        ]:
            with self.subTest(name=name):
                self.stats = stats
                projection = json.loads(self.serve(force=True))
                projected = projection["plugins"][0]
                self.assertEqual((projected["marketplaceHearts"], projected["marketplaceViews"],
                                  projected["marketplaceCopies"]), expected)
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
            "stars", "addedAt", "listedAt", "marketplaceHearts", "marketplaceViews",
            "marketplaceCopies", "repositoryUpdatedAt", "versionUpdatedAt", "accent", "initials", "license",
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
            with self.assertRaisesRegex(u.Refused, "Could not fetch the catalog: Internal error: OSError"):
                self.serve(force=True)
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


class ArchivalTests(unittest.TestCase):
    """Exercise capacity preflight without fetching or invoking the desktop."""

    def fixture(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / "home"
        self.omarchy = self.home / ".config/omarchy"
        (self.omarchy / "plugins/acme.plugin").mkdir(parents=True)
        self.state = self.omarchy / "plugin-manager-updates"
        self.state.mkdir(mode=0o700)
        self.archive = self.omarchy / "plugin-manager-updates-archive"

    def record(self, tx, name, value):
        path = tx / (name + ".json")
        path.write_bytes(json.dumps(value).encode())
        path.chmod(0o600)

    def history(self, number, kind="update", verified=True):
        tx = self.state / ("txn-%024x" % number)
        tx.mkdir(mode=0o700)
        request = dict(schemaVersion=1, id="acme.plugin", repository=REPO)
        prepared = {"replacement": [tx.stat().st_dev, tx.stat().st_ino + 1000000]}
        if kind == "update":
            request.update(expectedLocalHead="a" * 40)
            request["verifiedCommit" if verified else "unverifiedCommit"] = "b" * 40
            checkout = tx / "checkout"
            checkout.mkdir(mode=0o755)
            (checkout / "valuable.txt").write_bytes(b"original backup\x00bytes")
            prepared["original"] = [checkout.stat().st_dev, checkout.stat().st_ino]
            result = dict(status="updated", backup=str(checkout))
        else:
            request.update(section="right")
            request.update({"verifiedCommit": "b" * 40} if verified else {"branch": "main"})
            result = dict(status="installed")
        for name, value in (("request", request), ("prepared", prepared),
                            ("published", result), ("result", result)):
            self.record(tx, name, value)
        return tx

    def fill(self, start=1, stop=32):
        for number in range(start, stop + 1):
            (self.state / ("pending-%d" % number)).mkdir(mode=0o700)

    def updater(self):
        updater = u.Updater(home=str(self.home))
        def close():
            for fd in reversed(updater.fds):
                os.close(fd)
            updater.fds.clear()
        self.addCleanup(close)
        return updater

    def preflight(self):
        updater = self.updater()
        try:
            updater.open_paths("acme.plugin")
        finally:
            for fd in reversed(updater.fds):
                os.close(fd)
            updater.fds.clear()

    def assert_limit(self):
        with self.assertRaises(u.Refused) as caught:
            self.preflight()
        reason = u.reason_text(caught.exception)
        self.assertIn("~/.config/omarchy/plugin-manager-updates", reason)
        self.assertIn("README", reason)
        self.assertLess(len(reason), 200)

    def test_renumbered_device_histories_still_archive_at_capacity(self):
        # btrfs may renumber st_dev across a reboot (issue #7); proven-success
        # history must stay archivable or updates wedge at the cap forever.
        self.fixture()
        for i in range(32):
            tx = self.history(i, "update" if i % 2 else "install")
            path = tx / "prepared.json"
            prepared = json.loads(path.read_text())
            for pair in prepared.values():
                pair[0] += 1
            path.write_text(json.dumps(prepared))
        with patch.object(u.Updater, "git", side_effect=AssertionError("No history HEAD lookup")):
            self.preflight()
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertEqual(len(list(self.archive.iterdir())), 32)

    def test_full_successful_histories_archive_without_rewriting_or_traversing_backups(self):
        for kind in ("install", "update"):
            for verified in (True, False):
                with self.subTest(kind=kind, verified=verified):
                    self.fixture()
                    originals = [self.history(i, kind, verified) for i in range(32)]
                    snapshots = {p.name: {f.name: (f.read_bytes(), f.stat().st_ino)
                                 for f in p.glob("*.json")} for p in originals}
                    backups = {p.name: (p / "checkout").stat().st_ino for p in originals
                               if (p / "checkout").exists()}
                    if backups:
                        # Backup content is preserved, not scanned for eligibility.
                        os.mkfifo(originals[0] / "checkout/opaque-fifo")
                    with patch.object(u.Updater, "git", side_effect=AssertionError("No history HEAD lookup")):
                        self.preflight()
                    self.assertEqual(list(self.state.iterdir()), [])
                    self.assertEqual(self.archive.stat().st_mode & 0o777, 0o700)
                    for name, records in snapshots.items():
                        archived = self.archive / name
                        for filename, (raw, inode) in records.items():
                            self.assertEqual((archived / filename).read_bytes(), raw)
                            self.assertEqual((archived / filename).stat().st_ino, inode)
                        if name in backups:
                            self.assertEqual((archived / "checkout").stat().st_ino, backups[name])
                            self.assertEqual((archived / "checkout/valuable.txt").read_bytes(),
                                             b"original backup\x00bytes")

    def test_below_pressure_does_not_open_history_or_archive(self):
        self.fixture()
        for i in range(31):
            self.history(i)
        self.archive.symlink_to(self.state, target_is_directory=True)
        with patch.object(u, "read_file", side_effect=AssertionError("No history read below capacity")):
            self.preflight()
        self.assertEqual(len(list(self.state.iterdir())), 31)

    def test_configured_limit_moves_archival_threshold(self):
        self.fixture()
        (self.omarchy / "shell.json").write_text(json.dumps(
            {"bar": {"layout": {"right": [{"id": "io.github.juancasanueva.plugin-manager",
                                           "transactionLimit": 8}]}}}))
        for i in range(8):
            self.history(i)
        with patch.object(u.Updater, "git", side_effect=AssertionError("No history HEAD lookup")):
            self.preflight()
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertEqual(len(list(self.archive.iterdir())), 8)

    def test_limit_below_active_count_archives_down_before_refusing(self):
        # Settings clamps to the live count, but the helper cannot trust the
        # panel: status may be missing or stale, or shell.json hand-edited.
        # When the saved limit is below the active count, proven-success
        # history is archived down first and only the recount refuses.
        self.fixture()
        (self.omarchy / "shell.json").write_text(json.dumps(
            {"plugins": [{"id": "io.github.juancasanueva.plugin-manager",
                          "transactionLimit": 8}]}))
        for i in range(12):
            self.history(i)
        with patch.object(u.Updater, "git", side_effect=AssertionError("No history HEAD lookup")):
            self.preflight()
        self.assertEqual(len(list(self.state.iterdir())), 3)
        self.assertEqual(len(list(self.archive.iterdir())), 9)

    def test_mixed_history_repeated_pressure_and_archive_is_never_enumerated(self):
        self.fixture()
        self.fill(stop=31)
        scan = os.scandir
        def active_only(fd):
            self.assertEqual(u.identity(fd), (self.state.stat().st_dev, self.state.stat().st_ino))
            return scan(fd)
        for number in (100, 101):
            tx = self.history(number)
            with patch.object(u.os, "scandir", side_effect=active_only):
                updater = self.updater()
                updater.open_paths("acme.plugin")
            # Release the held lock as an actual finished worker does.
            for fd in reversed(updater.fds):
                os.close(fd)
            updater.fds.clear()
            self.assertFalse(tx.exists())
            self.assertTrue((self.archive / tx.name / "checkout/valuable.txt").exists())
            self.assertEqual(len(list(self.state.iterdir())), 31)
        self.assertEqual(len(list(self.archive.iterdir())), 2)

    def test_unsafe_or_incomplete_histories_stay_active(self):
        cases = ("missing-result", "reload", "enable", "finalization", "unknown-status",
                 "wrong-backup", "published-mismatch", "result-extra", "request-extra",
                 "request-derived", "request-version", "prepared-extra", "identity-bool",
                 "identity-negative", "identity-mismatch", "identity-same", "refused",
                 "refused-symlink", "duplicate", "oversize", "malformed", "journal-symlink",
                 "journal-hardlink", "journal-fifo", "journal-mode", "transaction-mode",
                 "transaction-symlink", "checkout-symlink", "checkout-mode", "bad-name",
                 "install-checkout", "install-original", "wrong-owner", "unchanged-target",
                 "journal-readable", "missing-request", "prepared-list", "replacement-float")
        for case in cases:
            with self.subTest(case=case):
                self.fixture()
                self.fill(stop=31)
                tx = self.history(100, "install" if case.startswith("install-") else "update")
                result = json.loads((tx / "result.json").read_bytes())
                prepared = json.loads((tx / "prepared.json").read_bytes())
                request = json.loads((tx / "request.json").read_bytes())
                if case in ("missing-result", "missing-request"):
                    (tx / (case.removeprefix("missing-") + ".json")).rename(tx / "missing.json")
                elif case == "unchanged-target":
                    request["verifiedCommit"] = request["expectedLocalHead"]
                    self.record(tx, "request", request)
                elif case == "prepared-list":
                    self.record(tx, "prepared", [])
                elif case == "replacement-float":
                    prepared["replacement"][1] = 1.5
                    self.record(tx, "prepared", prepared)
                elif case in ("reload", "enable", "finalization", "unknown-status"):
                    result["status"] = "updated; " + case + " failed"
                    self.record(tx, "result", result)
                elif case == "wrong-backup":
                    result["backup"] += "/other"
                    for name in ("result", "published"):
                        self.record(tx, name, result)
                elif case == "published-mismatch":
                    self.record(tx, "published", dict(status="installed"))
                elif case == "result-extra":
                    self.record(tx, "result", {**result, "other": 1})
                elif case.startswith("request-"):
                    request[{"request-extra": "other", "request-derived": "target",
                             "request-version": "schemaVersion"}[case]] = 99
                    self.record(tx, "request", request)
                elif case in ("prepared-extra", "identity-bool", "identity-negative", "identity-mismatch",
                              "identity-same", "install-original"):
                    if case in ("prepared-extra", "install-original"):
                        prepared["other" if case == "prepared-extra" else "original"] = [1, 2]
                    elif case == "identity-same":
                        prepared["replacement"] = prepared["original"]
                    else:
                        prepared["original"][1] = {"identity-bool": True, "identity-negative": -1,
                                                    "identity-mismatch": 1}[case]
                    self.record(tx, "prepared", prepared)
                elif case == "refused":
                    self.record(tx, "refused", {})
                elif case == "refused-symlink":
                    (tx / "refused.json").symlink_to("absent")
                elif case in ("duplicate", "oversize", "malformed"):
                    (tx / "result.json").write_bytes({"duplicate": b'{"status":"updated","status":"updated"}',
                                                      "oversize": b" " * 65537,
                                                      "malformed": b"{"}[case])
                elif case.startswith("journal-"):
                    path = tx / "result.json"
                    path.rename(tx / "saved-result")
                    if case == "journal-symlink":
                        path.symlink_to("saved-result")
                    elif case == "journal-hardlink":
                        os.link(tx / "saved-result", path)
                    elif case == "journal-fifo":
                        os.mkfifo(path)
                    else:
                        self.record(tx, "result", result)
                        path.chmod(0o644 if case == "journal-readable" else 0o666)
                elif case in ("transaction-mode", "checkout-mode"):
                    (tx if case == "transaction-mode" else tx / "checkout").chmod(0o777)
                elif case == "transaction-symlink":
                    moved = self.omarchy / "moved"
                    tx.rename(moved)
                    tx.symlink_to(moved, target_is_directory=True)
                elif case == "checkout-symlink":
                    (tx / "checkout").rename(tx / "saved-checkout")
                    (tx / "checkout").symlink_to("saved-checkout")
                elif case == "bad-name":
                    tx = tx.rename(self.state / "txn-NOT-A-TRANSACTION")
                elif case == "install-checkout":
                    (tx / "checkout").mkdir()
                if case == "wrong-owner":
                    # Scope the foreign uid to journal validation, not the home chain.
                    foreign_uid = os.getuid() + 1
                    read = u.read_file
                    def foreign(*args, **kwargs):
                        with patch.object(u.os, "getuid", return_value=foreign_uid):
                            return read(*args, **kwargs)
                    with patch.object(u, "read_file", side_effect=foreign):
                        self.assert_limit()
                else:
                    self.assert_limit()
                self.assertTrue(tx.exists())
                self.assertFalse(self.archive.exists())

    def test_unsafe_archive_roots_and_all_collision_types_refuse_without_overwrite(self):
        for case in ("root-symlink", "root-file", "root-mode", "collision-directory",
                     "collision-file", "collision-symlink"):
            with self.subTest(case=case):
                self.fixture()
                self.fill(stop=31)
                tx = self.history(100)
                if case == "root-symlink":
                    self.archive.symlink_to(self.state)
                elif case == "root-file":
                    self.archive.write_bytes(b"keep")
                else:
                    self.archive.mkdir(mode=0o700)
                    if case == "root-mode":
                        self.archive.chmod(0o755)
                    elif case == "collision-directory":
                        (self.archive / tx.name).mkdir()
                    elif case == "collision-file":
                        (self.archive / tx.name).write_bytes(b"keep")
                    else:
                        (self.archive / tx.name).symlink_to("absent")
                collision = self.archive / tx.name if case.startswith("collision") else self.archive
                before = collision.lstat()
                with self.assertRaisesRegex(u.Refused, "Archive.*README"):
                    self.preflight()
                self.assertEqual(collision.lstat(), before)
                self.assertTrue(tx.exists())

    def test_archive_root_must_be_owned_and_on_the_same_filesystem(self):
        for field in (2, 4):  # stat_result device and uid fields
            with self.subTest(field=field):
                self.fixture()
                self.fill(stop=31)
                tx = self.history(100)
                self.archive.mkdir(mode=0o700)
                archive_inode = self.archive.stat().st_ino
                fstat = os.fstat
                def foreign(fd):
                    info = fstat(fd)
                    if info.st_ino == archive_inode:
                        fields = list(info)
                        fields[field] += 1
                        return os.stat_result(fields)
                    return info
                with patch.object(u.os, "fstat", side_effect=foreign):
                    with self.assertRaisesRegex(u.Refused, "Archive"):
                        self.preflight()
                self.assertTrue(tx.exists())
                self.assertEqual(list(self.archive.iterdir()), [])

    def test_mixed_success_and_failed_journals_preserve_unresolved_history(self):
        self.fixture()
        failed = {}
        for i in range(32):
            tx = self.history(i, "install" if i % 2 else "update", verified=bool(i % 3))
            if i % 4 == 0:
                result = json.loads((tx / "result.json").read_bytes())
                result["status"] += "; reload failed"
                self.record(tx, "result", result)
                failed[tx.name] = (tx / "result.json").read_bytes()
        self.preflight()
        self.assertEqual({p.name for p in self.state.iterdir()}, set(failed))
        self.assertEqual(len(list(self.archive.iterdir())), 24)
        for name, raw in failed.items():
            self.assertEqual((self.state / name / "result.json").read_bytes(), raw)

    def test_archive_failures_never_admit_a_new_transaction(self):
        for case in ("unavailable", "rename", "creation-fsync", "source-fsync", "archive-fsync",
                     "cancel", "deadline", "replace-source", "replace-after", "replace-root"):
            with self.subTest(case=case):
                self.fixture()
                self.fill(stop=31)
                tx = self.history(100)
                updater = self.updater()
                checkpoint = updater.checkpoint
                rename = u.NOREPLACE
                fsync = os.fsync
                def check(phase):
                    if phase == "before-archive":
                        if case == "cancel":
                            updater.cancelled = True
                        elif case == "deadline":
                            updater.deadline = 0
                        elif case == "replace-source":
                            tx.rename(self.omarchy / "displaced")
                            tx.mkdir(mode=0o700)
                        elif case == "replace-root":
                            self.archive.rename(self.omarchy / "displaced-archive")
                            self.archive.mkdir(mode=0o700)
                    checkpoint(phase)
                updater.checkpoint = check
                def move(*args):
                    if case == "rename":
                        return -1
                    rc = rename(*args)
                    if case == "replace-after" and rc == 0:
                        archived = self.archive / tx.name
                        archived.rename(self.archive / "displaced")
                        archived.mkdir(mode=0o700)
                    return rc
                def sync(fd):
                    target = {"creation-fsync": self.omarchy, "source-fsync": self.state,
                              "archive-fsync": self.archive}.get(case)
                    if target is not None and target.exists() and u.identity(fd) == (
                            target.stat().st_dev, target.stat().st_ino):
                        raise OSError("injected fsync failure")
                    fsync(fd)
                with patch.object(u, "NOREPLACE", None if case == "unavailable" else move), \
                     patch.object(u.os, "fsync", side_effect=sync):
                    with self.assertRaises(u.Refused):
                        updater.open_paths("acme.plugin")
                self.assertEqual(updater.transaction, "")
                self.assertTrue(tx.exists() or (self.archive / tx.name).exists())

    def test_journal_mutation_after_validation_is_detected_before_and_after_rename(self):
        for phase in ("before-archive", "rename"):
            with self.subTest(phase=phase):
                self.fixture()
                self.fill(stop=31)
                tx = self.history(100)
                updater = self.updater()
                checkpoint, rename = updater.checkpoint, u.NOREPLACE
                def check(current):
                    if current == phase:
                        self.record(tx, "result", {"status": "updated; reload failed"})
                    checkpoint(current)
                def move(*args):
                    result = rename(*args)
                    if phase == "rename" and result == 0:
                        self.record(self.archive / tx.name, "refused", {})
                    return result
                updater.checkpoint = check
                with patch.object(u, "NOREPLACE", side_effect=move):
                    with self.assertRaisesRegex(u.Refused, "Archive"):
                        updater.open_paths("acme.plugin")
                self.assertEqual(updater.transaction, "")
                self.assertTrue(tx.exists() if phase == "before-archive"
                                else (self.archive / tx.name).exists())

    def test_successful_move_still_needs_a_fresh_bounded_recount(self):
        for case in ("refilled", "unreadable", "cancelled"):
            with self.subTest(case=case):
                self.fixture()
                self.fill(stop=31)
                tx = self.history(100)
                updater = self.updater()
                checkpoint = updater.checkpoint
                scan = os.scandir
                calls = []
                def check(phase):
                    if phase == "after-archive":
                        if case == "refilled":
                            self.fill(start=100, stop=100)
                        elif case == "cancelled":
                            updater.cancelled = True
                    checkpoint(phase)
                def inventory(fd):
                    calls.append(fd)
                    if case == "unreadable" and len(calls) == 2:
                        raise OSError("recount unavailable")
                    return scan(fd)
                updater.checkpoint = check
                with patch.object(u.os, "scandir", side_effect=inventory):
                    with self.assertRaises(u.Refused):
                        updater.open_paths("acme.plugin")
                self.assertEqual(updater.transaction, "")
                self.assertTrue((self.archive / tx.name).exists())
                if case != "cancelled":
                    self.assertEqual(len(calls), 2)

    def test_lock_excludes_archival_and_inventory_stops_at_the_33rd_entry(self):
        self.fixture()
        self.fill(stop=32)
        tx = self.history(100)
        scan = os.scandir
        enumerations = []

        class BoundedScan:
            def __init__(self, fd):
                self.entries = scan(fd)
                self.reads = 0
                enumerations.append(0)
            def __enter__(self):
                return self
            def __exit__(self, *_):
                self.entries.close()
            def __iter__(self):
                return self
            def __next__(self):
                self.reads += 1
                enumerations[-1] = max(enumerations[-1], self.reads)
                if self.reads > 33:
                    raise AssertionError("Read beyond the bounded inventory")
                return next(self.entries)
        # One completed txn sits past the limit, so the walk archives it down
        # and the recount over the 32 pending names still refuses.
        with patch.object(u.os, "scandir", BoundedScan):
            self.assert_limit()
        self.assertEqual(enumerations[0], 33)
        self.assertLessEqual(max(enumerations), 33)
        self.assertTrue((self.archive / tx.name).exists())
        self.assertFalse(tx.exists())
        lock = os.open(self.state, u.DIR)
        try:
            u.fcntl.flock(lock, u.fcntl.LOCK_EX | u.fcntl.LOCK_NB)
            with patch.object(u.os, "scandir", side_effect=AssertionError("Inventory needs the lock")):
                with self.assertRaisesRegex(u.Refused, "Another pinned update"):
                    self.preflight()
        finally:
            os.close(lock)


if __name__ == "__main__":
    unittest.main()
