# Fix catalog entry cap (v1.10.6)

## Intent, scope and authority
Verified installs and pinned updates fail with "unchanged; install refused (Invalid catalog)" because `authorize()` refuses any live catalog with more than 5,000 listings and the marketplace now serves 5,128. User authorized the fix, a regression test and shipping it as v1.10.6 (commit, push, GitHub release). Marketplace issue retargeting needs its own confirmation.

## Tasks
- [x] T1 Regression test: a catalog above 5,000 listings must authorize (RED first). Route: inline, one test file.
- [x] T2 Drop the entry caps in `authorize()` and `catalog_ids()`; the byte caps already bound both. Route: inline, mechanical.
- [x] T3 README bounded-work row, manifest 1.10.6, full Python and Node suites.
- [ ] T4 Commit, push master, tag and publish GitHub release v1.10.6.

## Checks
`PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen python3 -m unittest discover -s test -p 'test_*.py'`; `node --test test/*.test.mjs`.

## Evidence
Reproduced 2026-10-06: live catalog.json is 12,946,587 bytes with 5,128 plugins; `authorize()` on it raised "Invalid catalog". RED observed on the rewritten test (same refusal). After the fix: Python 144 tests OK, Node 402 pass / 0 fail, and `authorize()` on the live catalog returns None for payton.logomarchy. Diff: 4 files, 11 insertions, 8 deletions. Shipped as a single commit on master tagged v1.10.6 (commit identity: the commit this document first appears in).
