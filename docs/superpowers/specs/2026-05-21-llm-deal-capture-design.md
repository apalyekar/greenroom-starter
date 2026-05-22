# Deal Sheet capture + Settlement engine — Phase 1 spec

**Status:** Draft design
**Date:** 2026-05-21
**Author:** Amey (PM case study)
**Slice owner:** Settlement craft bet, Q1 2026 (per Pri's memo)

---

## 1. Problem

Settlement is failing for one upstream reason: **the deal terms are never captured as a shared, unambiguous artifact.** The structured fields in `deals` are filled inconsistently, the truth lives in `dealNotesFreetext`, and that prose is itself a paraphrase of an email the agent wrote at 11pm. When ambiguity surfaces at 2am during settlement, there is no canonical version to fall back to.

The Coastal Spell dispute (March 2025) is the prototype: an 80-word deal email with the sentence *"expenses capped at $2,500, marketing recoup of $900 against gross"* — readable two different ways — that cost The Crescent $720 and several days of agent goodwill. Mariana's note after the fact: *"there's no version of the truth in our system. It's just in her head and ours."*

This slice closes that gap at the moment the deal is born, not at the moment it's settled.

### What the data says

Across 537 deals (24-month synthetic seed):

- **100% have parseable prose** in `dealNotesFreetext`. Even short flat-deal prose extracts cleanly.
- **~10–15% of vs deals (30 of 195) have a prose-vs-`bonuses_json` mismatch** — bonuses described in prose but missing from the structured field, or vice versa.
- **23 deals (4.3%) point to off-system sources** ("see the email thread", "per the deal memo") — the prose itself defers to documents Greenroom doesn't hold.
- **The Coastal Spell row exists in the data** with a retroactive note acknowledging the dispute. It is not unique. The pattern is structural.

The structured `dealType` field is reliable (only 1 miscategorization across 537), but `dealType` is the *category*, not the *terms*. The terms are where the disputes live.

## 1.1 Prime directive (applies to capture AND settlement engine)

> **Every component in this slice computes from explicit structured terms and never guesses silently. When the source does not pin something down, the system surfaces it rather than assuming.**

This is the load-bearing rule for both the LLM extractor and the settlement engine. It cashes out concretely in many places:

- The extractor *omits* a structured field rather than picking an interpretation; it adds an `ambiguity` instead (§6).
- The engine *refuses to compute* a line it doesn't have unambiguous inputs for; it surfaces the gap in the result (§7).
- Bonus stacking defaults to **off** when ambiguous (a stacking deal must be explicitly declared); a silent default to "on" would silently overpay artists (§4.2 `bonusesJson` notes).
- Recoup placement defaults to **flagged**, not picked, when the prose is unclear (Coastal Spell class).
- The engine returns `dealTermsConfirmed: boolean` rather than refusing to run on unsealed deals — useful and honest beats obstructive (§7).

When the prime directive conflicts with making the tool look more capable than it is, the prime directive wins. The product's reason to exist is that *the existing system silently guesses and gets caught at 2am.* Repeating that pattern in a new wrapper would be worse than not shipping.

## 2. Scope of this slice

The slice is two coupled halves: **deal capture** (LLM-driven ingestion that produces clean structured terms) and **settlement engine extension** (math that consumes those terms to settle the deal types Mariana currently uses a spreadsheet for). Both ship within Phase 1, sequenced as described in §2.1.

**In scope — capture half:**

- A new "Deal Sheet" artifact: versioned, shareable, signed by both venue and agent
- LLM extraction of structured terms from pasted deal-email prose
- Categorical detection of common ambiguity classes (see §6)
- Booker-side resolution of confident ambiguities; agent-side resolution of the rest
- Agent-facing shareable view (no Greenroom login required)
- A `sealed` state that becomes the source of truth for downstream settlement
- A `stale_unconfirmed` soft-state with reminder cadence
- Provenance: each structured field traces to a prose span + extraction event
- **Venue-level LLM settings** (API key entry, model selection) — bring-your-own-key model so each venue authenticates against its own Anthropic/OpenAI account. See §4.7 and §5.4.
- **One-time backfill job for unsettled shows.** When the §4.2 schema lands, run a job that processes deal prose for all shows that haven't yet been settled (future shows + past shows still pre-settlement) through the LLM extractor and pre-populates structured fields + flagged ambiguities. Booker reviews the resulting Deal Sheets like any other. Scope: ~30 future shows + however many past shows remain in pre-settled states.

**In scope — engine half (see §7):**

- Settlement math for `vs`, `percentage_of_net`, and `door` deal types — the three types currently returning `{ supported: false }` from `lib/dealMath.ts` (62.5% of past deals).
- Vs-deal variants: **walkout pots, ratchets, vs-gross** — using the structured fields (`walkoutJson`, `ratchetJson`, `deductionOrderJson`) produced by capture.
- The capped-bucket deduction waterfall (§4.2) consumed correctly — including the Coastal-Spell-class case where a recoup is inside or outside the expense cap.
- Bonuses applied on top of all supported deal types (the current engine only applies bonuses to `flat` and `percentage_of_gross`).
- Comp counting (`comps.countsTowardGross`) honored at calculation time.
- Recoup application with deal-time → settlement-time precedence (Q4 lock-in).
- `expense_cap` and `hospitality_cap` enforced (currently read from schema but ignored).
- `expenses.approved` filtered (currently included regardless).
- Provenance on every line of `steps[]` (currently no source back-references).
- Engine returns `dealTermsConfirmed: boolean` so the UI can flag preliminary calculations (Q10 lock-in) — the engine runs even on unsealed deals.
- A `ticket_sales.source` enum migration (Q2 lock-in) so door deals can distinguish door-vs-advance receipts.

**Out of scope (explicitly):**

- Inbound email ingestion (forward-to-Greenroom). Paste-only for Phase 1.
- PDF advance document parsing (the CEO memo's second sore point, deferred).
- Three-way confirmation including artist management. Phase 2.
- **Backfill of already-settled historical deals.** Phase 2 — same component, "scan existing prose" mode. The unsettled-shows backfill above is in-scope; rerunning extraction on past-already-paid settlements has no operational value (the artist's been paid) and would burn LLM cost. Useful only for the dispute-rate measurement comparison group, which is itself Phase 2.
- Re-extraction triggered by post-seal renegotiation. Possible via the revision loop, but not the focus.
- Greenroom-managed LLM keys (centralized, billed-into-subscription). Phase 2 consideration — BYOK ships first because it's simpler architecturally; managed keys as an upgrade path if BYOK friction proves costly. See §11 item 2 and §12.6.
- Multi-currency / international tax handling.
- Snapshot-style ticket sales correction handling (current engine assumes additive rows per Q8; an `is_correction` field is noted but not built).
- Multi-venue rollups, sponsor accounting, mobile-first UX, real-time co-editing.

**Why this scope:** Per Pri's memo, the bet is craft, not coverage. This slice picks the *single highest-leverage trust moment* in the deal lifecycle (capture) and ships the engine half that makes capture's output operationally useful, rather than shipping capture and leaving Mariana in her spreadsheet for another quarter. Combined the slice covers both ends of the trust mechanic — the deal terms are unambiguous AND the settlement math is computed from those unambiguous terms. Either half alone would underdeliver.

### 2.1 Sequencing within Phase 1

The capture and engine halves share a contract — the §4.2 schema additions. Capture *writes* those fields from LLM extraction + booker/agent confirmation. Engine *reads* those fields to compute settlement. The dependency runs one way: capture cannot be built on top of engine, but engine can be built against the schema independently once it lands.

Three sequenced steps:

```
Step 1 — Schema migration (small, low-risk PR)
   Ship §4.2 additions (walkoutJson, ratchetJson, deductionOrderJson,
   recoupsAtDealTimeJson) + §4.8 (ticket_sales.source).
   No new tables yet, no behavior change yet.

Step 2 — Capture and Engine in parallel
   Capture team: LLM ingestion (§5.1 booker view, §5.2 agent view, §5.4
     settings), new tables (deal_terms_extraction, deal_ambiguities,
     deal_confirmations), prompt iteration (§6 + extractor-system-prompt doc).
   Engine team: vs / percentage_of_net / door handlers + walkout + ratchet +
     deduction waterfall (§7), provenance on steps[], dealTermsConfirmed flag,
     removal of dead tier_ratchet branch.

Step 3 — Both ship behind feature flags; A/B against Mariana's spreadsheet
   Engine computes settlement for past shows that have been settled in the
   spreadsheet. Compare results within $1 on a hand-labeled set. Capture
   prompts iterate against extraction-quality regression suite. Switch fully
   when both halves clear validation (§7.10).
```

This sequencing has three nice properties:

1. **The schema is the contract.** Once Step 1 ships, capture and engine cannot drift; they're both speaking the same data structure. The §4.2 design has been pressure-tested against the 195 vs deals in the seed (see §4.2.1).
2. **Either half is releasable independently.** If engine ships first, the in-app tool works for new structured-and-sealed deals (low denominator initially but growing) — Mariana opts in deal-by-deal. If capture ships first, sealed Deal Sheets accumulate and the engine ships into a pre-populated dataset.
3. **The "wrong order" is also impossible to silently choose.** If someone builds the engine without the schema, it has to read `dealNotesFreetext` directly — which moves the Coastal Spell ambiguity from "2am dispute" to "the engine silently picked one interpretation." That's strictly worse, and the prime directive (§1.1) categorically rules it out. Capture is therefore a hard precondition for honest engine output, even if engine code can be written in parallel.

For dispute-rate measurement (the headline validation metric in §10), the comparison group is "shows settled via the engine on sealed Deal Sheets" vs. "shows settled via Mariana's spreadsheet on prose." Both populations exist once Step 3 starts; meaningful signal accumulates over 2 quarters.

> Note: an earlier draft of this spec deferred the engine work to Phase 2 and described it in [engine-scope-sketch.md](./2026-05-21-engine-scope-sketch.md). That sketch is now superseded by §7 of this spec. The sketch is preserved as a reference for the original scope but is no longer the canonical engine design.

## 3. Actors and core flow

Five participants:

1. **Mariana (booker)** — initiates the extraction, pre-resolves confident ambiguities, sends to agent
2. **LLM extractor** — produces structured terms, ambiguity flags, provenance, confidence
3. **Greenroom system** — persists state, generates magic links, sends notifications, computes Deal Sheet versions
4. **Agent (Sarah / Andrea / etc.)** — opens magic-link view, answers open ambiguities, confirms
5. **The Deal Sheet** — the versioned artifact; the `deals` table becomes a derived view of the currently-sealed Deal Sheet

### State machine

```
[no deal]
   │  paste email → click "Extract terms"
   ▼
[extracted_draft]                        LLM run #1 written; ambiguities flagged
   │
   │  Mariana resolves confident-ambiguities; clicks "Send for confirmation"
   │  (this click IS the venue-side confirmation event — writes a
   │   deal_confirmations row with party=venue)
   ▼
[pending_agent_confirmation]             magic link generated (signed, 14-day TTL)
   │                                     auto-nudge sent at 3d if no link open
   │
   ├── Agent never opens link in 7 days ──▶ [stale_unconfirmed]
   │
   │  Agent opens link
   ▼
[in_review_by_agent]                     review timestamp captured
   │
   ├── Agent answers + confirms ───────▶ [sealed]
   │
   ├── Agent edits a resolved field ───▶ [revision_proposed]
   │       │
   │       └── back to [in_review_by_agent] until convergence
   │
   └── Agent opened but inactive 7 days ──▶ [stale_unconfirmed]

[stale_unconfirmed]
   │  Show can still progress; UI flags everywhere
   │  No further auto-nudges (avoid spamming agent); booker-initiated resend only
   │
   └──▶ back to [pending_agent_confirmation] on resend (new TTL)

[sealed]
   │  Structured fields frozen as canonical for settlement
   │  Deal Sheet URL becomes shareable reference
   │
   ├── Renegotiation ──▶ [revision_proposed] → new sealed version (v2, v3, ...)
   │
   └── Settlement reads sealed terms (no more 2am "what did the email say")
```

### Notes on the soft-unconfirmed state

The default is **not to block**. A show with unconfirmed terms can still be advanced, sold, and run. But every downstream surface (show detail, settlement worksheet) shows an "Agent has not confirmed deal terms" banner with a one-click resend. The cost is visibility, not workflow lock. Bookers can override the banner by attaching a note ("agent verbally confirmed, follow-up pending") — that becomes part of the audit trail.

This matches Marcus's transcript: *"if we could see Wednesday this deal is going to have an ambiguous expense fight."* The unconfirmed state IS the Wednesday signal.

## 4. Data model changes

The existing `deals` table is preserved and extended. Four new tables, two sets of column additions to `deals`, and one cross-cutting concern (magic-link tokens):

### 4.1 Extensions to `deals` (provenance and confirmation columns)

```ts
deals += {
  termsSource: "manual" | "llm_extracted" | "llm_extracted_then_edited",
  currentExtractionId: string | null,         // FK to deal_terms_extraction
  currentDealSheetVersion: integer,           // 1, 2, 3...
  termsConfirmedByVenueAt: timestamp | null,
  termsConfirmedByAgentAt: timestamp | null,
  termsSealedAt: timestamp | null,
}
```

### 4.2 Schema fields to express variants the current model can't (load-bearing)

The current `deals.bonusesJson` can express bonuses but not waterfalls, recoup placement, or ratchets. Four additions (one more than originally proposed — see pressure-test findings below):

```ts
deals += {
  walkoutJson: string | null,                 // walkout pot definition
  ratchetJson: string | null,                 // percentage-replacement schedule (NEW)
  deductionOrderJson: string | null,          // explicit deduction waterfall
  recoupsAtDealTimeJson: string | null,       // recoups declared at deal time
                                              //   (separate from settlements.recoupsJson
                                              //    which captures post-show lifecycle)
}
```

`walkoutJson` shape: `{ basis: "gross"|"net", breakevenFormula: "guarantee+expenses"|"guarantee_only"|null, potThreshold: number|null, artistShareAbove: number }`.

**Both `breakevenFormula` and `potThreshold` are nullable.** Pressure-test on the seed data found that 16 of 32 walkout deals (50%) say *"walkout above breakeven"* without specifying the formula. Forcing a default would silently impose one interpretation; nullable + ambiguity-flag preserves the truth that the deal email was unclear. The 12 deals that say *"walkout pot: 100% of gross above $X"* populate `potThreshold`; the 16 deals that say *"after breakeven on guarantee + expenses, all incremental gross goes to artist"* populate `breakevenFormula`. The ambiguous ones populate neither and live as an open ambiguity until the agent clarifies.

`ratchetJson` shape (NEW — not in original spec): `{ basePercentage: number, basis: "gross"|"net", tiers: [{ triggerType: "capacity_pct"|"gross_amount"|"attendance"|"net_amount", triggerValue: number, newPercentage: number }] }`.

**Why this is separate from `bonusesJson`.** The existing `Bonus` union has a `tier_ratchet` type, but it models ratchets as additive bonuses (an amount added on top). Ratchets actually *replace* the percentage at thresholds — the artist's split goes from 85% to 95% over 80% capacity, not "85% plus a bonus." `lib/dealMath.ts:248-252` literally has a comment acknowledging this gap: *"Tier ratchets fundamentally change the percentage structure... not yet handled."* Pressure-test found 27 vs deals (14% of vs) need this. Multi-tier ratchets exist (13 of 25 ratchet deals have multiple tiers), so `tiers` is an array.

`deductionOrderJson` shape: **the crux of the build.** A flat ordered list of named deductions cannot express the Coastal Spell ambiguity, because being "inside the expense cap" is *membership in a group*, not just a position in an order. The schema therefore uses an ordered list where one element can itself be a **capped bucket** — an explicit set of line items that count against an expense cap, with anything outside the bucket deducted separately regardless of position.

```ts
type DeductionStep =
  | { kind: "line_item";
      id: string;
      ref:
        | { type: "fees" }
        | { type: "recoup"; recoupId: string }
        | { type: "expense_categories"; categories: ExpenseCategory[] }
        | { type: "all_expenses_except_recoups" }
    }
  | { kind: "capped_bucket";
      id: string;
      capRef: "expenseCap" | "hospitalityCap";    // pointer to the deal-level cap field
      members: DeductionStep[];                   // line items INSIDE this cap
    }
  | { kind: "apply_percentage"; basis: "gross" | "net" };

type DeductionOrder = DeductionStep[];
```

**`DeductionStep` is exported from `db/schema.ts`** alongside the existing `Bonus` and `Recoup` helper types. Both the capture writeback (`lib/extraction/writeback.ts`) and the settlement engine (`lib/dealMath.ts`) import from the schema module so the shape stays single-sourced. The column itself is stored as `text` and parsed via `JSON.parse(deal.deductionOrderJson) as DeductionStep[]`.

**The Coastal Spell ambiguity now has two clean, distinguishable representations:**

Reading 1 — marketing recoup **inside** the cap (Andrea's read; the one that won):
```json
[
  { "kind": "line_item", "id": "fees", "ref": { "type": "fees" } },
  {
    "kind": "capped_bucket",
    "id": "venue_expenses",
    "capRef": "expenseCap",
    "members": [
      { "kind": "line_item", "id": "expenses", "ref": { "type": "all_expenses_except_recoups" } },
      { "kind": "line_item", "id": "marketing_recoup", "ref": { "type": "recoup", "recoupId": "rec_001" } }
    ]
  },
  { "kind": "apply_percentage", "basis": "net" }
]
```

Reading 2 — marketing recoup **outside** the cap (Mariana's read):
```json
[
  { "kind": "line_item", "id": "fees", "ref": { "type": "fees" } },
  { "kind": "line_item", "id": "marketing_recoup", "ref": { "type": "recoup", "recoupId": "rec_001" } },
  {
    "kind": "capped_bucket",
    "id": "venue_expenses",
    "capRef": "expenseCap",
    "members": [
      { "kind": "line_item", "id": "expenses", "ref": { "type": "all_expenses_except_recoups" } }
    ]
  },
  { "kind": "apply_percentage", "basis": "net" }
]
```

These produce different totals AND a human can read them as visibly different structures. **This representational unambiguity is what proves the slice actually solves Coastal Spell** — not "we built a smarter UI," but "the deal terms now have a schema in which the dispute couldn't have happened, because the two readings are different objects in the data."

For the memo: this is worth calling out as the architectural crux. Every other feature in the slice supports the use of this schema; this schema is the load-bearing fact.

`recoupsAtDealTimeJson` shape: same as the existing `settlements.recoupsJson` but with explicit placement (`relativeTo: "gross"|"net"`, `insideExpenseCap: boolean`). The settlement-time recoups default to these but can be amended. **Note:** pressure-test found only 1 vs deal in the seed has explicit deal-time recoup language (Coastal Spell itself). Most recoups appear at settlement-time. This field is defensive — populated when prose mentions recoups, empty otherwise. The value of declaring at deal time is precisely *because* it forces the placement question upstream.

### 4.2.1 Pressure-test summary

These additions were stress-tested against all 195 vs deals. Findings:

| Concern | Result |
|---|---|
| Walkout schema coverage | Splits 50/50 between explicit and ambiguous; nullable fields + LLM ambiguity flag handle both |
| Ratchet schema coverage | **Original spec missed this** — added `ratchetJson` after finding `bonusesJson.tier_ratchet` is structurally wrong |
| Deduction-order coverage | Sparse in deal-time prose (1 deal), heavily exercised at settlement time — schema field is the upstream lock-in |
| Recoup placement coverage | Same as deduction-order — defensive |
| Vs-synonym coverage | LLM contract must recognize "g'tee with escalator", "whichever greater", "vs" as the same structure (14 vs deals use the escalator phrasing) — handled in LLM contract (§6), not schema |
| Bonus type coverage | Existing `Bonus` union covers all categories observed in seed |
| percentage_of_net coverage | 100% of 109 deals have both structured cap and prose-mentioned cap; no gap |

### 4.3 New table: `deal_terms_extraction`

One row per LLM extraction attempt. Append-only; supersedes form a history.

```ts
deal_terms_extraction = {
  id: string,
  dealId: string,                             // FK
  version: integer,                           // 1, 2, 3...
  sourceText: text,                           // prose the LLM read
  sourceArtifacts: text,                      // JSON array of refs to attached source docs
  extractedJson: text,                        // structured terms produced
  modelVersion: text,                         // for audit (e.g., "claude-sonnet-4-6-2026")
  promptVersion: text,                        // pinned prompt template version
  extractedAt: timestamp,
  confidence: real,                           // 0-1, aggregated across fields
  status: "draft" | "pending_confirmation"
        | "confirmed" | "superseded" | "rejected"
}
```

### 4.4 New table: `deal_ambiguities`

One row per flagged ambiguity. **This is where the value lives** — the questions Mariana would have wanted to email the agent on Wednesday.

```ts
deal_ambiguities = {
  id: string,
  dealId: string,                             // FK
  extractionId: string,                       // FK
  category: "recoup_placement" | "percentage_basis"
          | "expense_cap_scope" | "bonus_threshold_basis"
          | "comp_counting" | "deduction_order"
          | "missing_source" | "stale_structured_field" | "other",
  proseSpan: text,                            // the offending text
  proseSpanStart: integer,                    // for highlighting in UI
  proseSpanEnd: integer,
  question: text,                             // human-readable question
  options: text,                              // JSON array of candidate interpretations
  resolution: text | null,                    // chosen option
  resolvedBy: text | null,                    // user_id (venue) or agent contact ref
  resolvedAt: timestamp | null,
  resolutionEvidence: text | null,            // pasted email reply, free-text note
}
```

### 4.5 New table: `deal_confirmations`

One row per confirmation event per party. Sealing requires one venue-side and one agent-side row for the current extraction.

```ts
deal_confirmations = {
  id: string,
  dealId: string,                             // FK
  extractionId: string,                       // FK — pinned to a specific version
  party: "venue" | "agent" | "artist_management",
  contactId: text,                            // user_id or agent_id
  confirmedAt: timestamp,
  confirmationMethod: "in_app" | "magic_link" | "email_reply" | "verbal_logged",
  fieldsConfirmedJson: text | null,           // optional partial confirm; null = all
}
```

### 4.6 Magic link tokens (not a table, but a concern)

The agent-facing view uses a signed JWT-style token with 14-day expiry. Token carries `{dealId, extractionId, role: "agent_review"}` and is delivered via email. No agent account required — Sarah explicitly said the friction of "yet another login" would kill adoption.

### 4.7 New table: `venue_llm_settings`

One row per venue. Holds the venue's bring-your-own-key (BYOK) LLM credentials and model preferences. Required for any LLM extraction to fire — without it, the capture flow falls back to manual structured-field entry with a banner explaining why.

```ts
venue_llm_settings = {
  venueId: text (PK, FK → venues.id),
  provider: "anthropic" | "openai",          // model family selection
  modelId: text,                             // e.g., "claude-opus-4-7"
  apiKeyEncrypted: text,                     // encrypted at rest with app-level key
  apiKeyLastFour: text,                      // for display ("ends in ...a3f9")
  configuredByUserId: text (FK → users.id),
  configuredAt: timestamp,
  lastSuccessfulCallAt: timestamp | null,
  lastFailureReason: text | null,            // "invalid_key" | "rate_limit" | "model_unavailable" | null
  monthlyExtractionCount: integer,           // for venue-side usage visibility
  monthlyExtractionResetAt: timestamp,
}
```

**Storage and security:**
- `apiKeyEncrypted` uses a Greenroom-level encryption key (envelope encryption pattern; key rotation is an operational concern, not a schema one)
- Plaintext API key is never logged, never returned through any API response, never displayed back to the user after entry
- Only `apiKeyLastFour` is shown in the settings UI for verification
- Decryption happens at LLM-call time in a server-only code path

**Permission model:** API key configuration is gated to users with `role IN ("gm", "booker")`. Production and box_office roles cannot read or write LLM settings. The "configuredBy" attribution exists for audit (a venue with rotating staff needs to know who set this up).

### 4.7.1 Stub-mode fallback (BYOK absence handler)

When a venue has no `venue_llm_settings` row, or the configured key has just failed (status flipped to `"invalid_key"` after a real call), the extraction pipeline **does not break**. It falls back to a deterministic stub extractor with the same input/output contract as the real LLM call. The stub:

- Returns a realistic-shaped response (empty `structuredTerms`, one `ambiguities` entry per the prose with `category: "other"`, low `overallConfidence`)
- Sets a top-level `mode: "stub" | "live"` field so callers know they're looking at a fallback result
- Never makes an external API call; safe to run in CI, in seed data, in offline demos

Why this matters: the prose-extraction logic — the pipeline that takes the booker's pasted email, runs the extractor, persists the `deal_terms_extraction` row, surfaces ambiguities, drives the UI — is the load-bearing path. If a missing API key broke that path, every dev environment and every test would also break. The stub mode keeps the *flow* working even when the *intelligence* isn't. In the UI, stub-mode results render with a clear banner ("AI extraction isn't configured for this venue — placeholder data shown") so no one is fooled into thinking the extraction was real.

This is also a graceful first-time experience: a brand-new venue sees the flow render with placeholder data and a "configure your key to get real extraction" CTA, rather than a hard-stop error.

### 4.8 Extension to `ticket_sales` — `source` enum (Q2 lock-in)

Door deals need to distinguish receipts collected at the door from receipts collected through advance sales. The current `ticket_sales` schema has no source/channel field:

```ts
ticket_sales += {
  source: "advance" | "door" | "platform_credit",   // NEW; required on insert
}
```

`"advance"` is the default for backfilled rows (the 537 existing rows are migrated as `"advance"` since the seed has no door-only data). `"door"` is set explicitly by box office at end-of-night when receipts are reconciled. `"platform_credit"` covers complimentary tickets that produced gross via fee-only models (rare; included for future-proofing).

**Why an enum rather than a boolean `is_door`:** future-proofs against mixed-channel shows (advance + door sold for the same event) and against new sale types (platform_credit, promotional). A boolean would have required a second migration the first time a venue did anything fancier than a simple split.

The schema migration also adds a code-comment clarification (Q8 lock-in):

```ts
/**
 * Ticket sales are recorded as ADDITIVE rows — multiple rows per show
 * accumulate. They are NOT snapshots replacing prior rows. Future work
 * may add an `is_correction: boolean` flag if snapshot/replacement semantics
 * become necessary, but Phase 1 assumes additive rows only.
 */
```

No `is_correction` field in Phase 1; the comment exists to prevent future maintainers from assuming snapshot semantics.

## 5. User surfaces

Four surfaces. Described functionally; mockups deferred.

### 5.1 Booker view — `/shows/[id]/deal/capture`

Two-pane layout:

- **Left pane:** the pasted prose, with LLM-extracted spans highlighted. Hover any span → see which structured field it produced.
- **Right pane:** the structured Deal Sheet, organized by section (guarantee, splits, expense cap, recoups, bonuses, walkout, deduction order). Each field shows:
  - The extracted value
  - The confidence (visual indicator, not raw number)
  - "Edit" affordance
  - Provenance link back to its prose span (highlights on hover)

**Ambiguities surface as a separate list at the top:** *"4 questions need answers before this can be sent for confirmation."* Each ambiguity is a card showing the offending prose span, the question, and 2–3 candidate options as radio buttons + a free-text "neither of these" option.

The booker can:
- Resolve an ambiguity she's certain about (pick an option, optionally attach evidence) — this resolution is attributed to her
- Mark an ambiguity as "for agent" — leaves it open for the agent to resolve
- Edit any extracted structured field — flags it as `llm_extracted_then_edited` with diff preserved
- Click **"Send for agent confirmation"** when she's done

When she clicks send, the system generates the magic link, sends the email to the agent on file, and moves the state to `pending_agent_confirmation`. The Deal Sheet URL appears in her view as a copy-able link too (some bookers will want to send via their own channels).

### 5.2 Agent view — `/deal-sheet/[token]`

Same layout as the booker view, but:

- No Greenroom navigation chrome — single-purpose page
- Read-only on resolved-by-venue fields (with hover to see who resolved it and why)
- Editable on open-for-agent ambiguities, with the same option-card UI
- Editable on any structured field (with a "propose change" affordance that flags it for the booker to accept)
- A persistent "Confirm and seal" button at the bottom, disabled until all open ambiguities are resolved
- Plain language explanations of what each section means — the agent is not a frequent Greenroom user

When the agent clicks "Confirm and seal":
- If no fields were edited: state → `sealed` immediately
- If any fields were edited: state → `revision_proposed`, ball back to booker

### 5.3 Show detail — surfacing the Deal Sheet state

On `/shows/[id]`, a new module above the existing deal panel:

- **Sealed:** small badge with sealed date, link to the Deal Sheet
- **Pending agent confirmation:** banner with last-activity timestamp and resend button
- **Stale unconfirmed:** orange banner — "Agent has not confirmed in N days. [Resend] [Override with note]"
- **No Deal Sheet:** prompt to start one — "This deal's terms aren't yet captured as a Deal Sheet"
- **LLM not configured:** soft prompt — "Set up an Anthropic or OpenAI key in venue settings to enable AI-assisted capture" with link to §5.4. Capture still works in manual mode (skip the LLM, go straight to structured form), so this never blocks creating a Deal Sheet.

### 5.4 Venue settings — `/settings/llm`

New page in the existing settings area (gated to GM and booker roles per §4.7 permission model). Sections:

- **Current configuration** — provider badge, model badge, "ends in ...a3f9" key fingerprint, last-successful-call timestamp, monthly extraction count
- **Provider selection** — radio between Anthropic and OpenAI; provider choice drives the model dropdown below
- **Model selection** — dropdown filtered by provider. For Anthropic: claude-opus-4-7 (recommended), claude-sonnet-4-6, claude-haiku-4-5. For OpenAI: GPT-4 family. Each model row shows a brief "best for / cost relative" hint to help the GM pick without becoming an LLM expert.
- **API key entry** — single password-style input. On save: validates the key by making a minimal test call to the chosen provider (low-cost, no actual extraction). Saved only if the test call returns 200. Failure surfaces inline with the provider's error message and suggested fix.
- **Test extraction** — paste-area + "Try it" button that runs an extraction against a synthetic sample deal and shows the result. Lets the GM verify the integration works before relying on it for real deals.
- **Usage** — current-month call count, estimated cost (computed from the provider's published per-token pricing × tokens used; approximate only), link to the provider's dashboard for actual billing
- **Permissions** — show which roles can edit (read-only display of the access policy)
- **Rotation** — "Replace key" button that prompts for the new key, validates it, and atomically swaps. Old key is purged from `apiKeyEncrypted` immediately.

The page is intentionally not chatty. A venue admin should be able to copy a key from their Anthropic dashboard, paste it, test it, and walk away in under two minutes. Documentation links go out to the providers' own docs rather than reproducing them inline.

**What this page does NOT include:**
- Billing or invoicing flows — venues pay providers directly (BYOK model). Greenroom takes no cut.
- Per-user keys. The key is venue-scoped. Multiple bookers at a venue share the configured key.
- Bulk-purchase of LLM credits. That's a Greenroom-managed-key feature, which is Phase 2 (see §11).

## 6. The LLM contract

The extractor is a single LLM call with a structured-output schema. **Provider, model, and API key are resolved per-venue from `venue_llm_settings` (§4.7)** — the call is dispatched against the venue's own Anthropic/OpenAI account. Greenroom proxies the call (so the encrypted key is never sent to the browser), but the cost is borne by the venue. If `venue_llm_settings` is missing or invalid, the extraction request fails fast and the booker falls back to manual structured-form entry.

The extractor receives the prose plus a small context block (venue name, capacity, prior deals with this agent if any). It returns:

```ts
{
  structuredTerms: {                          // partial — only fields it's confident about
    dealType?: "flat" | "vs" | "percentage_of_net" | ...,
    guaranteeAmount?: number,
    percentage?: number,
    percentageBasis?: "gross" | "net",
    expenseCap?: number,
    hospitalityCap?: number,
    bonuses?: Bonus[],
    walkout?: Walkout,
    recoups?: Recoup[],
    deductionOrder?: DeductionStep[],
  },
  fieldProvenance: {                          // per field: which span produced it
    [fieldPath]: { proseSpanStart, proseSpanEnd, confidence },
  },
  ambiguities: Ambiguity[],                   // see categories below
  unparseableSpans: string[],                 // prose the model didn't understand
  missingSourcePointers: string[],            // e.g., "deal email referenced but not provided"
  overallConfidence: number,                  // 0-1
}
```

### Ambiguity categories the extractor must detect

These are the recurring patterns from the data and transcripts. Each has a hard-coded prompt section that asks the model to specifically look for it:

| Category | Example | What the LLM asks |
|---|---|---|
| `recoup_placement` | "marketing recoup of $900 against gross" + "expenses capped at $2,500" | Is the recoup inside or outside the cap? |
| `percentage_basis` | "85% net" with no definition of net | Is net = gross − fees, or gross − fees − expenses? |
| `expense_cap_scope` | "expenses capped at $2,500" | Does this include hospitality, marketing, production? |
| `bonus_threshold_basis` | "+$500 over $20k" | Is $20k gross, net, attendance? |
| `comp_counting` | "all comps count toward gross" | Which comp categories specifically? |
| `deduction_order` | Multiple deductions mentioned with no order | What's the waterfall? |
| `missing_source` | "per the deal memo (see email thread)" | The email isn't attached — request it |
| `stale_structured_field` | Prior structured value disagrees with current prose | Which is current? |

When the model is unsure, it flags rather than guesses. **This is the most important design constraint:** false confidence is worse than no confidence. A wrongly-extracted "95% certain" field that becomes load-bearing for a $11,565 settlement is exactly the Coastal Spell failure mode in a new wrapper.

### Prompt versioning

The prompt template is versioned (`prompt_v1`, `prompt_v2`, ...) and pinned to every extraction. Iteration on the prompt does not retroactively change historical extractions. This is required for audit and for measuring extraction quality over time.

The full DRAFT v1 prompt is in [extractor-system-prompt.md](./2026-05-21-extractor-system-prompt.md) — the source of truth for the prompt itself; this spec is the source of truth for the contract the prompt is held to.

## 7. Settlement engine

### 7.1 What the engine does, and what it refuses to do

The engine is `lib/dealMath.ts`, extended. It takes a deal (with its sealed structured terms, where available), a set of ticket-sales rows, an expense list, comp counts, and a venue capacity. It returns a `SettlementCalculation` describing the money owed to the artist, the line-by-line work, and the engine's own confidence in its result.

The engine **refuses to silently default.** This is the prime directive (§1.1) operationalized:

- If `walkoutJson.breakevenFormula` is `null` because the deal email was ambiguous, the engine **does not** pick `"guarantee+expenses"` as a default. It computes the rest of the settlement, returns a `lineSkipped` for the walkout step, and surfaces the unresolved ambiguity from `deal_ambiguities` in the result so the worksheet can ask the booker to resolve before signing off.
- If `deductionOrderJson` is missing on a deal with both an expense cap and a recoup, the engine **does not** infer an order. Same `lineSkipped` treatment.
- If `bonusesJson` contains a `gross_threshold` bonus with no explicit `stacks` value, the engine treats it as **non-stacking** (Q5 lock-in). When multiple gross_threshold bonuses trigger, only the highest pays unless `stacks: true` is explicit on each.
- If the deal has not been sealed (`termsSealedAt` is null), the engine **still runs**, but returns `dealTermsConfirmed: false` so the UI can render "preliminary settlement — deal terms not yet confirmed by agent" (Q10 lock-in). **Phase 1 note:** since the agent-side magic-link confirmation flow is Phase 2 (per §11), no deal sealed via the capture UI ever reaches `termsSealedAt != null` today. Every fresh-extracted deal stays preliminary by default. The four engine demo deals in the seed (`show_engine_demo_*`) are populated with `termsConfirmedByVenueAt` set directly so the engine has fixtures to exercise both code paths. When magic-link ships, the existing capture state machine writes `termsSealedAt` on agent confirmation — no engine changes required.
- If expenses include rows where `approved = false`, the engine **does not** count them in the headline total. They surface in a separate `pendingExpenses` field (Q9 lock-in) so the UI can show "$X pending approval" without inflating the settlement number Mariana shows the tour manager.

Each of these is a place where the obvious shortcut would silently cost the venue money or silently produce a fake-confident number. The engine prefers to be useful AND honest.

### 7.2 Common math (reworked)

The existing common math at the top of `calculateSettlement` (lib/dealMath.ts:77-85) needs three changes before the new handlers can use it:

```ts
// CURRENT (lib/dealMath.ts):
const grossBoxOffice = sum(ticketSales.gross);
const totalFees      = sum(ticketSales.fees);
const netBoxOffice   = grossBoxOffice - totalFees;   // ← misnamed
const totalExpenses  = sum(expenses where !absorbedByVenue);   // ← also includes unapproved

// REWORKED:
const grossBoxOffice    = sum(ticketSales.gross) + sum(comps.count × comps.faceValue WHERE comps.countsTowardGross);
const totalFees         = sum(ticketSales.fees);
const grossLessFees     = grossBoxOffice - totalFees;       // renamed from netBoxOffice
const rawExpenses       = sum(expenses where !absorbedByVenue AND approved);
const pendingExpenses   = sum(expenses where !absorbedByVenue AND !approved);   // separately surfaced
const cappedExpenses    = applyExpenseCap(rawExpenses, deal.expenseCap, deal.hospitalityCap, expenses);
const tickets           = ticketsSold ?? sum(ticketSales.qty);
const doorReceipts      = sum(ticketSales.gross WHERE source = "door");   // for door deals only
```

Five intentional changes:

1. **`grossBoxOffice` now includes counted comps.** Comps with `countsTowardGross = true` contribute `count × faceValue` to gross. Most deals: this is zero (comps don't count). Vs deals where the agent argued comps DO count: the per-row flag picks them up. (Q6 lock-in.)
2. **`netBoxOffice` renamed to `grossLessFees`.** The old name conflated two meanings — "net of fees" and "net after expenses." For pct-net and vs handlers, "net" specifically means `grossLessFees - cappedExpenses` (Q1 lock-in: definition B, industry standard, what Coastal Spell assumed).
3. **`totalExpenses` split into `rawExpenses` + `pendingExpenses`.** Unapproved expenses don't compute into the settlement number; they surface separately for UI display (Q9 lock-in, traceable to Mariana's transcript: *"half my Wednesday is just chasing down expenses"* — pending approval state is exactly the in-flight Wednesday state).
4. **`cappedExpenses` computed via `applyExpenseCap`.** Pure summation can't honor `expenseCap` and `hospitalityCap` correctly — see §7.4 for the actual algorithm.
5. **`doorReceipts` added for door deals.** Uses the new `ticket_sales.source` enum from §4.8 to distinguish door from advance.

### 7.3 Per-deal-type math

| Deal type | Formula | Notes |
|---|---|---|
| `flat` | `totalToArtist = guaranteeAmount + bonuses` | Unchanged from current engine; bonus-on-flat still works. |
| `percentage_of_gross` | `totalToArtist = grossBoxOffice × percentage + bonuses` | Unchanged. |
| `percentage_of_net` | `net = grossLessFees − cappedExpenses; totalToArtist = net × percentage + bonuses` | NEW. "Net" is unambiguous per Q1 lock-in: gross less fees less capped expenses. |
| `vs` (standard) | `net = grossLessFees − cappedExpenses; totalToArtist = max(guaranteeAmount, net × percentage) + bonuses` | NEW. The `max(...)` is the vs-deal core. |
| `vs` (vs-gross variant) | `basis = grossBoxOffice (counted comps included, before fees); totalToArtist = max(guaranteeAmount, basis × percentage) + bonuses` | NEW. Used when `deal.percentageBasis = "gross"`. Q3 lock-in: pure ticket gross + counted comps at face value, before fees. The extractor flags if prose says otherwise. |
| `door` | `totalToArtist = doorReceipts × percentage` | NEW. Door deals use only door-channel receipts (`source = "door"` from §4.8). Advance sales are not part of the door payout. |

Bonuses (§7.6.1) apply on top of the base totalToArtist for every deal type. The current engine restriction (bonuses only on flat/pct-gross) is removed.

### 7.4 The deduction waterfall — consuming `deductionOrderJson`

This is the heart of the engine extension. The capped-bucket schema (§4.2) is meaningful only because the engine walks it correctly.

```
applyDeductionWaterfall(grossBoxOffice, deal.deductionOrderJson, context):
  running = grossBoxOffice
  steps = []
  
  for step in deductionOrderJson:
    if step.kind == "line_item":
      amount = resolveLineItem(step.ref, context)    // looks up the actual $ amount
      running -= amount
      steps.push({ label: step.id, value: amount, sourceType: step.ref.type, sourceId: ... })
    
    elif step.kind == "capped_bucket":
      // Compute total of MEMBERS, then cap to deal[step.capRef]
      memberTotal = sum(resolveLineItem(member.ref, context) for member in step.members)
      cap = deal[step.capRef]   // e.g., deal.expenseCap
      cappedTotal = min(memberTotal, cap)
      running -= cappedTotal
      steps.push({ 
        label: step.id, 
        value: cappedTotal, 
        cap: cap, 
        overage: max(0, memberTotal - cap),    // surfaced separately — venue absorbs this
        members: [...individual member breakdowns]
      })
    
    elif step.kind == "apply_percentage":
      basis = (step.basis == "gross") ? grossBoxOffice : running
      // For vs deals, the percentage application is wrapped by the max(guarantee, ...) at §7.3
      pctPayout = basis × deal.percentage
      // Engine returns both running and pctPayout; caller applies max() per deal type
      return { running, pctPayout, steps }
  
  return { running, steps }
```

**The capped_bucket is what makes the Coastal Spell case computable in two visibly different ways.**

For Reading 1 (recoup INSIDE the cap):
- `memberTotal = expenses + marketing_recoup = (say) $2,000 + $900 = $2,900`
- `cap = $2,500`
- `cappedTotal = min($2,900, $2,500) = $2,500`
- `overage = $400` (venue absorbs)
- Total deducted from gross before percentage: $2,500

For Reading 2 (recoup OUTSIDE the cap):
- `marketing_recoup` is a top-level `line_item` → deducted as $900
- `bucket.memberTotal = expenses = $2,000` → `cappedTotal = min($2,000, $2,500) = $2,000`
- Total deducted from gross before percentage: $900 + $2,000 = $2,900

Different inputs (the structured `deductionOrderJson`), different outputs ($400 difference on this hypothetical). The schema's job is to make the two readings distinguishable. The engine's job is to walk whichever reading was sealed.

If the deal has an expense cap but `deductionOrderJson` is absent, the engine falls back to a documented default: `[fees, capped_bucket(all_expenses), apply_percentage]` — i.e., all expenses inside the cap, no recoups. **This default is conservative** (no recoups extracted means no recoup deductions; same direction as the Q5 stacks default). If the deal has recoups in `recoupsAtDealTimeJson` but no `deductionOrderJson`, the engine refuses to apply the recoups and surfaces a `deduction_order` ambiguity — better to ask than to silently choose.

### 7.5 Vs variants

#### 7.5.1 Vs-gross

`deal.dealType = "vs"` AND `deal.percentageBasis = "gross"`. The percentage applies to `grossBoxOffice` (with counted comps, before fees, per Q3) rather than to net-after-expenses. Calculated as:

```
basis            = grossBoxOffice
percentagePayout = basis × deal.percentage
totalToArtist    = max(deal.guaranteeAmount, percentagePayout) + bonuses
```

No deduction waterfall is run because the percentage applies to gross directly. Expenses still factor into the venue's *internal* margin reporting but don't enter the artist payout calculation. **Important:** the engine still surfaces `cappedExpenses` and `pendingExpenses` in the return shape so the GM can see them; they just don't enter `totalToArtist`.

#### 7.5.2 Vs + walkout

`deal.dealType = "vs"` AND `deal.walkoutJson` is non-null AND all required walkout fields are populated.

```
1. Run the base vs math → totalToArtist_base = max(guarantee, percentage × net) + bonuses
2. Compute breakeven:
     IF walkoutJson.breakevenFormula == "guarantee+expenses":
        breakeven = deal.guaranteeAmount + cappedExpenses
     ELIF walkoutJson.breakevenFormula == "guarantee_only":
        breakeven = deal.guaranteeAmount
     ELIF walkoutJson.breakevenFormula == null:
        → REFUSE to compute walkout line; surface ambiguity
3. IF walkoutJson.potThreshold is non-null AND walkoutJson.potThreshold > breakeven:
        breakeven = walkoutJson.potThreshold     // explicit threshold overrides formula
4. IF grossBoxOffice > breakeven:
        walkoutShare = walkoutJson.artistShareAbove × (grossBoxOffice - breakeven)
        totalToArtist = totalToArtist_base + walkoutShare
   ELSE:
        totalToArtist = totalToArtist_base
        steps.push({ label: "Walkout", value: 0, note: "Gross did not exceed breakeven" })
```

The `breakevenFormula == null` case is the 50% of walkout deals in the seed that just say *"above breakeven"* without specifying. Refusing to compute is the only honest behavior.

#### 7.5.3 Vs + ratchet

`deal.dealType = "vs"` AND `deal.ratchetJson` is non-null.

```
1. Determine effective percentage:
     sort ratchetJson.tiers ascending by triggerValue
     effectivePct = ratchetJson.basePercentage
     for tier in ratchetJson.tiers:
       actual = (tier.triggerType == "capacity_pct") ? tickets / capacity
              : (tier.triggerType == "gross_amount") ? grossBoxOffice
              : (tier.triggerType == "attendance")   ? tickets
              : (tier.triggerType == "net_amount")   ? net
       IF actual >= tier.triggerValue:
         effectivePct = tier.newPercentage    // REPLACES, doesn't stack
2. Run vs math with effectivePct in place of deal.percentage
3. steps[] records both the base and the effective percentage with a note explaining which tier triggered
```

The "replaces, doesn't stack" is the critical distinction from `bonusesJson.tier_ratchet` (now deprecated — see §7.9). A ratchet doesn't ADD to the payout; it CHANGES the percentage applied.

### 7.6 Cross-cutting features

#### 7.6.1 Bonuses

Extended to apply on every supported deal type, not just `flat` and `percentage_of_gross`. `applyBonuses()` is called after the base totalToArtist is computed. Stacking semantics:

- `gross_threshold` bonuses: when multiple trigger, **only the highest pays** unless `stacks: true` is set on every triggering bonus (Q5 lock-in). The engine surfaces non-paying triggers in `bonusesNotTriggered` with an explanatory note (`"Outranked by higher-tier bonus that also triggered"`).
- `sellout` and `attendance_threshold` bonuses: always pay when triggered; not subject to stacking rules.
- `tier_ratchet` bonus type: **deprecated and ignored** by the engine after this slice (see §7.9). New deals use `ratchetJson`.

#### 7.6.2 Comps that count toward gross

Per-row `comps.countsTowardGross` is consulted at common-math time (§7.2). When `true`, the comp's `count × faceValue` is added to `grossBoxOffice` before any percentage applies. Per Q6 lock-in, the per-row flag is the source of truth; deal-level `compCountingRulesJson` (if added later) declares intent and populates per-row defaults but doesn't override per-row reality.

#### 7.6.3 Recoup precedence (Q4 lock-in)

A recoup is a single real obligation. Double-deducting it would be a silent math error — exactly the failure mode this slice exists to prevent.

- **At deal time:** `deal.recoupsAtDealTimeJson` declares the recoup as part of the sealed deal.
- **At settlement time:** `settlements.recoupsJson` records the recoup's lifecycle (agreed/disputed/withdrawn) and the actual amount applied.
- **Precedence:** `settlements.recoupsJson` is canonical at settlement time. It is initialized from `deal.recoupsAtDealTimeJson` on first calculation. Subsequent settlement-time edits diverge from the deal-time record but never stack with it. The engine reads from `settlements.recoupsJson` exclusively; `deal.recoupsAtDealTimeJson` is consulted only to initialize, never to re-apply.

This is a data-integrity rule, not a tradeoff. Stating it that way (per your framing) is correct: a recoup is one real obligation, double-deducting it is exactly the kind of silent error that destroys agent trust.

#### 7.6.4 Approved-expenses filter (Q9 lock-in)

```
rawExpenses     = sum(expenses where !absorbedByVenue AND approved == true)
pendingExpenses = sum(expenses where !absorbedByVenue AND approved == false)
```

`pendingExpenses` is surfaced separately in the return shape. The UI shows it as a "Pending approval: $X" line on the worksheet — visible but not computed into the headline number.

Direct from Mariana's transcript: *"If you could just have all the expenses ready when I sat down to settle, that alone would change my life."* The pending state IS the Wednesday-vs-Friday gap. The engine cannot make pending expenses arrive faster, but it can make their absence honest rather than silently muddying the settlement number. **Worth calling out in the memo as a design choice driven directly by user research.**

#### 7.6.5 Cap enforcement

`applyExpenseCap(rawExpenses, expenseCap, hospitalityCap, expenseList)`:

```
hospitalitySubtotal = sum(e.amount for e in expenseList where category == "hospitality" AND approved AND !absorbedByVenue)
otherSubtotal       = rawExpenses - hospitalitySubtotal
cappedHospitality   = min(hospitalitySubtotal, hospitalityCap or Infinity)
cappedOther         = min(otherSubtotal, expenseCap or Infinity) - cappedHospitality  
                                                                  // adjust if hospitality is sub-bucket of overall
return cappedHospitality + cappedOther
```

The hospitality cap interacts with the overall expense cap in two ways depending on the deal:
- **Hospitality counts toward expense cap:** the hospitality subtotal contributes to the overall total before the cap is applied. The engine surfaces `hospitalityOverage` and `expenseOverage` separately so the venue knows what it absorbed where.
- **Hospitality is a separate cap:** hospitality has its own ceiling outside the expense cap. The expense cap applies only to non-hospitality.

**Engine default = separate cap.** Most deals use this model in practice (the schema reflects this — `hospitalityCap` is a distinct deal-level field). The engine applies `min(hospitalityActual, hospitalityCap)` outside the deduction waterfall and deducts the result as its own line, regardless of whether `deductionOrderJson` mentions hospitality. **To override and have hospitality count toward the expense cap instead**, the deal's `deductionOrderJson` must explicitly list a hospitality `line_item` as a member of the `capped_bucket` (e.g., `{kind: "line_item", id: "hospitality", ref: {type: "expense_categories", categories: ["hospitality"]}}`). When the engine sees hospitality listed inside the bucket, it does not apply the separate hospitality cap a second time.

If a deal email is ambiguous about the relationship, the extractor flags `expense_cap_scope` (§6) and the engine defers to the booker's resolution.

### 7.7 Return shape — `SettlementCalculation` enrichment

The existing return shape (lib/dealMath.ts:33-52) keeps its `supported: true | false` discrimination but enriches the success branch:

```ts
type SettlementCalculation =
  | {
      supported: true;
      // Existing fields (kept):
      grossBoxOffice: number;
      totalToArtist: number;
      
      // Renamed:
      grossLessFees: number;                  // was: netBoxOffice
      
      // NEW:
      cappedExpenses: number;                 // post-cap, the actual deduction
      rawExpenses: number;                    // pre-cap
      pendingExpenses: number;                // unapproved; surfaced for UI
      doorReceipts: number;                   // for door deals only
      
      // Existing, enriched:
      steps: {
        label: string;
        value: number;
        note?: string;
        sourceType?: "deal_field" | "expense" | "ticket_sale" | "comp" | "bonus" | "recoup" | "computed";
        sourceId?: string;                    // FK back to the source row
      }[];
      finalFormula: string;
      bonusesApplied: { label: string; amount: number; reason: string }[];
      bonusesNotTriggered: { label: string; amount: number; reason: string }[];
      
      // NEW — engine's honesty signals:
      dealTermsConfirmed: boolean;            // is the Deal Sheet sealed?
                                              // Until Phase 2 magic-link agent
                                              // confirmation, this is true only
                                              // for deals seeded with
                                              // termsConfirmedByVenueAt directly.
      linesSkipped: {                         // gaps the engine refused to compute
        label: string;                        // e.g., "Walkout payout"
        reason: string;                       // e.g., "walkout breakevenFormula is null"
        ambiguityId?: string;                 // FK to deal_ambiguities IF the gap
                                              // corresponds to a flagged ambiguity.
                                              // Optional: structural skips
                                              // (deprecated bonus type, null
                                              // deductionOrderJson, capacity
                                              // unknown for ratchet) have no
                                              // ambiguity row — just a reason.
      }[];
      preliminaryConfidence: "high" | "medium" | "low";    // engine's self-rated trustworthiness
    }
  | {
      supported: false;
      reason: string;
      dealType: Deal["dealType"];
    };
```

Provenance on `steps[]` is the operational realization of Sarah's *"every line traceable to a source"* — every number the worksheet shows can be clicked back to where it came from.

`linesSkipped` is the engine's prime-directive cashout in the data model: when the engine refuses to compute something, the refusal is a structured value, not a silent omission. The UI renders these as orange-flagged rows on the worksheet ("Walkout payout: needs agent confirmation on breakeven formula — [Resolve]").

`preliminaryConfidence` aggregates:
- `dealTermsConfirmed == false` → at most `"medium"`
- `linesSkipped.length > 0` → at most `"medium"`
- `linesSkipped.length > 0` AND any line is load-bearing (walkout, percentage application) → `"low"`
- Otherwise `"high"`

### 7.8 Engine failure modes

| Failure | What happens |
|---|---|
| Deal has no sealed Deal Sheet | Engine runs; returns `dealTermsConfirmed: false`. UI shows preliminary banner. Mariana can still settle but the worksheet reads "preliminary." |
| Required structured field is null (e.g., walkout breakeven, deduction order) | Engine computes everything it can; the affected line goes into `linesSkipped` with the ambiguity ID. No silent default. |
| Expenses arrive after first calculation | Worksheet has a "Refresh calculation" button. Recompute is non-destructive (prior `calculationJson` snapshot preserved on the settlement record for audit). |
| `ticket_sales` has multiple rows (per §4.8: additive) | Engine sums correctly; no special case. |
| Engine result differs from Mariana's spreadsheet by >$1 during validation comparison | Logged for investigation; engine does NOT auto-overwrite. Capture-side regression possible (a sealed Deal Sheet had a wrong structured field), or engine bug. |
| Bonus `stacks` field is absent on a `gross_threshold` bonus | Treated as non-stacking (Q5 default). If multiple trigger, only the highest pays. Surfaced clearly in `bonusesNotTriggered` for the non-paying ones. |
| Comp category has `countsTowardGross = true` but `faceValue = 0` | Adds zero to gross. No error. Real-world: comps with zero face value (true freebies) shouldn't be flagged as counting, but if the data says so the engine respects it. |
| Door deal has zero rows where `source = "door"` | `doorReceipts = 0`; `totalToArtist = 0`. UI surfaces "No door receipts recorded" — likely a data entry gap before settling. |
| Sealed deal has `deductionOrderJson` that references a `recoupId` not in `recoupsAtDealTimeJson` | Logged warning; engine treats the reference as a zero-amount step rather than crashing. Caught by validation harness (§7.10). |
| `expense_cap = 0` (vs `null`) | Honored — cap is $0, no expenses deduct. Different from `null` ("no cap"). Worth a comment in the engine code. |

### 7.9 What to remove from current `dealMath.ts`

Three removals as part of this slice:

1. **The dead `tier_ratchet` bonus handler** (lines 243-253). Ratchets are now `ratchetJson` on the deal, handled in §7.5.3. The `Bonus.tier_ratchet` type is deprecated. **Phase 1 engine behavior for the ~27 existing vs deals with `tier_ratchet` bonus entries:** the engine emits a `linesSkipped` row per encountered `tier_ratchet` bonus (`label: "<bonus.label>"`, `reason: "Deprecated bonus type — migrate to ratchetJson; computation skipped"`) rather than silently paying $0 or treating it as additive. The data migration that rewrites these into `deals.ratchetJson` (where structurally possible) and flags the rest for manual review is **Phase 2 deferred work** — listed in §11. This keeps the engine output honest about what it can't compute today.
2. **The "everything else: not supported" empty state** for vs / percentage_of_net / door (lines 171-186). After this slice, all five deal types are supported.
3. **The `netBoxOffice` field name** in the return shape. Renamed to `grossLessFees`; downstream callers must be updated. The capture spec's documentation that referenced `netBoxOffice` is also corrected.

The `parseBonuses()` helper stays. The `applyBonuses()` helper stays, with the `tier_ratchet` branch removed and `stacks` handling added per Q5.

### 7.10 Validation strategy

Two complementary tests:

1. **Hand-labeled regression suite.** Take Mariana's actual settlement spreadsheets for ~30 past shows spanning all deal types and variants (5 flat, 5 pct-gross, 5 pct-net, 10 vs including walkout/ratchet/vs-gross, 5 door). Hand-populate the new structured fields (`deductionOrderJson`, `walkoutJson`, etc.) from her notes. Run the engine. Assert engine's `totalToArtist` matches her spreadsheet to within $1. Any divergence > $1 is either:
   - An engine bug (fix).
   - A real ambiguity in the original deal that she resolved in her spreadsheet by judgment — surface as a `deal_ambiguity` and get her on-record resolution (this is the capture side catching up to her tacit knowledge).
2. **Production A/B behind a feature flag.** When engine ships, every settlement is computed twice: in the engine AND in Mariana's spreadsheet (she keeps doing it as normal during this phase). The engine's result is shown to her as a "compare" view; she settles in whichever she trusts. Engine adoption is opt-in per show during this phase. Aim for parity on 90%+ of shows within the first quarter; flip the default to engine when the parity rate clears 95%.

Headline metric for the slice overall (combining capture + engine): **the dispute rate on shows settled via sealed Deal Sheet + engine should be measurably lower than the comparison group** within 2 quarters post-launch.

### 7.11 Engine open questions

Carried over from §12 (Open questions), narrowed to engine-specific items:

1. **Comp-counting precedence at deal level vs. per-row.** Currently per-row is the source of truth (Q6 lock-in). If venues drift toward inconsistent per-row tagging in practice, may want to elevate `compCountingRulesJson` at deal level to a hard rule rather than a default.
2. **`ticket_sales.source` backfill.** Migration sets all existing 537 rows to `"advance"`. If any past shows were actually door-only and need correction, that's a one-off data fix done by hand. Not a Phase 1 problem unless we discover door-only past shows during validation.
3. **Snapshot vs. additive ticket-sales semantics.** Phase 1 assumes additive (§4.8 comment). If we discover venues using ticket_sales as snapshots in production, the `is_correction` flag becomes necessary; the comment is the warning shot.
4. **Engine code as a server-only module.** Should the calculation be exposed via an API endpoint for the agent magic-link view (so they can pre-review the math) or strictly internal? Likely internal for Phase 1; agent view shows the *sealed deal terms* and the *settlement statement after Mariana's sign-off*, not a live calculation.
5. **Multi-version deal sheets and recomputation.** When a Deal Sheet is renegotiated post-show (rare but possible), does the engine recompute against v2's terms or stay locked to v1's? The current design: settlement is locked to the version sealed at the time of computation, snapshotted in `settlements.calculationJson`. A revision triggers explicit recalculation that the GM signs off on.

## 8. Failure modes and edge cases

| Failure | What happens |
|---|---|
| LLM extracts a field wrong with high confidence | Booker catches it in review. Edit is recorded. The error becomes training signal (logged for prompt iteration). Worst-case: agent catches it on confirm. Both-miss is the residual risk — see §8. |
| Prose is genuinely unparseable | `overallConfidence` low; UI tells booker "extraction quality is poor for this deal — review carefully or enter manually." Manual entry is always available as fallback. |
| Agent never opens the magic link | Single auto-nudge at 3 days. If still unopened at 7 days, → `stale_unconfirmed`. No further auto-nudges (avoid spamming). Booker can resend manually, which generates a new link and resets the TTL. |
| Agent opens link but never confirms | `in_review_by_agent` decays to `stale_unconfirmed` after 7 days of no activity. Same rules from there. |
| Magic link expires before agent acts | Booker can regenerate from show detail; new link, fresh 14-day TTL. |
| Agent edits a field in a way the booker rejects | Loop continues. If it loops more than 3 times, surface a "this isn't converging — take it to email" affordance. Some negotiations belong in human channels. |
| Renegotiation post-seal | Treated as a new version of the Deal Sheet. v1 stays in the audit trail; v2 supersedes. Settlement reads the latest sealed version. |
| Multiple ambiguities of the same category in one deal | Extractor produces one ambiguity per offending span. Booker sees them as separate cards (rather than rolled up) because each needs its own resolution. |
| Email contains attachments (e.g., the actual rider) | Phase 1: ignored, flagged as `missing_source`. Phase 2: PDF extraction. |
| The 23 "see the deal memo" deals where prose defers off-system | Extractor flags `missing_source`. Booker is prompted to paste the deal memo too. Until they do, the Deal Sheet cannot be sealed. |
| No `venue_llm_settings` row (venue never configured a key) | Capture flow loads in manual mode. Banner: *"AI-assisted capture isn't set up — [Configure now] or enter terms manually."* Manual mode is a straight structured-form. No LLM call is made; no charge accrues. |
| API key is invalid / revoked at provider | First failed call writes `lastFailureReason = "invalid_key"` to `venue_llm_settings`. UI surfaces a banner on capture pages: *"Last extraction failed: invalid API key. [Update key]."* Capture falls back to manual mode for the current deal. |
| Provider returns rate-limit error | Single retry with exponential backoff. If still failing, surface to booker: *"AI service is rate-limited — try again in a few minutes or enter manually."* `lastFailureReason = "rate_limit"`. |
| Provider model is unavailable / deprecated | Same flow as rate-limit but with reason `"model_unavailable"`. Banner suggests picking a different model in §5.4 settings. |
| Configured model produces structured output that doesn't match the contract schema | Treated as extraction failure. Logged for prompt iteration. Booker sees "extraction quality is poor — review carefully or enter manually" message (same as unparseable prose). |
| GM rotates the API key mid-extraction | Atomic swap; in-flight extraction completes against the old key (already authenticated); subsequent calls use the new key. No mid-flight failure. |

## 9. Trust mechanics

The Deal Sheet is only worth building if both sides trust it more than the email. Three mechanisms:

1. **Provenance everywhere.** Every structured field hovers to show its source prose span and extraction event. No field is "just there."
2. **Sealed = signed.** The `deal_confirmations` table records who confirmed what and when, including method (in-app, magic link, verbal-logged). The Deal Sheet displays a signature block — "Sealed by Mariana Reyes (The Crescent) and Sarah Kim (WME) on 2026-05-23."
3. **Versions are immutable.** A sealed Deal Sheet v1 stays accessible even after v2 is sealed. This matters for disputes that surface months later ("but we agreed to X" — we can show what was agreed and when).

## 10. Validation strategy (capture-side)

> Engine-side validation lives in §7.10 (hand-labeled regression suite against Mariana's spreadsheets + production A/B). This section covers the capture-side metrics.

How we know the capture half works:

- **Extraction quality** — hand-label 50 historical deals across all 5 deal types. Run the extractor against them. Measure: field-by-field accuracy, ambiguity-detection recall on known-ambiguous cases (the Coastal Spell row should *always* trigger a `recoup_placement` ambiguity), false-confidence rate.
- **Coverage** — fraction of new deals that reach `sealed` within 7 days of paste. Target: 70% in Phase 1, 90% in Phase 2 after iterating on agent UX.
- **Dispute reduction** — over 2 quarters, compare dispute rate on shows with sealed Deal Sheets vs. shows without. The Coastal Spell class of dispute (recoup placement, expense scope, percentage basis) should approach zero on sealed deals. **Combined with engine adoption, this is the headline slice metric.**
- **Time-to-clean-data** — wall-clock time from paste to seal. Lower is better, but not the primary metric (agent latency dominates and is uncontrollable).
- **Booker adoption** — % of new shows that have a Deal Sheet created. If Mariana doesn't reach for it, nothing else matters.

## 11. Explicitly deferred (Phase 2+)

In rough priority order:

1. **Backfill mode for already-settled historical deals.** Same components as Phase 1, "scan existing prose" entry point. Lets past-already-paid deals get cleaned up retroactively, giving us the dataset to measure dispute reduction against. (Note: the *unsettled-shows* backfill is in-scope for Phase 1 per §2 — what's deferred here is the larger scan of shows where settlement has already completed.)
2. **Greenroom-managed LLM keys + token usage on customer billing.** Centralized API key pool, costs bundled into the subscription invoice. Pairs the key-management work with billing integration so they ship together. Optional upgrade from BYOK for venues that find the key-setup friction too high. See §12.6.
3. **Email-forward ingestion.** `bookings@greenroom.app` inbound, automatic association to show by subject-line matching or manual triage.
4. **PDF advance document parsing.** The CEO memo's other sore point. Same LLM pattern, different input shape.
5. **Three-way confirmation including artist management.** Adds CC'd party with view-only role escalating to co-signer where the artist's mgmt is contractually in the loop.
6. **Wednesday pre-show scan.** Auto-runs extractor on the deal prose 5 days before show and surfaces any new ambiguities (e.g., from amendments) for resolution before settlement night.
7. **Agent-side dashboard.** If agents adopt magic links, they'll eventually want a way to see all pending deals from one venue. Not a Phase 1 problem.
8. **Snapshot-style `ticket_sales.is_correction` flag.** Phase 1 assumes additive rows (§4.8); a correction/snapshot semantic ships later if needed.
9. **Deal-level `compCountingRulesJson` field.** Phase 1 uses per-row `comps.countsTowardGross` exclusively (Q6); deal-level rules layer ships if per-row drift becomes a problem in production.
10. **`tier_ratchet` bonus → `ratchetJson` migration.** Phase 1 engine emits `linesSkipped` for the ~27 vs deals in seed that still have `bonusesJson.tier_ratchet` entries (per §7.9). A one-time migration script rewrites those into `deals.ratchetJson` where the tier structure maps cleanly, and flags the rest for manual review. Until that ships, the affected deals settle with the bonus line skipped and surfaced on the worksheet.

## 12. Open questions

1. **Should the extractor see prior deals with the same agent?** A small context window of "here's how this agent has structured deals before" could improve extraction quality but introduces a privacy-of-pattern question.
2. **Cost.** A non-trivial LLM call per deal × ~25 new deals/month/venue × thousands of venues. Under BYOK (this spec), cost is borne by the venue — Greenroom isn't on the hook. Still relevant for venue ROI conversations: if it costs $5/month in LLM calls to prevent one $720 Coastal Spell, the case is strong; if it costs $50/month, less so. Caching identical prose is trivial; otherwise the marginal cost is real. Cache deal-email patterns by agent + agency to reduce.
3. **What if Mariana wants to seal without the agent?** Some bookers will. Maybe an "venue-only seal" with explicit "unconfirmed" badge that persists everywhere. Worth user-testing.
4. **Localization.** Some independent deal emails are in Spanish, French. Phase 1 English-only; flag as out-of-scope explicitly.
5. **The extractor's "I'm not sure" threshold.** Tuning this is the difference between "useful tool" and "annoying tool." Initial calibration: flag ambiguity if confidence on a field is below 0.85, OR if the prose contains any of ~20 known-ambiguous patterns ("against gross", "off the top", "subject to", etc.).
~~6. BYOK vs. Greenroom-managed keys~~ — **Resolved.** BYOK ships in Phase 1; clean architecture, clean cost attribution, no billing complexity to figure out at the same time. Phase 2 path is explicit: Greenroom-managed key pool paired with **token usage added to customer billing** (i.e., LLM costs flow through the existing subscription invoice rather than the venue's separate provider bill). This makes managed-keys a billing-integration project, not a key-management project — the harder work is finance/billing, not LLM. BYOK friction is real and acknowledged; revisiting once the billing infrastructure exists, not on a fixed threshold.

~~7. Unsettled-shows backfill — auto-run or settings-triggered?~~ — **Resolved as settings-triggered.** Backfill runs from a button in §5.4 venue settings ("Run AI extraction across pre-settlement shows — N shows, estimated cost $X"). The GM sees the cost estimate before kicking it off; result review happens in the normal Deal Sheet UI. Auto-running on migration was rejected because the first surprise bill destroys trust in the LLM feature.

## 13. Success criteria for this slice

The slice is successful if, six months in:

- Mariana creates a Deal Sheet for ≥80% of new shows
- ≥70% of created Deal Sheets reach `sealed` within 7 days
- The dispute rate on sealed deals is meaningfully lower than on non-sealed deals (the comparison group exists because backfill is Phase 2)
- At least three external agents have signed a Deal Sheet via magic link without complaint
- Pri can quote a percentage of customers using the Deal Sheet flow in her next quarterly memo

If those hold, the next slice (settlement engine that reads sealed Deal Sheets) becomes the obvious next bet.

---

## Appendix A — Mapping to source signals

For traceability — every design choice should map to something a user said or the data showed.

| Design choice | Source |
|---|---|
| Deal Sheet as a shareable artifact | Sarah: *"a version of the deal we both agreed on, in one place"* |
| Magic link, no agent login | Sarah's friction signal + general SaaS PLG playbook |
| Two-pane prose ↔ structured with provenance | Mariana: *"every line in my spreadsheet has a sourceable breakdown"*; Sarah: *"provenance: I want to be able to trace each line to a source"* |
| Soft `stale_unconfirmed` (don't block show progress) | Operational reality — shows must go on; Marcus: *"if we could see Wednesday this deal is going to have an ambiguous expense fight"* |
| Ambiguity categories enumerated, not free-form | Coastal Spell dispute + 30-deal mismatch finding in `bonuses_json` analysis |
| Settlement engine bundled into Phase 1 (not deferred) | Capture without engine leaves Mariana in her spreadsheet for another quarter — the 82% bypass number doesn't move. Schema-first sequencing (§2.1) makes capture+engine parallelizable. Prior draft of this spec deferred engine to Phase 2; this draft brings it in. |
| Engine refuses to silently default (`linesSkipped`, `dealTermsConfirmed`, refusal to apply unconfirmed walkout) | Prime directive (§1.1). Better to surface a gap than to compute a fake-confident number. |
| Bonus `stacks` defaults to false when absent | Q5 lock-in. Defaulting to stacks=true silently overpays artists when the deal is silent; the conservative direction of error is "don't pay extra unless explicitly told to." Extractor flags genuinely stacking deals so confirmation resolves rather than silent assumption. |
| Recoup precedence: settlement-time wins, never stacks with deal-time | Q4 lock-in. A recoup is a single real obligation; double-deducting is exactly the silent math error that destroys agent trust. Stated as a data-integrity rule, not a tradeoff. |
| Engine runs on unsealed deals with `dealTermsConfirmed: false` | Q10 lock-in. Hard-blocking would break Mariana's day-one workflow and push her back to the spreadsheet. The system should always be useful AND honest about its confidence — never obstructive. |
| Approved-expenses filter; pending expenses surfaced separately | Q9 lock-in. Direct from Mariana's transcript: *"If you could just have all the expenses ready when I sat down to settle, that alone would change my life."* The pending state IS the Wednesday-vs-Friday gap. Engine cannot speed up approvals but it can make pending state honest rather than silently muddying the number. |
| `ticket_sales.source` enum (advance / door / platform_credit) | Q2 lock-in. Door deals need to distinguish door receipts from advance; enum future-proofs against mixed-channel shows where a venue does both. |
| `deductionOrderJson` as a list of steps where one can be a `capped_bucket` | Q7 lock-in — the architectural crux. A flat ordered list cannot express "inside the cap" because cap-inclusion is *membership* in a group, not a position in an order. The capped_bucket schema is what proves the slice actually solves Coastal Spell — the two readings (recoup inside vs. outside the cap) become visibly different JSON objects, computationally distinct. |
| BYOK stub-mode fallback (extraction pipeline never breaks on missing key) | Dev-environment + first-time-experience design. Stub mode keeps the *flow* working when the *intelligence* isn't configured; UI banner ensures no one is fooled into thinking stub data is real. |
| Backfill split: unsettled in Phase 1, already-settled deferred | Unsettled shows still have settlement value (the artist hasn't been paid yet, so terms still matter); already-settled shows have no operational value and only matter for dispute-rate measurement (Phase 2 comparison group). Splitting the scope avoids burning LLM cost on data nobody will act on. |
| `deductionOrderJson` as a schema field | The Coastal Spell ambiguity literally had no schema home before this |
| `recoupsAtDealTimeJson` separate from `settlements.recoupsJson` | Recoups have two lifecycles: declared (at deal) and contested (at settlement). Conflating them is exactly how Coastal Spell happened |
| `ratchetJson` separate from `bonusesJson` | Pressure test against 195 vs deals; existing `tier_ratchet` bonus models additive bonuses but ratchets *replace* the base percentage. `dealMath.ts:248-252` acknowledges this gap. |
| BYOK (bring-your-own-key) LLM model in Phase 1 | Standard vertical-SaaS pattern (Linear, Vercel, etc.); clean cost attribution (venue pays its own LLM bill); no Greenroom-side billing complexity. Friction cost (every venue admin sets up an Anthropic/OpenAI account) is real but acceptable for Phase 1; Greenroom-managed keys is the Phase 2 alternative. |
| Venue-scoped (not user-scoped) API key | Multiple bookers + GMs share a venue and the same LLM workload; per-user keys would multiply cost and config burden without operational benefit. Matches how venue-level settings work elsewhere in the schema. |
| GM + booker roles can configure; production + box_office cannot | LLM key is a sensitive operational credential; gating to roles that are already accountable for deal terms keeps the blast radius small without creating friction for the people who need it. |
