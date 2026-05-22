/**
 * Stub extractor — runs when no venue_llm_settings row exists or the
 * configured key just failed. Returns a realistic-shaped response with
 * `mode: "stub"` so the UI knows to show the placeholder banner.
 *
 * The stub never makes an external API call. It surfaces a single
 * "other" ambiguity instructing the booker to configure a key or enter
 * the deal terms manually.
 *
 * See capture spec §4.7.1 (Stub-mode fallback) for the design rationale.
 */

import type { Extractor, ExtractionResult } from "./types";

export const stubExtractor: Extractor = async (input) => {
  const preview = input.dealProse.slice(0, 200);

  const result: ExtractionResult = {
    mode: "stub",
    structuredTerms: {},
    fieldProvenance: {},
    ambiguities: [
      {
        category: "other",
        proseSpan: preview,
        proseSpanStart: 0,
        proseSpanEnd: Math.min(200, input.dealProse.length),
        question:
          "AI extraction isn't configured for this venue. Configure an Anthropic API key in Settings → AI Configuration to enable automatic deal-term extraction, or fill in the deal terms manually below.",
        options: [],
      },
    ],
    unparseableSpans: [],
    missingSourcePointers: [],
    overallConfidence: 0,
  };

  return result;
};
