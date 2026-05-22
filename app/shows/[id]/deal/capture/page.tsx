import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  shows,
  artists,
  agents,
  agencies,
  deals,
  venues,
  dealTermsExtraction,
  dealAmbiguities,
  venueLlmSettings,
} from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { CURRENT_VENUE_ID } from "@/lib/session";
import { CaptureClient } from "./capture-client";

export default async function DealCapturePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const ctx = await db
    .select({
      show: shows,
      deal: deals,
      venue: venues,
      artist: artists,
      agent: agents,
      agency: agencies,
    })
    .from(shows)
    .leftJoin(deals, eq(deals.showId, shows.id))
    .leftJoin(venues, eq(shows.venueId, venues.id))
    .leftJoin(artists, eq(shows.artistId, artists.id))
    .leftJoin(agents, eq(artists.agentId, agents.id))
    .leftJoin(agencies, eq(agents.agencyId, agencies.id))
    .where(eq(shows.id, id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!ctx?.show || !ctx.deal || !ctx.venue) notFound();

  // Load the most recent extraction for this deal (if any).
  const latest = await db
    .select()
    .from(dealTermsExtraction)
    .where(eq(dealTermsExtraction.dealId, ctx.deal.id))
    .orderBy(desc(dealTermsExtraction.version))
    .limit(1)
    .then((rows) => rows[0]);

  // Load ambiguities for the latest extraction.
  const ambiguities = latest
    ? await db
        .select()
        .from(dealAmbiguities)
        .where(eq(dealAmbiguities.extractionId, latest.id))
    : [];

  // Check whether the venue has an LLM key configured.
  const llmConfigured = await db
    .select({ venueId: venueLlmSettings.venueId })
    .from(venueLlmSettings)
    .where(eq(venueLlmSettings.venueId, CURRENT_VENUE_ID))
    .limit(1)
    .then((rows) => rows.length > 0);

  const initialProse =
    latest?.sourceText ?? ctx.deal.dealNotesFreetext ?? "";

  return (
    <div className="px-12 py-10 max-w-7xl">
      <div className="mb-6">
        <Link
          href={`/shows/${id}`}
          className="inline-flex items-center gap-1.5 text-[13px] text-ink-500 hover:text-ink-800"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to show
        </Link>
      </div>

      <div className="mb-10">
        <div className="eyebrow mb-3">
          {ctx.artist?.name} · {ctx.venue.name} ·{" "}
          {new Date(ctx.show.date).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </div>
        <h1
          className="font-display text-[40px] font-medium text-ink-900 leading-[1.05]"
          style={{ letterSpacing: "-0.025em", fontOpticalSizing: "auto" }}
        >
          Capture deal terms
        </h1>
        <p className="text-[14px] text-ink-500 mt-3 max-w-2xl leading-relaxed">
          Paste the deal email from{" "}
          {ctx.agent?.name ?? "the agent"}
          {ctx.agency ? ` (${ctx.agency.name})` : ""}. Greenroom will extract
          the structured terms and flag anything ambiguous — questions you can
          send back to clarify before the show.
        </p>
      </div>

      <CaptureClient
        showId={id}
        initialProse={initialProse}
        llmConfigured={llmConfigured}
        existingExtraction={
          latest
            ? {
                id: latest.id,
                mode: latest.mode,
                version: latest.version,
                status: latest.status,
                overallConfidence: latest.confidence ?? 0,
                extractedAt: latest.extractedAt.toISOString(),
                result: JSON.parse(latest.extractedJson),
              }
            : null
        }
        existingAmbiguities={ambiguities.map((a) => ({
          id: a.id,
          category: a.category,
          proseSpan: a.proseSpan,
          question: a.question,
          options: a.optionsJson ? JSON.parse(a.optionsJson) : [],
          resolution: a.resolution,
          resolvedAt: a.resolvedAt?.toISOString() ?? null,
        }))}
        venueConfirmedAt={ctx.deal.termsConfirmedByVenueAt?.toISOString() ?? null}
      />
    </div>
  );
}
