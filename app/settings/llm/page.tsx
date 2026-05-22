import { db } from "@/db";
import { venueLlmSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CURRENT_VENUE_ID } from "@/lib/session";
import { SettingsForm } from "./settings-form";

export default async function LlmSettingsPage() {
  const settings = await db
    .select()
    .from(venueLlmSettings)
    .where(eq(venueLlmSettings.venueId, CURRENT_VENUE_ID))
    .limit(1)
    .then((rows) => rows[0]);

  return (
    <div className="px-12 py-10 max-w-3xl">
      <div className="mb-10">
        <div className="eyebrow mb-3">Settings</div>
        <h1
          className="font-display text-[40px] font-medium text-ink-900 leading-[1.05]"
          style={{ letterSpacing: "-0.025em", fontOpticalSizing: "auto" }}
        >
          AI configuration
        </h1>
        <p className="text-[14px] text-ink-500 mt-3 max-w-2xl leading-relaxed">
          AI-assisted deal capture reads pasted deal emails, extracts the
          structured terms, and flags anything ambiguous as a question you
          can send back to the agent — turning the deal email into a clean
          source of truth before show day, instead of a 2am dispute. Without
          this, every term has to be typed into the structured form by hand
          and ambiguities only surface when someone notices them at
          settlement.
        </p>
        <p className="text-[14px] text-ink-500 mt-3 max-w-2xl leading-relaxed">
          Today, Greenroom uses your venue&apos;s own Anthropic API key
          (bring-your-own-key) for these calls. You pay the provider directly,
          which keeps cost attribution clean and gives you full control over
          which model is used and how many calls run. In a future release
          we&apos;ll offer Greenroom-managed access — bundled into your
          subscription, no key to set up — for venues that prefer that path.
          BYOK will stay as an option for venues that want their own billing
          relationship.
        </p>
      </div>

      <SettingsForm
        existing={
          settings
            ? {
                provider: settings.provider,
                modelId: settings.modelId,
                lastFour: settings.apiKeyLastFour,
                configuredAt: settings.configuredAt?.toISOString() ?? null,
                lastSuccessfulCallAt:
                  settings.lastSuccessfulCallAt?.toISOString() ?? null,
                lastFailureReason: settings.lastFailureReason,
              }
            : null
        }
      />

      <div className="mt-10 pt-8 border-t border-ink-200/50">
        <h2 className="text-[13px] font-medium text-ink-700 uppercase tracking-[0.08em]">
          How this works
        </h2>
        <div className="text-[13px] text-ink-600 leading-relaxed mt-4 space-y-3">
          <p>
            When you paste a deal email on a show&apos;s capture page, Greenroom
            sends it to Claude with a structured-extraction prompt that pulls
            out the deal terms (guarantee, percentage, expense cap, bonuses,
            recoups, walkout, ratchet) and flags any ambiguities for your
            review.
          </p>
          <p>
            Your API key never leaves Greenroom&apos;s servers. We make the
            Claude call on your behalf so the key isn&apos;t exposed to your
            browser.
          </p>
          <p>
            Don&apos;t have an Anthropic key?{" "}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-700 hover:underline"
            >
              Generate one at console.anthropic.com
            </a>{" "}
            (create a project, then a key with permission to call the Messages
            API).
          </p>
        </div>
      </div>
    </div>
  );
}
