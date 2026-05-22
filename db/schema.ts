/**
 * Greenroom database schema.
 *
 * The data model is deliberately simple but realistic enough to support
 * the settlement workflows. Mariana (the booker at The Crescent) is the
 * primary user. Other personas (tour managers, agents, the GM) appear
 * in the data but don't have UI here.
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// -------- Users (operator accounts at the venue) --------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role", {
    enum: ["booker", "gm", "production", "box_office"],
  }).notNull(),
  venueId: text("venue_id").notNull(),
});

// -------- Venues --------

export const venues = sqliteTable("venues", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  capacity: integer("capacity").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
});

// -------- Agencies & Agents --------

export const agencies = sqliteTable("agencies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  agencyId: text("agency_id").references(() => agencies.id),
  email: text("email").notNull(),
  phone: text("phone"),
  preferencesNotes: text("preferences_notes"),
});

// -------- Artists --------

export const artists = sqliteTable("artists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  agentId: text("agent_id").references(() => agents.id),
  managerEmail: text("manager_email"),
  genre: text("genre"),
  priorShowCount: integer("prior_show_count").notNull().default(0),
});

// -------- Shows --------

export const shows = sqliteTable("shows", {
  id: text("id").primaryKey(),
  venueId: text("venue_id")
    .notNull()
    .references(() => venues.id),
  artistId: text("artist_id")
    .notNull()
    .references(() => artists.id),
  date: text("date").notNull(),
  status: text("status", {
    enum: ["booked", "advanced", "day_of", "settled", "closed"],
  })
    .notNull()
    .default("booked"),
  doorsTime: text("doors_time"),
  setTime: text("set_time"),
  openerArtistId: text("opener_artist_id").references(() => artists.id),
  roomConfig: text("room_config", { enum: ["standing", "seated", "mixed"] })
    .notNull()
    .default("standing"),
  internalNotes: text("internal_notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// -------- Deals --------

/**
 * One deal per show. The structure here is deliberately split:
 *
 *  - `dealType` and the structured fields (guarantee, percentage, etc.)
 *    are what the in-app settlement tool reads.
 *  - `dealNotesFreetext` is what Mariana actually trusts.
 *  - `bonusesJson` exists in the schema but the in-app tool doesn't read it.
 *    It's been there since 2023, originally added by a now-departed PM. About
 *    half the deals that have bonus structures fill it in; the other half
 *    leave it empty and put the bonuses in the prose only. That mismatch
 *    is one of the case-study seams.
 *
 * bonusesJson schema (when present):
 *   [
 *     { type: "gross_threshold", label: string, threshold: number, amount: number, stacks?: boolean },
 *     { type: "sellout", label: string, amount: number },
 *     { type: "attendance_threshold", label: string, threshold: number, amount: number },
 *     { type: "tier_ratchet", label: string, tiers: [{ from, to|null, percentage }] }
 *   ]
 */
export const deals = sqliteTable("deals", {
  id: text("id").primaryKey(),
  showId: text("show_id")
    .notNull()
    .unique()
    .references(() => shows.id),

  dealType: text("deal_type", {
    enum: ["flat", "percentage_of_gross", "percentage_of_net", "vs", "door"],
  }).notNull(),
  guaranteeAmount: real("guarantee_amount"),
  percentage: real("percentage"),
  percentageBasis: text("percentage_basis", { enum: ["gross", "net"] }),
  expenseCap: real("expense_cap"),
  hospitalityCap: real("hospitality_cap"),

  bonusesJson: text("bonuses_json"),
  dealNotesFreetext: text("deal_notes_freetext"),

  // -------- Deal Sheet additions (per capture spec §4.1 + §4.2) --------
  walkoutJson: text("walkout_json"),
  ratchetJson: text("ratchet_json"),
  deductionOrderJson: text("deduction_order_json"),
  recoupsAtDealTimeJson: text("recoups_at_deal_time_json"),

  termsSource: text("terms_source", {
    enum: ["manual", "llm_extracted", "llm_extracted_then_edited"],
  })
    .notNull()
    .default("manual"),
  currentExtractionId: text("current_extraction_id"),
  currentDealSheetVersion: integer("current_deal_sheet_version")
    .notNull()
    .default(0),
  termsConfirmedByVenueAt: integer("terms_confirmed_by_venue_at", {
    mode: "timestamp",
  }),
  termsConfirmedByAgentAt: integer("terms_confirmed_by_agent_at", {
    mode: "timestamp",
  }),
  termsSealedAt: integer("terms_sealed_at", { mode: "timestamp" }),

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// -------- Ticket sales --------

/**
 * Ticket sales are recorded as ADDITIVE rows — multiple rows per show
 * accumulate. They are NOT snapshots replacing prior rows. Future work
 * may add an `is_correction: boolean` flag if snapshot/replacement semantics
 * become necessary, but Phase 1 assumes additive rows only.
 */
export const ticketSales = sqliteTable("ticket_sales", {
  id: text("id").primaryKey(),
  showId: text("show_id")
    .notNull()
    .references(() => shows.id),
  qty: integer("qty").notNull(),
  gross: real("gross").notNull(),
  fees: real("fees").notNull(),
  // Channel the sale came through. Defaults to "advance" — backfilled
  // value for the existing 537 rows and the value the seed inserts
  // for all generated rows. Door deals need "door" to compute
  // door receipts correctly (see engine §7.3 in the capture spec).
  source: text("source", {
    enum: ["advance", "door", "platform_credit"],
  })
    .notNull()
    .default("advance"),
  capturedAt: integer("captured_at", { mode: "timestamp" }).notNull(),
});

// -------- Comps --------

/**
 * Comp tickets given away. A real source of dispute — agents sometimes argue
 * that certain comps "should have counted toward the gross" the artist's % is
 * calculated against. Most comps don't count, but the rules vary by category
 * and sometimes by deal.
 *
 * Stored as one row per category per show (aggregated count, not per-ticket).
 */
export const comps = sqliteTable("comps", {
  id: text("id").primaryKey(),
  showId: text("show_id")
    .notNull()
    .references(() => shows.id),
  category: text("category", {
    enum: [
      "artist_gl", // artist guest list
      "label", // label/management
      "press", // journalists, photographers
      "venue_staff", // venue staff and friends
      "sponsor", // sponsor reps
      "promo", // radio giveaways, 2-for-1s
      "other",
    ],
  }).notNull(),
  count: integer("count").notNull(),
  faceValue: real("face_value").notNull(),
  // Whether these comps count toward gross box office for settlement purposes.
  // Most categories don't, but the rules are inconsistent across deals.
  countsTowardGross: integer("counts_toward_gross", { mode: "boolean" })
    .notNull()
    .default(false),
  notes: text("notes"),
});

// -------- Expenses --------

export const expenses = sqliteTable("expenses", {
  id: text("id").primaryKey(),
  showId: text("show_id")
    .notNull()
    .references(() => shows.id),
  category: text("category", {
    enum: [
      "production",
      "sound",
      "lights",
      "hospitality",
      "marketing",
      "backline",
      "security",
      "other",
    ],
  }).notNull(),
  amount: real("amount").notNull(),
  description: text("description"),
  approved: integer("approved", { mode: "boolean" }).notNull().default(true),
  absorbedByVenue: integer("absorbed_by_venue", { mode: "boolean" })
    .notNull()
    .default(false),
  enteredByUserId: text("entered_by_user_id").references(() => users.id),
  enteredAt: integer("entered_at", { mode: "timestamp" }).notNull(),
});

// -------- Settlements --------

/**
 * The post-show financial reconciliation. One per show.
 *
 * Settlement is a multi-party state machine: the venue calculates a number,
 * sends it to the artist's tour manager / agent for review, they sign or
 * dispute, revisions happen, eventually a final number is agreed and money
 * moves.
 *
 * Stage timestamps below capture each transition. `status` is the current
 * stage. Most past shows are `paid`; recent ones are still in-flight.
 *
 * recoupsJson schema (when present):
 *   [
 *     { id, category: "marketing"|"hospitality_overage"|"production_overage"|"prior_advance"|"damages"|"other",
 *       label: string, amount: number, status: "agreed"|"disputed"|"withdrawn" }
 *   ]
 *
 * Recoups are venue costs that come "off the top" before artist payment.
 * They differ from regular expenses in two ways:
 *   1. They're disputed more often — the deal email language about recoups
 *      is frequently ambiguous (see the Coastal Spell dispute).
 *   2. They have their own lifecycle independent of the rest of the
 *      settlement — a recoup can be disputed even after the rest of the
 *      math is signed.
 */
export const settlements = sqliteTable("settlements", {
  id: text("id").primaryKey(),
  showId: text("show_id")
    .notNull()
    .unique()
    .references(() => shows.id),

  status: text("status", {
    enum: [
      "draft", // booker is still doing math
      "submitted", // sent to artist team
      "in_review", // artist team has opened it
      "signed", // both parties agree
      "disputed", // line items contested
      "revised", // venue sent a revision after dispute
      "finalized", // signed after revision
      "paid", // money has moved
      "voided", // show cancelled or settlement scrapped
    ],
  })
    .notNull()
    .default("draft"),

  // Stage timestamps
  draftedAt: integer("drafted_at", { mode: "timestamp" }),
  submittedAt: integer("submitted_at", { mode: "timestamp" }),
  reviewStartedAt: integer("review_started_at", { mode: "timestamp" }),
  signedAt: integer("signed_at", { mode: "timestamp" }),
  disputedAt: integer("disputed_at", { mode: "timestamp" }),
  revisedAt: integer("revised_at", { mode: "timestamp" }),
  finalizedAt: integer("finalized_at", { mode: "timestamp" }),
  paidAt: integer("paid_at", { mode: "timestamp" }),

  completedAt: integer("completed_at", { mode: "timestamp" }),
  completedByUserId: text("completed_by_user_id").references(() => users.id),

  grossBoxOffice: real("gross_box_office"),
  netBoxOffice: real("net_box_office"),
  totalExpenses: real("total_expenses"),
  totalToArtist: real("total_to_artist"),

  calculationJson: text("calculation_json"),
  recoupsJson: text("recoups_json"),

  signoffText: text("signoff_text"),
  notes: text("notes"),
});

// -------- Deal Sheet capture tables (per capture spec §4.3–§4.7) --------

/**
 * One row per LLM extraction attempt. Append-only; supersedes form a history.
 * `status` transitions: draft → pending_confirmation → confirmed (or superseded/rejected).
 */
export const dealTermsExtraction = sqliteTable("deal_terms_extraction", {
  id: text("id").primaryKey(),
  dealId: text("deal_id")
    .notNull()
    .references(() => deals.id),
  version: integer("version").notNull().default(1),
  sourceText: text("source_text").notNull(),
  sourceArtifactsJson: text("source_artifacts_json"),
  extractedJson: text("extracted_json").notNull(),
  mode: text("mode", { enum: ["live", "stub"] }).notNull().default("live"),
  modelId: text("model_id"),
  promptVersion: text("prompt_version").notNull().default("v1"),
  confidence: real("confidence"),
  status: text("status", {
    enum: ["draft", "pending_confirmation", "confirmed", "superseded", "rejected"],
  })
    .notNull()
    .default("draft"),
  extractedAt: integer("extracted_at", { mode: "timestamp" }).notNull(),
});

/**
 * One row per flagged ambiguity. Each carries a human-readable question
 * the booker could send to the agent.
 */
export const dealAmbiguities = sqliteTable("deal_ambiguities", {
  id: text("id").primaryKey(),
  dealId: text("deal_id")
    .notNull()
    .references(() => deals.id),
  extractionId: text("extraction_id")
    .notNull()
    .references(() => dealTermsExtraction.id),
  category: text("category", {
    enum: [
      "recoup_placement",
      "percentage_basis",
      "expense_cap_scope",
      "bonus_threshold_basis",
      "comp_counting",
      "deduction_order",
      "missing_source",
      "stale_structured_field",
      "other",
    ],
  }).notNull(),
  proseSpan: text("prose_span").notNull(),
  proseSpanStart: integer("prose_span_start").notNull().default(0),
  proseSpanEnd: integer("prose_span_end").notNull().default(0),
  question: text("question").notNull(),
  optionsJson: text("options_json"),
  resolution: text("resolution"),
  resolvedBy: text("resolved_by"),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  resolutionEvidence: text("resolution_evidence"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/**
 * One row per confirmation event per party. A "sealed" Deal Sheet has
 * one row with party=venue and one with party=agent for the current extraction.
 */
export const dealConfirmations = sqliteTable("deal_confirmations", {
  id: text("id").primaryKey(),
  dealId: text("deal_id")
    .notNull()
    .references(() => deals.id),
  extractionId: text("extraction_id")
    .notNull()
    .references(() => dealTermsExtraction.id),
  party: text("party", {
    enum: ["venue", "agent", "artist_management"],
  }).notNull(),
  contactId: text("contact_id").notNull(),
  confirmedAt: integer("confirmed_at", { mode: "timestamp" }).notNull(),
  confirmationMethod: text("confirmation_method", {
    enum: ["in_app", "magic_link", "email_reply", "verbal_logged"],
  })
    .notNull()
    .default("in_app"),
  fieldsConfirmedJson: text("fields_confirmed_json"),
});

/**
 * One row per venue. Holds BYOK LLM credentials. The plaintext API key
 * is never returned by any query after creation — only `apiKeyLastFour`
 * is exposed for verification.
 *
 * NOTE: In Phase 1 the apiKey field stores the key as-is for prototype use.
 * Production would store an encrypted blob; this is documented as a known
 * scope cut in the capture spec §4.7.
 */
export const venueLlmSettings = sqliteTable("venue_llm_settings", {
  venueId: text("venue_id")
    .primaryKey()
    .references(() => venues.id),
  provider: text("provider", { enum: ["anthropic", "openai"] })
    .notNull()
    .default("anthropic"),
  modelId: text("model_id").notNull().default("claude-opus-4-7"),
  apiKey: text("api_key"),
  apiKeyLastFour: text("api_key_last_four"),
  configuredByUserId: text("configured_by_user_id").references(() => users.id),
  configuredAt: integer("configured_at", { mode: "timestamp" }),
  lastSuccessfulCallAt: integer("last_successful_call_at", {
    mode: "timestamp",
  }),
  lastFailureReason: text("last_failure_reason"),
  monthlyExtractionCount: integer("monthly_extraction_count")
    .notNull()
    .default(0),
  monthlyExtractionResetAt: integer("monthly_extraction_reset_at", {
    mode: "timestamp",
  }),
});

// -------- Type exports for convenience --------

export type User = typeof users.$inferSelect;
export type Venue = typeof venues.$inferSelect;
export type Agency = typeof agencies.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Artist = typeof artists.$inferSelect;
export type Show = typeof shows.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type TicketSale = typeof ticketSales.$inferSelect;
export type Comp = typeof comps.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Settlement = typeof settlements.$inferSelect;
export type DealTermsExtraction = typeof dealTermsExtraction.$inferSelect;
export type DealAmbiguity = typeof dealAmbiguities.$inferSelect;
export type DealConfirmation = typeof dealConfirmations.$inferSelect;
export type VenueLlmSettings = typeof venueLlmSettings.$inferSelect;

// -------- Decoded JSON helpers --------

export type Bonus =
  | {
      type: "gross_threshold";
      label: string;
      threshold: number;
      amount: number;
      stacks?: boolean;
    }
  | { type: "sellout"; label: string; amount: number }
  | {
      type: "attendance_threshold";
      label: string;
      threshold: number;
      amount: number;
    }
  | {
      type: "tier_ratchet";
      label: string;
      tiers: { from: number; to: number | null; percentage: number }[];
    };

export type Recoup = {
  id: string;
  category:
    | "marketing"
    | "hospitality_overage"
    | "production_overage"
    | "prior_advance"
    | "damages"
    | "other";
  label: string;
  amount: number;
  status: "agreed" | "disputed" | "withdrawn";
};

/**
 * deductionOrderJson shape (capture spec §4.2). The capped_bucket is the
 * load-bearing structure — it expresses "these line items count against the
 * expense cap; anything not listed here is outside the cap." Both the capture
 * writeback (lib/extraction/writeback.ts) and the settlement engine
 * (lib/dealMath.ts) consume this type — it's exported here to keep them
 * single-sourced.
 */
export type DeductionStep =
  | {
      kind: "line_item";
      id: string;
      ref:
        | { type: "fees" }
        | { type: "recoup"; recoupId: string }
        | { type: "expense_categories"; categories: ExpenseCategory[] }
        | { type: "all_expenses_except_recoups" };
    }
  | {
      kind: "capped_bucket";
      id: string;
      capRef: "expenseCap" | "hospitalityCap";
      members: DeductionStep[];
    }
  | { kind: "apply_percentage"; basis: "gross" | "net" };

export type ExpenseCategory =
  | "production"
  | "sound"
  | "lights"
  | "hospitality"
  | "marketing"
  | "backline"
  | "security"
  | "other";

/**
 * walkoutJson shape (capture spec §4.2 + §7.5.2). A null breakevenFormula
 * means the prose was ambiguous about how breakeven is computed — the
 * engine refuses to compute the walkout line and emits linesSkipped.
 */
export type Walkout = {
  basis: "gross" | "net";
  breakevenFormula: "guarantee+expenses" | "guarantee_only" | null;
  potThreshold: number | null;
  artistShareAbove: number;
};

/**
 * ratchetJson shape (capture spec §4.2 + §7.5.3). Replaces (not adds to)
 * the base percentage when a tier's trigger is met.
 */
export type Ratchet = {
  basePercentage: number;
  basis: "gross" | "net";
  tiers: {
    triggerType: "capacity_pct" | "gross_amount" | "attendance" | "net_amount";
    triggerValue: number;
    newPercentage: number;
  }[];
};

export type SettlementStage = Settlement["status"];
