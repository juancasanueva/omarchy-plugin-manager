#!/usr/bin/python3
"""Exact marketplace snapshots; no installed Git configuration is executed.

CLI: python3 -I -S pinned_update.py REQUEST_JSON
The CLI forks a finite, independent worker before touching the plugin root.
All executable Python is loaded before the fork. A destroyed QML Process can
lose its result pipe, but cannot interrupt the worker's publication/finalization.
Transactions are retained, never automatically removed or rolled back.
"""
import configparser
import ctypes
import fcntl
import hashlib
import json
import os
import pwd
import re
import resource
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import time

CATALOG_URL = "https://plugins.omarchy.org/catalog.json"
SHA = re.compile(r"[0-9a-fA-F]{40}\Z")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
MAX_CATALOG = 8 * 1024 * 1024
MAX_TREE = 16 * 1024 * 1024
MAX_DISK = 128 * 1024 * 1024
LIBC = ctypes.CDLL(None, use_errno=True)
EXCHANGE = getattr(LIBC, "renameat2", None)
if EXCHANGE:
    EXCHANGE.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    EXCHANGE.restype = ctypes.c_int


class Refused(Exception):
    """A failed prerequisite, never permission to use another target."""


def reason_text(error):
    """Static helper prose only: printable ASCII, bounded, no paths or tracebacks."""
    text = str(error) if isinstance(error, Refused) else "Internal error: " + type(error).__name__
    return "".join(c for c in text if 32 <= ord(c) < 127)[:200]


def require(condition, message):
    if not condition:
        raise Refused(message)


def repository(value):
    if not isinstance(value, str):
        return ""
    match = re.fullmatch(r"(?:https://github\.com/|ssh://git@github\.com/|git@github\.com:)"
                        r"([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/([A-Za-z0-9._-]+?)(?:\.git)?/?", value)
    if not match:
        return ""
    owner, repo = match.groups()
    if len(owner) > 39 or len(repo) > 100 or repo in (".", ".."):
        return ""
    return "https://github.com/" + owner.lower() + "/" + repo.lower()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def document(raw, cap):
    require(len(raw) <= cap, "JSON exceeds limit")
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=lambda _: require(False, "Non-finite JSON"))
    except (ValueError, RecursionError, UnicodeError) as error:
        raise Refused("Invalid JSON") from error


def request_value(value):
    require(type(value) is dict and set(value) == {
        "schemaVersion", "id", "repository", "verifiedCommit", "expectedLocalHead"}, "Invalid request fields")
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1, "Unsupported request")
    require(isinstance(value["id"], str) and ID.fullmatch(value["id"])
            and ".." not in value["id"] and not value["id"].startswith("omarchy."), "Invalid plugin id")
    require(repository(value["repository"]) == value["repository"] != "", "Noncanonical repository")
    for key in ("verifiedCommit", "expectedLocalHead"):
        require(isinstance(value[key], str) and SHA.fullmatch(value[key]), "Full SHA-1 required")
    return {**value, "verifiedCommit": value["verifiedCommit"].lower(),
            "expectedLocalHead": value["expectedLocalHead"].lower()}


def authorize(raw, request):
    doc = document(raw, MAX_CATALOG)
    require(type(doc) is dict and type(doc.get("plugins")) is list
            and len(doc["plugins"]) <= 5000, "Invalid catalog")
    matches = []
    for entry in doc["plugins"]:
        require(type(entry) is dict and isinstance(entry.get("id"), str), "Malformed catalog entry")
        if entry["id"] == request["id"]:
            matches.append(entry)
    require(len(matches) == 1, "Listing missing or ambiguous")
    entry = matches[0]
    require(entry.get("verificationStatus") == "verified", "Listing is not verified")
    require(entry.get("sourceType") == "community", "Not a community snapshot")
    require(repository(entry.get("repo")) == request["repository"], "Repository changed")
    sha = entry.get("verificationCommit")
    require(isinstance(sha, str) and SHA.fullmatch(sha)
            and sha.lower() == request["verifiedCommit"], "Verified snapshot changed")


def identity(fd):
    value = os.fstat(fd)
    return value.st_dev, value.st_ino


def checked_dir(parent, name, private=False):
    fd = os.open(name, DIR, dir_fd=parent)
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.getuid() and not info.st_mode & 0o022, "Unsafe directory permissions")
        require(not private or stat.S_IMODE(info.st_mode) == 0o700, "Transaction directory must be 0700")
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_file(parent, name, cap, sync=False):
    fd = os.open(name, FILE, dir_fd=parent)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and info.st_nlink == 1 and not info.st_mode & 0o7022 and info.st_size <= cap, "Unsafe file")
        result = bytearray()
        while len(result) <= cap:
            chunk = os.read(fd, min(65536, cap + 1 - len(result)))
            if not chunk:
                break
            result.extend(chunk)
        require(len(result) <= cap, "File grew beyond limit")
        if sync:
            os.fsync(fd)
        return bytes(result), info.st_mode
    finally:
        os.close(fd)


def create_file(parent, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            require(written > 0, "Short file write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(parent)


class Updater:
    def __init__(self, home=None):
        # Test injection is in-process only; argv/environment never select a home.
        self.home = home if home is not None else pwd.getpwuid(os.getuid()).pw_dir
        self.deadline = time.monotonic() + 120
        self.fds = []
        self.anchors = []
        self.published = False
        self.cancelled = False
        self.transaction = ""
        self.backup = ""
        self.reason = ""
        self.tx = None
        self.env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/usr/bin/false",
            "GIT_NO_REPLACE_OBJECTS": "1", "GIT_ATTR_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0", "GIT_ALLOW_PROTOCOL": "https"}

    def hold(self, fd):
        self.fds.append(fd)
        return fd

    def checkpoint(self, phase):
        require(not self.cancelled and time.monotonic() < self.deadline, "Cancelled or deadline exceeded")

    def run(self, argv, cwd=None, cap=1024 * 1024, extra_env=None):
        self.checkpoint("subprocess")
        env = {**self.env, **(extra_env or {})}

        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
        proc = subprocess.Popen(argv, cwd=None if cwd is None else f"/proc/self/fd/{cwd}",
            pass_fds=() if cwd is None else (cwd,), env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, preexec_fn=limits)
        out, err = bytearray(), bytearray()
        try:
            with selectors.DefaultSelector() as poller:
                poller.register(proc.stdout, selectors.EVENT_READ, out)
                poller.register(proc.stderr, selectors.EVENT_READ, err)
                while poller.get_map():
                    self.checkpoint("subprocess")
                    for key, _ in poller.select(0.1):
                        data = os.read(key.fileobj.fileno(), 65536)
                        if not data:
                            poller.unregister(key.fileobj)
                        else:
                            key.data.extend(data)
                            require(len(out) <= cap and len(err) <= 16384, "Command output exceeds limit")
                # Keep the leader unreaped until its entire process group is killed.
                while not os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
                    self.checkpoint("subprocess")
                    time.sleep(0.01)
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            proc.stdout.close()
            proc.stderr.close()
        require(proc.returncode == 0, "Command failed: " + os.path.basename(argv[0]))
        return bytes(out)

    def git(self, stage, *args, extra_env=None):
        return self.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
            "-c", "http.followRedirects=false", "-c", "http.proxy=", "-c", "credential.helper=",
            "-c", "fetch.recurseSubmodules=false", "-c", "fetch.unpackLimit=1",
            "-c", "fetch.fsckObjects=true", *args], cwd=stage, extra_env=extra_env)

    def catalog_bytes(self):
        raw = self.run(["/usr/bin/curl", "-q", "--fail", "--silent", "--show-error",
            "--proto", "=https", "--noproxy", "*", "--connect-timeout", "5", "--max-time", "20",
            "--max-filesize", str(MAX_CATALOG), "--header", "Cache-Control: no-cache",
            "--write-out", "\n%{http_code}", "--", CATALOG_URL], cap=MAX_CATALOG + 4)
        body, status = raw.rsplit(b"\n", 1)
        require(status == b"200", "Catalog redirects or non-200 responses are refused")
        return body

    def open_paths(self, plugin_id):
        require(os.path.isabs(self.home) and len(self.home.encode()) <= 512
                and all(p not in (".", "..", "") for p in self.home.split("/")[1:]), "Unsupported home path")
        fd = self.hold(os.open("/", DIR))
        # Never resolve a parent symlink, including parents above the passwd home.
        for part in self.home.strip("/").split("/"):
            child = self.hold(os.open(part, DIR, dir_fd=fd))
            info = os.fstat(child)
            require(info.st_uid in (0, os.getuid()) and (not info.st_mode & 0o022
                    or (info.st_uid == 0 and info.st_mode & stat.S_ISVTX)), "Unsafe home ancestor")
            self.anchors.append((fd, part, identity(child)))
            fd = child
        require(os.fstat(fd).st_uid == os.getuid() and not os.fstat(fd).st_mode & 0o022, "Unsafe home")
        for part in (".config", "omarchy"):
            child = self.hold(checked_dir(fd, part))
            self.anchors.append((fd, part, identity(child)))
            fd = child
        self.omarchy = fd
        self.plugins = self.hold(checked_dir(fd, "plugins"))
        self.anchors.append((fd, "plugins", identity(self.plugins)))
        self.original = self.hold(checked_dir(self.plugins, plugin_id))
        self.anchors.append((self.plugins, plugin_id, identity(self.original)))
        try:
            os.mkdir("plugin-manager-updates", 0o700, dir_fd=fd)
            os.fsync(fd)
        except FileExistsError:
            pass
        self.state = self.hold(checked_dir(fd, "plugin-manager-updates", private=True))
        require(os.fstat(self.state).st_dev == os.fstat(self.plugins).st_dev, "Staging must share filesystem")
        try:
            fcntl.flock(self.state, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused("Another pinned update is running") from error
        self.anchors.append((fd, "plugin-manager-updates", identity(self.state)))
        with os.scandir(self.state) as entries:
            require(sum(1 for _ in zip(entries, range(33))) < 32, "Review retained transactions before updating")

    def check_anchors(self):
        for parent, name, expected in self.anchors:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            safe_mode = not info.st_mode & 0o022 or (info.st_uid == 0 and info.st_mode & stat.S_ISVTX)
            require(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == expected
                    and safe_mode, "Directory identity changed")

    def scan(self, root, skip_git=False, sync=False):
        result = {}
        total = count = 0

        def visit(fd, prefix, depth):
            nonlocal total, count
            require(depth <= 20, "Tree too deep")
            # Enumerate through a freshly reopened view of the same inode. A
            # dirfd opened while the directory was still empty keeps returning
            # an empty listing on btrfs even after another process (git
            # checkout) has populated the inode; reopening via /proc/self/fd
            # yields the current entries. It is the same inode, not a path
            # re-resolution, so every openat below still uses the validated
            # `fd`. Name lookup on the held fd is unaffected, only readdir is.
            view = os.open("/proc/self/fd/%d" % fd, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                with os.scandir(view) as entries:
                    for entry in entries:
                        self.checkpoint("tree")
                        count += 1
                        require(count <= 4096, "Too many files")
                        name = entry.name
                        if skip_git and not prefix and name == ".git":
                            continue
                        require(len(name.encode()) <= 255, "Invalid filename")
                        path = prefix + name
                        info = entry.stat(follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode):
                            child = checked_dir(fd, name)
                            try:
                                visit(child, path + "/", depth + 1)
                            finally:
                                os.close(child)
                        else:
                            require(stat.S_ISREG(info.st_mode), "Symlinks and special files refused")
                            data, mode = read_file(fd, name, 32 * 1024 * 1024, sync=sync)
                            total += len(data)
                            require(total <= MAX_DISK, "Checkout exceeds disk limit")
                            digest = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                            result[path] = ("100755" if mode & 0o111 else "100644", digest)
            finally:
                os.close(view)
            if sync:
                os.fsync(fd)
        visit(root, "", 0)
        return result

    def local_metadata(self, request):
        meta = checked_dir(self.original, ".git")
        try:
            self.scan(meta)
            config, _ = read_file(meta, "config", 65536)
            parser = configparser.RawConfigParser(strict=True)
            try:
                parser.read_string(config.decode())
            except (configparser.Error, UnicodeError) as error:
                raise Refused("Unsupported Git configuration") from error
            # Includes, worktrees, alternates and extension-dependent formats are
            # refused. Other local customization is never copied or executed.
            require(all(s == "core" or s == 'remote "origin"' or s.startswith('branch "')
                        for s in parser.sections()), "Unsupported local Git metadata")
            require(set(parser["core"]) <= {"repositoryformatversion", "filemode", "bare", "logallrefupdates",
                    "ignorecase", "precomposeunicode"}, "Unsupported core configuration")
            require(parser.get("core", "repositoryformatversion") == "0"
                    and parser.get("core", "bare") == "false", "Not a standard checkout")
            origin = parser.get('remote "origin"', "url", fallback="")
            require(repository(origin) == request["repository"], "Installed origin changed")
            head, _ = read_file(meta, "HEAD", 256)
            if head.startswith(b"ref: "):
                ref = head[5:].decode().strip()
                require(re.fullmatch(r"refs/heads/[A-Za-z0-9._/-]+", ref)
                        and all(p not in (".", "..", "") for p in ref.split("/")), "Unsupported HEAD ref")
                current = meta
                opened = []
                try:
                    try:
                        for name in ref.split("/")[:-1]:
                            current = checked_dir(current, name)
                            opened.append(current)
                        head, _ = read_file(current, ref.split("/")[-1], 64)
                    except FileNotFoundError:
                        # Packed refs need not retain any loose parent directory.
                        # Only ENOENT permits fallback: symlinks, unsafe modes and
                        # other traversal errors must never become "not loose".
                        packed, _ = read_file(meta, "packed-refs", 1024 * 1024)
                        found = [line.partition(b" ")[0] for line in packed.splitlines()
                                 if line.partition(b" ")[2] == ref.encode()]
                        require(len(found) == 1, "Missing or ambiguous HEAD")
                        head = found[0]
                finally:
                    for fd in opened:
                        os.close(fd)
            require(head.strip().decode() == request["expectedLocalHead"], "Installed HEAD changed")
            files = self.scan(meta)
            for name in ("commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates"):
                require(name not in files, "External Git metadata")
            manifest = document(read_file(self.original, "manifest.json", 65536)[0], 65536)
            require(type(manifest) is dict and manifest.get("id") == request["id"], "Installed manifest id mismatch")
            index, _ = read_file(meta, "index", 4 * 1024 * 1024)
            return index
        finally:
            os.close(meta)

    def fetch(self, stage, sha):
        self.git(stage, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth=256", "origin", sha)

    def tree(self, stage, sha):
        data = self.git(stage, "ls-tree", "-r", "-z", "-l", sha)
        tree, total = {}, 0
        for record in data.split(b"\0"):
            if not record:
                continue
            header, raw_path = record.split(b"\t", 1)
            mode, kind, digest, size = header.split()
            path = raw_path.decode("utf-8")
            require(mode in (b"100644", b"100755") and kind == b"blob", "Symlinks, gitlinks and special files refused")
            require(len(path) <= 1024 and len(path.split("/")) <= 20
                    and all(p not in ("", ".", "..", ".git") for p in path.split("/"))
                    and not re.search(r"[\x00-\x1f\x7f]", path), "Unsafe tree path")
            total += int(size)
            require(int(size) <= 8 * 1024 * 1024 and total <= MAX_TREE and len(tree) < 1000, "Snapshot exceeds limits")
            tree[path] = (mode.decode(), digest.decode())
        return tree

    def check_clean(self, stage, base_tree, request, index_name):
        index = self.local_metadata(request)
        create_file(self.tx, index_name, index)
        # stage is a child of tx; use its ../ path so only the cwd fd is inherited.
        env = {"GIT_INDEX_FILE": f"/proc/self/fd/{stage}/../{index_name}"}
        records = self.git(stage, "ls-files", "--stage", "-z", extra_env=env)
        actual = {}
        for record in records.split(b"\0"):
            if record:
                header, path = record.split(b"\t", 1)
                mode, digest, number = header.split()
                require(number == b"0", "Unmerged index")
                actual[path.decode()] = (mode.decode(), digest.decode())
        require(actual == base_tree, "Index differs from installed HEAD")
        flags = self.git(stage, "ls-files", "-v", "-z", extra_env=env)
        require(all(not line or line.startswith(b"H ") for line in flags.split(b"\0")), "Special index flags refused")
        require(self.scan(self.original, skip_git=True, sync=True) == base_tree, "Dirty, untracked or ignored files present")

    def validate(self, stage):
        self.run(["/usr/share/omarchy/bin/omarchy-plugin-validate", "."], cwd=stage, cap=16384)

    def exchange(self, plugin_id):
        require(EXCHANGE is not None, "Atomic exchange unavailable")
        if EXCHANGE(self.plugins, plugin_id.encode(), self.tx, b"checkout", 2) != 0:
            raise Refused("Atomic exchange refused: " + os.strerror(ctypes.get_errno()))

    def reload(self):
        # Same host IPC operation, without the shell wrapper's whole-output collector.
        runtime = f"/run/user/{os.getuid()}"
        display = os.environ.get("WAYLAND_DISPLAY", "")
        require(re.fullmatch(r"wayland-[0-9]{1,4}", display), "Wayland display unavailable")
        output = self.run(["/usr/bin/qs", "ipc", "-n", "-p", "/usr/share/omarchy/shell",
            "call", "--", "shell", "rescanPlugins"], cap=4096,
            extra_env={"XDG_RUNTIME_DIR": runtime, "WAYLAND_DISPLAY": display})
        require(output.strip() not in (b"Target not found.", b"Function not found.",
                b"Not ready to accept queries yet"), "Shell rescan refused")

    def notify(self, request, result):
        self.deadline = time.monotonic() + 5
        self.cancelled = False
        try:
            self.run(["/usr/bin/notify-send", "--app-name=Plugin Manager", "--",
                      "Pinned plugin update", request["id"] + ": " + result["status"]
                      + (" (" + result["reason"] + ")" if result.get("reason") else "")], cap=4096,
                     extra_env={"DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus"})
        except Exception:
            pass

    def execute(self, value):
        request = request_value(value)
        try:
            self.open_paths(request["id"])
            self.local_metadata(request)
            authorize(self.catalog_bytes(), request)
            self.transaction = "txn-" + secrets.token_hex(12)
            os.mkdir(self.transaction, 0o700, dir_fd=self.state)
            os.fsync(self.state)
            self.tx = self.hold(checked_dir(self.state, self.transaction, private=True))
            self.anchors.append((self.state, self.transaction, identity(self.tx)))
            self.backup = self.home + "/.config/omarchy/plugin-manager-updates/" + self.transaction + "/checkout"
            create_file(self.tx, "request.json", json.dumps(request).encode())
            os.mkdir("checkout", 0o700, dir_fd=self.tx)
            stage = self.hold(checked_dir(self.tx, "checkout", private=True))
            self.anchors.append((self.tx, "checkout", identity(stage)))
            self.git(stage, "init", "--quiet", "--template=", "--object-format=sha1")
            self.git(stage, "config", "remote.origin.url", request["repository"])
            self.fetch(stage, request["verifiedCommit"])
            fetched = self.git(stage, "rev-parse", "FETCH_HEAD^{commit}").decode().strip()
            require(fetched == request["verifiedCommit"], "Fetched object is not the verified commit")
            self.git(stage, "merge-base", "--is-ancestor", request["expectedLocalHead"], fetched)
            require(fetched != request["expectedLocalHead"], "Already at verified snapshot")
            base_tree = self.tree(stage, request["expectedLocalHead"])
            target_tree = self.tree(stage, fetched)
            self.check_clean(stage, base_tree, request, "index-before")
            self.git(stage, "checkout", "--quiet", "--detach", fetched)
            require(self.git(stage, "rev-parse", "HEAD").decode().strip() == fetched, "Staged HEAD mismatch")
            manifest = document(read_file(stage, "manifest.json", 65536)[0], 65536)
            require(type(manifest) is dict and manifest.get("id") == request["id"], "Manifest id changed")
            self.validate(stage)
            require(self.scan(stage, skip_git=True) == target_tree, "Staged contents changed")
            self.scan(stage, sync=True)
            authorize(self.catalog_bytes(), request)
            self.check_clean(stage, base_tree, request, "index-final")
            self.check_anchors()
            create_file(self.tx, "prepared.json", json.dumps({"original": identity(self.original),
                        "replacement": identity(stage)}).encode())
            self.checkpoint("before-exchange")
            # Signals only set a flag, so none can raise between the syscall and
            # published=True. No automatic rollback can overwrite a later edit.
            self.exchange(request["id"])
            self.published = True
            os.fsync(self.plugins)
            os.fsync(self.tx)
            result = {"status": "updated", "backup": self.backup}
            create_file(self.tx, "published.json", json.dumps(result).encode())
            self.deadline = time.monotonic() + 10
            self.cancelled = False
            try:
                self.checkpoint("after-exchange")
                self.reload()
            except Exception:
                result["status"] = "updated; reload failed"
            create_file(self.tx, "result.json", json.dumps(result).encode())
            return result
        except Exception as error:
            if self.published:
                return {"status": "updated; finalization failed", "backup": self.backup}
            self.reason = reason_text(error)
            if self.tx is not None:
                # Best effort: the journal must never mask the refusal itself.
                try:
                    create_file(self.tx, "refused.json", json.dumps({"reason": self.reason}).encode())
                except Exception:
                    pass
            raise
        finally:
            for fd in reversed(self.fds):
                os.close(fd)
            self.fds.clear()


def launch(request, factory=Updater):
    """Separate the finite worker from its expendable UI observer."""
    read_end, write_end = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_end)
        os.setsid()
        if os.fork() != 0:
            os._exit(0)
        # The worker has no Quickshell-owned stdio or parent lifecycle. The only
        # pipe back is best-effort; durable transaction records survive its loss.
        null = os.open("/dev/null", os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        os.close(null)
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)
        updater = factory()
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda *_: setattr(updater, "cancelled", True))
        try:
            result = updater.execute(request)
        except Exception as error:
            result = {"status": "unchanged; update refused",
                      "reason": updater.reason or reason_text(error), "backup": updater.backup}
        try:
            os.write(write_end, json.dumps(result).encode() + b"\n")
        except BrokenPipeError:
            pass
        os.close(write_end)
        # Static, bounded notification text; no remote error prose reaches markup.
        updater.notify(request, result)
        os._exit(0)
    os.close(write_end)
    os.waitpid(pid, 0)
    result = bytearray()
    with selectors.DefaultSelector() as poller:
        poller.register(read_end, selectors.EVENT_READ)
        deadline = time.monotonic() + 140
        while time.monotonic() < deadline:
            if not poller.select(0.1):
                continue
            chunk = os.read(read_end, 4097 - len(result))
            if not chunk:
                break
            result.extend(chunk)
            require(len(result) <= 4096, "Worker result exceeds limit")
    os.close(read_end)
    if result:
        sys.stdout.buffer.write(result)
    else:
        print('{"status":"outcome unknown; inspect retained transactions","backup":""}')
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        os.umask(0o077)
        require(len(sys.argv) == 2 and len(sys.argv[1]) <= 2048, "One bounded request required")
        launch(request_value(document(sys.argv[1].encode(), 2048)))
    except Exception as error:
        print(json.dumps({"status": "unchanged; request refused", "reason": reason_text(error), "backup": ""}))
        sys.exit(1)
