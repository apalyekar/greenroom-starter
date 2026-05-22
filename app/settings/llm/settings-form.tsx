"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { saveLlmSettings, removeLlmSettings } from "./actions";

type Existing = {
  provider: string;
  modelId: string;
  lastFour: string | null;
  configuredAt: string | null;
  lastSuccessfulCallAt: string | null;
  lastFailureReason: string | null;
} | null;

export function SettingsForm({ existing }: { existing: Existing }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);
  const [showRotate, setShowRotate] = useState(false);

  const onSave = async (formData: FormData) => {
    setMessage(null);
    startTransition(async () => {
      const result = await saveLlmSettings(formData);
      if (result.ok) {
        setMessage({ kind: "ok", text: "Saved. Key validated successfully." });
        setShowRotate(false);
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const onRemove = async () => {
    if (!confirm("Remove the configured API key? Capture will fall back to manual mode.")) return;
    setMessage(null);
    startTransition(async () => {
      const result = await removeLlmSettings();
      if (result.ok) {
        setMessage({ kind: "ok", text: "Key removed." });
        setShowRotate(false);
      }
    });
  };

  if (existing && !showRotate) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-ink-200/60 bg-white p-6">
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 text-[13px]">
            <Field label="Provider" value="Anthropic" />
            <Field label="Model" value={existing.modelId} mono />
            <Field
              label="Key fingerprint"
              value={existing.lastFour ? `••••${existing.lastFour}` : "—"}
              mono
            />
            <Field
              label="Configured"
              value={
                existing.configuredAt
                  ? new Date(existing.configuredAt).toLocaleString()
                  : "—"
              }
            />
            <Field
              label="Last successful call"
              value={
                existing.lastSuccessfulCallAt
                  ? new Date(existing.lastSuccessfulCallAt).toLocaleString()
                  : "—"
              }
            />
            <Field
              label="Last failure"
              value={existing.lastFailureReason ?? "None"}
              tone={existing.lastFailureReason ? "warn" : "default"}
            />
          </div>
          <div className="mt-6 pt-5 border-t border-ink-200/50 flex gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowRotate(true)}
            >
              Replace key
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              disabled={isPending}
            >
              Remove
            </Button>
          </div>
        </div>
        {message && <MessageRow message={message} />}
      </div>
    );
  }

  return (
    <form action={onSave} className="space-y-6">
      <div className="space-y-5 rounded-xl border border-ink-200/60 bg-white p-6">
        <div>
          <label className="block text-[12px] font-medium text-ink-700 uppercase tracking-[0.08em] mb-2">
            Anthropic API key
          </label>
          <input
            type="password"
            name="apiKey"
            placeholder="sk-ant-api03-..."
            required
            className="w-full h-10 px-3 rounded-lg border border-ink-300 bg-white font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-700 focus:border-brand-700"
          />
          <p className="text-[12px] text-ink-500 mt-2">
            We&apos;ll test the key with a tiny request before saving.
          </p>
        </div>

        <div>
          <label className="block text-[12px] font-medium text-ink-700 uppercase tracking-[0.08em] mb-2">
            Model
          </label>
          <select
            name="modelId"
            defaultValue={existing?.modelId ?? "claude-opus-4-7"}
            className="w-full h-10 px-3 rounded-lg border border-ink-300 bg-white text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-700 focus:border-brand-700"
          >
            <option value="claude-opus-4-7">Claude Opus 4.7 (recommended)</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (faster, lower cost)</option>
            <option value="claude-haiku-4-5">Claude Haiku 4.5 (fastest, lowest cost)</option>
          </select>
        </div>

        <div className="flex gap-3 pt-2">
          <Button type="submit" variant="brand" disabled={isPending}>
            {isPending ? "Validating…" : "Save and validate"}
          </Button>
          {showRotate && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setShowRotate(false);
                setMessage(null);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
      {message && <MessageRow message={message} />}
    </form>
  );
}

function Field({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "warn";
}) {
  return (
    <div>
      <div className="text-[11px] font-medium text-ink-400 uppercase tracking-[0.08em]">
        {label}
      </div>
      <div
        className={[
          "mt-1 text-[14px]",
          mono ? "font-mono tabular" : "",
          tone === "warn" ? "text-amber-700" : "text-ink-900",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function MessageRow({
  message,
}: {
  message: { kind: "ok" | "error"; text: string };
}) {
  return (
    <div
      className={[
        "rounded-lg px-4 py-3 text-[13px]",
        message.kind === "ok"
          ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
          : "bg-rose-50 text-rose-800 border border-rose-200",
      ].join(" ")}
    >
      {message.text}
    </div>
  );
}
