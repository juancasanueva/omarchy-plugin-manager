# Release v1.10.5

## Intent, scope and authority
Release user-tested Settings Info improvements: archive path, ~ home display, shorter labels, accent PlainText paths and removed counter/caption. Backend unchanged. User authorized commit, push master, GitHub release and marketplace submission; separately authorized retargeting #4517 and affirmed its exact-commit/non-security-audit acknowledgment. No label or installation-policy changes.

## Tasks
- [x] R1 Prepare manifest 1.10.5, independently verify and commit.
- [x] R2 Push master/tag and publish verified GitHub release.
- [x] R3 Retarget marketplace #4517 and verify host readback.

## Checks and routing
Metadata inline; independent gentle-ai-verify ran: `node --test test/*.test.mjs` (402 passed); `PYTHONDONTWRITEBYTECODE=1 QML_DISABLE_DISK_CACHE=1 QT_QPA_PLATFORM=offscreen /usr/bin/python3 -m unittest discover -s test -p 'test_*.py'` (144 passed, three fork warnings); plugin validation; manifest ID/version assertions; diff checks. No skips. `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell BarWidget.qml Panel.qml Expanded.qml SettingsInfo.qml` exited 0, 689 warnings, no errors; not a warning-free/type-complete proof. No strict TDD configuration found; ordinary release checks used. User confirmed live appearance. Parent owns delivery.

## Evidence and constraints
Commit 21a63f23ba7617f69a8fa486315a534ae5658463 contains eight files, 133 insertions/67 deletions. Atomic push confirmed master and peeled v1.10.5 match. GitHub release is published/latest, non-draft/non-prerelease: https://github.com/juancasanueva/omarchy-plugin-manager/releases/tag/v1.10.5 . No force push or cleanup. Direct-master delivery explicitly requested; under 300-line forecast. Rollback boundary is presentation, tests/README and version; no stored update data changed. This task record stays local-only to avoid moving release-bound HEAD.

## Marketplace and next step
Open/closed duplicate search found existing conforming #4517; YAML form .github/ISSUE_TEMPLATE/verify-plugin.yml. Action: Verify and publish a newer upstream commit. Required acknowledgment affirmed; optional installation acknowledgment unchecked. Actor ADMIN on source, READ and issue-author viewerCanUpdate on marketplace. One issue-edit attempt confirmed by exact host readback: https://github.com/omacom/omarchy-plugin-marketplace/issues/4517 now titled [Verify]: Plugin Manager v1.10.5 and targets 21a63f23ba7617f69a8fa486315a534ae5658463. Issue remains OPEN; existing validated/security-review-required/plugin-update labels unchanged and do not prove fresh-target validation. Submission completed, marketplace publication not yet confirmed; await automation and maintainer approval. No further push needed. Full record mirrored to Engram.
