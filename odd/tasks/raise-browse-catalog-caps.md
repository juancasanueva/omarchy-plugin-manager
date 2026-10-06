# Raise Browse catalog caps to 16/32 MiB (v1.10.8)

## Intent, scope and authority
Browse holds a projected copy of the marketplace catalog capped at 8 MiB and an enriched Model.js publication capped at 16 MiB. On 2026-10-06 they measured 5.0 MB (about 980 bytes per listing) and 8.0 MB (about 1,565 bytes per entry), leaving room for about 3,400 and 5,600 more listings. September added 2,503 listings. When the projection fills, refresh falls back to the cache and Browse and update detection go stale. User authorized raising them to 16 MiB and 32 MiB and releasing v1.10.8. Not 64 MiB: the shell keeps the whole enriched catalog in memory.

## Tasks
- [x] T1 Tests first: MAX_CATALOG pinned at 16 MiB; oversized projection and cache fixtures scale with it; builder accepts 8-16 MiB catalog text and refuses above 16 MiB; engine output overflow at 33 MiB; aggregate publication fixture grown to 12,000 entries so it still exceeds 32 MiB. RED observed (8388608 != 16777216; builder refused 8 MiB+1). Route: inline.
- [x] T2 Move the limits together: `MAX_CATALOG` (pinned_update.py), `RAW_LIMIT` and `OUTPUT_LIMIT` (catalog_build.py), input and transport checks in PluginStore.qml (97 MiB = 6 x 16 + 1, matching REQUEST_LIMIT). README and manifest 1.10.8. Route: inline, mechanical constants.
- [ ] T3 Release v1.10.8 and retarget marketplace issue 10278.

## Known limits left as they are
The real fix is to stop loading the full catalog into the shell (helper-side search and paging). These caps buy roughly four months at September's pace.

## Checks
`PYTHONDONTWRITEBYTECODE=1 QML_DISABLE_DISK_CACHE=1 QT_QPA_PLATFORM=offscreen /usr/bin/python3 -m unittest discover -s test -p 'test_*.py'`; `node --test test/*.test.mjs`.
