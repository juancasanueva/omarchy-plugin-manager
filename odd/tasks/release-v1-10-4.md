# Release v1.10.4

## Authority and scope
User confirmed deployed behavior works and authorized all session branches integrated into master, pushed and released as v1.10.4. Includes completed-transaction archival and Settings paths/count/confirmed completed-only cleanup. No live data cleanup or additional deployment authorized.

## Integration and checks
All six session branches are in the linear ac0912b..e609333 range, no unrelated merges. Fresh origin/master matched ac0912b; remote v1.10.4 absent. Release branch starts e609333. Only release-version edit: manifest.json 1.10.3 -> 1.10.4. Follow prior normal GitHub release convention, no uploaded assets; no force pushes.
Full-suite verification initially found nine stale test-fixture failures. Fixed lexical store/cleanupProcess/refreshUpdateData dependencies in three tests, preserving every existing assertion and adding refresh/locking assertions. Commit5396924. Observed RED49/58 -> GREEN58/58; no production workaround.
Independent final verifier mud8av7a-l-uali:402 Node tests and144 Python tests passed, no skips; manifest version/ID assertion and git diff --check passed. Python emits three non-failing fork deprecation warnings. Absolute Qt lint exits0 with657 warnings; independent comparison to master baselineac0912b found exactly identical messages/categories, no new diagnostics. Lint is not warning-free/full type proof. No live cleanup executed.

## Tasks
- [x] R1 Prepare manifest and scope.
- [x] R2 Resolve fixture regressions and independently pass full release checks.
- [ ] R3 Commit release, fast-forward master, atomically push master/tag, publish GitHub release and verify remote evidence. IN PROGRESS.

## Publication contract
Tag v1.10.4 identifies the release commit. Verify remote master/tag identity at publication, release normal/published/latest, correct manifest. Notes distinguish archival preserving backups from irreversible confirmed cleanup; unresolved/unsafe history remains, active counter excludes archive. Rollback code to prior release does not restore deleted backups. Record publication outcome after it is observed; no premature success claim.
