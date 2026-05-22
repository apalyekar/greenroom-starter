/**
 * Extractor dispatcher.
 *
 * Resolves the right extractor for a venue based on its venue_llm_settings
 * row, then runs the extraction. Falls back to stub mode if no settings
 * row exists OR the configured key just failed.
 *
 * See capture spec §6 (LLM contract) and §4.7.1 (Stub-mode fallback).
 */

import { db } from "@/db";
import { venueLlmSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createAnthropicExtractor } from "./anthropic";
import { stubExtractor } from "./stub";
import type { ExtractionInput, ExtractionResult } from "./types";

export type { ExtractionInput, ExtractionResult } from "./types";

export async function runExtraction(
  venueId: string,
  input: ExtractionInput,
): Promise<ExtractionResult> {
  const settings = await db
    .select()
    .from(venueLlmSettings)
    .where(eq(venueLlmSettings.venueId, venueId))
    .limit(1)
    .then((rows) => rows[0]);

  // No settings row, or no API key configured → stub mode.
  if (!settings || !settings.apiKey) {
    return stubExtractor(input);
  }

  // Last call failed with an unrecoverable error → stub mode until rotated.
  if (settings.lastFailureReason === "invalid_key") {
    return stubExtractor(input);
  }

  const extractor = createAnthropicExtractor({
    apiKey: settings.apiKey,
    modelId: settings.modelId,
  });

  try {
    const result = await extractor(input);

    // Mark the venue's last successful call.
    await db
      .update(venueLlmSettings)
      .set({
        lastSuccessfulCallAt: new Date(),
        lastFailureReason: null,
      })
      .where(eq(venueLlmSettings.venueId, venueId));

    return result;
  } catch (err) {
    // Classify common failure modes per spec §7 (engine failure table).
    let reason = "unknown_error";
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes("401") || msg.includes("authentication") || msg.includes("invalid api key")) {
        reason = "invalid_key";
      } else if (msg.includes("429") || msg.includes("rate")) {
        reason = "rate_limit";
      } else if (msg.includes("404") || msg.includes("model")) {
        reason = "model_unavailable";
      }
    }

    await db
      .update(venueLlmSettings)
      .set({ lastFailureReason: reason })
      .where(eq(venueLlmSettings.venueId, venueId));

    // Fall back to stub so the UI flow doesn't break.
    return stubExtractor(input);
  }
}
