#!/usr/bin/python3
"""Bound and supervise the offscreen Model.js build; no display rules live here."""
import ctypes
import json
import os
from pathlib import Path
import resource
import select
import signal
import subprocess
import sys
import tempfile
import time

RAW_LIMIT = 8 * 1024 * 1024
REQUEST_LIMIT = 6 * RAW_LIMIT + 1024 * 1024
OUTPUT_LIMIT = 16 * 1024 * 1024
FRAME_LIMIT = 64 * 1024
DEADLINE = 20
cancelled = False


def cancel(*_):
    global cancelled
    cancelled = True


def ready(fds, parent, deadline, timeout=0.05):
    if cancelled or time.monotonic() >= deadline:
        raise ValueError("Catalog build cancelled or timed out")
    readable, _, _ = select.select([parent, *fds], [], [], timeout)
    if parent in readable:
        raise ValueError("Catalog owner exited")
    return readable


def run(parent, deadline):
    raw = bytearray()
    while True:
        if 0 not in ready([0], parent, deadline):
            continue
        chunk = os.read(0, min(65536, REQUEST_LIMIT + 1 - len(raw)))
        if not chunk:
            break
        raw.extend(chunk)
        if len(raw) > REQUEST_LIMIT:
            raise ValueError("Catalog request exceeds limit")
    request = json.loads(raw)
    if (type(request) is not dict or set(request) != {"generation", "raw", "installedIds"}
            or type(request["generation"]) is not int
            or not 0 <= request["generation"] <= 2147483647
            or not isinstance(request["raw"], str)
            or len(request["raw"].encode("utf-8")) > RAW_LIMIT
            or type(request["installedIds"]) is not list
            or any(not isinstance(value, str) for value in request["installedIds"])
            or len(json.dumps(request["installedIds"]).encode()) > 1024 * 1024):
        raise ValueError("Invalid or oversized catalog request")

    with tempfile.TemporaryDirectory(prefix="omarchy-catalog-", dir="/tmp") as directory:
        env = {"PATH": "/usr/bin:/bin", "HOME": directory, "QT_QPA_PLATFORM": "offscreen",
               "QML_DISABLE_DISK_CACHE": "1"}
        for key in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME"):
            env[key] = os.path.join(directory, key)
            os.mkdir(env[key], 0o700)
        with tempfile.TemporaryFile(dir=directory) as input_file:
            input_file.write(raw)
            input_file.seek(0)
            env["CATALOG_REQUEST_FD"] = str(input_file.fileno())
            owner = os.getpid()

            def child_setup():
                # Bound enrichment even before the first serialized byte exists.
                resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                # Even SIGKILL of this supervisor cannot orphan the QML engine.
                if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != owner:
                    os._exit(1)

            process = subprocess.Popen(
                ["/usr/bin/quickshell", "--no-color", "--path",
                 str(Path(__file__).resolve().parent.parent / "CatalogBuilder.qml")],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=env, pass_fds=(input_file.fileno(),), start_new_session=True, preexec_fn=child_setup)
            streams = {process.stdout.fileno(): bytearray(), process.stderr.fileno(): bytearray()}
            output = streams[process.stdout.fileno()]
            errors = streams[process.stderr.fileno()]
            try:
                while streams:
                    for fd in ready(list(streams), parent, deadline):
                        target = streams[fd]
                        cap = OUTPUT_LIMIT + 4096 if target is output else 4096
                        chunk = os.read(fd, min(65536, cap + 1 - len(target)))
                        if not chunk:
                            del streams[fd]
                        else:
                            target.extend(chunk)
                            if len(target) > cap:
                                raise ValueError("Catalog build output exceeds limit")
                while process.poll() is None:
                    ready([], parent, deadline)
                if process.returncode != 0:
                    raise ValueError("Catalog builder failed")
            finally:
                # Keep the owned leader unreaped during escalation, so its
                # process-group identity cannot be recycled underneath us.
                if process.returncode is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    time.sleep(0.05)
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                process.stdout.close()
                process.stderr.close()
    lines = [line.split(b"CATALOG_RESULT:", 1)[1] for line in output.splitlines()
             if line.startswith(b" DEBUG qml: CATALOG_RESULT:")]
    if len(lines) != 1 or len(lines[0]) > OUTPUT_LIMIT:
        raise ValueError("Invalid catalog builder response")
    result = json.loads(lines[0])
    if result.get("generation") != request["generation"]:
        raise ValueError("Invalid catalog generation")
    # Small independently bounded frames keep publication JSON parsing off a
    # single long shell event. Reject overflow, never truncate the catalog.
    frames = []
    batch = []
    size = 0
    for entry in result.get("entries") or []:
        encoded = json.dumps(entry, ensure_ascii=True, separators=(",", ":"))
        if len(encoded) > FRAME_LIMIT - 256:
            raise ValueError("Catalog entry exceeds publication limit")
        if size + len(encoded) > FRAME_LIMIT - 256:
            frames.append("[" + ",".join(batch) + "]\n")
            batch, size = [], 0
        batch.append(encoded)
        size += len(encoded) + 1
    frames.append("[" + ",".join(batch) + "]\n")
    frames.append(json.dumps({"generation": request["generation"], "error": result["error"]}) + "\n")
    if sum(map(len, frames)) > OUTPUT_LIMIT:
        raise ValueError("Catalog publication exceeds limit")
    # stdout may be backpressured; the same owner/deadline governs delivery.
    os.set_blocking(1, False)
    for frame in frames:
        data = memoryview(frame.encode("ascii"))
        while data:
            ready([], parent, deadline, timeout=0)
            try:
                data = data[os.write(1, data):]
            except BlockingIOError:
                ready([], parent, deadline)


def main():
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, cancel)
    owner = os.getppid()
    if owner == 1:
        return 1
    parent = os.pidfd_open(owner)
    try:
        if os.getppid() != owner:
            return 1
        # QProcess destruction kills its direct child without a cleanup grace.
        # The observer owns no scratch. A short-lived guardian watches its
        # pidfd, so even SIGKILL triggers engine teardown and private-dir cleanup.
        if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != owner:
            return 1
        observer = os.pidfd_open(os.getpid())
        child = os.fork()
        if child:
            os.close(observer)
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sig, lambda *_: os._exit(1))
            if cancelled:
                os._exit(1)
            _, status = os.waitpid(child, 0)
            return 0 if os.waitstatus_to_exitcode(status) == 0 else 1
        os.close(parent)
        parent = observer
        os.setsid()
        run(parent, time.monotonic() + DEADLINE)
        return 0
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        # Fixed, bounded diagnostics; never print catalog content or paths.
        sys.stderr.write("Could not build the plugin catalog; invalid input, limit, or helper failure\n")
        return 1
    finally:
        os.close(parent)


if __name__ == "__main__":
    sys.exit(main())
