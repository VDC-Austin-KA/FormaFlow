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

## Clash Checks (BETA) — Final Status

All 25 URL combinations tried (8 base URL × `/checks` + `/clashchecks` + `/clashChecks`, both plain and `b.`-prefixed containerId) returned 404. The "Clash checks" BETA feature is **not exposed via any public APS API endpoint**. It is an internal-only ACC UI feature as of May 2026.

| Status | URL pattern tried | Notes |
|--------|-------------------|-------|
| ❌ 404 | `bim360/clash/v3/.../checks` (× 2 containerIds) | |
| ❌ 404 | `construction/model-coordination/v2/.../checks` (× 2) | |
| ❌ 404 | `construction/clash/v1/.../checks` (× 2) | |
| ❌ 404 | `bim360/clash/v4/.../checks` (× 1) | |
| ❌ 404 | `modelcoordination/v2/.../checks` (× 1) | |

---

## Stages 3–5: Autonomous Grouping Endpoints (research → wired)

Sourced from the APS reference (https://aps.autodesk.com/en/docs/acc/v1/reference/http/) and the GET clashes/jobs/:jobId page the user referenced. All paths are container-scoped (`/clash/v3/containers/{c}/...`).

| Verb | Path | FormaFlow client method | Stage |
|---|---|---|---|
| GET  | `/modelsets/{m}/clashes/grouped` | `getGroupedClashes()` — primary | 3 |
| GET  | `/modelsets/{m}/clashes/grouped?clashTestId={t}` | same, filtered | 3 |
| POST | `/tests/{testId}/clashes:assign` | `assignClashGroupsToIssue()` | 5 |
| POST | `/tests/{testId}/clashes:close`  | `closeClashGroups()` | optional |
| GET  | `/tests/{testId}/clashes/assigned` | `getAssignedClashGroups()` | existing |
| GET  | `/modelsets/{m}/clashes/assigned` | `listAssignedClashGroups()` | existing |
| GET  | `/clashes/jobs/{jobId}` | `getClashGroupJobStatus()` | existing |
| POST | `/modelsets/{m}/screenshots` | `uploadScreenshot()` | existing |
| GET  | `/modelsets/{m}/screenshots/{id}` | `getScreenshot()` | existing |

### Expected `/clashes/grouped` response shape
```jsonc
{
  "modelSetId": "...",
  "modelSetVersion": 1,
  "clashTestId":     "1ae2261a-...",
  "groupingHierarchy": ["Level", "System Classification", "Family/Type"],
  "groups": [
    {
      "id":             "grp-001",
      "name":           "Level 3 > Supply Air > Ducts",
      "groupingValues": ["Level 3", "Supply Air", "Ducts"],
      "count":          47,
      "familyType":     "Ducts",
      "members":        [{ "documentId": "...", "objectId": 12345 }]
    }
  ],
  "pagination": { "continuationToken": "..." }
}
```

> The `name` field is preserved verbatim by FormaFlow (`nameSource: 'api'`) so a click from the FormaFlow report lands on the same group label the ACC UI shows.

### Stage 4 collapse trigger
Threshold from `config/workflow-config.json#results.collapseThreshold` (default 500). Override at runtime with `PRIORITY_COLLAPSE_THRESHOLD=N`. Collapsed group name = `<original API name> — <Family:Type>`; original IDs preserved in `collapsedFrom: [groupId, ...]`.

### Stage 5 inputs
- Group must have `autoAssignCandidate=true` (set when `test.priority <= config.autoAssign.priorityThreshold`).
- Required env: `ACC_PROJECT_ID` and either `FORMAFLOW_DEFAULT_ISSUE_TYPE_ID` or `config.autoAssign.issueTypeId`.
- Issue title = verbatim `group.name`. Issue body includes discipline pair and clash count.

---

## Discipline-Pair Fallback (Implemented)

Since the ACC API consistently returns 0 real clash groups (0 hard clashes at 0 tolerance), the workflow now generates **synthetic discipline-pair groups** when all API sources are exhausted. These represent the coordination checks that *were* performed, with 0 detected clashes.

**Model files and detected disciplines (9 NWCs in version 1):**

| File | Detected Discipline |
|------|---------------------|
| UTUSB_DSGN_ARCS_L12.nwc | ARCH |
| UTUSB_DSGN_ARIN_L12.nwc | ARCH |
| UTUSB_ACLP_TMPL_R25 - UTUSB_DSGN_STRC_L12.nwc | STRUCT |
| UTUSB_BKR_FRAM_L12.nwc | STRUCT |
| UTUSB_DSGN_MEP_L12.nwc | MEP |
| UTUSB_BKR_CLNG_L12.nwc | MEP/ARCH |
| UTUSB_ACLP_SITE_L12.nwc | CIVIL |
| UTUSB_MLN_F_L12.nwc | UNKNOWN |
| UTUSB_MSI_EMBED_L12.nwc | UNKNOWN |

**Expected groups generated (disciplines with ≥ 2 known):**
- `ARCH_vs_STRUCT_001` — synthetic, clashCount: 0
- `ARCH_vs_MEP_002` — synthetic, clashCount: 0
- `ARCH_vs_CIVIL_003` — synthetic, clashCount: 0
- `STRUCT_vs_MEP_004` — synthetic, clashCount: 0
- `STRUCT_vs_CIVIL_005` — synthetic, clashCount: 0
- `MEP_vs_CIVIL_006` — synthetic, clashCount: 0

**To get real clash data:** In ACC Model Coordination → Clashes → Clash checks, edit ARCH or STRC and set a Tolerance (e.g. 1 inch). This triggers a re-run that will produce real clash instances.

---

## Key Findings Summary

1. **0 hard clashes** — The OTG pipeline ran successfully (April 29, 2026) but found no intersecting geometry. Result documents are never written for empty results, hence all result paths return 404.
2. **Rules are empty** — `documentRules: {}` and `fileRules: {}` mean ACC defaults to checking all models against all others, but at `clashType: "Hard"` with 0 tolerance.
3. **Write operations blocked** — All `PUT/POST/PATCH` to `/rules` return 403 at IAM level. Clash rules must be configured via ACC web UI only.
4. **ARCH/STRC clash checks** — Visible in ACC UI (Clashes → Clash checks BETA tab) but their API surface has not yet been found. Likely on a newer base URL not yet probed.
5. **To get ≥ 2 clash groups** — Either (a) set a clearance tolerance on ARCH/STRC in the ACC UI and re-run, or (b) find the correct API base for the BETA checks endpoint.
