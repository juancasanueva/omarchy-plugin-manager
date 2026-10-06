# Raise raw catalog cap to 64 MiB (v1.10.7)

## Intent, scope and authority
The raw marketplace catalog download is capped at 16 MiB. On 2026-10-06 it was 12.9 MB for 5,128 listings (about 2.5 KB each), leaving room for about 1,500 more; September added 2,503. Hitting the cap would refuse every install and update again, exactly like the 5,000-entry cap fixed in v1.10.6. User authorized raising it to 64 MiB, releasing a new version and updating the open marketplace issue. v1.10.6 was already published, so this ships as v1.10.7 rather than moving a published tag.

## Tasks
- [x] T1 Tests at 64 MiB: authorization and projection accept a 64 MiB raw catalog, curl gets `--max-filesize` 64 MiB, the stream reader enforces the same constant. RED observed ("JSON exceeds limit"). Route: inline.
- [x] T2 `MAX_RAW_CATALOG` to 64 MiB; README bounded-work row and raw-download paragraph; manifest 1.10.7. Route: inline, mechanical. Python 144 OK, Node 402 pass.
- [ ] T3 Release v1.10.7 and retarget marketplace issue 10278.

## Known limits left as they are
- The projected Browse catalog stays capped at 8 MiB. It was 5.0 MB on 2026-10-06 (about 980 bytes per listing), room for about 3,400 more listings. When that fills, refresh falls back to the cache and Browse and update detection go stale; installs keep working. Needs its own decision.
- The catalog download keeps its 20-second curl time budget; 64 MiB inside it needs about 3.3 MB/s.

## Checks
`PYTHONDONTWRITEBYTECODE=1 QML_DISABLE_DISK_CACHE=1 QT_QPA_PLATFORM=offscreen /usr/bin/python3 -m unittest discover -s test -p 'test_*.py'`; `node --test test/*.test.mjs`.
