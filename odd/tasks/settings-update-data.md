# Settings update-data controls

## Intent and authority
Show `Plugins installed in ...`, the account-derived update-data path, an active N/32 counter, and a Delete update data button in both Settings views. User explicitly chose deletion of confirmed-success journals/backups from both active and archive directories after confirmation. Preserve failed, unresolved and unsafe data and installed plugins. No live cleanup, deployment, push or PR authorized.

## Safety contract
Read-only status never creates or mutates storage. Count all active direct entries, exclude archives, and represent overflow/unavailability truthfully. Cleanup shares the updater's active-directory inode lock; validates exact successful history and complete known contents including Git index files; uses bounded descriptor-relative no-follow removal, identity/mount checks and shared operation budgets. Journals are removed last; durable interruption markers prevent partial backups requalifying. Partial/unknown results never trigger automatic retry. Deletion is irreversible/non-atomic; advisory locks do not exclude arbitrary same-user writers.
SettingsInfo remains presentation-only. Shared store owns confirmation, isolated fixed argv, timeout escalation, bounded stdout/stderr, strict result validation, stale-generation rejection and independent post-completion status refresh. Active 0/32 does not disable archive cleanup.

## Method and delivery
TDD ON by explicit user Test-first selection; delegated direct, not SDD. User selected local feature-branch-chain and explicitly approved T2 and remaining cohesive review-size exceptions. Tests/docs remain with each behavior. Original 1,000–1,600-line estimate exceeded: four source units total 2,909 changed lines; final net diff versus 945d945 is 2,831 lines across 12 files. No cosmetic shrinking.

## Completed work units
- [x] T1 Read-only metadata/status: f35b4e8, 385 additions; branch feat/settings-update-data-status.
- [x] T2 Bounded completed-transaction removal: 4820209, 871 changed lines; branch feat/settings-update-data-delete.
- [x] T3 Cleanup CLI, lock/lifecycle and outcomes: b1819eb, 600 changed lines; branch feat/settings-update-data-cleanup.
- [x] T4 Shared Settings UI/store/parsers and tests: 80f082d54b217e9d3ba338f9a70cedced75237e1, 1,053 changed lines; branch feat/settings-update-data-ui.
- [x] T5 Independent integrated verification and local integration. Tracker feat/settings-update-data fast-forwarded from 945d945 through all four units. No remote publication or installation.

## Verification evidence
Each writer observed relevant RED before implementation, followed by GREEN. Independent verifiers passed each unit. Native assessments were unavailable due untracked files, RDD off; all units therefore received high-equivalent independent verification. T4 regressions caught Process.exited signal shadowing and impossible 129-removal success; both corrected before verification.
Final independent verifier mud7fywt-e-2cm7 found no blocking defects and ran:
- `/usr/bin/python3 -I -S test/test_update_data.py`: 53 passed (0.984s).
- `/usr/bin/python3 -I -S test/test_pinned_update.py`: 77 passed (4.797s).
- `node --test test/settings-style.test.mjs test/update-data.test.mjs test/model.test.mjs`: 315 passed (31.197s), no skips.
- `PYTHONDONTWRITEBYTECODE=1 QML_DISABLE_DISK_CACHE=1 QT_QPA_PLATFORM=offscreen /usr/bin/python3 -m unittest discover -s test -p 'test_popup_controls.py'`: 3 passed (0.904s), no skips.
- `git diff --check`: passed.
Total: 448 tests. Parent inspected shared UI bindings and integration diff. Actual host Button tested at 420/220/140px with long paths, disabled clicks and no QML warnings. Filesystem tests use disposable transaction fixtures; timeout tests use disposable blocking subprocesses. Store process transports are inert doubles, not full desktop/helper proof; arbitrary delayed EOF ordering remains unverified. No live helper or cleanup executed.

## Runtime and rollback
Status: fixed --update-data-status, schema 1, canonical paths, active count capped at 33 with lower-bound indication; 8 KiB output. Cleanup: fixed --cleanup-completed, schema 1 with complete/limited/cancelled/partial/failed/unknown accounting; 4 KiB output; exit 0 only for complete. Discovery bounds: 256 names/root, 512 total, 128 candidate attempts. Independent status refresh required; no locked final recount claimed. UI uses 6/20-second inner deadlines plus one-second KILL escalation and 8/22-second observers.
Rollback each code/tests/docs unit together, never attempt to restore already-deleted backups by reverting code. Installation and user testing remain next, only on authorization.
