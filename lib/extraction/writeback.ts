/**
 * Resolution write-back logic.
 *
 * When a booker resolves an ambiguity in the capture UI, the chosen
 * answer needs to translate into updates to deals.recoupsAtDealTimeJson
 * and deals.deductionOrderJson so the settlement engine has clean
 * structured terms to compute against.
 *
 * Phase 1 covers recoup_placement (the Coastal Spell case). Other
 * categories record the resolution but don't yet rebuild structured
 * fields — that's Phase 2 of the extractor / writeback.
 *
 * The capped-bucket schema (capture spec §4.2) is the architectural
 * crux: a recoup placed inside the cap is a MEMBER of the bucket;
 * outside the cap is a sibling line_item before/after the bucket.
 * Two visibly different JSON shapes, same prose source.
 */

import type { Recoup, DeductionStep } from "@/db/schema";

// Re-export for any caller that imports DeductionStep from here for
// historical reasons (e.g., the server action). New code should import
// directly from @/db/schema.
export type { DeductionStep };

/** Pattern-match a recoup amount + category from a prose span. */
function parseRecoupFromProse(prose: string): {
  amount: number;
  label: string;
  category: Recoup["category"];
} | null {
  // Common shapes: "marketing recoup of $900 against gross",
  //                "$900 marketing recoup off gross",
  //                "production recoup of $400".
  const patterns: { rx: RegExp; cat: Recoup["category"] }[] = [
    { rx: /\$?([\d,]+)\s+marketing\s+recoup/i, cat: "marketing" },
    { rx: /marketing\s+recoup\s+of\s+\$?([\d,]+)/i, cat: "marketing" },
    { rx: /\$?([\d,]+)\s+production\s+recoup/i, cat: "production_overage" },
    { rx: /production\s+recoup\s+of\s+\$?([\d,]+)/i, cat: "production_overage" },
    { rx: /\$?([\d,]+)\s+prior\s+advance/i, cat: "prior_advance" },
    { rx: /prior\s+advance\s+of\s+\$?([\d,]+)/i, cat: "prior_advance" },
    { rx: /\$?([\d,]+)\s+recoup/i, cat: "other" }, // generic fallback
  ];

  for (const { rx, cat } of patterns) {
    const m = prose.match(rx);
    if (m) {
      const amount = parseInt(m[1].replace(/,/g, ""), 10);
      if (!isNaN(amount)) {
        const labels: Record<Recoup["category"], string> = {
          marketing: "Marketing recoup",
          production_overage: "Production recoup",
          prior_advance: "Prior advance",
          hospitality_overage: "Hospitality overage",
          damages: "Damages",
          other: "Recoup",
        };
        return { amount, label: labels[cat], category: cat };
      }
    }
  }
  return null;
}

/**
 * Default deduction order for any vs / percentage_of_net deal with no
 * recoups: fees off the top, then all expenses inside the cap, then
 * apply the percentage. Per capture spec §7.4.
 */
function defaultDeductionOrder(basis: "gross" | "net"): DeductionStep[] {
  return [
    { kind: "line_item", id: "fees", ref: { type: "fees" } },
    {
      kind: "capped_bucket",
      id: "venue_expenses",
      capRef: "expenseCap",
      members: [
        {
          kind: "line_item",
          id: "expenses",
          ref: { type: "all_expenses_except_recoups" },
        },
      ],
    },
    { kind: "apply_percentage", basis },
  ];
}

/**
 * Given a resolved recoup_placement ambiguity, build the recoup record
 * and the updated deduction order that places the recoup inside or
 * outside the cap.
 *
 * Returns null if the prose can't be parsed (caller falls back to
 * recording the resolution text without building structured fields).
 */
export function applyRecoupPlacementResolution(
  prose: string,
  resolutionValue: "inside_cap" | "outside_cap",
  existingRecoups: Recoup[] = [],
  existingOrder: DeductionStep[] | null = null,
  basis: "gross" | "net" = "net",
): { recoups: Recoup[]; deductionOrder: DeductionStep[] } | null {
  const parsed = parseRecoupFromProse(prose);
  if (!parsed) return null;

  const recoupId = `rec_${parsed.category}_${Date.now().toString(36)}`;
  const newRecoup: Recoup = {
    id: recoupId,
    category: parsed.category,
    label: parsed.label,
    amount: parsed.amount,
    status: "agreed",
  };

  const recoups = [...existingRecoups, newRecoup];

  // Build the deduction order from scratch (or extend existing).
  // For simplicity, regenerate a fresh order that reflects the current
  // recoup placement decisions.
  const baseOrder = existingOrder ?? defaultDeductionOrder(basis);

  const recoupLineItem: DeductionStep = {
    kind: "line_item",
    id: `recoup_${recoupId}`,
    ref: { type: "recoup", recoupId },
  };

  let updatedOrder: DeductionStep[];

  if (resolutionValue === "inside_cap") {
    // Recoup goes INSIDE the capped_bucket as a member.
    updatedOrder = baseOrder.map((step) => {
      if (step.kind === "capped_bucket") {
        return {
          ...step,
          members: [...step.members, recoupLineItem],
        };
      }
      return step;
    });
  } else {
    // Recoup goes OUTSIDE the cap — as a sibling line_item BEFORE the bucket.
    const idx = baseOrder.findIndex((s) => s.kind === "capped_bucket");
    if (idx === -1) {
      // No bucket in order; just prepend before percentage step.
      const pctIdx = baseOrder.findIndex((s) => s.kind === "apply_percentage");
      updatedOrder = [
        ...baseOrder.slice(0, pctIdx),
        recoupLineItem,
        ...baseOrder.slice(pctIdx),
      ];
    } else {
      updatedOrder = [
        ...baseOrder.slice(0, idx),
        recoupLineItem,
        ...baseOrder.slice(idx),
      ];
    }
  }

  return { recoups, deductionOrder: updatedOrder };
}

/** Map an option label to the canonical resolutionValue we recognize. */
export function inferResolutionValue(
  label: string,
): "inside_cap" | "outside_cap" | null {
  const lower = label.toLowerCase();
  if (lower.includes("inside")) return "inside_cap";
  if (lower.includes("outside")) return "outside_cap";
  return null;
}
