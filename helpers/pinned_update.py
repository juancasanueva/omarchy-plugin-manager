#!/usr/bin/python3
"""Exact pinned plugin installs and updates; no installed Git configuration is executed.

CLI: python3 -I -S pinned_update.py REQUEST_JSON
Four transaction request shapes, each bound to one full commit SHA-1 before
anything is fetched or checked out:
  verifiedCommit + expectedLocalHead
                   - update to a marketplace-verified snapshot; the live
                     catalog must authorize exactly this repository and
                     commit, before the fetch and again before publication.
  unverifiedCommit + expectedLocalHead
                   - update to an upstream commit the user's setting allows
                     and the panel observed; no catalog authorization is
                     consulted, every other check is identical. Recorded as
                     unverified.
  verifiedCommit + section
                   - a first install of a marketplace-verified snapshot. The
                     same catalog authorization, fetch, staging and validation
                     as a verified update, published into a name that must not
                     exist with RENAME_NOREPLACE rather than exchanged, and
                     then enabled: a named section is a placement, an empty
                     section is a plain enable. There is no backup: nothing
                     was replaced.
  branch + section   - a first install of a listing the marketplace never
                     verified, allowed only by the user's setting. No catalog
                     authorization is consulted, exactly as for an unverified
                     update. The branch is resolved against the remote to one
                     commit before any fetch, and that commit is what the rest
                     of the transaction installs: no fetch and no checkout
                     ever names a branch. Recorded as unverified.
  catalog: {force}   - serve the Browse catalog projection: the cached copy
                     when it is compatible and fresh, otherwise a fresh
                     fetch published into the cache. Every cache read and
                     write goes through owner-checked no-follow directory
                     descriptors, so a symlink anywhere under the cache path
                     redirects nothing. Runs in this process, streams the
                     projection to stdout, and touches no plugin directory.
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
MARKETPLACE_STATS_URL = "https://api.omarchyplugins.com/v1/stats"
OMARCHY = "/usr/share/omarchy"
SECTIONS = ("", "left", "center", "right")
# Recomputed by request_value on every validation, so they carry no authority
# and are stripped again before anything is journaled.
DERIVED = ("target", "verified", "install")
SHA = re.compile(r"[0-9a-fA-F]{40}\Z")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\Z")
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
MAX_RAW_CATALOG = 16 * 1024 * 1024
MAX_CATALOG = 8 * 1024 * 1024  # Projected output and cache only.
MAX_STATS = 1024 * 1024
MAX_PLUGINS = 4 * 1024 * 1024
# The Browse cache: the catalog projected down to the fields the panel reads,
# joined with the anonymous engagement stats, reused for six hours. The
# schema version keeps an older cache from silently omitting a field the
# current UI requires; the key list is the projection contract.
CACHE_DIR = (".cache", "omarchy-plugin-manager")
CACHE_FILE = "catalog.json"
CACHE_TTL = 6 * 60 * 60
PROJECTION_SCHEMA = 2
PROJECTED_KEYS = ("id", "name", "description", "author", "version", "category", "tags", "kind",
                  "repo", "installCommand", "installAvailable", "installNote", "verificationStatus",
                  "sourceType", "stars", "addedAt", "listedAt", "marketplaceHearts", "accent",
                  "initials", "license", "previewThumbnail", "listingValidatedBranch",
                  "verificationCommit")
MAX_TREE = 16 * 1024 * 1024
MAX_DISK = 128 * 1024 * 1024
TRANSACTION_LIMIT = 32
ARCHIVE_NAME = "plugin-manager-updates-archive"
MAX_UPDATE_STATUS = 8192
CAPACITY_REASON = ("Transaction limit: review ~/.config/omarchy/plugin-manager-updates "
                   "using README recovery guidance before retrying")
ARCHIVE_REASON = ("Archive unsafe or incomplete: inspect active and archived transactions "
                  "using README recovery guidance before retrying")
LIBC = ctypes.CDLL(None, use_errno=True)
EXCHANGE = getattr(LIBC, "renameat2", None)
if EXCHANGE:
    EXCHANGE.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    EXCHANGE.restype = ctypes.c_int
# One syscall, bound once, named per flag so each publication site reads as
# what it does: RENAME_EXCHANGE (2) swaps an update's two directories,
# RENAME_NOREPLACE (1) refuses to overwrite anything at all, which is what a
# first install must do. Both names are the same ctypes object; the flag at
# the call site is what decides the behavior.
NOREPLACE = EXCHANGE


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


def branch_name(value):
    """A branch this is willing to name to Git, or "".

    Deliberately narrower than Git's own rules: no option shape, no path
    traversal, no reflog syntax and no lock file, so the name stays a ref and
    can never become an argument. The panel validates identically, so a
    listing either carries a usable branch or none at all.
    """
    if not isinstance(value, str) or not BRANCH.fullmatch(value):
        return ""
    if ".." in value or "//" in value or "@{" in value:
        return ""
    if value.endswith(("/", ".", ".lock")):
        return ""
    return value


def request_value(value):
    require(type(value) is dict, "Invalid request fields")
    # The derived keys are recomputed on every validation, never trusted: a
    # normalized request re-enters here through launch() and execute().
    value = {k: v for k, v in value.items() if k not in DERIVED}
    keys = set(value)
    install = keys == {"schemaVersion", "id", "repository", "verifiedCommit", "section"}
    tip_install = keys == {"schemaVersion", "id", "repository", "branch", "section"}
    verified = keys == {"schemaVersion", "id", "repository", "verifiedCommit", "expectedLocalHead"}
    unverified = keys == {"schemaVersion", "id", "repository", "unverifiedCommit", "expectedLocalHead"}
    require(install or tip_install or verified or unverified, "Invalid request fields")
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1, "Unsupported request")
    require(isinstance(value["id"], str) and ID.fullmatch(value["id"])
            and ".." not in value["id"] and not value["id"].startswith("omarchy."), "Invalid plugin id")
    require(repository(value["repository"]) == value["repository"] != "", "Noncanonical repository")
    commit_key = "unverifiedCommit" if unverified else "verifiedCommit"
    if tip_install:
        # The one shape that arrives without a commit: it is resolved from the
        # branch inside the staged repository, before anything is fetched.
        require(branch_name(value["branch"]) == value["branch"] != "", "Invalid branch")
    else:
        for key in (commit_key,) if install else (commit_key, "expectedLocalHead"):
            require(isinstance(value[key], str) and SHA.fullmatch(value[key]), "Full SHA-1 required")
    if install or tip_install:
        # An empty section enables without a placement; anything else is one
        # of the three bar sections the host accepts, matched exactly.
        require(type(value["section"]) is str and value["section"] in SECTIONS, "Invalid bar section")
    # `target`, `verified` and `install` are derived for the transaction; the
    # original shape is what gets journaled, so a record says which kind it was.
    normalized = {**value, "target": "", "verified": verified or install,
                  "install": install or tip_install}
    if not tip_install:
        normalized[commit_key] = value[commit_key].lower()
        normalized["target"] = value[commit_key].lower()
    if verified or unverified:
        normalized["expectedLocalHead"] = value["expectedLocalHead"].lower()
    return normalized


def catalog_request(value):
    """The one non-transaction shape: exactly a schema version and a force flag."""
    require(type(value) is dict and set(value) == {"schemaVersion", "catalog"}, "Invalid catalog request")
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1, "Unsupported request")
    body = value["catalog"]
    require(type(body) is dict and set(body) == {"force"} and type(body["force"]) is bool,
            "Invalid catalog request")
    return {"schemaVersion": 1, "catalog": {"force": body["force"]}}


def journal_value(request):
    """The request exactly as the panel sent it, with no derived key added."""
    return {k: v for k, v in request.items() if k not in DERIVED}


def request_kind(value):
    """Which shape a raw or normalized request is, without trusting a flag."""
    if not isinstance(value, dict):
        return "update"
    if "catalog" in value:
        return "catalog"
    return "install" if "section" in value else "update"


def usable_projection(raw):
    """Whether cached bytes are a projection this UI can read, or nothing."""
    try:
        doc = document(raw, MAX_CATALOG)
    except Refused:
        return False
    return (type(doc) is dict and doc.get("projectionSchemaVersion") == PROJECTION_SCHEMA
            and type(doc.get("plugins")) is list)


def project_catalog(raw, stats_raw):
    """The catalog reduced to PROJECTED_KEYS, hearts joined by plugin id.

    Stats are a courtesy: anything unusable about them reads as missing
    hearts rather than a missing storefront. The catalog itself is not: a
    body this cannot read, an entry that is not an object or has no string
    id, or a projection over the cache bound fails the refresh, and the
    caller falls back to whatever compatible cache it already has.
    """
    doc = document(raw, MAX_RAW_CATALOG)
    require(type(doc) is dict and type(doc.get("plugins")) is list, "Invalid catalog")
    stats = {}
    if stats_raw is not None:
        try:
            parsed = document(stats_raw, MAX_STATS)
        except Refused:
            parsed = None
        if type(parsed) is dict and type(parsed.get("plugins")) is dict:
            stats = parsed["plugins"]
    plugins = []
    for entry in doc["plugins"]:
        require(type(entry) is dict and isinstance(entry.get("id"), str), "Malformed catalog entry")
        record = stats.get(entry["id"])
        hearts = record.get("hearts") if type(record) is dict else None
        projected = {key: entry.get(key) for key in PROJECTED_KEYS}
        projected["marketplaceHearts"] = None if hearts is None or hearts is False else hearts
        plugins.append(projected)
    # A number that overflowed to infinity on parse would serialize as a bare
    # token no JSON parser accepts; refusing it here keeps the good cache.
    try:
        result = json.dumps({"projectionSchemaVersion": PROJECTION_SCHEMA, "generatedAt": doc.get("generatedAt"),
                             "plugins": plugins}, separators=(",", ":"), ensure_ascii=False,
                            allow_nan=False).encode()
    except ValueError as error:
        raise Refused("Non-finite catalog number") from error
    require(len(result) <= MAX_CATALOG, "Projection exceeds limit")
    return result


def authorize(raw, request):
    doc = document(raw, MAX_RAW_CATALOG)
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
        return bytes(result), info
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


def update_data_result():
    """Fixed status schema; unavailable counts and paths are never invented."""
    return {"schemaVersion": 1, "available": False, "paths": None,
            "activeCount": None, "lowerBound": False, "limit": TRANSACTION_LIMIT, "error": ""}


CLEANUP_MARKER = ".cleanup-started"
CLEANUP_JOURNALS = ("request.json", "prepared.json", "published.json", "result.json")


class CleanupBudget:
    """Shared, consumptive ceilings across discovery and every candidate/pass.

    Call spend() for T3's enumeration too; do not reset after a refusal. The
    deadline is cooperative between bounded filesystem calls, not an I/O timeout.
    """
    def __init__(self, *, work=200000, entries=32768, metadata=4 * 1024 * 1024,
                 bytes=512 * 1024 * 1024, seconds=15):
        self.remaining = dict(work=work, entries=entries, metadata=metadata, bytes=bytes)
        self.deadline = time.monotonic() + min(seconds, 15)

    def spend(self, worker, **costs):
        worker.checkpoint("cleanup")
        require(time.monotonic() < self.deadline, "Cleanup deadline exceeded")
        costs["work"] = costs.get("work", 0) + 1
        for key, cost in costs.items():
            self.remaining[key] -= cost
        require(all(value >= 0 for value in self.remaining.values()), "Cleanup budget exhausted")


def cleanup_mount_id(fd):
    """Linux fdinfo distinguishes even same-device bind mounts; no fallback."""
    info = os.open("/proc/self/fdinfo/%d" % fd, FILE)
    try:
        raw = bytearray()
        while len(raw) <= 4096:
            chunk = os.read(info, 4097 - len(raw))
            if not chunk:
                break
            raw.extend(chunk)
        matches = re.findall(rb"^mnt_id:\s*([0-9]+)$", raw, re.MULTILINE)
        require(len(raw) <= 4096 and len(matches) == 1 and len(matches[0]) <= 20,
                "Mount identity unavailable")
        return int(matches[0])
    finally:
        os.close(info)


class CleanupLock:
    """Own the active inode flock; only explicit cleanup may create a missing root.

    Use a fresh Updater. parent() supplies only held active/archive descriptors;
    keep this context open across all calls to remove_completed().
    """
    def __init__(self, worker, *, create_missing=False):
        self.worker = worker
        self.create_missing = create_missing
        self.parents = {}
        self.state = None
        self.failure = None

    def open_explicit_root(self):
        """Never create parents; archive-only storage needs the updater's lock inode."""
        worker = self.worker
        fd = worker.open_home()
        for part in (".config", "omarchy"):
            worker.checkpoint("cleanup-root")
            try:
                child = worker.hold(checked_dir(fd, part))
            except FileNotFoundError:
                worker.check_anchors()
                return None
            worker.anchors.append((fd, part, identity(child)))
            fd = child
        self.root = fd
        # Validate archive even when active is absent. Unsafe storage is not empty.
        try:
            archive = worker.hold(checked_dir(fd, ARCHIVE_NAME, private=True))
        except FileNotFoundError:
            archive = None
        if archive is not None:
            self.parents[archive] = ARCHIVE_NAME
            require(os.fstat(archive).st_dev == os.fstat(fd).st_dev
                    and cleanup_mount_id(archive) == cleanup_mount_id(fd),
                    "Cleanup root crosses a mount")
        try:
            active = worker.hold(checked_dir(fd, "plugin-manager-updates", private=True))
        except FileNotFoundError:
            worker.check_anchors()
            if archive is None:
                return None
            worker.recheck_directory(fd, ARCHIVE_NAME, archive)
            worker.checkpoint("cleanup-create-lock-root")
            # EEXIST is a race, not permission to adopt a different lock root.
            os.mkdir("plugin-manager-updates", 0o700, dir_fd=fd)
            created = os.stat("plugin-manager-updates", dir_fd=fd, follow_symlinks=False)
            active = worker.hold(checked_dir(fd, "plugin-manager-updates", private=True))
            require(identity(active) == (created.st_dev, created.st_ino), "Cleanup root changed")
            os.fsync(fd)
        worker.anchors.append((fd, "plugin-manager-updates", identity(active)))
        worker.state = active
        return active

    def __enter__(self):
        require(not self.worker.fds and self.state is None, "Cleanup requires a fresh worker")
        require(len(self.worker.home.split("/")) <= 32, "Too many home components")
        try:
            self.state = (self.open_explicit_root() if self.create_missing
                          else self.worker.open_update_root())
            if self.state is None and self.create_missing:
                self.worker.checkpoint("cleanup-empty")
                return self
            require(self.state is not None, "Active update directory missing")
            self.root = self.worker.anchors[-1][0]
            self.parents[self.state] = "plugin-manager-updates"
            self.mount = cleanup_mount_id(self.root)
            self.device = os.fstat(self.root).st_dev
            self.check()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def check(self):
        if self.failure is not None:
            raise self.failure
        try:
            require(self.state is not None, "Cleanup lock is closed")
            # A real flock, not a caller-supplied boolean or remembered assertion.
            fcntl.flock(self.state, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.worker.check_anchors()
            for fd, name in self.parents.items():
                self.worker.recheck_directory(self.root, name, fd)
                require(os.fstat(fd).st_dev == self.device and cleanup_mount_id(fd) == self.mount,
                        "Cleanup root crosses a mount")
        except (OSError, Refused) as error:
            # remove_completed reports refusals; never swallow a fatal lock loss
            # as a candidate skip, even if the next check would succeed.
            self.failure = error
            raise

    def parent(self, *, archived=False):
        self.check()
        if not archived:
            return self.state
        for fd, name in self.parents.items():
            if name == ARCHIVE_NAME:
                return fd
        fd = self.worker.hold(checked_dir(self.root, ARCHIVE_NAME, private=True))
        self.parents[fd] = ARCHIVE_NAME
        self.check()
        return fd

    def __exit__(self, *_):
        for fd in reversed(self.worker.fds):
            os.close(fd)
        self.worker.fds.clear()
        self.worker.anchors.clear()
        self.parents.clear()
        self.state = None


def cleanup_signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def remove_completed(lock, parent, name, budget):
    """Remove ONE known completed transaction; no discovery, retries or recovery.

    Result status: refused = untouched by us; partial = marker created or later
    mutation attempted successfully, including durability failure; removed = all
    removals synced. transactionRemoved remains true if only the final sync fails.
    Archives use the original txn name, never a journal-provided deletion path.
    """
    result = {"status": "refused", "transactionRemoved": False, "error": ""}
    tx = None
    started = False
    worker = lock.worker
    chain = []

    def safe(fd):
        budget.spend(worker)
        info = os.fstat(fd)
        directory = stat.S_ISDIR(info.st_mode)
        require(info.st_uid == os.getuid() and not info.st_mode & 0o7022
                and (directory or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                                   and info.st_size <= 32 * 1024 * 1024)),
                "Unsafe cleanup object")
        require(info.st_dev == lock.device and cleanup_mount_id(fd) == lock.mount,
                "Cleanup object crosses a mount")
        return cleanup_signature(info)

    def opened(directory, entry, expected=None):
        budget.spend(worker)
        info = os.stat(entry, dir_fd=directory, follow_symlinks=False)
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),
                "Cleanup symlink or special file")
        require(hasattr(os, "O_PATH"), "Safe cleanup descriptors unavailable")
        flags = DIR if stat.S_ISDIR(info.st_mode) else os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open(entry, flags, dir_fd=directory)
        try:
            signature = safe(fd)
            require(signature == cleanup_signature(info) and
                    (expected is None or signature == expected), "Cleanup object changed")
            return fd, signature
        except BaseException:
            os.close(fd)
            raise

    def scan(fd, depth=0):
        require(depth <= 20, "Cleanup tree too deep")
        before = safe(fd)
        nodes = []
        view = os.open(".", DIR, dir_fd=fd)
        try:
            with os.scandir(view) as entries:
                # scandir owns a duplicate; do not retain a third fd per level.
                os.close(view)
                view = None
                for entry in entries:
                    budget.spend(worker, entries=1, metadata=len(os.fsencode(entry.name)) + 128)
                    counts[0] += 1
                    require(counts[0] <= 4096, "Too many cleanup entries")
                    require(len(os.fsencode(entry.name)) <= 255, "Cleanup name too long")
                    if depth == 0:
                        require(entry.name in (*CLEANUP_JOURNALS, "index-before", "index-final", "checkout"),
                                "Unknown transaction content")
                    child, signature = opened(fd, entry.name)
                    try:
                        directory = stat.S_ISDIR(signature[2])
                        if depth == 0:
                            require(directory == (entry.name == "checkout"), "Unknown transaction layout")
                        if directory:
                            children = scan(child, depth + 1)
                        else:
                            counts[1] += signature[5]
                            budget.spend(worker, bytes=signature[5])
                            require(counts[1] <= 128 * 1024 * 1024, "Cleanup tree too large")
                            children = None
                        nodes.append((entry.name, signature, children))
                    finally:
                        os.close(child)
        finally:
            if view is not None:
                os.close(view)
        require(safe(fd) == before, "Cleanup directory changed during preflight")
        return sorted(nodes)

    def anchors():
        budget.spend(worker, work=len(worker.anchors) + len(chain))
        lock.check()
        for directory, entry, fd, signature in chain:
            current = safe(fd)
            # Our own unlinks change directory size/timestamps/link counts.
            require(current[:4] == signature[:4], "Cleanup anchor changed")
            info = os.stat(entry, dir_fd=directory, follow_symlinks=False)
            require(cleanup_signature(info)[:4] == current[:4], "Cleanup anchor detached")

    def erase(directory, node):
        entry, signature, children = node
        fd, current = opened(directory, entry, signature)
        try:
            if children is not None:
                chain.append((directory, entry, fd, current))
                try:
                    for child in children:
                        erase(fd, child)
                    anchors()
                    os.rmdir(entry, dir_fd=directory)
                finally:
                    chain.pop()
            else:
                anchors()
                require(safe(fd) == signature and cleanup_signature(os.stat(
                    entry, dir_fd=directory, follow_symlinks=False)) == signature,
                    "Cleanup file changed before unlink")
                os.unlink(entry, dir_fd=directory)
            os.fsync(directory)
        finally:
            os.close(fd)

    try:
        budget.spend(worker)
        lock.check()
        require(parent in lock.parents and re.fullmatch(r"txn-[0-9a-f]{24}", name) is not None,
                "Unknown cleanup candidate")
        tx, signature = opened(parent, name)
        require(stat.S_ISDIR(signature[2]) and stat.S_IMODE(signature[2]) == 0o700,
                "Unsafe transaction directory")
        chain.append((parent, name, tx, signature))
        counts = [0, 0]
        tree = scan(tx)
        budget.spend(worker, metadata=4 * 8192)
        evidence = worker.completed_record(tx, name)
        # Validate the entire snapshot again before creating even the marker.
        counts = [0, 0]
        require(scan(tx) == tree, "Cleanup preflight changed")
        anchors()
        budget.spend(worker, metadata=4 * 8192)
        require(worker.completed_record(tx, name) == evidence, "Completed history changed")
        anchors()
        marker = os.open(CLEANUP_MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=tx)
        started = True
        try:
            os.fsync(marker)
            marker_signature = cleanup_signature(os.fstat(marker))
        finally:
            os.close(marker)
        os.fsync(tx)
        # Backup first; its root and all journals survive while contents go.
        ordered = sorted(tree, key=lambda node: (0 if node[0] == "checkout" else
                         2 if node[0] in CLEANUP_JOURNALS else 1, node[0]))
        remaining = {node[0] for node in tree} | {CLEANUP_MARKER}
        for node in (*ordered, (CLEANUP_MARKER, marker_signature, None)):
            # A late unknown entry must not cost the remaining journals. This
            # bounded shallow recheck is not a new candidate or recovery scan.
            view = os.open(".", DIR, dir_fd=tx)
            try:
                seen = set()
                with os.scandir(view) as entries:
                    for entry in entries:
                        budget.spend(worker, entries=1, metadata=len(os.fsencode(entry.name)))
                        require(entry.name in remaining and entry.name not in seen,
                                "Transaction contents changed during cleanup")
                        seen.add(entry.name)
                require(seen == remaining, "Transaction contents disappeared during cleanup")
            finally:
                os.close(view)
            erase(tx, node)
            remaining.remove(node[0])
        anchors()
        os.rmdir(name, dir_fd=parent)
        result["transactionRemoved"] = True
        os.fsync(parent)
        result["status"] = "removed"
    except (OSError, Refused) as error:
        result["status"] = "partial" if started else "refused"
        result["error"] = reason_text(error)
    finally:
        if tx is not None:
            os.close(tx)
    return result


CLEANUP_DISCOVERY_PER_ROOT = 256
CLEANUP_DISCOVERY_TOTAL = 512
CLEANUP_CANDIDATES = 128
MAX_CLEANUP_OUTPUT = 4096


def cleanup_result():
    return {"schemaVersion": 1, "status": "failed", "discovered": 0, "visited": 0,
            "removed": 0, "preserved": 0, "partial": 0, "removedUnsynced": 0,
            "unknown": 0, "discoveryComplete": False, "refreshRequired": True, "error": ""}


def cleanup_completed(worker):
    """One lock and budget; bounded snapshots before removal, no automatic retry.

    Counters concern only this invocation, never total retained history. Status
    refresh is deliberately separate: no recount after cancellation or exhaustion.
    """
    result = cleanup_result()
    budget = CleanupBudget()
    attempted = False
    try:
        budget.spend(worker)
        with CleanupLock(worker, create_missing=True) as lock:
            if lock.state is None:
                result.update(status="complete", discoveryComplete=True)
                return result
            parents = [lock.parent()]
            try:
                parents.append(lock.parent(archived=True))
            except FileNotFoundError:
                pass
            candidates = []
            limited = False
            for parent in parents:
                budget.spend(worker)
                lock.check()
                view = os.open(".", DIR, dir_fd=parent)
                count = 0
                try:
                    with os.scandir(view) as entries:
                        for entry in entries:
                            # Charge even the single lookahead name. Never sort or
                            # materialize an unbounded directory (including archive).
                            budget.spend(worker, entries=1, metadata=len(os.fsencode(entry.name)) + 128)
                            if (count == CLEANUP_DISCOVERY_PER_ROOT or
                                    result["discovered"] == CLEANUP_DISCOVERY_TOTAL):
                                limited = True
                                break
                            candidates.append((parent, entry.name))
                            count += 1
                            result["discovered"] += 1
                finally:
                    os.close(view)
                if limited:
                    break
            result["discoveryComplete"] = not limited
            processed = 0
            for parent, name in candidates:
                budget.spend(worker)
                lock.check()
                if re.fullmatch(r"txn-[0-9a-f]{24}", name) is None:
                    result["visited"] += 1
                    result["preserved"] += 1
                    continue
                if processed == CLEANUP_CANDIDATES:
                    limited = True
                    break
                processed += 1
                attempted = True
                outcome = remove_completed(lock, parent, name, budget)
                attempted = False
                result["visited"] += 1
                if outcome["status"] == "removed":
                    result["removed"] += 1
                elif outcome["status"] == "partial":
                    result["partial"] += 1
                    result["removedUnsynced"] += int(outcome["transactionRemoved"])
                    result.update(status="partial", error=outcome["error"])
                    return result
                else:
                    result["preserved"] += 1
                # Detect cancellation/exhaustion hidden in a primitive refusal,
                # and the lock's latched failure before visiting another candidate.
                budget.spend(worker)
                lock.check()
            budget.spend(worker)
            lock.check()
            result.update(status="limited" if limited else "complete",
                          error="Cleanup discovery or candidate limit reached" if limited else "")
    except Exception as error:
        if attempted:
            result["visited"] += 1
            result["unknown"] += 1
        status = ("unknown" if result["unknown"] else "cancelled" if worker.cancelled else
                  "limited" if time.monotonic() >= budget.deadline or
                  any(value < 0 for value in budget.remaining.values()) else "failed")
        result.update(status=status, error=reason_text(error))
    return result


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
        self.original = None
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

    def https_bytes(self, url, cap, max_time):
        raw = self.run(["/usr/bin/curl", "-q", "--fail", "--silent", "--show-error",
            "--proto", "=https", "--noproxy", "*", "--connect-timeout", "5", "--max-time", str(max_time),
            "--max-filesize", str(cap), "--header", "Cache-Control: no-cache",
            "--write-out", "\n%{http_code}", "--", url], cap=cap + 4)
        body, status = raw.rsplit(b"\n", 1)
        require(status == b"200", "Catalog redirects or non-200 responses are refused")
        return body

    def catalog_bytes(self):
        return self.https_bytes(CATALOG_URL, MAX_RAW_CATALOG, 20)

    def stats_bytes(self):
        return self.https_bytes(MARKETPLACE_STATS_URL, MAX_STATS, 15)

    def catalog_ids(self):
        """Every plugin id the host already knows: first-party and installed.

        The host's own add refuses an id that is taken by a checkout under any
        directory name, or by a plugin that ships with Omarchy; an install here
        refuses the same way rather than landing a second plugin the shell
        would have to pick between. The account's home is passed explicitly —
        the worker's environment has none — and the Omarchy root is fixed here
        rather than inherited, so no caller can point the scan elsewhere.
        """
        raw = self.run(["/usr/bin/omarchy-plugin-catalog"], cap=MAX_PLUGINS,
                       extra_env={"HOME": self.home, "OMARCHY_PATH": OMARCHY})
        doc = document(raw, MAX_PLUGINS)
        require(type(doc) is list and len(doc) <= 5000, "Invalid plugin catalog")
        ids = set()
        for entry in doc:
            require(type(entry) is dict and isinstance(entry.get("id"), str), "Malformed plugin entry")
            ids.add(entry["id"])
        return ids

    def session_env(self):
        """The Wayland session a host IPC call needs, taken from the display alone."""
        display = os.environ.get("WAYLAND_DISPLAY", "")
        require(re.fullmatch(r"wayland-[0-9]{1,4}", display), "Wayland display unavailable")
        return {"XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}", "WAYLAND_DISPLAY": display}

    def open_home(self):
        """The account home as a descriptor, reached without resolving any symlink."""
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
        return fd

    def open_cache(self):
        """The Browse cache directory, created private when missing, never by path.

        Each component is created relative to its parent's descriptor and then
        opened no-follow with the owner and mode checked, so a symlink planted
        at ~/.cache or below it is a refusal, not a redirection. An existing
        directory keeps whatever private-enough mode it has; only a symlink,
        another owner, or group/world write refuses.
        """
        fd = self.open_home()
        for part in CACHE_DIR:
            try:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
                fd = self.hold(checked_dir(fd, part))
            except OSError as error:
                raise Refused("Cache directory unavailable") from error
        return fd

    def cached_projection(self, cache):
        """(bytes, fresh) for a compatible cache file, or (None, False).

        Read no-follow through the directory descriptor: a symlink, a foreign
        owner, a shared-writable mode, a hard link or an oversized file is not
        a cache, whatever it contains.
        """
        try:
            raw, info = read_file(cache, CACHE_FILE, MAX_CATALOG)
            age = time.time() - info.st_mtime
        except (OSError, Refused):
            return None, False
        if not usable_projection(raw):
            return None, False
        return raw, 0 <= age < CACHE_TTL

    def refresh_projection(self, cache):
        """Fetch, project and publish through the held descriptor only.

        The projection lands in an exclusive temp file beside the cache and is
        renamed into place relative to the same descriptor: readers see the
        old bytes or the new ones, never a partial file, and the name being
        replaced is a directory entry in an owner-checked directory, so
        whatever it pointed at is left alone. A failure after the temp file
        exists removes it; the previous cache is never touched.
        """
        raw = self.catalog_bytes()
        try:
            stats_raw = self.stats_bytes()
        except Exception:
            stats_raw = None
        projected = project_catalog(raw, stats_raw)
        name = "." + CACHE_FILE + ".tmp." + secrets.token_hex(6)
        try:
            create_file(cache, name, projected)
            os.rename(name, CACHE_FILE, src_dir_fd=cache, dst_dir_fd=cache)
        except BaseException:
            try:
                os.unlink(name, dir_fd=cache)
            except OSError:
                pass
            raise
        os.fsync(cache)
        return projected

    def serve_catalog(self, request):
        """The projection to hand the panel: cache when fresh, else refreshed.

        Automatic refresh failures serve a compatible cache when available.
        Forced refresh failures are refusals, so the UI can keep its displayed
        entries without claiming the user's refresh succeeded.
        """
        request = catalog_request(request)
        try:
            cache = self.open_cache()
            cached, fresh = self.cached_projection(cache)
            if cached is not None and fresh and not request["catalog"]["force"]:
                return cached
            try:
                return self.refresh_projection(cache)
            except Exception as error:
                self.reason = reason_text(error)
                require(cached is not None and not request["catalog"]["force"],
                        "Could not fetch the catalog: " + self.reason)
                return cached
        finally:
            for fd in reversed(self.fds):
                os.close(fd)
            self.fds.clear()

    def open_update_root(self):
        """Open only existing active data; never create or open plugins/archives.

        The active descriptor is the same inode update workers flock. Merely
        observing it does not acquire a lock or authorize a future mutation.
        """
        fd = self.open_home()
        for part in (".config", "omarchy", "plugin-manager-updates"):
            self.checkpoint("status-root")
            try:
                child = self.hold(checked_dir(fd, part, private=part == "plugin-manager-updates"))
            except FileNotFoundError:
                return None
            self.anchors.append((fd, part, identity(child)))
            fd = child
        self.state = fd
        return fd

    def update_data_status(self):
        """Bounded, read-only observation, not a consistent snapshot or lock."""
        result = update_data_result()
        self.deadline = min(self.deadline, time.monotonic() + 5)
        try:
            self.checkpoint("status-start")
            # Reject misleading display metadata instead of escaping/truncating
            # a different path into the UI. Validate before allocating paths.
            require(isinstance(self.home, str) and len(self.home) <= 512
                    and self.home.isprintable() and not any(c in self.home for c in "<>&")
                    and len(self.home.encode("utf-8")) <= 512 and self.home.startswith("/")
                    and all(p not in ("", ".", "..") for p in self.home.split("/")[1:]),
                    "Unsupported home path")
            root = self.home + "/.config/omarchy/"
            result["paths"] = {"plugins": root + "plugins", "active": root + "plugin-manager-updates",
                               "archive": root + ARCHIVE_NAME}
            active = self.open_update_root()
            count = 0 if active is None else len(self.active_transactions())
            self.check_anchors()
            if active is not None:
                parent, name, _ = self.anchors[-1]
                self.recheck_directory(parent, name, active)
            self.checkpoint("status-finish")
            result.update(available=True, activeCount=count, lowerBound=count > TRANSACTION_LIMIT)
        except (OSError, Refused, UnicodeError) as error:
            result["error"] = reason_text(error)
        finally:
            for fd in reversed(self.fds):
                os.close(fd)
            self.fds.clear()
        return result

    def open_paths(self, plugin_id, install=False):
        fd = self.open_home()
        for part in (".config", "omarchy"):
            child = self.hold(checked_dir(fd, part))
            self.anchors.append((fd, part, identity(child)))
            fd = child
        self.omarchy = fd
        self.plugins = self.hold(checked_dir(fd, "plugins"))
        self.anchors.append((fd, "plugins", identity(self.plugins)))
        if install:
            # Nothing may already answer to that name — not a directory, not a
            # file, and not a symlink pointing anywhere at all. Publication
            # asks the kernel for the same guarantee again; this only refuses
            # early, with a reason a person can read.
            try:
                os.stat(plugin_id, dir_fd=self.plugins, follow_symlinks=False)
            except FileNotFoundError:
                self.original = None
            else:
                raise Refused("Already installed")
        else:
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
        self.archive_at_capacity()

    def active_transactions(self):
        """At most 32 names; the 33rd signals manual review without inspection."""
        names = []
        # A fresh view avoids stale directory enumeration on btrfs, while
        # remaining bound to the held state inode (also important for recount).
        view = os.open(".", DIR, dir_fd=self.state)
        try:
            with os.scandir(view) as entries:
                for entry in entries:
                    self.checkpoint("archive-inventory")
                    names.append(entry.name)
                    if len(names) > TRANSACTION_LIMIT:
                        break
        finally:
            os.close(view)
        return names

    @staticmethod
    def absent(parent, name):
        try:
            os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return True
        return False

    def completed_record(self, tx, name):
        """Validate only known journals and the backup directory, never its tree.

        Return byte/inode evidence for rechecks, not a recovered transaction or
        an assertion about the plugin's current HEAD. Unknown history stays put.
        """
        require(self.absent(tx, "refused.json"), "Refused history")
        require(self.absent(tx, CLEANUP_MARKER), "Interrupted cleanup history")
        records, evidence = {}, {}
        for key in ("request", "prepared", "published", "result"):
            raw, info = read_file(tx, key + ".json", 8192)
            require(stat.S_IMODE(info.st_mode) == 0o600, "Unsafe journal permissions")
            records[key] = document(raw, 8192)
            evidence[key] = (raw, info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns)
        raw_request = records["request"]
        require(type(raw_request) is dict and not set(raw_request).intersection(DERIVED),
                "Unknown historical request")
        request = request_value(raw_request)
        prepared = records["prepared"]
        keys = {"replacement"} if request["install"] else {"original", "replacement"}
        require(type(prepared) is dict and set(prepared) == keys, "Unknown prepared record")
        for pair in prepared.values():
            require(type(pair) is list and len(pair) == 2
                    and all(type(value) is int for value in pair)
                    and pair[0] == os.fstat(tx).st_dev and pair[1] > 0, "Invalid prepared identity")
        if request["install"]:
            require(self.absent(tx, "checkout"), "Install still has a checkout")
            expected = {"status": "installed"}
        else:
            require(request["target"] != request["expectedLocalHead"], "Contradictory update target")
            require(prepared["original"] != prepared["replacement"], "Contradictory identities")
            checkout = checked_dir(tx, "checkout")
            try:
                require(list(identity(checkout)) == prepared["original"], "Backup identity changed")
            finally:
                os.close(checkout)
            expected = {"status": "updated", "backup": self.home
                        + "/.config/omarchy/plugin-manager-updates/" + name + "/checkout"}
        require(records["published"] == expected and records["result"] == expected,
                "Incomplete or contradictory result")
        return evidence

    @staticmethod
    def recheck_directory(parent, name, held):
        current = checked_dir(parent, name, private=True)
        try:
            require(identity(current) == identity(held), "Archive directory identity changed")
        finally:
            os.close(current)

    def open_archive(self):
        require(NOREPLACE is not None, "Atomic archival unavailable")
        self.check_anchors()
        try:
            os.mkdir(ARCHIVE_NAME, 0o700, dir_fd=self.omarchy)
            os.fsync(self.omarchy)
        except FileExistsError:
            pass
        archive = self.hold(checked_dir(self.omarchy, ARCHIVE_NAME, private=True))
        require(os.fstat(archive).st_dev == os.fstat(self.state).st_dev,
                "Archive must share filesystem")
        self.anchors.append((self.omarchy, ARCHIVE_NAME, identity(archive)))
        return archive

    def archive_at_capacity(self):
        names = self.active_transactions()
        require(len(names) <= TRANSACTION_LIMIT, CAPACITY_REASON)
        if len(names) < TRANSACTION_LIMIT:
            return
        archive = None
        try:
            for name in names:
                self.checkpoint("archive-history")
                if re.fullmatch(r"txn-[0-9a-f]{24}", name) is None:
                    continue
                try:
                    tx = checked_dir(self.state, name, private=True)
                except (OSError, Refused):
                    continue
                try:
                    try:
                        evidence = self.completed_record(tx, name)
                    except (OSError, Refused):
                        continue
                    if archive is None:
                        archive = self.open_archive()
                    self.checkpoint("before-archive")
                    self.check_anchors()
                    self.recheck_directory(self.omarchy, "plugin-manager-updates", self.state)
                    self.recheck_directory(self.omarchy, ARCHIVE_NAME, archive)
                    self.recheck_directory(self.state, name, tx)
                    require(self.completed_record(tx, name) == evidence, "History changed")
                    # This lock excludes helper workers, not arbitrary same-user
                    # writers. Rechecks detect changes, not a race-free snapshot.
                    if NOREPLACE(self.state, name.encode(), archive, name.encode(), 1) != 0:
                        raise Refused("Atomic archival refused")
                    os.fsync(self.state)
                    os.fsync(archive)
                    self.check_anchors()
                    self.recheck_directory(self.omarchy, "plugin-manager-updates", self.state)
                    self.recheck_directory(self.omarchy, ARCHIVE_NAME, archive)
                    self.recheck_directory(archive, name, tx)
                    require(self.absent(self.state, name)
                            and self.completed_record(tx, name) == evidence, "Archived history changed")
                    self.checkpoint("after-archive")
                finally:
                    os.close(tx)
            # Never admit a new transaction merely because a rename succeeded.
            names = self.active_transactions()
            self.check_anchors()
            self.checkpoint("archive-recount")
        except (OSError, Refused) as error:
            raise Refused(ARCHIVE_REASON) from error
        require(len(names) < TRANSACTION_LIMIT, CAPACITY_REASON)

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
                            data, info = read_file(fd, name, 32 * 1024 * 1024, sync=sync)
                            total += len(data)
                            require(total <= MAX_DISK, "Checkout exceeds disk limit")
                            digest = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                            result[path] = ("100755" if info.st_mode & 0o111 else "100644", digest)
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

    def publish(self, plugin_id):
        """Move the staged checkout into a name that must not already exist.

        RENAME_NOREPLACE makes the kernel refuse rather than overwrite, so
        whoever created that name while this transaction was staging keeps it
        (EEXIST) and the checkout stays in the unpublished transaction. There
        is no second attempt and nothing is deleted.
        """
        require(NOREPLACE is not None, "Atomic publication unavailable")
        if NOREPLACE(self.tx, b"checkout", self.plugins, plugin_id.encode(), 1) != 0:
            raise Refused("Atomic publication refused: " + os.strerror(ctypes.get_errno()))

    def reload(self):
        # Same host IPC operation, without the shell wrapper's whole-output collector.
        output = self.run(["/usr/bin/qs", "ipc", "-n", "-p", OMARCHY + "/shell",
            "call", "--", "shell", "rescanPlugins"], cap=4096, extra_env=self.session_env())
        require(output.strip() not in (b"Target not found.", b"Function not found.",
                b"Not ready to accept queries yet"), "Shell rescan refused")

    def enable(self, plugin_id, section):
        """Switch a freshly published plugin on, once the shell has discovered it.

        The rescan is asynchronous and the host's enable fails outright on an
        id it has not seen yet, so this waits the same bounded way the host's
        own add does. A list call that fails is one more attempt, never a
        reason to enable blindly; the deadline ends the wait either way.
        """
        require(section in SECTIONS, "Invalid bar section")
        env = {**self.session_env(), "HOME": self.home, "OMARCHY_PATH": OMARCHY}
        for _ in range(40):
            self.checkpoint("enable")
            try:
                listed = document(self.run(["/usr/bin/omarchy-plugin-list", "--json"],
                                           cap=MAX_PLUGINS, extra_env=env), MAX_PLUGINS)
            except Refused:
                listed = None
            if type(listed) is list and any(type(entry) is dict and entry.get("id") == plugin_id
                                            for entry in listed):
                break
            time.sleep(0.05)
        else:
            raise Refused("Shell did not discover the plugin")
        # Only a plugin that takes a place in the bar gets one. The host
        # refuses a placement for a plugin that replaces the whole bar, so an
        # empty section is a bare enable rather than an empty argument.
        placement = ["--section", section] if section else []
        self.run(["/usr/bin/omarchy-plugin-enable", plugin_id, *placement],
                 cap=16384, extra_env=env)

    def notify(self, request, result):
        self.deadline = time.monotonic() + 5
        self.cancelled = False
        try:
            self.run(["/usr/bin/notify-send", "--app-name=Plugin Manager", "--",
                      ("Pinned plugin install" if request_kind(request) == "install"
                       else "Pinned plugin update")
                      + ("" if request.get("verified", True) else " (unverified)"),
                      request["id"] + ": " + result["status"]
                      + (" (" + result["reason"] + ")" if result.get("reason") else "")], cap=4096,
                     extra_env={"DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus"})
        except Exception:
            pass

    def open_stage(self, request):
        """The transaction and an empty staged repository bound to the remote.

        Deliberately stops short of fetching: an unverified install still has
        a branch to resolve, and it resolves it through this very remote.
        """
        self.transaction = "txn-" + secrets.token_hex(12)
        os.mkdir(self.transaction, 0o700, dir_fd=self.state)
        os.fsync(self.state)
        self.tx = self.hold(checked_dir(self.state, self.transaction, private=True))
        self.anchors.append((self.state, self.transaction, identity(self.tx)))
        create_file(self.tx, "request.json", json.dumps(journal_value(request)).encode())
        os.mkdir("checkout", 0o700, dir_fd=self.tx)
        stage = self.hold(checked_dir(self.tx, "checkout", private=True))
        self.anchors.append((self.tx, "checkout", identity(stage)))
        self.git(stage, "init", "--quiet", "--template=", "--object-format=sha1")
        self.git(stage, "config", "remote.origin.url", request["repository"])
        return stage

    def fetch_stage(self, stage, request):
        """Exactly the requested commit, proven to be what arrived."""
        require(SHA.fullmatch(request["target"] or ""), "Full SHA-1 required")
        self.fetch(stage, request["target"])
        fetched = self.git(stage, "rev-parse", "FETCH_HEAD^{commit}").decode().strip()
        require(fetched == request["target"], "Fetched object is not the requested commit")
        return fetched

    def stage_snapshot(self, request):
        """Everything the update shapes do: open a transaction and fetch.

        Returns the staged checkout's descriptor and the commit that arrived,
        ready for vet_stage to check out, validate and compare.
        """
        stage = self.open_stage(request)
        return stage, self.fetch_stage(stage, request)

    def ls_remote(self, stage, branch):
        return self.git(stage, "ls-remote", "--exit-code", "--", "origin", "refs/heads/" + branch)

    def resolve_tip(self, stage, branch):
        """The one commit a validated branch names right now.

        Asked of the remote before anything is fetched, so every later step
        binds a full SHA-1 exactly as a verified request does. Exactly one
        matching line is required: an ambiguous or unreadable answer is a
        refusal, never a pick among candidates.
        """
        lines = self.ls_remote(stage, branch).decode("utf-8", "replace").splitlines()
        require(len(lines) == 1, "Branch does not name exactly one commit")
        parts = lines[0].split("\t")
        require(len(parts) == 2 and SHA.fullmatch(parts[0])
                and parts[1] == "refs/heads/" + branch, "Unreadable branch reference")
        return parts[0].lower()

    def vet_stage(self, stage, fetched, request, target_tree):
        self.git(stage, "checkout", "--quiet", "--detach", fetched)
        require(self.git(stage, "rev-parse", "HEAD").decode().strip() == fetched, "Staged HEAD mismatch")
        manifest = document(read_file(stage, "manifest.json", 65536)[0], 65536)
        require(type(manifest) is dict and manifest.get("id") == request["id"], "Manifest id changed")
        self.validate(stage)
        require(self.scan(stage, skip_git=True) == target_tree, "Staged contents changed")
        self.scan(stage, sync=True)

    def install(self, request):
        """A first install into a name nothing holds: one verified snapshot,
        or the current tip of a listing's validated branch under the user's
        setting."""
        self.open_paths(request["id"], install=True)
        # The host refuses an id another plugin already answers to under some
        # other directory name, or that ships with Omarchy; so does this. It is
        # an early, readable refusal, not the guarantee: publication below is
        # still a no-replace rename through the descriptor opened above. It
        # applies to both shapes: the id collision is about this machine.
        require(request["id"] not in self.catalog_ids(), "Plugin id is already in use")
        if request["verified"]:
            authorize(self.catalog_bytes(), request)
        stage = self.open_stage(request)
        if not request["verified"]:
            # There is no catalog snapshot to authorize against, exactly as an
            # unverified update never consults one. The branch becomes a single
            # commit here, before any fetch, and only that commit is ever
            # fetched, checked out or published.
            request["target"] = self.resolve_tip(stage, request["branch"])
        fetched = self.fetch_stage(stage, request)
        target_tree = self.tree(stage, fetched)
        self.vet_stage(stage, fetched, request, target_tree)
        if request["verified"]:
            authorize(self.catalog_bytes(), request)
        self.check_anchors()
        create_file(self.tx, "prepared.json", json.dumps({"replacement": identity(stage)}).encode())
        self.checkpoint("before-publication")
        # Signals only set a flag, so none can raise between the syscall and
        # published=True. Nothing is ever rolled back once it is published.
        self.publish(request["id"])
        self.published = True
        os.fsync(self.plugins)
        os.fsync(self.tx)
        # The checkout left the transaction directory; the journal stays, and
        # there is no backup to name because nothing was replaced.
        result = {"status": "installed"}
        create_file(self.tx, "published.json", json.dumps(result).encode())
        self.deadline = time.monotonic() + 10
        self.cancelled = False
        try:
            self.checkpoint("after-publication")
            self.reload()
        except Exception:
            result["status"] = "installed; reload failed"
        else:
            # Every install is enabled, placed or not: a plugin that landed on
            # disk and was never switched on looks to the user like one that
            # did not install. Enabling waits on an asynchronous rescan the
            # shell may take its time over, so it gets a deadline of its own.
            self.deadline = time.monotonic() + 60
            self.cancelled = False
            try:
                self.enable(request["id"], request["section"])
            except Exception:
                result["status"] = "installed; enable failed"
        create_file(self.tx, "result.json", json.dumps(result).encode())
        return result

    def execute(self, value):
        request = request_value(value)
        try:
            if request["install"]:
                return self.install(request)
            self.open_paths(request["id"])
            self.local_metadata(request)
            if request["verified"]:
                authorize(self.catalog_bytes(), request)
            stage, fetched = self.stage_snapshot(request)
            self.backup = self.home + "/.config/omarchy/plugin-manager-updates/" + self.transaction + "/checkout"
            self.git(stage, "merge-base", "--is-ancestor", request["expectedLocalHead"], fetched)
            require(fetched != request["expectedLocalHead"], "Already at the requested commit")
            base_tree = self.tree(stage, request["expectedLocalHead"])
            target_tree = self.tree(stage, fetched)
            self.check_clean(stage, base_tree, request, "index-before")
            self.vet_stage(stage, fetched, request, target_tree)
            if request["verified"]:
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
                return ({"status": "installed; finalization failed"} if request["install"]
                        else {"status": "updated; finalization failed", "backup": self.backup})
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
            reason = updater.reason or reason_text(error)
            # A refused install replaced nothing, so it has no backup to name.
            result = ({"status": "unchanged; install refused", "reason": reason}
                      if request_kind(request) == "install"
                      else {"status": "unchanged; update refused", "reason": reason,
                            "backup": updater.backup})
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


def serve_update_data_status():
    """Foreground status endpoint: no request parser, fork, network or writes."""
    signals = {}
    try:
        updater = Updater()
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signals[sig] = signal.signal(sig, lambda *_: setattr(updater, "cancelled", True))
        result = updater.update_data_status()
        output = json.dumps(result, ensure_ascii=True, allow_nan=False)
        require(len(output) + 1 <= MAX_UPDATE_STATUS, "Status output exceeds limit")
    except Exception as error:
        result = update_data_result()
        result["error"] = reason_text(error)
        output = json.dumps(result)
    finally:
        for sig, handler in signals.items():
            signal.signal(sig, handler)
    print(output)
    return 0 if result["available"] else 1


def serve_cleanup_completed():
    """Foreground, finite mutation; loss of stdout never causes a second attempt."""
    handlers = {}
    result = cleanup_result()
    try:
        try:
            worker = Updater()
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                handlers[sig] = signal.signal(sig, lambda *_: setattr(worker, "cancelled", True))
        except Exception as error:
            result["error"] = reason_text(error)
        else:
            result = cleanup_completed(worker)
        output = json.dumps(result, ensure_ascii=True, allow_nan=False)
        require(len(output) + 1 <= MAX_CLEANUP_OUTPUT, "Cleanup output exceeds limit")
        sys.stdout.write(output + "\n")
        sys.stdout.flush()
        return 0 if result["status"] == "complete" else 1
    except Exception:
        # No replacement success/zero-count response after possible mutation.
        # A missing or malformed response means unknown to the caller.
        return 1
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    if sys.argv[1:] == ["--cleanup-completed"]:
        sys.exit(serve_cleanup_completed())
    if sys.argv[1:] == ["--update-data-status"]:
        sys.exit(serve_update_data_status())
    kind = "update"
    try:
        os.umask(0o077)
        require(len(sys.argv) == 2 and len(sys.argv[1]) <= 2048, "One bounded request required")
        raw_request = document(sys.argv[1].encode(), 2048)
        kind = request_kind(raw_request)
        if kind == "catalog":
            # In-process and streamed: the projection is far larger than the
            # bounded result a detached transaction worker reports, and no
            # plugin directory is involved, so nothing needs to outlive the
            # observer. Stdout carries the projection bytes and nothing else.
            sys.stdout.buffer.write(Updater().serve_catalog(raw_request))
            sys.stdout.flush()
        else:
            launch(request_value(raw_request))
    except Exception as error:
        if kind == "catalog":
            print(reason_text(error), file=sys.stderr)
        else:
            print(json.dumps({"status": "unchanged; request refused", "reason": reason_text(error), "backup": ""}))
        sys.exit(1)
