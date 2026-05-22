/**
 * Settlement engine.
 *
 * Computes the money owed to an artist after a show. Implements the engine
 * design in capture spec §7. The prime directive (§1.1): every component
 * computes from explicit structured terms and never guesses silently. When
 * the source does not pin something down, the engine surfaces the gap
 * (`linesSkipped`) rather than picking a number.
 *
 * Supports all five deal types — flat, percentage_of_gross, percentage_of_net,
 * vs (with walkout / ratchet / vs-gross variants), door — plus bonuses,
 * comps that count toward gross, recoups with deal-time vs settlement-time
 * precedence, approved-expense filtering, and the capped-bucket deduction
 * waterfall.
 *
 * The engine runs even on unsealed deals and returns `dealTermsConfirmed:
 * false` so the worksheet can mark the result "preliminary." Useful and
 * honest beats obstructive (Q10 lock-in).
 */

import type {
  Deal,
  Expense,
  TicketSale,
  Comp,
  Bonus,
  Recoup,
  DeductionStep,
  Walkout,
  Ratchet,
} from "@/db/schema";

// -------- Return shape --------

export type StepSourceType =
  | "deal_field"
  | "expense"
  | "ticket_sale"
  | "comp"
  | "bonus"
  | "recoup"
  | "computed";

export type CalcStep = {
  label: string;
  value: number;
  note?: string;
  sourceType?: StepSourceType;
  sourceId?: string;
};

export type LineSkipped = {
  label: string;
  reason: string;
  /**
   * FK to deal_ambiguities if the gap corresponds to a flagged ambiguity;
   * omitted for structural skips (deprecated bonus type, null
   * deductionOrderJson, capacity unknown for ratchet, etc.).
   */
  ambiguityId?: string;
};

export type SettlementCalculation =
  | {
      supported: true;
      // Box office
      grossBoxOffice: number; // includes counted comps × faceValue
      grossLessFees: number; // renamed from netBoxOffice
      // Expenses
      rawExpenses: number;
      cappedExpenses: number;
      pendingExpenses: number;
      hospitalityExpenses: number;
      hospitalityOverage: number;
      expenseOverage: number;
      // Door-only (zero unless dealType = "door")
      doorReceipts: number;
      // Payout
      totalToArtist: number;
      // Trace
      steps: CalcStep[];
      finalFormula: string;
      bonusesApplied: { label: string; amount: number; reason: string }[];
      bonusesNotTriggered: { label: string; amount: number; reason: string }[];
      // Honesty signals
      dealTermsConfirmed: boolean;
      linesSkipped: LineSkipped[];
      preliminaryConfidence: "high" | "medium" | "low";
    }
  | {
      supported: false;
      reason: string;
      dealType: Deal["dealType"];
    };

export type CalcInput = {
  deal: Deal;
  ticketSales: TicketSale[];
  expenses: Expense[];
  comps?: Comp[];
  venueCapacity?: number;
  ticketsSold?: number;
};

// -------- Parsers --------

export function parseBonuses(deal: Deal): Bonus[] {
  if (!deal.bonusesJson) return [];
  try {
    const parsed = JSON.parse(deal.bonusesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseDeductionOrder(deal: Deal): DeductionStep[] | null {
  if (!deal.deductionOrderJson) return null;
  try {
    const parsed = JSON.parse(deal.deductionOrderJson);
    return Array.isArray(parsed) ? (parsed as DeductionStep[]) : null;
  } catch {
    return null;
  }
}

function parseWalkout(deal: Deal): Walkout | null {
  if (!deal.walkoutJson) return null;
  try {
    return JSON.parse(deal.walkoutJson) as Walkout;
  } catch {
    return null;
  }
}

function parseRatchet(deal: Deal): Ratchet | null {
  if (!deal.ratchetJson) return null;
  try {
    return JSON.parse(deal.ratchetJson) as Ratchet;
  } catch {
    return null;
  }
}

function parseRecoupsAtDealTime(deal: Deal): Recoup[] {
  if (!deal.recoupsAtDealTimeJson) return [];
  try {
    const parsed = JSON.parse(deal.recoupsAtDealTimeJson);
    return Array.isArray(parsed) ? (parsed as Recoup[]) : [];
  } catch {
    return [];
  }
}

// -------- Common math (capture spec §7.2) --------

type CommonMath = {
  ticketGross: number;
  countedCompsValue: number;
  grossBoxOffice: number;
  totalFees: number;
  grossLessFees: number;
  rawExpenses: number;
  pendingExpenses: number;
  hospitalityExpenses: number;
  cappedHospitality: number;
  hospitalityOverage: number;
  doorReceipts: number;
  tickets: number;
  recoups: Recoup[];
};

function computeCommonMath(input: CalcInput): CommonMath {
  const { deal, ticketSales, expenses, comps = [], ticketsSold } = input;

  const ticketGross = ticketSales.reduce((s, t) => s + t.gross, 0);
  const countedCompsValue = comps
    .filter((c) => c.countsTowardGross)
    .reduce((s, c) => s + c.count * c.faceValue, 0);
  const grossBoxOffice = ticketGross + countedCompsValue;

  const totalFees = ticketSales.reduce((s, t) => s + t.fees, 0);
  const grossLessFees = grossBoxOffice - totalFees;

  // §7.6.4: approved-only counts toward the headline number.
  const venueBorne = expenses.filter((e) => !e.absorbedByVenue);
  const approved = venueBorne.filter((e) => e.approved);
  const pending = venueBorne.filter((e) => !e.approved);
  const rawExpenses = approved.reduce((s, e) => s + e.amount, 0);
  const pendingExpenses = pending.reduce((s, e) => s + e.amount, 0);

  // §7.6.5: hospitality default = separate cap. Engine applies
  // min(hospitalityActual, hospitalityCap) outside the deduction waterfall.
  const hospitalityExpenses = approved
    .filter((e) => e.category === "hospitality")
    .reduce((s, e) => s + e.amount, 0);
  const cappedHospitality = Math.min(
    hospitalityExpenses,
    deal.hospitalityCap ?? Infinity,
  );
  const hospitalityOverage = hospitalityExpenses - cappedHospitality;

  // Door deal source.
  const doorReceipts = ticketSales
    .filter((t) => t.source === "door")
    .reduce((s, t) => s + t.gross, 0);

  const tickets = ticketsSold ?? ticketSales.reduce((s, t) => s + t.qty, 0);

  // Recoups: deal-time initializes; settlement-time (not yet implemented as
  // a separate read here — would replace deal-time at settle time per §7.6.3)
  const recoups = parseRecoupsAtDealTime(deal);

  return {
    ticketGross,
    countedCompsValue,
    grossBoxOffice,
    totalFees,
    grossLessFees,
    rawExpenses,
    pendingExpenses,
    hospitalityExpenses,
    cappedHospitality,
    hospitalityOverage,
    doorReceipts,
    tickets,
    recoups,
  };
}

// -------- Deduction waterfall walker (§7.4) --------

/**
 * Default deduction order when the deal has none. Per spec §7.4:
 * [fees, capped_bucket(all_expenses_except_recoups), apply_percentage].
 * Conservative — no recoups extracted means no recoup deductions.
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

type WaterfallResult = {
  running: number; // post-deductions, pre-percentage
  pctPayout: number; // basis × percentage (basis determined by apply_percentage step)
  steps: CalcStep[];
  hospitalityCountedInBucket: boolean; // if true, common math should NOT also deduct hospitality
};

function resolveLineItemAmount(
  step: Extract<DeductionStep, { kind: "line_item" }>,
  ctx: {
    deal: Deal;
    expenses: Expense[];
    fees: number;
    recoups: Recoup[];
  },
): { amount: number; sourceType: StepSourceType; sourceId?: string } {
  const ref = step.ref;
  if (ref.type === "fees") {
    return { amount: ctx.fees, sourceType: "computed", sourceId: "ticket_fees" };
  }
  if (ref.type === "recoup") {
    const r = ctx.recoups.find((x) => x.id === ref.recoupId);
    return {
      amount: r?.amount ?? 0,
      sourceType: "recoup",
      sourceId: ref.recoupId,
    };
  }
  if (ref.type === "expense_categories") {
    const cats = new Set(ref.categories);
    const amount = ctx.expenses
      .filter(
        (e) => !e.absorbedByVenue && e.approved && cats.has(e.category),
      )
      .reduce((s, e) => s + e.amount, 0);
    return { amount, sourceType: "computed", sourceId: step.id };
  }
  // all_expenses_except_recoups: per §7.6.5 default, hospitality has its own
  // separate cap — engine deducts it outside the waterfall. So this ref
  // excludes hospitality too unless the deal has no hospitalityCap (in which
  // case hospitality is just a regular expense).
  const hospitalityHasOwnCap = ctx.deal.hospitalityCap != null;
  const amount = ctx.expenses
    .filter(
      (e) =>
        !e.absorbedByVenue &&
        e.approved &&
        (!hospitalityHasOwnCap || e.category !== "hospitality"),
    )
    .reduce((s, e) => s + e.amount, 0);
  return { amount, sourceType: "computed", sourceId: step.id };
}

function walkDeductionWaterfall(
  order: DeductionStep[],
  ctx: {
    deal: Deal;
    expenses: Expense[];
    grossBoxOffice: number;
    fees: number;
    recoups: Recoup[];
    cappedHospitality: number; // engine-deducted separately unless hospitality is in bucket
  },
): WaterfallResult {
  let running = ctx.grossBoxOffice;
  const steps: CalcStep[] = [];
  let pctPayout = 0;
  let hospitalityCountedInBucket = false;

  for (const step of order) {
    if (step.kind === "line_item") {
      const { amount, sourceType, sourceId } = resolveLineItemAmount(step, ctx);
      running -= amount;
      steps.push({
        label: step.id,
        value: -amount,
        sourceType,
        sourceId,
      });
    } else if (step.kind === "capped_bucket") {
      const cap = ctx.deal[step.capRef] ?? Infinity;

      // Track per-member breakdown for the step note + detect hospitality membership.
      const memberAmounts: { id: string; amount: number }[] = [];
      let bucketHospitality = 0;
      for (const m of step.members) {
        if (m.kind !== "line_item") continue; // nested buckets not supported in Phase 1
        const { amount } = resolveLineItemAmount(m, ctx);
        memberAmounts.push({ id: m.id, amount });

        if (m.ref.type === "expense_categories" && m.ref.categories.includes("hospitality")) {
          bucketHospitality += amount;
          hospitalityCountedInBucket = true;
        }
      }
      const memberTotal = memberAmounts.reduce((s, x) => s + x.amount, 0);
      const cappedTotal = Math.min(memberTotal, cap);
      const overage = Math.max(0, memberTotal - cap);

      running -= cappedTotal;
      steps.push({
        label: `${step.id} (capped @ ${cap === Infinity ? "no cap" : `$${cap.toLocaleString()}`})`,
        value: -cappedTotal,
        note:
          overage > 0
            ? `Members totaled $${memberTotal.toLocaleString()}; venue absorbs $${overage.toLocaleString()} overage`
            : `Members: ${memberAmounts.map((m) => `${m.id} $${m.amount.toLocaleString()}`).join(", ")}`,
        sourceType: "computed",
        sourceId: step.id,
      });
    } else if (step.kind === "apply_percentage") {
      const basis = step.basis === "gross" ? ctx.grossBoxOffice : running;
      const pct = ctx.deal.percentage ?? 0;
      pctPayout = basis * pct;
      steps.push({
        label: `× ${(pct * 100).toFixed(0)}% of ${step.basis}`,
        value: pctPayout,
        note: `Basis: $${basis.toLocaleString()}`,
        sourceType: "deal_field",
        sourceId: "percentage",
      });
    }
  }

  return { running, pctPayout, steps, hospitalityCountedInBucket };
}

// -------- Bonus application (§7.6.1) --------

type BonusContext = {
  gross: number;
  net: number;
  tickets: number;
  capacity?: number;
};

type AppliedBonus = { label: string; amount: number; reason: string };

function applyBonuses(
  bonuses: Bonus[],
  ctx: BonusContext,
): {
  applied: AppliedBonus[];
  notTriggered: AppliedBonus[];
  totalApplied: number;
  skipped: LineSkipped[];
} {
  const applied: AppliedBonus[] = [];
  const notTriggered: AppliedBonus[] = [];
  const skipped: LineSkipped[] = [];

  // Group gross_threshold bonuses for stacking resolution.
  const grossThresholdTriggered: { bonus: Extract<Bonus, { type: "gross_threshold" }>; amount: number }[] = [];

  for (const b of bonuses) {
    if (b.type === "gross_threshold") {
      if (ctx.gross >= b.threshold) {
        grossThresholdTriggered.push({ bonus: b, amount: b.amount });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross $${ctx.gross.toLocaleString()} < $${b.threshold.toLocaleString()}`,
        });
      }
    } else if (b.type === "sellout") {
      if (ctx.capacity != null && ctx.tickets >= ctx.capacity * 0.95) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} of ${ctx.capacity} sold (≥95%)`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason:
            ctx.capacity != null
              ? `${ctx.tickets} of ${ctx.capacity} sold (sellout = ≥95%)`
              : "Capacity unknown — can't evaluate",
        });
      }
    } else if (b.type === "attendance_threshold") {
      if (ctx.tickets >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} ≥ ${b.threshold}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} < ${b.threshold}`,
        });
      }
    } else if (b.type === "tier_ratchet") {
      // §7.9 Phase 1: deprecated; emit linesSkipped rather than silently
      // dropping or applying as additive. Migration to ratchetJson is Phase 2.
      skipped.push({
        label: b.label,
        reason:
          "Deprecated bonus type (tier_ratchet) — migrate to ratchetJson; computation skipped",
      });
    }
  }

  // Resolve gross_threshold stacking (§7.6.1, Q5 lock-in).
  // If all triggered bonuses have stacks=true, pay them all.
  // Otherwise, pay only the highest-amount one.
  if (grossThresholdTriggered.length > 0) {
    const allStack = grossThresholdTriggered.every(
      (g) => g.bonus.stacks === true,
    );
    if (allStack) {
      for (const g of grossThresholdTriggered) {
        applied.push({
          label: g.bonus.label,
          amount: g.amount,
          reason: `Gross $${ctx.gross.toLocaleString()} ≥ $${g.bonus.threshold.toLocaleString()} (stacking)`,
        });
      }
    } else {
      // Non-stacking default: only the highest triggered bonus pays.
      const sorted = [...grossThresholdTriggered].sort(
        (a, b) => b.amount - a.amount,
      );
      const winner = sorted[0];
      applied.push({
        label: winner.bonus.label,
        amount: winner.amount,
        reason: `Gross $${ctx.gross.toLocaleString()} ≥ $${winner.bonus.threshold.toLocaleString()} (non-stacking; highest tier wins)`,
      });
      for (const g of sorted.slice(1)) {
        notTriggered.push({
          label: g.bonus.label,
          amount: g.amount,
          reason: "Outranked by higher-tier bonus that also triggered (non-stacking)",
        });
      }
    }
  }

  const totalApplied = applied.reduce((s, b) => s + b.amount, 0);
  return { applied, notTriggered, totalApplied, skipped };
}

// -------- Ratchet (§7.5.3) --------

function applyRatchet(
  ratchet: Ratchet,
  ctx: { grossBoxOffice: number; net: number; tickets: number; capacity?: number },
): { effectivePercentage: number; triggeredTier: Ratchet["tiers"][number] | null; skipped: LineSkipped | null } {
  let effective = ratchet.basePercentage;
  let triggered: Ratchet["tiers"][number] | null = null;
  const sorted = [...ratchet.tiers].sort((a, b) => a.triggerValue - b.triggerValue);

  for (const tier of sorted) {
    let actual: number;
    if (tier.triggerType === "capacity_pct") {
      if (ctx.capacity == null || ctx.capacity === 0) {
        return {
          effectivePercentage: ratchet.basePercentage,
          triggeredTier: null,
          skipped: {
            label: "Ratchet tier",
            reason:
              "triggerType is capacity_pct but venue capacity is unknown — skipping ratchet",
          },
        };
      }
      actual = ctx.tickets / ctx.capacity;
    } else if (tier.triggerType === "gross_amount") {
      actual = ctx.grossBoxOffice;
    } else if (tier.triggerType === "net_amount") {
      actual = ctx.net;
    } else {
      // attendance
      actual = ctx.tickets;
    }

    if (actual >= tier.triggerValue) {
      effective = tier.newPercentage;
      triggered = tier;
    }
  }

  return { effectivePercentage: effective, triggeredTier: triggered, skipped: null };
}

// -------- Walkout (§7.5.2) --------

function applyWalkout(
  walkout: Walkout,
  ctx: {
    grossBoxOffice: number;
    guarantee: number;
    cappedExpenses: number;
  },
): { walkoutShare: number; skipped: LineSkipped | null; note: string } {
  // Determine breakeven.
  let breakeven: number;
  if (walkout.potThreshold != null) {
    // Explicit threshold overrides formula.
    breakeven = walkout.potThreshold;
  } else if (walkout.breakevenFormula === "guarantee+expenses") {
    breakeven = ctx.guarantee + ctx.cappedExpenses;
  } else if (walkout.breakevenFormula === "guarantee_only") {
    breakeven = ctx.guarantee;
  } else {
    // null formula AND no potThreshold → refuse to compute.
    return {
      walkoutShare: 0,
      skipped: {
        label: "Walkout payout",
        reason:
          "walkout breakevenFormula is null and no explicit potThreshold — needs agent confirmation",
      },
      note: "",
    };
  }

  if (ctx.grossBoxOffice > breakeven) {
    const share = walkout.artistShareAbove * (ctx.grossBoxOffice - breakeven);
    return {
      walkoutShare: share,
      skipped: null,
      note: `Gross $${ctx.grossBoxOffice.toLocaleString()} > breakeven $${breakeven.toLocaleString()}; artist gets ${(walkout.artistShareAbove * 100).toFixed(0)}% of $${(ctx.grossBoxOffice - breakeven).toLocaleString()}`,
    };
  }
  return {
    walkoutShare: 0,
    skipped: null,
    note: `Gross $${ctx.grossBoxOffice.toLocaleString()} did not exceed breakeven $${breakeven.toLocaleString()}`,
  };
}

// -------- Confidence aggregation (§7.7) --------

function computeConfidence(
  dealTermsConfirmed: boolean,
  linesSkipped: LineSkipped[],
): "high" | "medium" | "low" {
  const hasLoadBearingSkip = linesSkipped.some((l) =>
    /walkout|percentage|ratchet/i.test(l.label),
  );
  if (linesSkipped.length > 0 && hasLoadBearingSkip) return "low";
  if (!dealTermsConfirmed || linesSkipped.length > 0) return "medium";
  return "high";
}

// -------- Main dispatcher --------

export function calculateSettlement(input: CalcInput): SettlementCalculation {
  const { deal } = input;
  const common = computeCommonMath(input);

  // Door deal is special-cased — no waterfall, just percentage of door receipts.
  if (deal.dealType === "door") {
    return computeDoor(input, common);
  }

  // Flat deal — guarantee + bonuses, no waterfall.
  if (deal.dealType === "flat") {
    return computeFlat(input, common);
  }

  // percentage_of_gross — no expenses, just gross × percentage.
  if (deal.dealType === "percentage_of_gross") {
    return computePctGross(input, common);
  }

  // vs (with all variants) and percentage_of_net — run the waterfall.
  return computeVsOrPctNet(input, common);
}

function dealTermsConfirmed(deal: Deal): boolean {
  // Per §7.1: confirmed when the Deal Sheet is sealed. Until Phase 2
  // magic-link, only demo-seeded deals get sealed/confirmed status.
  return deal.termsSealedAt != null || deal.termsConfirmedByVenueAt != null;
}

// -------- Per-deal-type handlers --------

function computeFlat(input: CalcInput, common: CommonMath): SettlementCalculation {
  const { deal } = input;
  if (deal.guaranteeAmount == null) {
    return {
      supported: false,
      reason: "Flat deal is missing a guarantee amount.",
      dealType: deal.dealType,
    };
  }

  const bonusResult = applyBonuses(parseBonuses(deal), {
    gross: common.grossBoxOffice,
    net: common.grossLessFees, // flat doesn't use net but pass anyway
    tickets: common.tickets,
    capacity: input.venueCapacity,
  });

  const total = deal.guaranteeAmount + bonusResult.totalApplied;
  const steps: CalcStep[] = [
    {
      label: "Flat guarantee",
      value: deal.guaranteeAmount,
      note: "No expense deductions. The guarantee is the floor.",
      sourceType: "deal_field",
      sourceId: "guaranteeAmount",
    },
    ...bonusResult.applied.map((b) => ({
      label: b.label,
      value: b.amount,
      note: b.reason,
      sourceType: "bonus" as const,
    })),
  ];

  const linesSkipped = bonusResult.skipped;
  const confirmed = dealTermsConfirmed(deal);

  return {
    supported: true,
    grossBoxOffice: common.grossBoxOffice,
    grossLessFees: common.grossLessFees,
    rawExpenses: common.rawExpenses,
    cappedExpenses: 0, // flat deals don't deduct expenses from artist payout
    pendingExpenses: common.pendingExpenses,
    hospitalityExpenses: common.hospitalityExpenses,
    hospitalityOverage: common.hospitalityOverage,
    expenseOverage: 0,
    doorReceipts: common.doorReceipts,
    totalToArtist: total,
    steps,
    finalFormula:
      bonusResult.applied.length > 0
        ? `flat ${deal.guaranteeAmount} + bonuses ${bonusResult.totalApplied} = ${total.toFixed(2)}`
        : `flat guarantee = ${deal.guaranteeAmount}`,
    bonusesApplied: bonusResult.applied,
    bonusesNotTriggered: bonusResult.notTriggered,
    dealTermsConfirmed: confirmed,
    linesSkipped,
    preliminaryConfidence: computeConfidence(confirmed, linesSkipped),
  };
}

function computePctGross(input: CalcInput, common: CommonMath): SettlementCalculation {
  const { deal } = input;
  if (deal.percentage == null) {
    return {
      supported: false,
      reason: "Percentage-of-gross deal is missing a percentage.",
      dealType: deal.dealType,
    };
  }

  const payout = common.grossBoxOffice * deal.percentage;
  const bonusResult = applyBonuses(parseBonuses(deal), {
    gross: common.grossBoxOffice,
    net: common.grossLessFees,
    tickets: common.tickets,
    capacity: input.venueCapacity,
  });

  const total = payout + bonusResult.totalApplied;
  const steps: CalcStep[] = [
    {
      label: "Gross box office",
      value: common.grossBoxOffice,
      note:
        common.countedCompsValue > 0
          ? `Incl. $${common.countedCompsValue.toLocaleString()} from counted comps`
          : undefined,
      sourceType: "ticket_sale",
    },
    {
      label: `× ${(deal.percentage * 100).toFixed(0)}%`,
      value: payout,
      note: "Percentage of gross — no expense deductions.",
      sourceType: "deal_field",
      sourceId: "percentage",
    },
    ...bonusResult.applied.map((b) => ({
      label: b.label,
      value: b.amount,
      note: b.reason,
      sourceType: "bonus" as const,
    })),
  ];

  const linesSkipped = bonusResult.skipped;
  const confirmed = dealTermsConfirmed(deal);

  return {
    supported: true,
    grossBoxOffice: common.grossBoxOffice,
    grossLessFees: common.grossLessFees,
    rawExpenses: common.rawExpenses,
    cappedExpenses: 0,
    pendingExpenses: common.pendingExpenses,
    hospitalityExpenses: common.hospitalityExpenses,
    hospitalityOverage: common.hospitalityOverage,
    expenseOverage: 0,
    doorReceipts: common.doorReceipts,
    totalToArtist: total,
    steps,
    finalFormula:
      bonusResult.applied.length > 0
        ? `gross × ${deal.percentage} + bonuses = ${total.toFixed(2)}`
        : `gross × ${deal.percentage} = ${payout.toFixed(2)}`,
    bonusesApplied: bonusResult.applied,
    bonusesNotTriggered: bonusResult.notTriggered,
    dealTermsConfirmed: confirmed,
    linesSkipped,
    preliminaryConfidence: computeConfidence(confirmed, linesSkipped),
  };
}

function computeDoor(input: CalcInput, common: CommonMath): SettlementCalculation {
  const { deal } = input;
  if (deal.percentage == null) {
    return {
      supported: false,
      reason: "Door deal is missing a percentage.",
      dealType: deal.dealType,
    };
  }

  const payout = common.doorReceipts * deal.percentage;
  const steps: CalcStep[] = [
    {
      label: "Door receipts",
      value: common.doorReceipts,
      note:
        common.doorReceipts === 0
          ? "No door-channel ticket sales recorded — verify before settling"
          : undefined,
      sourceType: "ticket_sale",
    },
    {
      label: `× ${(deal.percentage * 100).toFixed(0)}%`,
      value: payout,
      sourceType: "deal_field",
      sourceId: "percentage",
    },
  ];

  const confirmed = dealTermsConfirmed(deal);

  return {
    supported: true,
    grossBoxOffice: common.grossBoxOffice,
    grossLessFees: common.grossLessFees,
    rawExpenses: common.rawExpenses,
    cappedExpenses: 0,
    pendingExpenses: common.pendingExpenses,
    hospitalityExpenses: common.hospitalityExpenses,
    hospitalityOverage: common.hospitalityOverage,
    expenseOverage: 0,
    doorReceipts: common.doorReceipts,
    totalToArtist: payout,
    steps,
    finalFormula: `door_receipts × ${deal.percentage} = ${payout.toFixed(2)}`,
    bonusesApplied: [],
    bonusesNotTriggered: [],
    dealTermsConfirmed: confirmed,
    linesSkipped: [],
    preliminaryConfidence: computeConfidence(confirmed, []),
  };
}

function computeVsOrPctNet(input: CalcInput, common: CommonMath): SettlementCalculation {
  const { deal } = input;
  const isVs = deal.dealType === "vs";

  if (deal.percentage == null) {
    return {
      supported: false,
      reason: `${isVs ? "Vs" : "Percentage-of-net"} deal is missing a percentage.`,
      dealType: deal.dealType,
    };
  }
  if (isVs && deal.guaranteeAmount == null) {
    return {
      supported: false,
      reason: "Vs deal is missing a guarantee amount.",
      dealType: deal.dealType,
    };
  }

  const basis = deal.percentageBasis ?? "net";
  const linesSkipped: LineSkipped[] = [];
  const steps: CalcStep[] = [];

  // Vs-gross variant: skip waterfall, use grossBoxOffice directly.
  if (isVs && basis === "gross") {
    return computeVsGross(input, common);
  }

  // Ratchet: determine effective percentage (replaces deal.percentage).
  const ratchet = parseRatchet(deal);
  let effectivePercentage = deal.percentage;
  if (ratchet) {
    const r = applyRatchet(ratchet, {
      grossBoxOffice: common.grossBoxOffice,
      net: common.grossLessFees,
      tickets: common.tickets,
      capacity: input.venueCapacity,
    });
    if (r.skipped) {
      linesSkipped.push(r.skipped);
    } else {
      effectivePercentage = r.effectivePercentage;
      if (r.triggeredTier) {
        steps.push({
          label: "Ratchet triggered",
          value: 0,
          note: `Tier ${r.triggeredTier.triggerType} ≥ ${r.triggeredTier.triggerValue} → ${(r.effectivePercentage * 100).toFixed(0)}% (base was ${(ratchet.basePercentage * 100).toFixed(0)}%)`,
          sourceType: "deal_field",
          sourceId: "ratchetJson",
        });
      }
    }
  }

  // Run waterfall. Override deal.percentage temporarily via shallow clone
  // so the apply_percentage step uses the ratcheted value.
  const dealForWaterfall = { ...deal, percentage: effectivePercentage };
  const order = parseDeductionOrder(deal) ?? defaultDeductionOrder(basis);

  const waterfall = walkDeductionWaterfall(order, {
    deal: dealForWaterfall,
    expenses: input.expenses,
    grossBoxOffice: common.grossBoxOffice,
    fees: common.totalFees,
    recoups: common.recoups,
    cappedHospitality: common.cappedHospitality,
  });

  steps.push(...waterfall.steps);

  // Apply separate hospitality cap if NOT included in the bucket (default).
  let hospitalityDeduction = 0;
  if (!waterfall.hospitalityCountedInBucket && deal.hospitalityCap != null) {
    hospitalityDeduction = common.cappedHospitality;
    if (hospitalityDeduction > 0) {
      steps.push({
        label: "Hospitality (separate cap)",
        value: -hospitalityDeduction,
        note:
          common.hospitalityOverage > 0
            ? `$${common.hospitalityExpenses.toLocaleString()} actual; venue absorbs $${common.hospitalityOverage.toLocaleString()} overage`
            : undefined,
        sourceType: "computed",
        sourceId: "hospitality_separate",
      });
    }
  }

  // Adjust waterfall.pctPayout for the separately-deducted hospitality.
  // (The waterfall already applied the percentage to a basis that didn't
  //  include hospitality, but the basis comes from `running` which had
  //  cappedExpenses deducted — we deducted hospitality outside, so it
  //  hasn't been removed from `running` yet at the apply_percentage step.)
  // Simplest fix: re-run percentage on (running - hospitalityDeduction).
  let percentagePayout = waterfall.pctPayout;
  if (hospitalityDeduction > 0) {
    const adjustedBasis = waterfall.running - hospitalityDeduction;
    percentagePayout = adjustedBasis * effectivePercentage;
    // Replace the last apply_percentage step's value.
    const pctStepIdx = steps.findIndex((s) =>
      s.label.startsWith("× ") && s.label.includes("%"),
    );
    if (pctStepIdx >= 0) {
      steps[pctStepIdx] = {
        ...steps[pctStepIdx],
        value: percentagePayout,
        note: `Basis: $${adjustedBasis.toLocaleString()} (after hospitality)`,
      };
    }
  }

  // For vs: totalToArtist = max(guarantee, percentage_payout) + bonuses + walkout
  // For pct_of_net: totalToArtist = percentage_payout + bonuses + walkout
  const guarantee = deal.guaranteeAmount ?? 0;
  let baseTotal: number;
  if (isVs) {
    baseTotal = Math.max(guarantee, percentagePayout);
    steps.push({
      label: `max(guarantee $${guarantee.toLocaleString()}, %-payout $${percentagePayout.toFixed(2).toLocaleString()})`,
      value: baseTotal,
      sourceType: "computed",
      sourceId: "vs_max",
    });
  } else {
    baseTotal = percentagePayout;
  }

  // Walkout (vs only — pct_of_net doesn't have a guarantee floor to subtract from).
  let walkoutShare = 0;
  if (isVs) {
    const walkout = parseWalkout(deal);
    if (walkout) {
      const w = applyWalkout(walkout, {
        grossBoxOffice: common.grossBoxOffice,
        guarantee,
        cappedExpenses: -waterfall.steps
          .filter((s) => s.label.startsWith("venue_expenses"))
          .reduce((s, x) => s + x.value, 0), // recover from the negative step value
      });
      if (w.skipped) {
        linesSkipped.push(w.skipped);
      } else {
        walkoutShare = w.walkoutShare;
        if (walkoutShare > 0) {
          steps.push({
            label: "Walkout payout",
            value: walkoutShare,
            note: w.note,
            sourceType: "deal_field",
            sourceId: "walkoutJson",
          });
        } else {
          steps.push({
            label: "Walkout (not triggered)",
            value: 0,
            note: w.note,
            sourceType: "deal_field",
            sourceId: "walkoutJson",
          });
        }
      }
    }
  }

  // Bonuses on top of everything else.
  const bonusResult = applyBonuses(parseBonuses(deal), {
    gross: common.grossBoxOffice,
    net: waterfall.running,
    tickets: common.tickets,
    capacity: input.venueCapacity,
  });
  linesSkipped.push(...bonusResult.skipped);

  for (const b of bonusResult.applied) {
    steps.push({
      label: b.label,
      value: b.amount,
      note: b.reason,
      sourceType: "bonus",
    });
  }

  const total = baseTotal + walkoutShare + bonusResult.totalApplied;
  const cappedExpensesFromBucket = -waterfall.steps
    .filter((s) => s.label.startsWith("venue_expenses"))
    .reduce((s, x) => s + x.value, 0);
  const expenseOverage = Math.max(
    0,
    common.rawExpenses -
      common.hospitalityExpenses -
      cappedExpensesFromBucket,
  );

  const confirmed = dealTermsConfirmed(deal);

  return {
    supported: true,
    grossBoxOffice: common.grossBoxOffice,
    grossLessFees: common.grossLessFees,
    rawExpenses: common.rawExpenses,
    cappedExpenses: cappedExpensesFromBucket + hospitalityDeduction,
    pendingExpenses: common.pendingExpenses,
    hospitalityExpenses: common.hospitalityExpenses,
    hospitalityOverage: common.hospitalityOverage,
    expenseOverage,
    doorReceipts: common.doorReceipts,
    totalToArtist: total,
    steps,
    finalFormula: `${isVs ? `max(g=$${guarantee}, %-payout)` : "%-payout"}${walkoutShare > 0 ? " + walkout" : ""}${bonusResult.totalApplied > 0 ? " + bonuses" : ""} = $${total.toFixed(2)}`,
    bonusesApplied: bonusResult.applied,
    bonusesNotTriggered: bonusResult.notTriggered,
    dealTermsConfirmed: confirmed,
    linesSkipped,
    preliminaryConfidence: computeConfidence(confirmed, linesSkipped),
  };
}

function computeVsGross(input: CalcInput, common: CommonMath): SettlementCalculation {
  const { deal } = input;
  const guarantee = deal.guaranteeAmount ?? 0;
  const pct = deal.percentage ?? 0;
  const percentagePayout = common.grossBoxOffice * pct;
  const baseTotal = Math.max(guarantee, percentagePayout);

  const steps: CalcStep[] = [
    {
      label: "Gross box office (vs-gross basis)",
      value: common.grossBoxOffice,
      note:
        common.countedCompsValue > 0
          ? `Incl. $${common.countedCompsValue.toLocaleString()} from counted comps. Vs-gross: % applies to gross, no expense deductions from artist payout.`
          : "Vs-gross: % applies to gross, no expense deductions from artist payout.",
      sourceType: "ticket_sale",
    },
    {
      label: `× ${(pct * 100).toFixed(0)}% of gross`,
      value: percentagePayout,
      sourceType: "deal_field",
      sourceId: "percentage",
    },
    {
      label: `max(guarantee $${guarantee.toLocaleString()}, %-payout $${percentagePayout.toFixed(2)})`,
      value: baseTotal,
      sourceType: "computed",
      sourceId: "vs_max",
    },
  ];

  const bonusResult = applyBonuses(parseBonuses(deal), {
    gross: common.grossBoxOffice,
    net: common.grossLessFees,
    tickets: common.tickets,
    capacity: input.venueCapacity,
  });
  for (const b of bonusResult.applied) {
    steps.push({ label: b.label, value: b.amount, note: b.reason, sourceType: "bonus" });
  }

  const total = baseTotal + bonusResult.totalApplied;
  const confirmed = dealTermsConfirmed(deal);
  const linesSkipped = bonusResult.skipped;

  return {
    supported: true,
    grossBoxOffice: common.grossBoxOffice,
    grossLessFees: common.grossLessFees,
    rawExpenses: common.rawExpenses,
    cappedExpenses: 0, // vs-gross doesn't deduct expenses from artist payout
    pendingExpenses: common.pendingExpenses,
    hospitalityExpenses: common.hospitalityExpenses,
    hospitalityOverage: common.hospitalityOverage,
    expenseOverage: 0,
    doorReceipts: common.doorReceipts,
    totalToArtist: total,
    steps,
    finalFormula: `max(g=$${guarantee}, gross × ${pct})${bonusResult.totalApplied > 0 ? " + bonuses" : ""} = $${total.toFixed(2)}`,
    bonusesApplied: bonusResult.applied,
    bonusesNotTriggered: bonusResult.notTriggered,
    dealTermsConfirmed: confirmed,
    linesSkipped,
    preliminaryConfidence: computeConfidence(confirmed, linesSkipped),
  };
}
