# Forma / ACC Model Coordination — Rules & Grouping Guide

> **TL;DR** — When you see "195 clashes in 3 groups of 65" it almost certainly means **one group per clash test** with no further breakdown, because no **Saved Clash Check** with a grouping hierarchy has been configured in the ACC UI. The Model Coordination API only returns the structure that the UI's "Group clashes by" dialog has saved. To get meaningful groups like *Level 3 › Supply Air › Ducts*, you have to configure those rules **once** in the Forma web app — they are not editable via the API today. This guide explains every rule layer, where it lives, and how to make them efficient and reusable.

---

## 0. What "rules" actually means in Model Coordination

Forma uses the word "rules" in several places, for different things. Pinning them down is the first step toward making them useful:

| Layer | What it is | Where it lives | Editable via API? |
|---|---|---|---|
| **1. Clash on/off per model** | Toggle whether each `.rvt`/`.nwc`/`.dwg` participates in clash | ACC → Model Coordination → Clashes → Settings → **Models** tab | ❌ UI only (PATCH on model set has limited shape) |
| **2. Object Exclusions** | Property-based filters that *remove* objects from clash before it runs | Clashes → Settings → **Object exclusions** | ❌ UI only (V2 coordination spaces) |
| **3. Tolerance** | Penetration depth that distinguishes a "real" clash from touching geometry | Clashes panel → Show clashes… | ❌ UI only — V2 detection runs at a fixed 0.5 mm; the panel filter trims results visually |
| **4. Saved Clash Check (selection + filter + grouping hierarchy)** | The reusable container that holds Side A models, Side B models, tolerance, *and* the property hierarchy used to group results | Clashes panel → Save clash check | ❌ UI only (GET-only on `/rules` endpoint) |
| **5. Search Sets** | Property-based saved queries (like Navisworks) | Models tool → Search sets (March 2026 release) | ❌ UI only |
| **6. Issue templates / naming** | Pattern that turns a clash group into a draft ACC Issue | FormaFlow `config/clash-issue-templates.json` + the UI's Templates panel | ✅ Yes — FormaFlow controls this entirely |

> Important context: every PUT/POST/PATCH against `https://developer.api.autodesk.com/bim360/clash/v3/.../rules` currently returns **403 — IAM explicit deny**. Autodesk reserves this surface for the web UI. FormaFlow can **read** the active rules, but it cannot **author** them.

---

## 1. How clash grouping actually works in Forma

When you open the Clashes panel in the viewer:

1. You pick **Selection A** (models that contain the objects you want to fix first) and **Selection B** (models to clash against).
2. You set a **Tolerance** (above/below/between, mm or in).
3. You click **Group clashes by** and pick up to **10 properties**, in priority order. Common ones:
   - `Level` — aggregate of *Level*, *Base Level*, *Reference Level*, *Base Constraint*
   - `Category` — Revit category (Walls, Pipes, Ducts…)
   - `System Classification` — HVAC/Plumbing system bucket (Supply Air, Domestic Cold Water…)
   - `System` — the specific Pipe/Duct system (e.g. *SA-01*)
   - `Family / Type` — `Family:Type` concatenation
   - `Default Grouping` / `Default Subgrouping` — first/second-level groupings shared across file formats
4. You click **Save clash check** with a name like *MEP × Structure — by Level*.

After that, `GET /clash/v3/containers/{c}/modelsets/{m}/clashes/grouped` returns the data Forma is showing you, with each group's:
- `name` — the breadcrumb string (e.g. `Level 3 › Supply Air › Ducts`)
- `groupingValues[]` — the same string broken into ordered values
- `count` — number of clashes in the group
- `members[]` — `{ documentId, objectId }` per element involved

**FormaFlow's `getGroupedClashes()` calls this exact endpoint** (see `src/api/model-coordination.js`). It does **not** invent or rearrange groups; it shows what the saved Clash Check produced.

> **Why "3 groups of 65"?** If no Saved Clash Check has a grouping hierarchy, the API returns one group per Side-A/Side-B pair. With 3 clash tests configured, you get 3 groups whose names are just the test names, and the 195 clashes are split however Forma's defaults chose to bucket them.

---

## 2. The minimum setup to get meaningful FormaFlow output

Do this once in the Forma web app, then every FormaFlow run inherits it.

### Step 1 — Turn off models you don't care about

`Clashes → Settings → Models tab` → un-tick anything that is:
- a federated/whole-building model whose contents are already in other turned-on models
- an as-built / context model
- a Revit *view* of a file whose parent `.rvt` is already on (duplicates)

Effect: clash counts drop by 50-90 % almost immediately. Stage 5 auto-assign becomes practical.

### Step 2 — Create three "essential" Object Exclusions

`Clashes → Settings → Object exclusions → Create object exclusion`. Each accepts up to 100 rule parts and combines them with `and` / `or`.

**Recommended starter set:**

```
A. "Hangers & supports (low priority)"
   Property: Internal/Category
   Operator: is
   Value: Pipe Accessories, Duct Accessories
   AND
   Property: Family / Type
   Operator: contains
   Value: Hanger
   → reduces ~20–30 % of MEP-vs-STRUCT noise

B. "Bolts and fasteners under 25 mm"
   Property: Internal/Category
   Operator: is
   Value: Structural Connections
   AND
   Property: Diameter
   Operator: <
   Value: 25
   → reduces FP-vs-STRUCT noise on bolted connections

C. "Furniture & specialty equipment"
   Property: Internal/Category
   Operator: is
   Value: Furniture, Furniture Systems, Specialty Equipment, Casework
   → these almost never matter at coordination stage
```

Effect: another 10-40 % noise reduction. Coordination focus shifts to constructability-critical elements.

### Step 3 — Create the canonical Saved Clash Check

This is the one thing that transforms FormaFlow output from generic to legible.

Open the Clashes panel → pick the models you want clashed → click **Group clashes by** → add these properties in this order:

1. **Level** — primary bucket (matches construction sequence)
2. **System Classification** — secondary for MEP coordination (Supply Air vs Return Air etc.)
3. **Category** — tertiary fallback for non-MEP clashes
4. **Family / Type** — quaternary, only used by FormaFlow's Stage 4 collapse

Save as `FormaFlow — Default Grouping (Public)`.

After this, `GET /clashes/grouped` returns groups named like:
```
Level 3 › Supply Air › Ducts
Level 3 › Supply Air › Duct Fittings
Level 3 › Domestic Cold Water › Pipes
Level 3 › (no value) › Structural Framing
Roof › Fire Protection Wet › Sprinklers
…
```
and FormaFlow displays them **verbatim** (see PR #87 / Stage 3) so your team's labels match exactly what ACC shows.

### Step 4 — Variant Saved Clash Checks per phase

Once the canonical check is in place, derive phase-specific variants:

| Variant | When | Grouping change |
|---|---|---|
| `FormaFlow — Pre-pour` | Before slab/structure pours | Add `Pour Number` as 1st property; demote Level to 2nd |
| `FormaFlow — MEP-only` | MEP coordination meetings | Side A: MEP models only · Side B: same · grouping `System Classification › Level › Family/Type` |
| `FormaFlow — Penetrations` | Penetration sign-off | Side A: Walls/Floors · Side B: MEP runs · grouping `Level › Category` |

In Forma, click your canonical check → **Save as new** → tweak.

---

## 3. Naming conventions worth standardising

The Saved Clash Check **name** itself shows up in every FormaFlow report and every linked Issue. Use this scheme:

```
{Discipline pair or scope} — {Grouping intent} [— {Phase}]

Examples:
  MEP × Structure — by Level
  ARCH × STRUCT — by Family Type
  Plumbing × Structure — Penetrations Pre-pour
  All × All — Final Coordination
```

Why it matters:
- The string is the **only** label that's preserved through the API to FormaFlow to ACC Issues. Cryptic names make every downstream report cryptic.
- Use ` — ` (em-dash + spaces) as the section separator. FormaFlow's `nameSource: 'api'` path preserves it verbatim and the UI breadcrumb renders cleanly.
- Keep the discipline pair first so reports sort by discipline.

For clash **group** names (auto-generated by the grouping hierarchy), do not try to override them. The names Forma produces — e.g. `Level 3 › Supply Air › Ducts` — are exactly what your team sees in the Clashes panel and what FormaFlow now passes through unchanged. Overriding them breaks the 1:1 mapping.

For **issue** names FormaFlow creates from clash groups, the template in `config/clash-issue-templates.json` defaults to `{groupName}`. Recommended override per discipline pair:

```jsonc
{
  "templates": [
    { "id": "tpl-arch-struct",  "name": "ARCH × STRUCT",  "namingPatternId": "verbatim" },
    { "id": "tpl-mep-struct",   "name": "MEP × STRUCT",   "namingPatternId": "level-system",
      "customPattern": "{level} | {system} | {groupName}" },
    { "id": "tpl-penetration",  "name": "Penetrations",   "namingPatternId": "custom",
      "customPattern": "PEN — {level} — {familyType}" }
  ]
}
```

`verbatim` is almost always the right choice — it matches what users see in Forma.

---

## 4. Efficient rule design — patterns that save time

### Pattern 1 — One Saved Clash Check per discipline pair

Instead of one huge `All × All` check, create per-pair checks. They run in parallel, return faster, and let each trade open exactly its rows.

```
ARCH × STRUCT — by Level
MEP × STRUCT — by Level, System
PLUMB × STRUCT — by Level, System
FP × STRUCT — by Level
ELEC × ARCH — by Level, System
```

FormaFlow's auto-pairing matrix (`config/clash-test-templates.json#autoPairingMatrix`) already mirrors this — set the same names in ACC and the names line up.

### Pattern 2 — Use Object Exclusions, not per-test filters

Filters inside a Saved Clash Check apply only to that check. Object Exclusions apply globally and persist across versions. If you find yourself adding the same filter to three checks, promote it to an Object Exclusion.

### Pattern 3 — Group by what your *next action* is

If the next action is "send a Pour-Number-tagged list to the GC", grouping starts with Pour Number. If it's "schedule a per-floor coordination meeting", grouping starts with Level. Don't grope around — pick the meeting/handoff that owns the groups and group by its key.

### Pattern 4 — Limit grouping depth to 3 properties

More than 3 properties usually produces hundreds of micro-groups (e.g. `Level 3 › Supply Air › Ducts › PipeFitting:Elbow › 24" × 12"` → one elbow per group). FormaFlow's Stage 4 collapse handles this, but the round-trip is faster if the saved hierarchy is already coarse.

### Pattern 5 — Lock the canonical check to *Public* and one author

Saved Clash Checks edited by anyone tend to drift. Promote `FormaFlow — Default Grouping` to **Public**, restrict edit rights to the BIM lead, and let variants be Private.

---

## 5. What FormaFlow brings on top of Forma's rules

| Capability | Where in FormaFlow |
|---|---|
| Read the verbatim group name from `clashes/grouped` and surface it 1:1 in the UI and report | `src/api/model-coordination.js` `getGroupedClashes()` + `src/results/clash-results-processor.js` |
| Walk `groupingValues[]` and infer the discipline pair from `config/discipline-rules.json#groupingValuePatterns` | `src/model-identification/discipline-classifier.js` `classifyFromGroupingValues()` |
| Collapse high-cardinality groups by `Family:Type` once a discipline pair exceeds `collapseThreshold` (default 500) | `_maybeCollapseHighCardinality()` |
| Flag groups whose source test priority ≤ `autoAssign.priorityThreshold` and batch-create ACC Issues via `POST /tests/{t}/clashes:assign` | `autoAssignHighPriorityGroups()` in the workflow |
| Tag every group with `provenance.source` (`api-grouped` / `synthetic-discipline-pair` / `legacy-fallback`) so the UI can show what's real | added in this PR |

FormaFlow does **not** generate the grouping — it consumes and enriches the grouping Forma produces. So if a Forma rule is missing, no amount of FormaFlow effort can fix it.

---

## 6. Why your last run produced "3 groups of 65" — root-cause checklist

Run these in order until something fails:

1. **Is there a Saved Clash Check active?** Open Forma → Clashes → side-panel dropdown. If empty: create the canonical check from §2 Step 3.
2. **Does the active check have a grouping hierarchy?** Click `Group clashes by` — if the dialog is empty, add Level → System Classification → Category.
3. **Did the workflow hit `/modelsets/{m}/clashes/grouped` or fall back?** Check the run log for `getGroupedClashes succeeded at: …/clashes/grouped`. If it logs anything other than that path, the saved check isn't published.
4. **Are the groups in the JSON report tagged `provenance.source: 'api-grouped'`?** If they're tagged `synthetic-discipline-pair`, FormaFlow generated them because the API returned nothing useful — usually means tolerance is too low or rules aren't saved.
5. **Run `/api/debug/readiness?modelSetId=...`** (added in this PR). It probes rules, tolerance, saved checks, and tells you in one response what to fix.

---

## 7. API reference — what's real and what's UI-only

| Endpoint | Purpose | Editable? |
|---|---|---|
| `GET /modelsets/{m}/rules` | Returns `{checksum, documentRules, fileRules, clashType, clashDisabled}` — the rules document the active Saved Clash Check writes | ❌ all writes → 403 |
| `GET /modelsets/{m}/clashes/grouped` | Returns the active Saved Clash Check's grouped results | ❌ read-only |
| `GET /tests/{t}/clashes/assigned` | Groups linked to ACC Issues | ❌ read-only |
| `POST /tests/{t}/clashes:assign` | Link N groups to one Issue | ✅ FormaFlow Stage 5 uses this |
| `POST /tests/{t}/clashes:close` | Mark groups "Not an Issue" | ✅ available via `closeClashGroups()` |
| `GET /modelsets/{m}/views` / `POST /modelsets/{m}/views` | Saved views | ✅ |
| `POST /modelsets/{m}/screenshots` | Attach an image to a group/issue | ✅ |

Everything in the **rule authoring** path is read-only via the API. This is by design — Autodesk treats the rules as a UI-owned configuration. FormaFlow's job is to make the UI work productive: pick the right grouping once, run the workflow over and over, and have every report read identically to the panel your team is already looking at.

---

## 8. Further reading

- Forma help — [Clash Checks](https://help.autodesk.com/cloudhelp/ENU/Coord-Clashes/files/filter-investigate-clashes/Model_Coord_Clash_Checks.html) (Save / Apply / Update / Share)
- Forma help — [Filter and Investigate Clashes](https://help.autodesk.com/cloudhelp/ENU/Coord-Clashes/files/Model_Coord_Filter_Investigate_Clashes.html) (Group clashes by, tolerance, Saved Clash Checks)
- Forma help — [Exclude Model Objects from Clash](https://help.autodesk.com/cloudhelp/ENU/Coord-Clashes/files/clash-settings/Model_Coord_Object_Exclusions.html) (Object Exclusions rule operators)
- Forma help — [Clash Settings](https://help.autodesk.com/cloudhelp/ENU/Coord-Clashes/files/Model_Coord_Clash_Settings.html) (Models tab, Run clash check button)
- Forma help — [Clash FAQ](https://help.autodesk.com/cloudhelp/ENU/Coord-Clashes/files/Model_Coord_Clash_FAQs.html) (fixed 0.5 mm tolerance, unsuccessful clash checks)
- APS — [Model Coordination Clash Testing](https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-coordination/mcfg-clash) (API field guide)
- APS — [GET /modelsets/{m}/clashes/grouped](https://aps.autodesk.com/en/docs/acc/v1/reference/http/mc-clash-service-v3-get-grouped-clashes-GET) (the endpoint FormaFlow uses)
- FormaFlow — `docs/api-url-reference.md` (empirical probe results for the current ACC container)
