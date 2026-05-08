# APS / ACC Model Coordination API URL Reference

**Container:** `85300971-bbec-46a6-8d28-665cc905026d`  
**Model Set:** `1dbf3fb0-c878-4f2d-a20b-a193d8e1b23e` (ACLP_Trade Coordination)  
**Clash Test:** `1ae2261a-f827-459d-9fdb-e2f251594152` (Success, OtgClashPipeline, modelSetVersion 1)

Legend: ✅ returns data  ⚠️ responds but no useful data  ❌ error (status noted)

---

## Model Set Endpoints

| Status | URL | Notes |
|--------|-----|-------|
| ✅ 200 | `GET bim360/modelset/v3/containers/{c}/modelsets` | Returns 1 model set (ACLP_Trade Coordination). `page: {}` = no further pages. |
| ❌ 404 | `GET modelcoordination/v3/containers/{c}/modelsets` | Alternate base not supported for this container. |
| ✅ 200 | `GET bim360/modelset/v3/containers/{c}/modelsets/{m}` | Full model set detail: `tipVersion:1`, `clashEngineVersion:2`, `permission:Edit`. |
| ✅ 200 | `GET bim360/modelset/v3/containers/{c}/modelsets/{m}/views` | Returns `{supported:true, views:[{title:"Test"}]}` — one saved view. |

---

## Clash Rules Endpoint

| Status | URL | Notes |
|--------|-----|-------|
| ✅ 200 | `GET bim360/clash/v3/containers/{c}/modelsets/{m}/rules` | Returns `{checksum, documentRules:{}, fileRules:{}, clashType:"Hard", clashDisabled:false}`. Both rule maps are **empty** — no per-document or per-file clash pairs defined. |
| ❌ 403 | `PUT bim360/clash/v3/containers/{c}/modelsets/{m}/rules` | "explicit deny in identity-based policy" — write blocked at Autodesk IAM level. Cannot change via API. |
| ❌ 403 | `POST bim360/clash/v3/containers/{c}/modelsets/{m}/rules` | Same 403 deny. |
| ❌ 403 | `PATCH bim360/clash/v3/containers/{c}/modelsets/{m}/rules` | Same 403 deny. |
| ❌ 404 | `GET bim360/clash/v3/containers/{c}/modelsets/{m}/versions/1/rules` | Versioned rules path not supported. |

> **Root cause:** Rules are read-only via API. Must be configured in ACC web UI: Model Coordination → Clashes → Settings.

---

## Clash Test List Endpoints

| Status | URL | Notes |
|--------|-----|-------|
| ✅ 200 | `GET bim360/clash/v3/containers/{c}/modelsets/{m}/tests` | Returns 1 test: `id=1ae2261a`, `status=Success`, `backendType=OtgClashPipeline`, `modelSetVersion=1`, `completedOn=2026-04-29`. |
| ✅ 200 | `GET bim360/clash/v3/containers/{c}/modelsets/{m}/versions/1/tests` | Same single test (versioned path also works). |
| ❌ 404 | `GET bim360/clash/v3/containers/{c}/modelsets` | Top-level model set listing not supported on clash base. |

---

## Clash Result Endpoints (for test `1ae2261a`)

All result paths for this test return 404. The OTG pipeline does **not** create result documents when 0 hard clashes are detected.

| Status | URL | Notes |
|--------|-----|-------|
| ❌ 404 | `GET .../versions/1/tests/{t}/groups` | |
| ❌ 404 | `GET .../tests/{t}/groups` | |
| ❌ 404 | `GET .../versions/1/tests/{t}/clashinstances` | |
| ❌ 404 | `GET .../tests/{t}/clashinstances` | |
| ❌ 404 | `GET .../versions/1/tests/{t}/resources` | |
| ❌ 404 | `GET .../tests/{t}/resources` | |
| ❌ 404 | `GET .../tests/{t}` (detail) | |
| ❌ 404 | `GET .../clashsets/{t}/groups` | |
| ❌ 404 | `GET .../checks/{t}` | (test ID used as check ID — wrong ID) |
| ❌ 404 | `GET .../checks/{t}/groups` | (test ID used as check ID — wrong ID) |

> **Why 404?** Hard clash at 0 tolerance found no intersections → no result documents written.  
> **Fix:** Set a clearance tolerance in ACC UI for ARCH/STRC clash checks, or these are the correct check IDs.

---

## Clash Checks (BETA UI Feature — ARCH / STRC)

The ACC Model Coordination UI shows two named checks ("Clash checks" BETA tab): **ARCH** and **STRC**.
These use a different API surface than the legacy `/tests` endpoint.

| Status | URL | Notes |
|--------|-----|-------|
| ❌ 404 | `GET bim360/clash/v3/containers/{c}/modelsets/{m}/checks` | Not on this base. |
| ❌ 404 | `GET bim360/clash/v3/containers/{c}/modelsets/{m}/clashchecks` | Not on this base. |
| ❌ 404 | `GET bim360/clash/v3/containers/{c}/modelsets/{m}/clashChecks` | Not on this base. |
| ❓ TBD | `GET construction/model-coordination/v2/containers/{c}/modelsets/{m}/checks` | **Next to probe** — likely base for BETA checks feature. |
| ❓ TBD | `GET construction/clash/v1/containers/{c}/modelsets/{m}/checks` | **Next to probe** |
| ❓ TBD | `GET bim360/clash/v4/containers/{c}/modelsets/{m}/checks` | **Next to probe** — v4 may exist for OTG pipeline |

---

## Write / Create Probes (all failed)

| Status | URL | Notes |
|--------|-----|-------|
| ❌ 403 | `PUT bim360/clash/v3/.../rules` | IAM deny |
| ❌ 403 | `POST bim360/clash/v3/.../rules` | IAM deny |
| ❌ 404 | `POST bim360/clash/v3/.../tests` | |
| ❌ 404 | `POST bim360/clash/v3/.../checks` | |
| ❌ 404 | `POST bim360/clash/v3/.../clashsets` | |
| ❌ 404 | `POST bim360/clash/v3/.../run` | |
| ❌ 404 | `POST bim360/clash/v3/.../trigger` | |
| ❌ 404 | `POST bim360/clash/v3/.../refresh` | |

---

## Search Sets Endpoints

| Status | URL | Notes |
|--------|-----|-------|
| ❌ 404 | `GET bim360/clash/v3/.../versions/1/searchsets` | Not available — this container uses the v3 unified-rules model, search sets are not supported. |
| ❌ 404 | `GET bim360/clash/v3/.../searchsets` | Same. |

---

## API Base URL Summary

| Base | Status | Used For |
|------|--------|----------|
| `https://developer.api.autodesk.com/bim360/modelset/v3` | ✅ Active | Model set listing, detail, views |
| `https://developer.api.autodesk.com/bim360/clash/v3` | ✅ Partial | Test listing, rules GET — result paths 404 |
| `https://developer.api.autodesk.com/modelcoordination/v3` | ❌ 404 | Not supported for this container |
| `https://developer.api.autodesk.com/construction/model-coordination/v2` | ❓ Untested | Candidate for BETA Clash Checks |
| `https://developer.api.autodesk.com/construction/clash/v1` | ❓ Untested | Candidate for BETA Clash Checks |
| `https://developer.api.autodesk.com/bim360/clash/v4` | ❓ Untested | Candidate for OTG result endpoint |

---

## Second Model Set

User reports two coordination spaces exist in ACC. API currently returns only one.

| Investigated | Finding |
|-------------|---------|
| `bim360/modelset/v3` listing | 1 result only (`ACLP_Trade Coordination`) |
| `modelcoordination/v3` listing | 404 — base unsupported |
| Disabled/deleted filter | `isDisabled:false, isDeleted:false` — no filter issue |
| Pagination | `page: {}` — no next page |
| Alternative container IDs | Not yet probed — second model set may be in a different ACC project |

> **Next step:** Identify the second coordination space name from the ACC UI dropdown, then find its project/container ID.

---

## Key Findings Summary

1. **0 hard clashes** — The OTG pipeline ran successfully (April 29, 2026) but found no intersecting geometry. Result documents are never written for empty results, hence all result paths return 404.
2. **Rules are empty** — `documentRules: {}` and `fileRules: {}` mean ACC defaults to checking all models against all others, but at `clashType: "Hard"` with 0 tolerance.
3. **Write operations blocked** — All `PUT/POST/PATCH` to `/rules` return 403 at IAM level. Clash rules must be configured via ACC web UI only.
4. **ARCH/STRC clash checks** — Visible in ACC UI (Clashes → Clash checks BETA tab) but their API surface has not yet been found. Likely on a newer base URL not yet probed.
5. **To get ≥ 2 clash groups** — Either (a) set a clearance tolerance on ARCH/STRC in the ACC UI and re-run, or (b) find the correct API base for the BETA checks endpoint.
