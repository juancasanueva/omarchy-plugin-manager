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
- [x] R3 Release committed, master fast-forwarded, master/tag atomically pushed, GitHub release published and remote evidence verified.

## Publication contract
Tag v1.10.4 identifies the release commit. Verify remote master/tag identity at publication, release normal/published/latest, correct manifest. Notes distinguish archival preserving backups from irreversible confirmed cleanup; unresolved/unsafe history remains, active counter excludes archive. Rollback code to prior release does not restore deleted backups. Release commit: 50975a458bc738a234d202a8161ff36b2d05f29c. Remote master and peeled v1.10.4 matched this commit at publication; no local branches remained unmerged. GitHub published v1.10.4 at 2026-09-22T22:15:32Z as latest, non-draft/non-prerelease, no uploaded assets. Tagged manifest is 1.10.4. URL: https://github.com/juancasanueva/omarchy-plugin-manager/releases/tag/v1.10.4 . This post-publication evidence is recorded in a follow-up documentation commit; the release tag remains immutable.
