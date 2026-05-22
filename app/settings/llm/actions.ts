"use server";

/**
 * Server actions for the venue LLM settings page.
 *
 * Saves the BYOK API key. In Phase 1 the key is stored as-is (prototype scope);
 * production would store an encrypted blob (see capture spec §4.7).
 *
 * On save, we also test the key with a minimal Anthropic call so the venue
 * admin gets immediate feedback rather than discovering a bad key later
 * during an actual extraction.
 */

import { db } from "@/db";
import { venueLlmSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CURRENT_USER_ID, CURRENT_VENUE_ID } from "@/lib/session";
import { revalidatePath } from "next/cache";
import Anthropic from "@anthropic-ai/sdk";

export async function saveLlmSettings(formData: FormData) {
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const modelId =
    String(formData.get("modelId") ?? "claude-opus-4-7").trim() ||
    "claude-opus-4-7";

  if (!apiKey) {
    return { ok: false as const, error: "API key is required" };
  }

  // Validate the key with a minimal test call. Use a tiny max_tokens so it
  // costs almost nothing — we just want to confirm 200 OK.
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: modelId,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    });
  } catch (err) {
    let reason = "unknown_error";
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes("401") || msg.includes("authentication"))
        reason = "Invalid API key";
      else if (msg.includes("404")) reason = `Model ${modelId} not available for this key`;
      else if (msg.includes("rate")) reason = "Rate limit hit during validation";
      else reason = err.message;
    }
    return { ok: false as const, error: `Key validation failed: ${reason}` };
  }

  const lastFour = apiKey.slice(-4);
  const now = new Date();

  const existing = await db
    .select()
    .from(venueLlmSettings)
    .where(eq(venueLlmSettings.venueId, CURRENT_VENUE_ID))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing) {
    await db
      .update(venueLlmSettings)
      .set({
        provider: "anthropic",
        modelId,
        apiKey,
        apiKeyLastFour: lastFour,
        configuredByUserId: CURRENT_USER_ID,
        configuredAt: now,
        lastFailureReason: null,
        lastSuccessfulCallAt: now,
      })
      .where(eq(venueLlmSettings.venueId, CURRENT_VENUE_ID));
  } else {
    await db.insert(venueLlmSettings).values({
      venueId: CURRENT_VENUE_ID,
      provider: "anthropic",
      modelId,
      apiKey,
      apiKeyLastFour: lastFour,
      configuredByUserId: CURRENT_USER_ID,
      configuredAt: now,
      lastSuccessfulCallAt: now,
      lastFailureReason: null,
      monthlyExtractionCount: 0,
      monthlyExtractionResetAt: now,
    });
  }

  revalidatePath("/settings/llm");
  return { ok: true as const };
}

export async function removeLlmSettings() {
  await db
    .delete(venueLlmSettings)
    .where(eq(venueLlmSettings.venueId, CURRENT_VENUE_ID));
  revalidatePath("/settings/llm");
  return { ok: true as const };
}
