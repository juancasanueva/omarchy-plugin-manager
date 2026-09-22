# Catalog worker shutdown workaround — issue #3

## Outcome
Released v1.10.3. User authorized implementation, test-first development, local deployment/restart, then confirmed all functionality works and explicitly requested PR, merge, issue closure and release. User approved one cohesive PR size exception. Repository default is master (not main).

## Delivery evidence
- Implementation commit: 0118f52cebbb0c2f944721f6d0b8a484f3ee3086 on fix/catalog-worker-shutdown.
- PR #4: https://github.com/juancasanueva/omarchy-plugin-manager/pull/4, squash-merged2026-09-22T17:05:01Z.
- Default-branch merge: 20cc63b79efd41caa80d339eeddbd3e573f98ff4.
- Issue #3 automatically closed2026-09-22T17:05:02Z; release confirmation comment added.
- Release: https://github.com/juancasanueva/omarchy-plugin-manager/releases/tag/v1.10.3, published17:05:39Z, stable/latest; tag resolves to exact merge commit above.
- manifest.json version1.10.3 confirmed remotely; merged shipping files equal verified candidate bytes.
- Local checkout master synced to origin/master. Only parent-owned odd/ remains untracked, excluded from PR/release.

## Scope and completed tasks
- [x] CW1: Remove desktop WorkerScript and run unchanged Model.js in isolated offscreen Quickshell; bounded Python supervisor and incremental publication. Preserve old catalog on errors, stale results, installed/opt-in state and callback ordering. No new runtime dependency.
- [x] CW2: Test-first implementation and corrections: missing helper/teardown failures observed RED; subsequent coverage GREEN. Corrected FailedToStart retry wedge, guarded signals by positive owned PID, handled stale startup, and documented cooperative timeout.
- [x] CW3: Independent verification, parent readback, local runtime test and user UI acceptance.
- [x] CW4: Version bump, approved size exception, explicit eight-file staging, PR/merge/issue closure/release/tag verification.

## Verification
Final independent release verification: focused catalog14 passed, full Node391 passed (no failures/skips), offscreen Python78 passed (no skips), diff-check clean, no test-generated Git-visible debris. Commands: `node --test test/catalog-builder.test.mjs`; `node --test test/*.test.mjs`; `QT_QPA_PLATFORM=offscreen PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'`; `git diff --check`. Existing Python fork deprecation warnings remain. Earlier plain non-offscreen Python run failed unrelated bar edge-scroll test.
RDD off; unassessable native risk due untracked declaration was treated high, so independent verifier used. No repository CI configured. PR was mergeable/CLEAN. Scope864 authored lines (+801/-63) including version bump, explicitly accepted size:exception; tests stay with coupled helper/integration.

## Local runtime evidence and limits
Initial live per-file deployment triggered24 plugin-change notifications and likely hot reload of an old worker generation. Old shell crashed18:30:40CEST in WorkerScript callback execution, a DIFFERENT stack from issue#3 destructor report. Exact callback/lifetime remains unproven. Omarchy has independent inotify plugin watcher despite QS_DISABLE_FILE_WATCHER. coredump appeared late; initial no-core check missed it. Do not repeat live per-file deployment without accounting for watcher.
User authorized subsequent controlled restart18:54:24CEST with updated files already loaded. Old PID203009 -> new PID257480, IPC pingok. Both system coredumps and Quickshell crash inventories checked through18:56:11CEST: no new crashes. User then reported 'perfect, it all works'. Original destructor fault not recreated under instrumentation. Upgrade caveat included in PR/release notes.
Twenty-second budget is cooperative, not a hard watchdog; synchronous parsing/cleanup may overrun. Store timing excludes panel rendering; final assignment/stamping is synchronous. Teardown tests count zombies as non-running and do not exhaustively cover earliest fork races. Signal0 reachability not reproduced; guard tested with mocks and upstream API evidence.

## Cleanup and rollback
Final tests left no new scratch/live helpers; four older /tmp/omarchy-catalog-* directories were left untouched because exact probe provenance was unavailable. Full old installed-plugin backup: ~/.local/state/omarchy-plugin-manager-local-backups/20260922-183038-4ubq_m7r/plugin. Installed test copy was deployed before release version bump; no additional restart after publication.
Shipping rollback boundary: CatalogBuilder.qml, CatalogWorker.js, PluginStore.qml, helpers/catalog_build.py, test/catalog-builder.test.mjs, test/model.test.mjs, README.md, manifest.json. Revert the merge as one coherent behavior if needed; preserve unrelated/local recovery files. No pending implementation or delivery tasks.

## Continuity
Local-only feature locator odd/tasks/catalog-worker-shutdown.md. Full Engram mirror topic odd/catalog-worker-shutdown/tasks, observation776. Separate incident/restart/deployment observations retain timestamps and provenance.
