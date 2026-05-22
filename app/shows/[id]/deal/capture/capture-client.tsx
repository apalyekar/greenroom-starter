"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Settings,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  extractDealTerms,
  resolveAmbiguity,
  sealByVenue,
} from "./actions";
import type { ExtractionResult } from "@/lib/extraction/types";

type Ambiguity = {
  id: string;
  category: string;
  proseSpan: string;
  question: string;
  options: { label: string; value: string }[];
  resolution: string | null;
  resolvedAt: string | null;
};

type ExistingExtraction = {
  id: string;
  mode: "live" | "stub";
  version: number;
  status: string;
  overallConfidence: number;
  extractedAt: string;
  result: ExtractionResult;
};

type Props = {
  showId: string;
  initialProse: string;
  llmConfigured: boolean;
  existingExtraction: ExistingExtraction | null;
  existingAmbiguities: Ambiguity[];
  venueConfirmedAt: string | null;
};

export function CaptureClient({
  showId,
  initialProse,
  llmConfigured,
  existingExtraction,
  existingAmbiguities,
  venueConfirmedAt,
}: Props) {
  const [prose, setProse] = useState(initialProse);
  const [extraction, setExtraction] = useState<ExistingExtraction | null>(
    existingExtraction,
  );
  const [ambiguities, setAmbiguities] = useState<Ambiguity[]>(
    existingAmbiguities,
  );
  const [confirmed, setConfirmed] = useState<boolean>(!!venueConfirmedAt);
  const [isExtracting, startExtract] = useTransition();
  const [isSealing, startSeal] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const onExtract = () => {
    setErrorMsg(null);
    startExtract(async () => {
      const result = await extractDealTerms(showId, prose);
      if (!result.ok) {
        setErrorMsg(result.error);
        return;
      }
      // Server returned successfully — reload to pick up new extraction state.
      // Simpler than threading the full result through; revalidatePath
      // already invalidated the page.
      window.location.reload();
    });
  };

  const onResolve = (
    ambiguityId: string,
    resolution: string,
    evidence?: string,
  ) => {
    startExtract(async () => {
      await resolveAmbiguity(ambiguityId, resolution, evidence);
      setAmbiguities((prev) =>
        prev.map((a) =>
          a.id === ambiguityId
            ? { ...a, resolution, resolvedAt: new Date().toISOString() }
            : a,
        ),
      );
    });
  };

  const onSeal = () => {
    if (!extraction) return;
    startSeal(async () => {
      const result = await sealByVenue(showId, extraction.id);
      if (result.ok) setConfirmed(true);
    });
  };

  const unresolvedCount = ambiguities.filter((a) => !a.resolution).length;

  return (
    <div className="space-y-6">
      {/* Status banners */}
      {!llmConfigured && (
        <Banner tone="warn">
          <Sparkles className="w-4 h-4 shrink-0" />
          <div>
            <strong>AI extraction not configured.</strong> Set up an Anthropic
            key in{" "}
            <Link
              href="/settings/llm"
              className="text-brand-700 hover:underline inline-flex items-center gap-1"
            >
              <Settings className="w-3 h-3" /> AI configuration
            </Link>{" "}
            to enable automatic extraction. You can still capture terms
            manually for now.
          </div>
        </Banner>
      )}

      {extraction?.mode === "stub" && (
        <Banner tone="warn">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <div>
            <strong>Placeholder extraction.</strong> Showing stub data — no real
            AI call was made. Configure a key to enable real extraction.
          </div>
        </Banner>
      )}

      {confirmed && (
        <Banner tone="ok">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <div>
            <strong>Sent for agent confirmation.</strong> Venue side of the
            Deal Sheet is sealed. (Magic-link agent flow is Phase 2; for now,
            forward the Deal Sheet by your usual channel.)
          </div>
        </Banner>
      )}

      {errorMsg && (
        <Banner tone="error">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <div>{errorMsg}</div>
        </Banner>
      )}

      {/* Two-pane layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left pane: prose */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-medium text-ink-700 uppercase tracking-[0.08em]">
              Deal email
            </h2>
            {extraction && (
              <span className="text-[11px] text-ink-400">
                v{extraction.version} ·{" "}
                {new Date(extraction.extractedAt).toLocaleString()}
              </span>
            )}
          </div>
          <textarea
            value={prose}
            onChange={(e) => setProse(e.target.value)}
            placeholder="Paste the deal email here..."
            className="w-full min-h-[420px] p-4 rounded-xl border border-ink-200/60 bg-white font-mono text-[13px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-700 focus:border-brand-700"
            disabled={confirmed}
          />
          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="brand"
              onClick={onExtract}
              disabled={isExtracting || !prose.trim() || confirmed}
            >
              {isExtracting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Extracting…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  {extraction ? "Re-extract" : "Extract terms"}
                </>
              )}
            </Button>
            {extraction && (
              <span className="text-[12px] text-ink-500">
                Confidence:{" "}
                <span className="font-mono tabular">
                  {(extraction.overallConfidence * 100).toFixed(0)}%
                </span>
              </span>
            )}
          </div>
        </div>

        {/* Right pane: extracted terms + ambiguities */}
        <div>
          <h2 className="text-[13px] font-medium text-ink-700 uppercase tracking-[0.08em] mb-3">
            Structured terms
          </h2>
          {extraction ? (
            <StructuredTermsView terms={extraction.result.structuredTerms} />
          ) : (
            <div className="rounded-xl border border-dashed border-ink-200 bg-ink-50/30 p-8 text-center text-[13px] text-ink-500">
              Click <strong>Extract terms</strong> to populate this panel.
            </div>
          )}
        </div>
      </div>

      {/* Ambiguities section */}
      {ambiguities.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[13px] font-medium text-ink-700 uppercase tracking-[0.08em]">
              Questions for the agent
            </h2>
            <span className="text-[12px] text-ink-500">
              {unresolvedCount} unresolved · {ambiguities.length - unresolvedCount}{" "}
              answered
            </span>
          </div>
          <div className="space-y-4">
            {ambiguities.map((a) => (
              <AmbiguityCard key={a.id} ambiguity={a} onResolve={onResolve} />
            ))}
          </div>
        </div>
      )}

      {/* Send for confirmation */}
      {extraction && !confirmed && (
        <div className="mt-10 pt-8 border-t border-ink-200/50 flex items-center justify-between">
          <div className="text-[13px] text-ink-600 max-w-lg">
            When you&apos;ve resolved what you can, send the Deal Sheet to the
            agent. The remaining {unresolvedCount} open question
            {unresolvedCount === 1 ? "" : "s"} will be visible to them too.
          </div>
          <Button
            variant="brand"
            size="lg"
            onClick={onSeal}
            disabled={isSealing}
          >
            {isSealing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Sealing…
              </>
            ) : (
              <>
                <Send className="w-4 h-4" /> Send for confirmation
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function Banner({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "warn" | "ok" | "error";
}) {
  const cls =
    tone === "warn"
      ? "bg-amber-50 border-amber-200 text-amber-900"
      : tone === "ok"
        ? "bg-emerald-50 border-emerald-200 text-emerald-900"
        : "bg-rose-50 border-rose-200 text-rose-900";
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-[13px] ${cls}`}
    >
      {children}
    </div>
  );
}

function StructuredTermsView({
  terms,
}: {
  terms: ExtractionResult["structuredTerms"];
}) {
  const rows: { label: string; value: React.ReactNode }[] = [];

  if (terms.dealType)
    rows.push({
      label: "Deal type",
      value: <span className="font-mono">{terms.dealType}</span>,
    });
  if (terms.guaranteeAmount != null)
    rows.push({
      label: "Guarantee",
      value: `$${terms.guaranteeAmount.toLocaleString()}`,
    });
  if (terms.percentage != null)
    rows.push({
      label: "Percentage",
      value: `${(terms.percentage * 100).toFixed(0)}%${terms.percentageBasis ? ` of ${terms.percentageBasis}` : ""}`,
    });
  if (terms.expenseCap != null)
    rows.push({
      label: "Expense cap",
      value: `$${terms.expenseCap.toLocaleString()}`,
    });
  if (terms.hospitalityCap != null)
    rows.push({
      label: "Hospitality cap",
      value: `$${terms.hospitalityCap.toLocaleString()}`,
    });
  if (terms.walkout)
    rows.push({
      label: "Walkout",
      value: (
        <div className="text-[12px]">
          {terms.walkout.basis} ·{" "}
          {terms.walkout.breakevenFormula ?? "breakeven unspecified"}
          {terms.walkout.potThreshold != null
            ? ` · pot @ $${terms.walkout.potThreshold.toLocaleString()}`
            : ""}{" "}
          · {(terms.walkout.artistShareAbove * 100).toFixed(0)}% above
        </div>
      ),
    });
  if (terms.ratchet)
    rows.push({
      label: "Ratchet",
      value: (
        <div className="text-[12px]">
          Base {(terms.ratchet.basePercentage * 100).toFixed(0)}% of{" "}
          {terms.ratchet.basis}; {terms.ratchet.tiers.length} tier
          {terms.ratchet.tiers.length === 1 ? "" : "s"}
        </div>
      ),
    });
  if (terms.bonuses && terms.bonuses.length > 0)
    rows.push({
      label: "Bonuses",
      value: (
        <div className="space-y-1 text-[12px]">
          {terms.bonuses.map((b, i) => (
            <div key={i}>
              {b.label}{" "}
              <span className="text-ink-400 font-mono">({b.type})</span>
            </div>
          ))}
        </div>
      ),
    });
  if (terms.recoupsAtDealTime && terms.recoupsAtDealTime.length > 0)
    rows.push({
      label: "Recoups",
      value: (
        <div className="space-y-1 text-[12px]">
          {terms.recoupsAtDealTime.map((r, i) => (
            <div key={i}>
              {r.label}: ${r.amount.toLocaleString()}{" "}
              <span className="text-ink-400">
                ({r.relativeTo},{" "}
                {r.insideExpenseCap ? "inside cap" : "outside cap"})
              </span>
            </div>
          ))}
        </div>
      ),
    });

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-5 text-[13px] text-amber-900">
        No structured terms were extracted with high confidence. Review the
        questions below — every field that the prose didn&apos;t pin down
        cleanly was flagged instead of guessed.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-ink-200/60 bg-white divide-y divide-ink-100">
      {rows.map((row, i) => (
        <div
          key={i}
          className="px-5 py-3 grid grid-cols-[140px_1fr] gap-4 items-start"
        >
          <div className="text-[11px] font-medium text-ink-400 uppercase tracking-[0.08em] pt-1">
            {row.label}
          </div>
          <div className="text-[14px] text-ink-900">{row.value}</div>
        </div>
      ))}
    </div>
  );
}

function AmbiguityCard({
  ambiguity,
  onResolve,
}: {
  ambiguity: Ambiguity;
  onResolve: (id: string, resolution: string, evidence?: string) => void;
}) {
  const [customResolution, setCustomResolution] = useState("");
  const isResolved = !!ambiguity.resolution;

  return (
    <div
      className={[
        "rounded-xl border p-5 transition-colors",
        isResolved
          ? "bg-emerald-50/30 border-emerald-200/60"
          : "bg-white border-ink-200/60",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        {isResolved ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
        ) : (
          <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-medium text-ink-500 uppercase tracking-[0.08em] font-mono">
              {ambiguity.category}
            </span>
            {isResolved && (
              <span className="text-[11px] text-emerald-700">Resolved</span>
            )}
          </div>
          <blockquote className="text-[12px] text-ink-600 italic border-l-2 border-ink-200 pl-3 mb-3">
            &ldquo;{ambiguity.proseSpan}&rdquo;
          </blockquote>
          <p className="text-[13px] text-ink-800 leading-relaxed mb-4">
            {ambiguity.question}
          </p>

          {isResolved ? (
            <div className="text-[13px] text-emerald-800 bg-emerald-50 rounded-md px-3 py-2">
              <strong>Answer:</strong> {ambiguity.resolution}
            </div>
          ) : (
            <div className="space-y-2">
              {ambiguity.options.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onResolve(ambiguity.id, opt.label)}
                  className="block w-full text-left text-[13px] text-ink-800 rounded-md px-3 py-2 border border-ink-200 bg-white hover:bg-ink-50 hover:border-ink-300 transition-colors"
                >
                  {opt.label}
                </button>
              ))}
              {ambiguity.options.length === 0 && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customResolution}
                    onChange={(e) => setCustomResolution(e.target.value)}
                    placeholder="Type your answer…"
                    className="flex-1 h-9 px-3 rounded-md border border-ink-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-700 focus:border-brand-700"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (customResolution.trim()) {
                        onResolve(ambiguity.id, customResolution.trim());
                        setCustomResolution("");
                      }
                    }}
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
