/**
 * Contract for the deal-terms extractor.
 *
 * This shape is the source of truth for what every extractor implementation
 * (stub + real LLM) must return. It mirrors the JSON schema in the
 * extractor system prompt (docs/superpowers/specs/2026-05-21-extractor-system-prompt.md)
 * and the capture spec §6.
 */

export type AmbiguityCategory =
  | "recoup_placement"
  | "percentage_basis"
  | "expense_cap_scope"
  | "bonus_threshold_basis"
  | "comp_counting"
  | "deduction_order"
  | "missing_source"
  | "stale_structured_field"
  | "other";

export type StructuredTerms = {
  dealType?: "flat" | "vs" | "percentage_of_net" | "percentage_of_gross" | "door";
  guaranteeAmount?: number;
  percentage?: number;
  percentageBasis?: "gross" | "net";
  expenseCap?: number;
  hospitalityCap?: number;
  walkout?: {
    basis: "gross" | "net";
    breakevenFormula: "guarantee+expenses" | "guarantee_only" | null;
    potThreshold: number | null;
    artistShareAbove: number;
  };
  ratchet?: {
    basePercentage: number;
    basis: "gross" | "net";
    tiers: {
      triggerType: "capacity_pct" | "gross_amount" | "attendance" | "net_amount";
      triggerValue: number;
      newPercentage: number;
    }[];
  };
  bonuses?: (
    | { type: "gross_threshold"; label: string; threshold: number; amount: number; stacks: boolean }
    | { type: "sellout"; label: string; amount: number }
    | { type: "attendance_threshold"; label: string; threshold: number; amount: number }
  )[];
  recoupsAtDealTime?: {
    id: string;
    category: "marketing" | "hospitality_overage" | "production_overage" | "prior_advance" | "damages" | "other";
    label: string;
    amount: number;
    relativeTo: "gross" | "net";
    insideExpenseCap: boolean;
  }[];
  // deductionOrder is intentionally omitted from the simplified MVP extractor —
  // the capped_bucket schema (capture spec §4.2) is built but the extractor
  // surfaces ambiguities rather than producing a structured deduction order
  // on first pass. Phase 2 of the extractor will produce it.
};

export type FieldProvenance = {
  [fieldPath: string]: {
    proseSpanStart: number;
    proseSpanEnd: number;
    confidence: number;
  };
};

export type Ambiguity = {
  category: AmbiguityCategory;
  proseSpan: string;
  proseSpanStart: number;
  proseSpanEnd: number;
  question: string;
  options: { label: string; value: string }[];
};

export type ExtractionResult = {
  mode: "live" | "stub";
  structuredTerms: StructuredTerms;
  fieldProvenance: FieldProvenance;
  ambiguities: Ambiguity[];
  unparseableSpans: string[];
  missingSourcePointers: string[];
  overallConfidence: number;
};

export type ExtractionInput = {
  dealProse: string;
  venueContext: {
    name: string;
    capacity: number;
    city: string;
  };
  agentContext?: {
    name?: string;
    agency?: string;
  };
  priorExtraction?: StructuredTerms;
};

export type Extractor = (input: ExtractionInput) => Promise<ExtractionResult>;
