# Completed transaction archival

## Objective and authority
Prevent successful installs/updates exhausting the shared 32-entry active transaction cap while preserving recovery data. User initially authorized repository implementation, then explicitly authorized installing the fix and restarting the shell. User confirmed live updates work and explicitly authorized one cohesive commit, accepting the review-size exception. Publishing and further live-state cleanup remain unauthorized. Branch: fix/completed-transaction-archival; initial tree clean.

## Accepted design and scope
At exactly 32 entries, preflight archives only exact installed/updated successes under the existing state-directory flock. Bounded discovery; a 33rd entry requires manual review. Request/prepared/published/result records and update backup identities must agree. Refused/partial/unsafe/malformed/unknown records stay active.
Whole transaction directories move to sibling plugin-manager-updates-archive using validated descriptors and renameat2(NOREPLACE), directory fsyncs, identity rechecks and mandatory recount. No deletion, backup traversal, journal rewrite or active-root alias. Below capacity nothing moves. README documents historical backup-path fallback and cumulative archive growth.
Changed source: helpers/pinned_update.py, test/test_pinned_update.py, README.md. Parent owns this document. Rollback boundary: retention helper/tests/docs only; never automatically undo/delete existing archives.

## Method and delivery
Delegated direct, not SDD. TDD ON by explicit user Test-first selection. Native assessment unassessable due to untracked task document; RDD off, treated as high with independent verification.
Forecast 300–450 lines; actual source diff 651 lines (645 additions/6 deletions), mostly tests. Delivery: exception-ok, explicitly selected by the user to keep behavior, tests, documentation and task evidence in one cohesive commit. Commit subject: `fix: archive completed plugin transactions at capacity`. No PR, push or release authorized. After explicit user authorization, only the installed updater helper was replaced; unrelated installed changes were preserved.

## Tasks
- [x] T1 Map safe archival boundaries and tests. Explorer mud41vbd-2-bul9.
- [x] T2 Implement helper, regressions and docs with observed RED/GREEN. Writer mud483fr-3-mgrg.
- [x] T3 Assess, independently verify and inspect final diff. Verifier mud4jjf7-4-rpjz found no concrete defects.

## Acceptance and evidence
Coverage includes successful/mixed histories, install/update trust modes, below-limit compatibility, repeated pressure, journal/backup byte/inode preservation, unresolved outcomes, malformed/oversized/duplicate JSON, unsafe types/modes, collisions, syscall/rename/fsync failures, cancellation, locking, identity changes and bounded enumeration.
Writer RED: 72 tests with 40 failures/5 errors; additional RED for contradictory targets. Writer GREEN: 77 tests passed (4.963s); git diff --check passed.
Independent rerun: `/usr/bin/python3 -I -S test/test_pinned_update.py` passed all 77 tests (4.784s); `git diff --check` passed. Independent inspection found no concrete scoped defects and confirmed no verification mutations. Parent inspected helper/docs diff and archival loop.
Automated runtime harness uses isolated test homes/local fixture repositories; no live updater executed by the agents. After deployment, the user tested live updates and confirmed they work. Independent verifier did not witness historical RED chronology. Advisory locks do not exclude arbitrary same-user writers; archives remain cumulative.

## Deployment evidence
User requested installation and shell restart. Original installed helper matched repository HEAD exactly. Atomically replaced only installed helpers/pinned_update.py under updater flock; rollback at ~/.config/omarchy/plugin-manager-deploy-backup-614_js04/pinned_update.py. All unrelated installed changes preserved. `omarchy restart shell` exited 0. Independent verifier mud4q206-5-8ezd confirmed source/installed SHA256 e83eba20c6720fb872016c44402fb2c00dbb86ce5c133c11a2fb91b950d9c12a, original backup SHA256 4ac36e0da093f3deda603fcd63ba4913f7446b8eddae824bdcf111fd638882ae, and live shell IPC ping returned ok. No plugin update executed.

## Next step
Commit the verified work as the user-authorized single work unit. User acceptance: "ok, the updates work. commit". Publication requires separate authorization.
