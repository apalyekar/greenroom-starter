"use server";

/**
 * Server actions for the deal-capture flow.
 *
 * - extractDealTerms: run the LLM extractor on pasted prose, persist the
 *   result, return the extraction id + ambiguities for the UI.
 * - resolveAmbiguity: record the booker's resolution to a flagged ambiguity.
 * - sealByVenue: write the venue-side confirmation row, advancing the
 *   Deal Sheet toward sealed. (The agent-side seal is a Phase 2 surface.)
 *
 * All actions assume the hardcoded Mariana/Crescent session — see
 * lib/session.ts.
 */

import { db } from "@/db";
import {
  deals,
  shows,
  venues,
  artists,
  agents,
  dealTermsExtraction,
  dealAmbiguities,
  dealConfirmations,
  type Recoup,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { runExtraction } from "@/lib/extraction";
import {
  applyRecoupPlacementResolution,
  inferResolutionValue,
  type DeductionStep,
} from "@/lib/extraction/writeback";
import { CURRENT_USER_ID, CURRENT_VENUE_ID } from "@/lib/session";
import { revalidatePath } from "next/cache";

function randomId(prefix: string) {
  // Short opaque id — enough for prototype purposes.
  return (
    prefix +
    "_" +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

export async function extractDealTerms(showId: string, prose: string) {
  if (!prose.trim()) {
    return { ok: false as const, error: "Prose is empty" };
  }

  // Load show + venue + agent context for the extractor.
  const ctx = await db
    .select({
      show: shows,
      deal: deals,
      venue: venues,
      artist: artists,
      agent: agents,
    })
    .from(shows)
    .leftJoin(deals, eq(deals.showId, shows.id))
    .leftJoin(venues, eq(shows.venueId, venues.id))
    .leftJoin(artists, eq(shows.artistId, artists.id))
    .leftJoin(agents, eq(artists.agentId, agents.id))
    .where(eq(shows.id, showId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!ctx?.show || !ctx.deal || !ctx.venue) {
    return { ok: false as const, error: "Show, deal, or venue not found" };
  }

  // Determine the next version number for this deal's extractions.
  const priorExtractions = await db
    .select({ version: dealTermsExtraction.version })
    .from(dealTermsExtraction)
    .where(eq(dealTermsExtraction.dealId, ctx.deal.id));
  const nextVersion =
    priorExtractions.reduce((max, r) => Math.max(max, r.version), 0) + 1;

  // Run the extractor.
  const result = await runExtraction(CURRENT_VENUE_ID, {
    dealProse: prose,
    venueContext: {
      name: ctx.venue.name,
      capacity: ctx.venue.capacity,
      city: ctx.venue.city,
    },
    agentContext: ctx.agent
      ? { name: ctx.agent.name, agency: undefined }
      : undefined,
  });

  // Persist the extraction row.
  const extractionId = randomId("xtr");
  const now = new Date();
  await db.insert(dealTermsExtraction).values({
    id: extractionId,
    dealId: ctx.deal.id,
    version: nextVersion,
    sourceText: prose,
    sourceArtifactsJson: null,
    extractedJson: JSON.stringify(result),
    mode: result.mode,
    modelId: result.mode === "live" ? "claude-opus-4-7" : null,
    promptVersion: "v1",
    confidence: result.overallConfidence,
    status: "draft",
    extractedAt: now,
  });

  // Persist each ambiguity row.
  for (const a of result.ambiguities) {
    await db.insert(dealAmbiguities).values({
      id: randomId("amb"),
      dealId: ctx.deal.id,
      extractionId,
      category: a.category,
      proseSpan: a.proseSpan,
      proseSpanStart: a.proseSpanStart,
      proseSpanEnd: a.proseSpanEnd,
      question: a.question,
      optionsJson: JSON.stringify(a.options),
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionEvidence: null,
      createdAt: now,
    });
  }

  // Update the deal to point at this extraction AND write back any scalar
  // structured fields the extractor produced with confidence. Recoups,
  // deduction order, walkout, and ratchet are NOT written here — those
  // require explicit booker confirmation via resolveAmbiguity (recoups)
  // or are populated by the Phase 2 extractor (walkout/ratchet/order).
  const t = result.structuredTerms;
  const scalarPatch: Partial<typeof deals.$inferInsert> = {
    currentExtractionId: extractionId,
    termsSource:
      result.mode === "live" ? "llm_extracted" : ctx.deal.termsSource,
  };
  if (t.dealType !== undefined) scalarPatch.dealType = t.dealType;
  if (t.guaranteeAmount !== undefined)
    scalarPatch.guaranteeAmount = t.guaranteeAmount;
  if (t.percentage !== undefined) scalarPatch.percentage = t.percentage;
  if (t.percentageBasis !== undefined)
    scalarPatch.percentageBasis = t.percentageBasis;
  if (t.expenseCap !== undefined) scalarPatch.expenseCap = t.expenseCap;
  if (t.hospitalityCap !== undefined)
    scalarPatch.hospitalityCap = t.hospitalityCap;
  if (t.walkout) scalarPatch.walkoutJson = JSON.stringify(t.walkout);
  if (t.ratchet) scalarPatch.ratchetJson = JSON.stringify(t.ratchet);
  if (t.bonuses) scalarPatch.bonusesJson = JSON.stringify(t.bonuses);

  await db.update(deals).set(scalarPatch).where(eq(deals.id, ctx.deal.id));

  revalidatePath(`/shows/${showId}/deal/capture`);
  return { ok: true as const, extractionId, mode: result.mode };
}

export async function resolveAmbiguity(
  ambiguityId: string,
  resolution: string,
  evidence?: string,
) {
  // Record the resolution on the ambiguity row.
  await db
    .update(dealAmbiguities)
    .set({
      resolution,
      resolvedBy: CURRENT_USER_ID,
      resolvedAt: new Date(),
      resolutionEvidence: evidence ?? null,
    })
    .where(eq(dealAmbiguities.id, ambiguityId));

  // Load the ambiguity to see what category it was and which deal it belongs to.
  const ambiguity = await db
    .select()
    .from(dealAmbiguities)
    .where(eq(dealAmbiguities.id, ambiguityId))
    .limit(1)
    .then((rows) => rows[0]);

  if (ambiguity) {
    // Phase 1 writeback: recoup_placement is the high-value case (Coastal
    // Spell). We translate the chosen option into a real recoup record
    // and the appropriate capped-bucket placement in deductionOrderJson.
    if (ambiguity.category === "recoup_placement") {
      const resolutionValue = inferResolutionValue(resolution);
      if (resolutionValue) {
        const deal = await db
          .select()
          .from(deals)
          .where(eq(deals.id, ambiguity.dealId))
          .limit(1)
          .then((rows) => rows[0]);

        if (deal) {
          const existingRecoups: Recoup[] = deal.recoupsAtDealTimeJson
            ? JSON.parse(deal.recoupsAtDealTimeJson)
            : [];
          const existingOrder: DeductionStep[] | null =
            deal.deductionOrderJson
              ? JSON.parse(deal.deductionOrderJson)
              : null;
          const basis = deal.percentageBasis ?? "net";

          const writeback = applyRecoupPlacementResolution(
            ambiguity.proseSpan,
            resolutionValue,
            existingRecoups,
            existingOrder,
            basis,
          );

          if (writeback) {
            await db
              .update(deals)
              .set({
                recoupsAtDealTimeJson: JSON.stringify(writeback.recoups),
                deductionOrderJson: JSON.stringify(writeback.deductionOrder),
                termsSource: "llm_extracted_then_edited",
              })
              .where(eq(deals.id, ambiguity.dealId));
          }
        }
      }
    }
    // Other categories (percentage_basis, expense_cap_scope, etc.) record
    // their resolution but don't yet rebuild structured fields. Phase 2.
  }

  revalidatePath("/shows", "layout");
  return { ok: true as const };
}

export async function sealByVenue(showId: string, extractionId: string) {
  // Look up the deal id from the show.
  const dealRow = await db
    .select({ id: deals.id, dealId: deals.id })
    .from(deals)
    .where(eq(deals.showId, showId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!dealRow) {
    return { ok: false as const, error: "Deal not found for show" };
  }

  const now = new Date();

  // Write the venue-side confirmation row.
  await db.insert(dealConfirmations).values({
    id: randomId("conf"),
    dealId: dealRow.id,
    extractionId,
    party: "venue",
    contactId: CURRENT_USER_ID,
    confirmedAt: now,
    confirmationMethod: "in_app",
    fieldsConfirmedJson: null,
  });

  // Mark the deal as venue-confirmed. (The agent-side confirmation +
  // final sealed state are Phase 2 — this captures the booker's "send for
  // confirmation" click per spec §3.)
  await db
    .update(deals)
    .set({ termsConfirmedByVenueAt: now })
    .where(eq(deals.id, dealRow.id));

  // Update the extraction's status to reflect that it's been sent for
  // agent confirmation. (No real magic-link flow yet; just state.)
  await db
    .update(dealTermsExtraction)
    .set({ status: "pending_confirmation" })
    .where(eq(dealTermsExtraction.id, extractionId));

  revalidatePath(`/shows/${showId}/deal/capture`);
  revalidatePath(`/shows/${showId}`);
  return { ok: true as const };
}
