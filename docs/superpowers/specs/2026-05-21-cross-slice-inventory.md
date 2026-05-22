# Cross-Slice Inventory

**Status:** Reference doc
**Date:** 2026-05-21
**Author:** Amey (PM case study)
**Purpose:** Single-page index of everything known about the settlement craft bet across the capture slice and the engine slice. Reference for the PRD memo.

---

## 1. Project context

- **Company:** Greenroom (vertical SaaS for independent music venues)
- **ARR:** $8.1M, NDR 116%, 73 net new venues in last year (per Pri's Q4 memo)
- **CEO thesis:** *"Winning on completeness, losing on craft"* — customers stay for the all-in-one breadth, churn on individual feature shallowness
- **Q1 2026 craft bet:** Settlement
- **Why settlement:** 82% of customer base does settlement outside the app in spreadsheets. Existential signal, not a feature gap.
- **Strategic frame:** Independent venues survive the Live Nation / AEG consolidation only if they're the ones agents trust. Trust is built at settlement.

## 2. Personas (canonical)

| Persona | Role | Key quote | Primary need |
|---|---|---|---|
| **Mariana Reyes** | Lead booker, The Crescent (650-cap, Nashville) | *"Your tool can't do vs deals. So I do it in a Google Sheet."* | The 2am settlement ritual stops sucking |
| **Diego Velasquez** | Tour manager, ~200 shows/yr | *"I want to see the math. Not have it explained from memory."* | Pre-review settlement on phone before walking in |
| **Marcus Holland** | GM + co-owner, The Crescent | *"Once or twice a year, badly. There's a long tail of $50-$100 things."* | Sleep better signing off settlements via text from his couch |
| **Sarah Kim** | Music agent, WME, ~80 shows/yr | *"Settlement is the most signal-rich [signal]. A venue that settles well has its operational house in order."* | A version of the deal both parties agreed on, in one place |

## 3. Stakes for The Crescent

- Lease renewal: March 2027
- Routing reputation directly affects lease viability (Marcus saw an indie agent silently pull ~$80K/yr of routing after one bad settlement)
- ~25 hours/month of senior labor on settlement + post-settlement cleanup
- Predicted-vs-actual margin diverges 40%+ on half of shows

## 4. Data inventory (24-month synthetic seed)

### Deal type distribution (n=537 total, n=507 past)

| Deal type | Total | Past | % of past | Engine status |
|---|---:|---:|---:|---|
| Flat | 185 | 174 | 34.3% | **Supported** |
| Vs | 195 | 185 | 36.5% | Not supported |
| Percentage of net | 109 | 103 | 20.3% | Not supported |
| Door | 30 | 29 | 5.7% | Not supported |
| Percentage of gross | 18 | 16 | 3.2% | **Supported** |
| **Engine handles** | **203** | **190** | **37.5%** | |
| **Engine bypassed** | **334** | **317** | **62.5%** | (Mariana's spreadsheet) |

### Vs-deal variants (n=195 total)

| Variant | Count | % of vs |
|---|---:|---:|
| Standard vs | 89 | 45.6% |
| Walkout pot | 32 | 16.4% |
| Vs-gross (basis = gross) | 32 | 16.4% |
| Ratchet / escalator | 27 | 13.8% |
| Bonuses (excluding above) | 15 | 7.7% |

### Frontend vs. analysis mismatch (resolved)

- `/shows` shows 507 — frontend filters `shows.date <= today` (`lib/queries.ts:41`)
- Raw analysis showed 537 — counts all shows including future
- Both correct; choose denominator based on question (past-only for "what's in the system today"; full for "what your slice would gate going forward")

### Known data bugs in the starter codebase

- `lib/queries.ts:175-176` — `settledCount = pastShowIds.size` (every past show counted as settled regardless of `settlements.status`). The /reports page is currently lying.

## 5. Pressure-test findings (against all 195 vs deals)

Conducted while finalizing the capture spec's schema additions.

| Concern | Finding | Action taken |
|---|---|---|
| Walkout schema (`{breakevenFormula, potThreshold, artistShareAbove}`) | 16/32 walkout deals say *"above breakeven"* with no formula; 12 give explicit threshold; 4 use alternative wording | Schema fields made nullable; LLM flags ambiguity rather than defaulting |
| Ratchet schema (`bonusesJson.tier_ratchet`) | Existing type models ratchets as additive bonuses, but they *replace* the percentage; 27 vs deals (14%) affected. dealMath.ts:248-252 already acknowledges this gap. | **Added new `ratchetJson` field on `deals` separate from `bonusesJson`.** Updated capture spec §4.2. |
| Vs-prose synonyms | 14 vs deals use *"g'tee with escalator"* not *"vs"* | LLM extractor contract handles synonyms; structured `dealType` unchanged |
| Recoup-at-deal-time prose | Only 1 vs deal (Coastal Spell) mentions recoups in deal prose | Schema field added defensively; most recoups still arrive at settlement-time |
| Percentage_of_net cap coverage | 100% of 109 deals have both structured `expense_cap` and prose mention | No schema gap |
| Bonus type coverage | All categories in seed (gross_threshold, sellout, attendance_threshold, tier_ratchet) covered by existing `Bonus` union | No additions needed |
| Prose ↔ bonuses_json mismatch | 18 vs deals have bonus prose but empty `bonuses_json` (invisible to engine); 12 have JSON populated but prose silent | LLM extractor detects and surfaces; sealed Deal Sheet aligns both |
| Off-system source references | 23 deals (4.3%) say *"per the deal memo (see email thread)"* | LLM categorically flags as `missing_source` ambiguity |

## 6. Source signals → design choices

Each major design choice maps back to either a transcript quote or a data observation:

| Design choice | Source |
|---|---|
| Deal Sheet as shareable artifact | Sarah: *"a version of the deal we both agreed on, in one place"* |
| Magic link, no agent login | Sarah's friction signal; PLG playbook |
| Two-pane prose ↔ structured w/ provenance | Mariana: *"every line in my spreadsheet has a sourceable breakdown"*; Sarah: *"provenance"* as one of three trust criteria |
| Soft `stale_unconfirmed` (don't block) | Operational reality (shows go on); Marcus: *"if we could see Wednesday..."* |
| Hybrid resolution (booker pre-resolves confident, agent handles rest) | Real negotiation pattern; preserves agent intent on ambiguous fields |
| 8 enumerated ambiguity categories | Coastal Spell + 30-deal mismatch + 23 missing-source pattern |
| Settlement engine is Phase 2 | Honest scope per Pri's *"pick where to start, go deep"*; engine depends on capture's schema additions |
| Capture before engine sequencing | Engine on top of ambiguous prose silently picks one interpretation — worse than no engine |
| `deductionOrderJson` as schema field | Coastal Spell ambiguity literally had no schema home |
| `ratchetJson` separate from `bonusesJson` | Pressure test; dealMath.ts:248-252 comment |
| Schema migration as Step 1 (separate from capture or engine) | Allows parallel build of capture (writer) and engine (reader) against stable contract |
| BYOK LLM keys in venue settings | Standard vertical-SaaS pattern; clean cost attribution; no Greenroom-side billing complexity; Greenroom-managed keys is Phase 2 alternative |
| Unsettled-shows backfill in Phase 1, already-settled deferred | Unsettled shows still have operational value (artist not yet paid); already-settled doesn't, only matters for dispute-rate measurement |

## 7. Decisions made so far

| # | Decision | Rationale |
|---|---|---|
| ~~D1~~ | **Revised.** Originally: "slice the capture work, not the engine, for Phase 1." Now: **capture AND engine are both in Phase 1**, sequenced as schema-first → capture+engine in parallel (per capture spec §2.1). Reason for revision: shipping capture without engine leaves Mariana in her spreadsheet for another quarter — the 82% bypass number doesn't move. | Trust is still built upstream; sequencing keeps capture as a hard precondition for honest engine output, but engine doesn't have to wait for capture to be fully adopted before construction can start. |
| D2 | Booker + agent shared workflow (not booker-only or three-way) | Directly delivers Sarah's "we both see the same version"; three-way is scope creep |
| D3 | Paste-into-form entry point (not email forward / PDF) | No infrastructure; ships measurable; email forwarding deferred to Phase 2 |
| D4 | At-booking timing (not pre-show / Wednesday-scan) | Maximum prevention value; agent most willing to clarify on fresh deals |
| D5 | Hybrid handoff (booker pre-resolves, agent handles open) | Natural negotiation pattern; preserves agent intent where it matters |
| D6 | Deal Sheet is the artifact; `deals` table becomes derived view | Sarah's "in one place" requires a document, not a row |
| D7 | Soft `stale_unconfirmed` with single 3-day nudge | Avoids spam; preserves agent goodwill; show progress never blocked |
| D8 | Schema migration first, capture + engine in parallel | Schema is the contract between writer (capture) and reader (engine) |
| D9 | `ratchetJson` is its own schema field, not extension of `bonusesJson` | Ratchets replace percentage, not add to it |
| D10 | Magic link with 14-day TTL, signed token, no agent account | Adoption requires zero friction for agents |
| D11 | BYOK (bring-your-own-key) LLM model for Phase 1; venue-scoped key in new `venue_llm_settings` table | Clean cost attribution; no Greenroom-side billing complexity; standard vertical-SaaS pattern. Friction acknowledged but acceptable for Phase 1. Greenroom-managed keys deferred to Phase 2 (see capture spec §11.6). |
| D12 | LLM-key configuration gated to GM + booker roles | Sensitive credential; matches accountability for deal terms; production + box_office excluded |
| D13 | Backfill scope split: unsettled-shows backfill is in Phase 1, already-settled backfill is Phase 2 | Unsettled shows have operational value (artist hasn't been paid, terms still matter); already-settled has no operational value, only measurement value. Avoids burning LLM cost on data nobody acts on. |
| D14 | Phase 2 managed-keys ships paired with token usage on customer billing | Makes managed-keys a billing-integration project rather than a key-management one. Gates on billing infra readiness, not BYOK adoption percentage. |
| D15 | Backfill is manually triggered from venue settings with cost estimate, not auto-run on migration | First surprise LLM bill destroys trust. GM keeps the kickoff decision. |
| D16 | Engine bundled into Phase 1 (capture+engine, sequenced via schema-first) | Capture without engine = Mariana stays in her spreadsheet. Schema-first sequencing makes the two parallelizable; either is releasable independently behind feature flags. |
| D17 | Engine refuses to silently default (`linesSkipped`, `dealTermsConfirmed`) | Prime directive (capture spec §1.1) operationalized in engine code. Better to surface a gap than to compute a fake-confident number. |
| D18 | Bonus `stacks` defaults to false when absent (Q5) | Conservative direction of error: defaulting to true silently overpays artists. Extractor flags genuinely stacking deals so confirmation resolves. |
| D19 | Recoup precedence: settlement-time canonical, never stacks with deal-time (Q4) | Data-integrity rule: a recoup is one real obligation. Double-deducting = silent math error. |
| D20 | Engine runs on unsealed deals; flags `dealTermsConfirmed: false` (Q10) | Hard-blocking pushes Mariana back to her spreadsheet. The system should always be useful AND honest about confidence — never obstructive. |
| D21 | Approved-expenses filter; `pendingExpenses` surfaced separately (Q9) | Direct from Mariana's transcript on Wednesday-vs-Friday expense gap. Pending state stays visible without muddying the headline number. |
| D22 | `deductionOrderJson` uses capped_bucket schema (Q7) | The architectural crux. Flat ordered lists can't express cap-membership; capped_bucket makes the Coastal Spell readings representationally distinct. |
| D23 | `ticket_sales.source` enum (Q2) for door-deal support | Future-proofs against mixed-channel shows; small migration; existing rows backfill as `"advance"`. |
| D24 | `tier_ratchet` bonus type deprecated; ratchets move to `ratchetJson` | `dealMath.ts:248-252` comment already acknowledges the schema mismatch. Migration moves existing rows where structurally possible; flags otherwise. |

## 8. Open questions (cross-slice)

| # | Question | Affects |
|---|---|---|
| Q1 | Should the LLM see prior deals from the same agent for context? | Capture (extraction quality vs. privacy of pattern) |
| Q2 | LLM call cost per deal × scale — caching strategy? | Capture |
| Q3 | Confidence threshold for flagging ambiguity (0.85? 0.80?) | Capture (tunes "useful" vs. "annoying") |
| Q4 | Should Mariana be allowed to "venue-only seal"? | Capture (real workflow vs. clean state model) |
| Q5 | Localization — Spanish/French deal emails | Capture (deferred to Phase 2 explicitly) |
| ~~Q6~~ | **Resolved.** Two-layer model: deal-level `compCountingRulesJson` declares intent and populates per-row defaults; per-row `comps.countsTowardGross` records reality; engine reads per-row. Deal-level rules layer deferred to Phase 2 (per spec §11 item 9) unless per-row drift becomes a production problem. | — |
| ~~Q7~~ | **Resolved.** Add `source` enum to `ticket_sales` (advance / door / platform_credit). See capture spec §4.8. Existing 537 rows backfill as `"advance"`. | — |
| ~~Q8~~ | **Resolved.** Settlement-time `recoupsJson` is canonical at settlement; initialized from deal-time `recoupsAtDealTimeJson`; edits diverge but never stack. Stated as a data-integrity rule: one obligation, never double-deducted. See capture spec §7.6.3. | — |
| ~~Q9~~ | **Resolved.** Aggregated by default with itemized drill-down on click. Engine return shape carries `steps[]` with `sourceType` + `sourceId` per line so the UI can render either view. | — |
| ~~Q10~~ | **Resolved.** Settlement-time recoups not pre-declared are accepted but flagged in the worksheet for explicit GM sign-off. Engine handles them; capture spec doesn't currently cover the post-seal flow (Phase 2 follow-on if it becomes common). | — |
| ~~Q11~~ | **Resolved.** BYOK is the Phase 1 architecture; Phase 2 adds Greenroom-managed keys paired with token usage on customer billing. Not adoption-threshold driven — gated on billing-integration readiness. | — |
| ~~Q12~~ | **Resolved.** Backfill is manually triggered from §5.4 venue settings with a cost estimate before kickoff. Auto-running rejected (surprise LLM costs destroy trust). | — |

## 9. Out-of-scope across both slices

These are deferred together — neither capture nor engine touches them:

1. **Advance documents** (Pri's second sore point — 5-15 page tour PDFs)
2. **Sponsor reporting** (Pri's third sore point — 6-8 hrs/sponsor/quarter)
3. **Sponsor revenue accounting** in settlements
4. **Multi-venue rollups** (one venue at a time)
5. **Mobile-first UX** (assumes desktop for the booker; agent magic link works on mobile)
6. **Real-time co-editing** (Deal Sheet is asynchronous — booker proposes, agent confirms, no Google-Docs-style cursor sync)
7. **PDF generation of sealed Deal Sheets** (Phase 2 — agents will want a downloadable PDF)
8. **Integration with WME / CAA back-office systems** (out — they don't have public APIs)

## 10. Document index

All artifacts produced for this case study live in `docs/superpowers/specs/`:

| Doc | Purpose |
|---|---|
| [2026-05-21-llm-deal-capture-design.md](./2026-05-21-llm-deal-capture-design.md) | **Primary spec.** Full design for both halves of Phase 1 (capture AND engine). Highlights: prime directive (§1.1), sequencing within Phase 1 (§2.1), pressure-test findings (§4.2.1), BYOK venue-settings schema (§4.7) + UI (§5.4), `ticket_sales.source` migration (§4.8), and the full settlement engine design including capped-bucket waterfall (§7). |
| [2026-05-21-extractor-system-prompt.md](./2026-05-21-extractor-system-prompt.md) | **DRAFT v1 system prompt** for the LLM extractor — for review before wiring into the extraction module. Encodes the three priority goals (extract / flag / question), the 8 ambiguity categories, the prime directive ("when in doubt, don't silently cost the venue money"), three worked examples including Coastal Spell, and the stub-mode fallback shape. |
| [2026-05-21-engine-scope-sketch.md](./2026-05-21-engine-scope-sketch.md) | **SUPERSEDED.** Original Phase-2 sketch for the engine. Replaced by §7 of the capture spec when engine was bundled into Phase 1. Preserved for historical context. |
| [2026-05-21-cross-slice-inventory.md](./2026-05-21-cross-slice-inventory.md) | This doc. Single-page reference for the PRD memo. |

## 11. Suggested PRD memo structure

Drawing from these docs:

1. **Problem** (1 page) — Pri's "winning on completeness, losing on craft" + 82% bypass + Coastal Spell as the canonical failure
2. **The slice** (0.75 page) — both halves: Deal Sheet capture (clean structured terms) + settlement engine (math that consumes them). Why bundling them is the right call.
3. **Capture design** (1 page) — actors, two-pane UX, ambiguity-flagging mechanic, sealed artifact, agent magic link, BYOK + stub fallback
4. **Engine design** (0.75 page) — what it computes now that it didn't (vs, pct-net, door, walkout, ratchet); the capped-bucket waterfall as the Coastal Spell solution; refuses-to-silently-default behaviors
5. **Sequencing within Phase 1** (0.5 page) — schema migration → capture+engine in parallel → A/B against Mariana's spreadsheet
6. **What I'm not building** (0.5 page) — advance docs, sponsor reporting, three-way confirm, email-forward, Greenroom-managed keys, already-settled backfill; brief rationale per item
7. **Risks and validation** (0.5 page) — extraction quality, engine-vs-spreadsheet parity, adoption, dispute-rate measurement, the Coastal Spell test
8. **Appendix** — pressure-test findings; cross-slice inventory pointer; the extractor system prompt as an artifact

This memo can be 4-5 pages without padding. The crux to highlight prominently: **the capped-bucket schema in `deductionOrderJson` is what makes the Coastal Spell dispute representationally impossible to silently repeat.** Other features support the use of that schema; that schema is the load-bearing fact.
