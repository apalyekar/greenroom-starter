# Settlement craft bet: deal capture + engine extension

**Author:** Amey
**Role applied for:** Applied AI PM, Greenroom
**Date:** May 2026

---

Pri opened her Q4 memo with a sentence that frames every choice in this submission: *"We are winning on completeness and losing on craft."* The dashboard says ARR is up to $8.1M and NDR is 116%, but every customer call ends with the same shrug — "the individual features are kinda just okay." The most damning version of that shrug is the 18% adoption number on the in-app settlement tool. 82% of the customer base is doing the most trust-critical conversation of the week in a Google Sheet. That's not a feature gap. It's an existential signal. This memo is my Q1 craft bet against it.

## 1. The slice and why I picked it

The slice is two coupled halves, both shipping in Phase 1: **LLM-driven deal capture** that turns the agent's prose email into a structured, shareable, agent-signed "Deal Sheet," and a **settlement engine extension** that consumes those structured terms to compute settlements for the deal types Mariana is currently doing in her spreadsheet. They sit either side of the same schema migration and ship in parallel behind feature flags.

The motivating failure is the Coastal Spell dispute from March 2025. An 80-word deal email contained the line *"expenses capped at $2,500, marketing recoup of $900 against gross."* Mariana read the recoup as a separate deduction off gross; WME's Andrea read it as a member of the $2,500 cap. The two readings differ by $720 — Mariana's spreadsheet said $11,565 to the artist, Andrea's said $12,285. Marcus paid the difference and Mariana wrote in her forwarded note: *"there's no version of the truth in our system. It's just in her head and ours."*

That sentence is the whole problem. The settlement tool today computes math on terms that don't exist anywhere as structured data. The truth lives in a 90-day-old email in Mariana's inbox. The craft bet has to fix that upstream of the math, not at the math itself.

There is also a venue-specific urgency that Marcus surfaced directly: The Crescent's lease renews in March 2027. Whether they survive the rate increase comes down to whether agents keep routing strong shows there. Settlement is one of three or four signals agents use to decide who they route through, and Sarah Kim (WME) confirmed it: *"a venue that settles well has its operational house in order."* The cost of the Coastal Spell dispute wasn't $720 — Marcus has seen an indie agent silently pull $80K of routing over a single bad experience eighteen months later. Greenroom's job is to be the operational backbone of venues like The Crescent, and right now the operational backbone is a Google Sheet.

## 2. Why I cut the alternatives

**Math-only fix — just extend `lib/dealMath.ts` to handle vs, pct-net, and door.** The obvious move: today the engine returns `{ supported: false }` for 62.5% of past deals. But computing on ambiguous freetext inputs is strictly worse than not computing. The Coastal Spell dispute, run through a vs-handler that silently picks one interpretation of "recoup against gross," moves from "2am conversation between two humans" to "the engine silently picked the wrong reading and produced a confident-looking $11,565 number." The schema has to be able to express which reading was sealed before the engine can honestly walk it.

**Expense-aggregation cockpit — fix Mariana's Wednesday-to-Friday gap.** Mariana said it plainly: *"if you could just have all the expenses ready when I sat down to settle, that alone would change my life."* A standalone expense-collection tool would be useful, but it's the wrong sequence: the upstream trust failure isn't expense aggregation, it's deal-term ambiguity. The engine still has to honor `approved` vs `pending` regardless of where expenses come from — via the Q9 lock-in that surfaces `pendingExpenses` as a separate field. That's the right shape; the standalone cockpit is Phase 2 once trust upstream is solved.

**The 2am walkthrough UI — record the settlement conversation, build a "show your work" interactive worksheet.** Diego, Sarah, and Mariana all asked for some version of this (Diego: *"I want to see the math. Not have it explained from memory"*). I rejected it for Phase 1 because a worksheet built on top of bad inputs is showing its work on bad math. Provenance has to start at the deal terms, not at the calculation. Once the engine consumes sealed Deal Sheets and `steps[]` carries `sourceType + sourceId` per line, the walkthrough UI becomes the obvious Phase 2 layer on top.

## 3. The data evidence

I ran the full SQLite seed through analysis to size the bet honestly. Two numbers anchor it.

**The headline metric: the current engine handles 37.5% of past deals and bypasses 62.5%.** Distribution across the 507 past deals breaks down as follows:

| Deal type | Past count | Share | Engine status |
|---|---:|---:|---|
| Flat | 174 | 34.3% | Supported |
| Vs (vs guarantee) | 185 | 36.5% | Not supported |
| Percentage of net | 103 | 20.3% | Not supported |
| Door | 29 | 5.7% | Not supported |
| Percentage of gross | 16 | 3.2% | Supported |

The vs bucket alone is 36.5% — bigger than flat — and the existing settlement tool can't touch it. Mariana didn't switch to Google Sheets because she likes Google Sheets; she switched because 62.5% of her shows can't be settled in Greenroom.

The vs bucket has its own long tail. Of 195 vs deals, **45.6% are standard, 16.4% have walkout pots, 16.4% are vs-gross variants, 13.8% have ratchets or escalators, and 7.7% carry bonuses on top.** The schema has to support all five — and the existing `bonusesJson.tier_ratchet` type is structurally wrong for ratchets (it models them as additive bonuses; ratchets actually *replace* the percentage at thresholds). `lib/dealMath.ts:248-252` literally has a comment acknowledging this gap. That's why the spec adds a separate `ratchetJson` field instead of overloading bonuses.

**Thirty deals have prose-vs-structured mismatch on bonuses.** 18 describe bonuses in prose but have empty `bonuses_json`; 12 have JSON populated but prose silent. Each of those is a deal whose terms today are invisible to one half of the system. **100% of deals have parseable freetext in `dealNotesFreetext`** — meaning the LLM has something real to extract from on every deal — but the structured fields are entered inconsistently because they don't model the actual deals well. The truth has always lived in the prose; the slice is about elevating it into something both sides can sign.

The Coastal Spell deal sits in the data with its retroactive *"$720 dispute concession"* note. Worked end-to-end: gross was $19,840, fees were $1,984, expenses were within the $2,500 cap, and the $900 marketing recoup was either inside or outside the cap. Mariana's math (recoup outside) gave $11,565; Andrea's math (recoup inside) gave $12,285. Under the proposed schema, these two readings become visibly different JSON structures; under the current schema, there's nowhere to write either reading down.

A note on rigor: the frontend shows 507 deals but the raw DB has 537. The difference is `lib/queries.ts:41` filtering on `shows.date <= today`. Both numbers are correct — choose based on whether you're asking "what's settled today" (507) or "what your slice would gate going forward" (537). I also caught `lib/queries.ts:175-176` counting every past show as settled regardless of `settlements.status`, which means the /reports page is currently lying about settled-count. Worth fixing, but out of scope for the slice.

## 4. Current workflow vs. proposed workflow

**Architecture principles.** Three commitments shape the slice. First, schema-first sequencing: the §4.2 schema additions (`walkoutJson`, `ratchetJson`, `deductionOrderJson`, `recoupsAtDealTimeJson`) ship in a small low-risk PR, then capture and engine build in parallel against the stable contract. Second, the prime directive — *useful and honest, never obstructive*: if a deal isn't sealed yet the engine still computes but returns `dealTermsConfirmed: false` so the UI renders "preliminary settlement"; hard-blocking would push Mariana back to her spreadsheet on day one. Third, BYOK with deterministic stub fallback: venues bring their own Anthropic or OpenAI key (encrypted in `venue_llm_settings`, gated to GM and booker roles), and when no key is configured a stub returns the same shape with `mode: "stub"` and a UI banner. The capture flow never breaks, the test suite never breaks, and no one is fooled.

**Today's workflow.** The show ends around 11pm; the bar closes; the tour manager finds Mariana around midnight. She opens two laptop tabs: Greenroom for the deal terms and ticket sales, her own Google Sheet for the actual math engine. She copy-pastes the gross and the comp count from Greenroom into the sheet, then types in the expenses she chased earlier that day from the POS, the production manager, the receipts pile, and her marketing notes. The sheet computes the final number. The tour manager reviews it line by line at 2am. She texts Marcus a screenshot for sign-off, wires the payout Monday, and emails a PDF to the agent Tuesday. Roughly 40% of those settlements come back with pushback. The Coastal Spell dispute was one of them: $720 plus the agent goodwill it bought back.

**Proposed workflow — at deal time.** Wednesday morning, weeks before the show, Mariana pastes the agent's deal email into `/shows/[id]/deal/capture`. Claude Opus 4.7 extracts the structured terms with adaptive thinking and flags anything ambiguous as a question card with the original prose quoted back. The Coastal Spell line *"expenses capped at $2,500, marketing recoup of $900 against gross"* shows up as a `recoup_placement` ambiguity with two clear options: recoup inside the $2,500 cap, or recoup as a separate deduction off gross. Mariana picks one — or sends the magic link to the agent and lets Sarah pick. The choice writes back to `deals.deductionOrderJson` as a `capped_bucket` structure: two distinguishable JSON shapes for the two readings of the same sentence.

**Proposed workflow — at settlement time.** 2am Friday she opens `/shows/[id]/settle`. The engine reads the sealed structured terms and computes line by line, showing its work. Every step carries provenance (`deal_field` / `expense` / `ticket_sale` / `comp` / `bonus` / `recoup` / `computed`) so the tour manager can click any number to see where it came from. If anything was unresolved during capture, it appears as a `linesSkipped` card the engine refused to compute — not a silent zero. Unapproved expenses surface as a separate "pending approval" line, not muddying the headline number. Hospitality cap is enforced separately from the expense cap by default. If the deal was never sealed, the engine still runs but stamps the output `dealTermsConfirmed: false` and the UI renders "preliminary settlement."

**Outcome.** The math is on the same screen as the deal terms, and the deal terms were agreed to in writing weeks ago. The 2am conversation becomes "let me show you" instead of "let me explain."

**The anchor proof.** The two engine demo deals in the prototype — `show_engine_demo_inside_cap` and `show_engine_demo_outside_cap` — are the *same* show. Same gross ($19,840). Same expenses ($2,600). Same recoup ($900). They compute to **$11,964 vs $11,484, a $480 delta**, because the `capped_bucket` placement of the recoup differs by one JSON object. Same prose would have produced ambiguity; sealed structured terms produce deterministic, divergent answers. This is what "the schema does real work" looks like in concrete dollars: the disagreement is now categorically explicit before the show ever loads in, instead of erupting at 2am between two people staring at different spreadsheets.

## 5. Who this helps and how

**Coverage shift.** Before this slice, the in-app engine handled `flat` and `percentage_of_gross` only — 37.5% of past deals (190 of 507 per the table in §3). After this slice, the engine handles all five deal types: `vs` (+36.5%), `percentage_of_net` (+20.3%), and `door` (+5.7%) all land in scope, along with the variants that account for over half of vs deals — `walkout pots`, `ratchets`, and `vs-gross`. **From ~38% engine coverage to effectively 100%.** Every shape Mariana actually negotiates now computes inside Greenroom.

**What it solves for Mariana.** Each design choice traces back to a direct line in the transcripts:

- *"Your tool can't do vs deals. So I do it in a Google Sheet."* → the engine now computes vs / pct-net / door + every variant. The spreadsheet has no remaining job. Today she keeps two tabs open and copy-pastes numbers between them; after this slice, the math lives where the deal terms live.
- *"If you could just have all the expenses ready when I sat down to settle, that alone would change my life."* → unapproved expenses surface as a separate `pendingExpenses` line on the worksheet, visible but not muddying the headline. The Wednesday-versus-Friday gap is made honest rather than hidden.
- *"Every line in my spreadsheet has a sourceable breakdown."* → every step in the engine's `steps[]` carries `sourceType` (deal_field / expense / ticket_sale / comp / bonus / recoup / computed) + `sourceId` linking back to the source row. The tour manager can click any number and see exactly where it came from. The "show your work" standard she enforces by hand is now native to the engine.
- The 25-hour-a-month settlement overhead Marcus quoted is mostly the spreadsheet ritual itself — copy-paste, manual expense entry, manual reconciliation. With the engine producing the same answer in-app and showing its work, that overhead collapses without changing the *conversation* the tour manager and Mariana have at 2am. Same conversation; less typing; one fewer place for numbers to diverge.
- *"I want fewer surprises in that 2am conversation."* → capture-at-deal-time means ambiguities (recoup placement, expense scope, percentage basis) are resolved Wednesday by the agent, not discovered at 2am Friday. The Coastal Spell class of dispute is structurally prevented, not just better-managed.

**What it solves for the agent.** Sarah Kim's three trust criteria for a good settlement statement map one-to-one onto the engine's return shape:

- *"Itemization"* — every deduction is its own line in `steps[]`; no opaque "miscellaneous expenses" rollup.
- *"Provenance"* — every line has `sourceType` + `sourceId`; the receipts and ticket sales the engine read are referenceable.
- *"Tone"* — the worksheet renders the work, not the answer. Sarah's *"some statements feel like a fait accompli"* describes the failure mode; this shape inverts it.

Her larger ask — *"a version of the deal we both agreed on, in one place"* — is the sealed Deal Sheet. *"Settlement becomes a structured collaboration between the venue and the agency, not an asymmetric document the venue sends the next morning."* The recoup placement gets resolved before settlement night, not contested after.

The bookend: Mariana's dependence on her Google Sheet is downstream of two things — the engine couldn't compute her deals, and even when it could it didn't show its work to her standard. Both root causes are addressed in the same slice. The sheet stops being load-bearing the day the engine ships, not the day she decides to switch.

## 6. Validation with real bookers and agents

The validation plan has to answer two distinct questions: does the extractor read prose accurately, and does the engine match what Mariana would have computed by hand.

**Extractor quality.** Hand-label 50 historical deals across all five deal types from Mariana's spreadsheets. Run the extractor. Measure three things: field-by-field accuracy, ambiguity-detection recall against the known-ambiguous cases, and false-confidence rate (how often does the model assign high confidence to a field it actually got wrong). The Coastal Spell row is the regression test — *it must always trigger a `recoup_placement` ambiguity.* If the prompt ever stops flagging it, we've broken the load-bearing behavior. The full v1 prompt is in `docs/superpowers/specs/2026-05-21-extractor-system-prompt.md` and is held against the contract in spec §6.

**Engine parity.** Take Mariana's spreadsheets for ~30 past shows spanning all deal types and variants (5 flat, 5 pct-gross, 5 pct-net, 10 vs including walkout/ratchet/vs-gross, 5 door). Hand-populate the new structured fields from her deal notes. Run the engine. Assert engine output matches her totalToArtist within $1. Any divergence is either an engine bug or a real ambiguity she resolved by judgment in her sheet — in which case we surface it as a `deal_ambiguity` and get her resolution on the record. That second case is the capture side catching up to her tacit knowledge, and it's a feature, not a failure.

**Production A/B.** Once both halves ship behind feature flags, every settlement is computed twice — in the engine and in Mariana's spreadsheet. She settles in whichever she trusts. We watch parity rate, and flip the default when it clears 95% on shows where a Deal Sheet was sealed.

**Adoption metrics.** Fraction of new shows that have a Deal Sheet created within 7 days of paste. Targets: 70% in Phase 1, 90% in Phase 2 after iterating on the agent UX. If Mariana doesn't reach for it, nothing else matters.

**The headline metric.** Dispute rate on shows settled via sealed Deal Sheet + engine vs. the comparison group, measured over two quarters. The Coastal-Spell class of dispute (recoup placement, expense scope, percentage basis) should approach zero on sealed deals. Marcus's $720 events and Sarah's "one in 30 turns into a real dispute" rate are the numbers we expect to move.

**Direct user feedback loop.** Mariana reviews extractor output on real deals before the prompt ships. The ambiguity-resolution questions go out as actual emails to actual agents — so they have to read like emails an agent would answer, not like form inputs. Sarah is an honest first reader for that: she said *"the deal email needed three more sentences to be unambiguous; they never got written because deal emails get written at 11pm by overworked agents."* The whole capture flow exists to write those three sentences in a place both sides can sign.

## 7. What I'd ship next

Phase 2 is the obvious follow-on once Phase 1 has 6 months of operating data:

- **Greenroom-managed LLM keys + token usage on customer billing** — bundles key management with billing integration so they ship together. Removes the BYOK setup friction for venues that find it too high.
- **Backfill of already-settled historical deals** — same components as Phase 1 in "scan existing prose" mode. The unsettled-shows backfill is in Phase 1 scope (those artists haven't been paid yet); the already-settled backfill exists only for the dispute-rate comparison group, which is itself a Phase 2 measurement.
- **Email-forward ingestion** — `bookings@greenroom.app` inbound, auto-association by subject line. The paste-into-form entry point ships first because it has no infrastructure dependency.
- **PDF advance document parsing** — Pri's second sore point. Same LLM pattern, different input shape.
- **Three-way confirmation including artist management** — adds the CC'd party with view-only escalating to co-signer where artist mgmt is contractually in the loop.
- **Wednesday pre-show scan** — auto-runs the extractor 5 days before show and surfaces new ambiguities for resolution before settlement night. Directly addresses Marcus's *"if we could see Wednesday this deal is going to have an ambiguous expense fight."*
- **Agent-side dashboard** — once magic links have adoption, Sarah will want one view of all pending deals from one venue.
- **Snapshot vs. additive `ticket_sales.is_correction`** — schema deferral noted in spec §4.8; the Phase 1 comment is the warning shot for future maintainers.
- **Deal-level `compCountingRulesJson`** — Q6 deferred; ships if per-row drift becomes a production problem.

---

The bet is that Pri's *"go deep, be honest about trade-offs"* applied to settlement looks like this: stop trying to make the existing tool cover more cases and start fixing the upstream artifact that the tool reads from. The capped-bucket schema is the load-bearing fact. The engine's refusal to silently default is the operating discipline. The Deal Sheet is the social contract between Mariana and Sarah that the email never quite was. If The Crescent's lease conversation in March 2027 includes "agents trust us to settle cleanly," this is the slice that got us there.
