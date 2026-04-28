# FormaFlow — Autodesk Forma Model Coordination Automation

**FormaFlow** is a comprehensive, project-agnostic automation framework for Model Coordination in **Autodesk Forma / Autodesk Construction Cloud (ACC)**. It minimises human input to a single action: uploading all models into one folder. Everything else — discipline identification, Search Set creation, clash test execution, and result naming — runs automatically.

Built on the official **[APS SDK for Node.js](https://github.com/autodesk-platform-services/aps-sdk-node)** and the **[Model Coordination API v3](https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-coordination/mcfg-clash)**, with full leverage of Forma's **March 2026** Search Sets and Clash Checks Dashboard features.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Quick Start](#quick-start)
3. [Module 1 — Model Auto-Identification](#module-1--model-auto-identification)
4. [Module 2 — Search Set Library](#module-2--search-set-library)
5. [Module 3 — Clash Test Templates](#module-3--clash-test-templates)
6. [Module 4 — Naming & Grouping Rules](#module-4--naming--grouping-rules)
7. [Module 5 — Full Automated Workflow](#module-5--full-automated-workflow)
8. [Module 6 — Implementation Recommendations](#module-6--implementation-recommendations)
9. [Configuration Reference](#configuration-reference)
10. [API References](#api-references)

---

## Architecture Overview

```
FormaFlow/
├── src/
│   ├── api/
│   │   ├── aps-client.js            ← OAuth 2-legged token + HTTP wrapper (@aps_sdk/authentication)
│   │   ├── model-coordination.js    ← Model Coordination v3 REST client
│   │   └── model-derivative.js      ← Property extraction (@aps_sdk/model-derivative)
│   ├── model-identification/
│   │   └── discipline-classifier.js ← Multi-stage evidence-weighted classifier
│   ├── search-sets/
│   │   └── search-set-generator.js  ← Pushes Search Sets to ACC from the library
│   ├── clash-tests/
│   │   └── clash-test-configurator.js ← Selects + creates clash tests from pairing matrix
│   ├── results/
│   │   └── clash-results-processor.js ← Groups + names clash results, exports JSON
│   └── workflow/
│       └── automated-workflow.js    ← Orchestrates all steps end-to-end
└── config/
    ├── discipline-rules.json        ← Model classification rules (editable)
    ├── search-set-library.json      ← 30+ reusable Search Set templates
    ├── clash-test-templates.json    ← 14 clash test templates + pairing matrix
    ├── naming-conventions.json      ← Group naming format + level normalisation rules
    └── workflow-config.json         ← Runtime toggles (dry-run, overwrite, etc.)
```

---

## Quick Start

### Prerequisites

- Node.js ≥ 18
- An Autodesk Platform Services app with **data:read, data:write, data:create** scopes
- An ACC project with Model Coordination enabled
- Models uploaded to a single folder in ACC Docs

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your APS credentials and ACC project details
```

**Required env vars:**

| Variable | Description |
|---|---|
| `APS_CLIENT_ID` | APS application Client ID |
| `APS_CLIENT_SECRET` | APS application Client Secret |
| `ACC_ACCOUNT_ID` | ACC Account (Hub) ID |
| `ACC_PROJECT_ID` | ACC Project ID |
| `MC_CONTAINER_ID` | Model Coordination Container ID |
| `TARGET_FOLDER_URN` | Docs folder URN where models live |

> **Finding MC_CONTAINER_ID:** Call `GET /bim360/modelset/v3/accounts/{accountId}/containers` with your APS token.

### 3. Run the workflow

```bash
# Full automated run
npm run workflow

# Dry-run (shows planned actions, no API writes)
npm run workflow -- --dry-run

# With a project-specific config override
npm run workflow -- --config ./projects/hospital-a/config-override.json
```

---

## Module 1 — Model Auto-Identification

### How It Works

The classifier (`src/model-identification/discipline-classifier.js`) assigns a BIM discipline to each model using a **6-stage evidence-weighting pipeline**:

| Stage | Signal | Weight |
|-------|--------|--------|
| 1 | File name pattern match (e.g. `ARCH_`, `MEP_DUCT_`) | 1.0 |
| 2 | Required categories present (e.g. `Walls` + `Floors` → ARCH) | 0.8 |
| 3 | System Classification match (e.g. `Supply Air` → MECH) | 0.7 |
| 4 | System Type pattern match (e.g. `SA-01`, `DCW`) | 0.5 |
| 5 | Property signature (e.g. `Discipline = Architecture`) | 0.6 |
| 6 | Dominant category ratio (≥ threshold % of objects) | 0.4 |

**Classification is accepted if confidence ≥ 60%.** Below that threshold, the model is flagged for manual review but does not block the workflow (configurable via `stopOnUnknownDiscipline`).

### Supported Disciplines

| Abbreviation | Label | Key Signals |
|---|---|---|
| `ARCH` | Architecture | Walls, Floors, Ceilings, Roofs |
| `STRUCT` | Structure | Structural Columns, Structural Framing, Foundations |
| `MECH` | Mechanical (HVAC) | Ducts, Supply/Return/Exhaust Air system classifications |
| `PLUMB` | Plumbing | Pipes, DCW/DHW/Sanitary/Storm system classifications |
| `ELEC` | Electrical | Cable Trays, Conduits, Electrical Equipment |
| `FP` | Fire Protection | Sprinklers, FP Wet/Dry system classification |
| `CIVIL` | Civil / Site | Topography, Site |
| `INTERIORS` | Interiors | Furniture, Casework, Furniture Systems |
| `UNKNOWN` | Unclassified | Flagged for review |

### File Naming Conventions (Recommended)

To maximise auto-identification accuracy, use these **prefixes** in Revit file names:

```
ARCH_<BuildingCode>_<Description>.rvt
STRUCT_<BuildingCode>_<Description>.rvt
MECH_<BuildingCode>_<Description>.rvt        or  MEP_DUCT_<...>.rvt
PLUMB_<BuildingCode>_<Description>.rvt       or  MEP_PLUMB_<...>.rvt
ELEC_<BuildingCode>_<Description>.rvt        or  MEP_ELEC_<...>.rvt
FP_<BuildingCode>_<Description>.rvt
CIVIL_<BuildingCode>_<Description>.rvt
```

### Property Standards (for maximum accuracy)

Ensure these properties are populated in Revit before publishing:

| Property | Required For | Example Values |
|---|---|---|
| `Category` | All disciplines | `Walls`, `Ducts`, `Pipes`, `Structural Framing` |
| `System Classification` | MECH, PLUMB, FP | `Supply Air`, `Domestic Cold Water`, `Fire Protection Wet` |
| `System Type` | MECH, PLUMB | `SA-01 Supply`, `DCW-Cold Water` |
| `Discipline` | ARCH, STRUCT | `Architecture`, `Structural` |
| `Level` | All — used for grouping results | `Level 1`, `L3`, `Ground Floor` |

---

## Module 2 — Search Set Library

### Overview

The library (`config/search-set-library.json`) contains **30+ reusable Search Set templates** that are pushed to each ACC model set automatically. All sets use Forma's **property-based query syntax** (released March 2026).

Sets marked `transferable: true` can be imported to any project without modification.
Sets marked `systemBased: true` depend on consistent System Classification values in the Revit models.

### Full Search Set Catalogue

#### Architecture

| ID | Name | Filter Logic |
|---|---|---|
| `ss-arch-walls` | `ARCH_Walls` | Category in [Walls, Curtain Walls, Curtain Panels, Mullions] |
| `ss-arch-floors` | `ARCH_Floors` | Category = Floors |
| `ss-arch-ceilings` | `ARCH_Ceilings` | Category = Ceilings |
| `ss-arch-roofs` | `ARCH_Roofs` | Category = Roofs |
| `ss-arch-openings` | `ARCH_Openings` | Category in [Doors, Windows] |

#### Structure

| ID | Name | Filter Logic |
|---|---|---|
| `ss-struct-columns` | `STRUCT_Columns` | Category = Structural Columns |
| `ss-struct-framing` | `STRUCT_Framing` | Category = Structural Framing |
| `ss-struct-foundations` | `STRUCT_Foundations` | Category = Structural Foundations |
| `ss-struct-slabs` | `STRUCT_Slabs` | Category = Structural Floors |
| `ss-struct-walls` | `STRUCT_Walls` | Category = Structural Walls |

#### Mechanical (HVAC)

| ID | Name | Filter Logic |
|---|---|---|
| `ss-mech-ducts-supply` | `MEP_Duct_Supply` | (Category = Ducts\|Duct Fittings\|Flex Ducts) AND System Classification = Supply Air |
| `ss-mech-ducts-return` | `MEP_Duct_Return` | … AND System Classification = Return Air |
| `ss-mech-ducts-exhaust` | `MEP_Duct_Exhaust` | … AND System Classification = Exhaust Air |
| `ss-mech-ducts-oa` | `MEP_Duct_OutsideAir` | … AND System Classification = Outside Air |
| `ss-mech-ducts-all` | `MEP_Duct_All` | Category in [Ducts, Duct Fittings, Duct Accessories, Flex Ducts, Air Terminals] |
| `ss-mech-equipment` | `MEP_MechanicalEquipment` | Category in [Mechanical Equipment, HVAC Zones] |

#### Plumbing

| ID | Name | Filter Logic |
|---|---|---|
| `ss-plumb-dcw` | `Plumbing_DomesticColdWater` | (Pipes/Fittings) AND System Classification = Domestic Cold Water |
| `ss-plumb-dhw` | `Plumbing_DomesticHotWater` | … AND System Classification in [Domestic Hot Water, DHW Return] |
| `ss-plumb-sanitary` | `Plumbing_Sanitary` | … AND System Classification = Sanitary |
| `ss-plumb-vent` | `Plumbing_Vent` | … AND System Classification = Vent |
| `ss-plumb-storm` | `Plumbing_Storm` | … AND System Classification = Storm |
| `ss-plumb-hydronic` | `Plumbing_Hydronic` | (Pipes/Fittings/Insulation) AND System Classification in [HWS, HWR, CWS, CWR, CWSR, CWRR] |
| `ss-plumb-all` | `Plumbing_All` | Category in [Pipes, Fittings, Accessories, Insulation, Flex Pipes, Fixtures, Equipment] |

#### Electrical

| ID | Name | Filter Logic |
|---|---|---|
| `ss-elec-cabletrays` | `ELEC_CableTrays` | Category in [Cable Trays, Cable Tray Fittings] |
| `ss-elec-conduits` | `ELEC_Conduits` | Category in [Conduits, Conduit Fittings] |
| `ss-elec-equipment` | `ELEC_Equipment` | Category = Electrical Equipment |
| `ss-elec-lighting` | `ELEC_Lighting` | Category in [Lighting Fixtures, Lighting Devices] |

#### Fire Protection

| ID | Name | Filter Logic |
|---|---|---|
| `ss-fp-sprinklers` | `FP_Sprinklers` | Category = Sprinklers |
| `ss-fp-pipes` | `FP_Pipes` | (Pipes/Fittings) AND System Classification in [FP Wet, FP Dry, FP Pre-Action, FP Other] |
| `ss-fp-all` | `FP_All` | Category in [Sprinklers, Fire Protection Equipment] |

---

## Module 3 — Clash Test Templates

### Auto-Pairing Matrix

When disciplines are detected, the framework automatically selects clash tests using this matrix:

| Discipline Pair | Clash Tests Selected |
|---|---|
| ARCH + STRUCT | `ARCH_vs_STRUCT` (+ 3 sub-tests) |
| ARCH + MECH | `MECH_vs_ARCH` |
| ARCH + PLUMB | `PLUMB_vs_ARCH` |
| ARCH + ELEC | `ELEC_vs_ARCH` |
| ARCH + FP | `FP_vs_ARCH` |
| STRUCT + MECH | `MECH_vs_STRUCT` (+ 2 sub-tests) |
| STRUCT + PLUMB | `PLUMB_vs_STRUCT` (+ 2 sub-tests) |
| STRUCT + ELEC | `ELEC_vs_STRUCT` |
| STRUCT + FP | `FP_vs_STRUCT` |
| MECH + PLUMB | `MECH_vs_PLUMB` |
| MECH + ELEC | `MECH_vs_ELEC` |
| MECH + FP | `FP_vs_MECH` |
| PLUMB + ELEC | `PLUMB_vs_ELEC` |

### Priority Order (by construction impact)

1. ARCH vs STRUCT — *major structural/architectural coordination failures*
2. MECH vs STRUCT — *ductwork through beams — most common site clash*
3. MECH vs ARCH — *duct routing through walls and ceilings*
4. PLUMB vs STRUCT — *pipe penetrations through structural zones*
5. PLUMB vs ARCH — *pipe routing through architectural elements*
6. ELEC vs STRUCT — *cable tray and conduit vs steel*
7. ELEC vs ARCH — *electrical vs architectural surfaces*
8. MECH vs PLUMB — *congested ceiling MEP coordination*
9. MECH vs ELEC, PLUMB vs ELEC, FP tests

---

## Module 4 — Naming & Grouping Rules

### Clash Group Name Format

```
[Level]_[TestName]_[Sequence]
```

**Example:** `L03_ARCH_vs_STRUCT_001`

Full format with search set detail (used in sub-test reports):

```
[Level]_[TestName]_[SearchSetA]_vs_[SearchSetB]_[Sequence]
```

**Example:** `L03_ARCH_vs_STRUCT_ARCH_Floors_vs_STRUCT_Framing_001`

### Level Normalisation Rules

| Raw Level Value | Normalised |
|---|---|
| `Ground`, `GF`, `G` | `L00` |
| `1`, `Level 1`, `L1` | `L01` |
| `3`, `Level 3`, `L3` | `L03` |
| `B1`, `Basement 1` | `B01` |
| `Roof`, `RF` | `RF` |
| `Mech`, `MR` | `MR` |
| Unknown / missing | `ZUNK` |

### Multi-Property Grouping

Clashes are first split by **Level**, then sub-grouped by **System Classification** (if populated), giving groups like:

```
L03_MECH_vs_STRUCT_001   ← Supply Air ducts vs beams on Level 3
L03_MECH_vs_STRUCT_002   ← Return Air ducts vs beams on Level 3
L04_MECH_vs_STRUCT_001   ← Supply Air ducts vs beams on Level 4
```

---

## Module 5 — Full Automated Workflow

### Step-by-Step Process

```
Upload all models to one ACC Docs folder
              │
              ▼
┌─────────────────────────────┐
│  1. List Model Set (API)    │  GET /modelsets
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  2. Extract Properties      │  @aps_sdk/model-derivative
│     (Model Derivative API)  │  getAllProperties per model
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  3. Classify Disciplines    │  DisciplineClassifier
│     (6-stage pipeline)      │  fileName → categories → systems
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  4. Create Search Sets      │  POST /searchsets (per discipline)
│     (30+ templates)         │  skip if already exists
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  5. Select + Create         │  ClashTestConfigurator
│     Clash Tests             │  auto-pairing matrix → POST /tests
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  6. Poll for Completion     │  GET /tests/{id} every 5s
│     (auto-retry)            │  timeout after 10 min
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  7. Fetch + Group Results   │  GET /tests/{id}/groups
│     (Level + System)        │  fallback: resource-based fetch
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  8. Name + Export Report    │  Unique group names per convention
│                             │  JSON report → ./output/
└─────────────────────────────┘
```

### Running Per-Project

For each project, create a config override file — do not edit `config/workflow-config.json`:

```json
// projects/my-hospital/config-override.json
{
  "project": {
    "code": "HOSP-A",
    "name": "Hospital Block A"
  },
  "clashTests": {
    "disabledTestIds": ["ct-civil-arch"]
  }
}
```

Then run:
```bash
npm run workflow -- --config projects/my-hospital/config-override.json
```

---

## Module 6 — Implementation Recommendations

### Revit / Authoring Standards

For maximum automation accuracy, enforce these standards in your BIM Execution Plan:

1. **File naming** — enforce the `DISCIPLINE_Project_Description.rvt` convention for all published models
2. **System Classification** — all MEP systems must have `System Classification` populated before publishing to ACC (Mechanical: Supply/Return/Exhaust Air; Plumbing: DCW/DHW/Sanitary/Storm/Vent)
3. **System Type abbreviations** — use project standard codes (SA-, RA-, EA-, DCW, DHW, SAN, VNT, STM) in System Type names
4. **Level names** — standardise to `Level 1`, `Level 2`, etc. or use the project's WBS — avoids level normalisation failures
5. **Structural Material** — populate on all structural elements for improved STRUCT confidence scores
6. **Discipline property** — set the built-in Revit `Discipline` property on all views/models

### Search Set Transferability

All search sets in `config/search-set-library.json` are designed to be **project-agnostic**:

- Category-based sets work on any model with standard Revit categories — no customisation needed
- System Classification-based sets require consistent values across projects — add to BEP standards
- To import into a new project: deploy FormaFlow to that project's ACC container and run `npm run generate-search-sets`

### API Limitations & Known Constraints

| Limitation | Mitigation |
|---|---|
| Search Sets API (March 2026) — endpoint paths may evolve | Monitor APS release notes; update `MC_CLASH_BASE` endpoints in `src/api/model-coordination.js` |
| No official `@aps_sdk/model-coordination` package yet | Uses direct REST calls; swap to SDK package when released |
| Model Derivative property extraction requires published model (not just uploaded) | Ensure models are fully processed before running workflow; check `GET /manifest` status = `success` |
| Grouped clashes endpoint may not be available for all ACC tiers | Fallback to resource-based fetch is implemented |
| Level property may not be present on all element types | ZUNK fallback prevents workflow failure |

### Supplementary Tools

- **[aps-clash-data-view](https://github.com/autodesk-platform-services/aps-clash-data-view)** — visualise clash results in Forge Viewer
- **[aps-clash-data-export-pdf](https://github.com/autodesk-platform-services/aps-clash-data-export-pdf)** — export clash reports as PDFs
- **[aps-model-clash-powerbi](https://github.com/autodesk-platform-services/aps-model-clash-powerbi)** — PowerBI dashboard for clash analytics
- **[APS Postman Collections](https://aps.autodesk.com/blog/postman-collections-model-coordination-api)** — test and explore MC API endpoints

---

## Configuration Reference

### `config/workflow-config.json`

| Key | Default | Description |
|---|---|---|
| `workflow.dryRun` | `false` | Print planned actions without API writes |
| `workflow.stopOnUnknownDiscipline` | `false` | Halt if any model cannot be classified |
| `workflow.pollIntervalMs` | `5000` | Clash test polling interval |
| `workflow.clashTestTimeoutMs` | `600000` | Max wait per clash test (10 min) |
| `modelIdentification.minimumConfidence` | `0.60` | Min confidence score for classification |
| `searchSets.overwriteExisting` | `false` | Overwrite Search Sets with same name |
| `searchSets.createSystemBasedSets` | `true` | Create system classification-based sets |
| `clashTests.subTestsEnabled` | `true` | Create granular sub-tests per clash pair |
| `clashTests.disabledTestIds` | `["ct-mep-clearance"]` | Tests to exclude from this run |
| `results.groupByLevel` | `true` | Group clash results by Level property |
| `results.groupBySystemClassification` | `true` | Further sub-group by System Classification |
| `results.exportPath` | `./output/clash-results` | JSON report output directory |

---

## API References

- [APS SDK for Node.js](https://github.com/autodesk-platform-services/aps-sdk-node)
- [Model Coordination API — Field Guide](https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-coordination/mcfg-clash)
- [Model Derivative API Reference](https://aps.autodesk.com/en/docs/model-derivative/v2/reference/)
- [APS OAuth 2.0 Guide](https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/overview/)
- [Clash Data View Sample](https://github.com/autodesk-platform-services/aps-clash-data-view)
- [Clash Data Export PDF Sample](https://github.com/autodesk-platform-services/aps-clash-data-export-pdf)
- [PowerBI Clash Analytics](https://github.com/autodesk-platform-services/aps-model-clash-powerbi)
- [Postman Collections for MC API](https://aps.autodesk.com/blog/postman-collections-model-coordination-api)
- [Forma March 2026 Release Notes](https://www.autodesk.com/blogs/construction/autodesk-forma-march-2026-construction-releases-built-for-whats-next/)
