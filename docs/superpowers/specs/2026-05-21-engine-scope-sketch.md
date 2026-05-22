# Settlement Engine — Scope Sketch (SUPERSEDED)

> **⚠ SUPERSEDED.** This sketch was written when the engine work was scoped as Phase 2, deferred from the capture slice. The engine has since been bundled into Phase 1; the canonical engine design now lives in **§7 of [the capture spec](./2026-05-21-llm-deal-capture-design.md)**. This file is preserved for historical context and to show the evolution of the scope decision; it should not be used as the engine design reference.
>
> **Use §7 of the capture spec instead.** That section incorporates everything below plus the Q1–Q10 engine decisions (prime directive, capped-bucket waterfall, bonus stacks default, recoup precedence, approved-expenses filter, `dealTermsConfirmed`, etc.) and the `ticket_sales.source` migration.

---

**Status (original):** Sketch (companion to [Deal Sheet capture spec](./2026-05-21-llm-deal-capture-design.md))
**Date:** 2026-05-21
**Author:** Amey (PM case study)
**Original slice owner:** Settlement craft bet, Q2 2026 (proposed follow-on to capture) — now bundled into Q1

This is a sketch, not a full spec. It's here to make the capture spec's "Phase 2 deferred" claims concrete enough that a reviewer can see they're achievable, not aspirational.

---

## 1. What this slice does

Expands `lib/dealMath.ts` to compute settlement for every deal type Mariana negotiates, not just `flat` + `percentage_of_gross`. Reads from the structured fields populated by the capture slice. Returns a line-by-line breakdown with provenance — every number on the settlement statement traces back to its source.

When this ships, Mariana closes her spreadsheet.

## 2. Why this is the natural Phase 2

The capture slice produces clean structured deal terms but doesn't compute settlement math. As long as the engine still returns `{ supported: false }` for vs / percentage-of-net / door deals (62.5% of deals), Mariana keeps using her spreadsheet even for deals that have sealed Deal Sheets. The capture work delivers its full value only when the engine consumes its output.

Pri's memo treats settlement as one craft bet. Capture + engine are two slices of the same bet, sequenced to make each shippable on its own.

## 3. Scope

**In scope:**

- Vs deal math: `max(guarantee, percentage × adjusted_basis)`
- Net-of-expenses calculation, respecting `expenseCap`, `hospitalityCap`, and `deductionOrderJson`
- Walkout pots: 100% of gross above breakeven (using `walkoutJson`)
- Ratchets: percentage replacement at thresholds (using `ratchetJson`)
- Vs-gross variants (already in schema via `percentageBasis`)
- Door deals: % of door receipts
- Recoups applied in declared order (using `recoupsAtDealTimeJson`, falling back to `settlements.recoupsJson` for ad-hoc settlement-time recoups)
- Comps that count toward gross (per-deal rule from `compCountingRulesJson` — possibly new, see Open Questions)
- Bonuses already supported, extended to work on top of vs/net deals (not just flat)
- Line-by-line breakdown returned in the calculation result, with each line carrying a provenance reference (which structured field or expense row it came from)

**Out of scope:**

- Deal capture itself (separate slice)
- Negotiation tooling (deal terms are an input, not editable from the worksheet)
- Sponsor reporting or advance documents (Pri's other two sore points)
- Multi-currency or international tax handling
- Per-ticket-tier fee calculation (assumes ticketing already provides totals)

## 4. Math, briefly

For each deal type the engine must support, the canonical formula:

### Vs deal (standard)
```
gross           = sum(ticket_sales.gross)
fees            = sum(ticket_sales.fees)
expenses_raw    = sum(expenses where !absorbedByVenue)
expenses_capped = min(expenses_raw, expenseCap)
recoups_applied = apply recoups in deductionOrder
net             = gross - fees - recoups_off_gross - expenses_capped
percentage_payout = percentage × net
total_to_artist = max(guarantee, percentage_payout)
```

### Vs deal + walkout pot
```
... [same as above through total_to_artist]
breakeven       = guarantee + (walkout.breakevenFormula determines)
if gross > breakeven:
    walkout_share = walkout.artistShareAbove × (gross - breakeven)
    total_to_artist += walkout_share
```
(When `breakevenFormula` is null because the deal email was ambiguous, the worksheet refuses to compute the walkout line and surfaces the unresolved ambiguity from the capture slice's `deal_ambiguities` table. No silent defaulting.)

### Vs deal + ratchet
```
sort tiers by triggerValue ascending
applicable_tier = highest tier whose triggerValue is met
effective_percentage = applicable_tier.newPercentage (or base if none met)
... [use effective_percentage in the vs math above]
```

### Percentage of net
```
[same as vs without the max(guarantee, ...) step]
total_to_artist = percentage × net
```

### Door deal
```
door_receipts = sum(ticket_sales.gross where source = "door")
total_to_artist = percentage × door_receipts
```
(Door deals may need an additional ticketing data flag — TBD pending review of how door-only sales are captured today.)

### Bonuses (extended to all deal types)
After the base calculation, apply each bonus from `bonusesJson` in order. The existing `applyBonuses()` helper in `dealMath.ts` is already correct for gross_threshold / sellout / attendance_threshold — just needs to be invoked from the new vs / percentage_of_net code paths. The `tier_ratchet` bonus type is deprecated in favor of the new `ratchetJson` field.

## 5. The provenance principle (carried over from capture)

Every line in the returned `steps[]` array carries a back-reference:
- Expense lines reference the `expense.id` they came from
- Deal-term lines reference the structured field path (e.g., `deals.guaranteeAmount`)
- Recoup lines reference `deal.recoupsAtDealTimeJson[i].id`
- Bonus lines reference `deal.bonusesJson[i].id` and the trigger condition

The UI uses these to let Mariana point at any number on the worksheet and say *"this came from here"* — to herself, to the tour manager at 2am, and to the agent the next morning. This is the operational realization of Sarah's *"provenance: every line traceable to a source."*

## 6. The settlement worksheet (UX delta)

The existing `/shows/[id]/settle` worksheet stays largely the same. What changes:

- **No more "this deal type isn't supported" empty state** for vs / percentage_of_net / door deals
- **Line items show provenance on hover** — click to jump to the source (deal sheet, expense row, ticket sales summary)
- **Ambiguity banner** — if any unresolved ambiguities exist on the deal (carried from capture), the worksheet shows them as required-resolution before final sign-off
- **"Compare to spreadsheet" mode** — for the first quarter post-launch, Mariana can paste her spreadsheet's final number; the worksheet shows the delta and which lines might explain it. This is how we build her trust toward fully switching.
- **Sign-off captures a snapshot** — once she signs off, the calculation is frozen on the settlement record (already supported by `calculationJson`)

## 7. Failure modes

| Failure | What happens |
|---|---|
| Deal has no sealed Deal Sheet, structured fields partial | Engine attempts calculation using what's present; UI surfaces a banner "deal terms not fully captured" with link to start capture |
| `walkoutJson.breakevenFormula` is null (ambiguous deal email) | Engine refuses to compute the walkout line; surfaces the original ambiguity question and asks Mariana to resolve before settling |
| Engine result differs from Mariana's spreadsheet by >5% during compare mode | UI prompts her to investigate; doesn't auto-overwrite |
| Expenses arrive after the worksheet is computed (real: bar charges, hospitality) | Worksheet has a "refresh expenses" button; recompute is non-destructive (stores new calculation alongside old) |
| Comp-counting rule is unclear on a particular deal | Use the deal-level `compCountingRulesJson` if present; otherwise fall back to per-comp `countsTowardGross` flag; flag for review if conflicting |
| `ratchetJson` exists but no tier triggered | Use `basePercentage`; surface a "no ratchet tier triggered" note |

## 8. Validation strategy

Two complementary tests:

1. **Hand-labeled regression suite.** Take Mariana's spreadsheet for ~30 past shows across all deal types. Hand-populate the new structured fields. Run the engine. Assert the engine's final number matches her spreadsheet to within $1. Any divergence > $1 is either a bug (fix) or an ambiguity (file as deal_ambiguity, get her input).
2. **Quiet A/B in production.** When the engine ships behind a flag, compute settlement for both deal types it now supports AND have Mariana settle them in her spreadsheet as usual. Compare results post-show. Aim for parity on 90%+ of shows within the first quarter before unflagging.

## 9. Open questions

1. **`compCountingRulesJson` — schema gap or per-show data?** Comp counting currently lives on `comps.countsTowardGross` (per-row, post-hoc). For engine determinism, we may want a deal-level declaration. Needs investigation against actual comp-dispute patterns.
2. **Door deals — ticketing data shape.** Need to confirm `ticketSales` table distinguishes door sales from advance sales, or if door deals need a separate source.
3. **Settlement-time recoups vs. deal-time recoups — precedence rules.** When both exist, which wins? Probably "settlement-time amends deal-time," but needs explicit precedence stated in the engine.
4. **Granularity of provenance.** Does every line need a single source, or can lines aggregate (e.g., "expenses" rolls up 14 receipts)? Argues for both: aggregate on first view, expandable to itemized on click.
5. **What happens when the agent disputes a settlement-time recoup that wasn't in `recoupsAtDealTimeJson`?** Capture spec doesn't cover this — engine spec needs to handle the "recoup added at settlement time" lifecycle explicitly.

## 10. Estimated scope

- ~2-3 weeks engineering for the math (vs, net, door, walkout, ratchet handlers + bonus extension)
- ~1-2 weeks for the provenance + worksheet UX delta
- ~1 week for the compare-to-spreadsheet mode (only needed for the trust-building phase, removable later)
- ~2 weeks for the validation harness + A/B test infrastructure

Total: ~6-8 weeks for one engineer, assuming the capture slice's §4.2 schema additions are already shipped (Step 1 of the sequencing in capture spec §2.1).

---

## Why this is a sketch, not a spec

A real spec for this slice would include:
- Detailed mock-ups of the worksheet UX changes
- Comprehensive failure-mode handling for partial deal data
- An exhaustive list of deal-type × bonus-type × ratchet × walkout combinations and their expected outputs
- Per-handler unit-test specifications
- A migration plan for moving the deprecated `tier_ratchet` bonus type to the new `ratchetJson` field
- Telemetry events for measuring engine vs. spreadsheet parity

This sketch exists to demonstrate that the engine slice is well-bounded, depends only on already-specified schema additions, and is sequenced correctly relative to the capture slice. The full spec is a Q2 deliverable.
