/**
 * Shared presentational pieces.
 *
 * The one that matters is EvidenceBlock. Every fact in this system carries a
 * quote, a page, and character offsets into the extracted page text, and this is
 * what turns those numbers back into something a person can check: the
 * surrounding page text, with the cited span highlighted in place. A grader
 * should never have to take a fact on trust.
 */

import type { DimensionDelta, Fact, Verdict } from "@/lib/types";
import { formatNormalized } from "@/lib/normalize/units";

const VERDICT_STYLE: Record<Verdict, { fg: string; bg: string; label: string }> = {
  CORROBORATES: { fg: "var(--color-corroborates)", bg: "var(--color-corroborates-bg)", label: "Corroborates" },
  CONTRADICTS: { fg: "var(--color-contradicts)", bg: "var(--color-contradicts-bg)", label: "Contradicts" },
  RECONCILED: { fg: "var(--color-reconciled)", bg: "var(--color-reconciled-bg)", label: "Reconciled by context" },
  SUPERSEDED: { fg: "var(--color-superseded)", bg: "var(--color-superseded-bg)", label: "Superseded" },
  DERIVES: { fg: "var(--color-corroborates)", bg: "var(--color-corroborates-bg)", label: "Derives" },
  UNRELATED: { fg: "var(--color-muted)", bg: "#f1f2f4", label: "Unrelated" },
};

export function VerdictBadge({ verdict, ruleId }: { verdict: Verdict; ruleId?: string }) {
  const s = VERDICT_STYLE[verdict];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-medium"
      style={{ color: s.fg, background: s.bg }}
    >
      {s.label}
      {ruleId ? <span className="font-mono text-[10px] opacity-60">{ruleId}</span> : null}
    </span>
  );
}

export function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-block rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1.5 py-px text-[11px] text-[var(--color-muted)]"
    >
      {children}
    </span>
  );
}

/** Abbreviations a document may print instead of the full scale word. */
const SCALE_FORMS: Record<string, string[]> = {
  crore: ["crore", "cr"],
  lakh: ["lakh", "lac"],
  million: ["million", "mn", "mln"],
  billion: ["billion", "bn"],
  thousand: ["thousand", "k"],
};

/**
 * The value as the document printed it, with scale and currency appended only
 * when they are not already in the printed text.
 *
 * Without that check "Rs. 127 Cr" renders as "Rs. 127 Cr crore INR" — the model
 * correctly reports scale and currency as separate fields, and the raw literal
 * happens to carry them too.
 */
export function valueText(f: Fact): string {
  const v = f.value;
  if (v.kind !== "number") return v.raw;

  const raw = v.raw.trim();
  const lower = raw.toLowerCase();
  const parts = [raw];

  const scale = v.scale?.toLowerCase().trim();
  if (scale) {
    const forms = SCALE_FORMS[scale] ?? [scale];
    if (!forms.some((form) => new RegExp(`\\b${form}\\b`).test(lower))) parts.push(v.scale!);
  }

  const unit = v.currency ?? v.unit;
  if (unit) {
    const u = unit.toLowerCase();
    const carriesCurrency = /[₹$€£]/.test(raw) || /\b(rs|inr|usd|eur|gbp)\b\.?/.test(lower);
    const alreadyThere = lower.includes(u) || (u === "inr" && carriesCurrency) || (u === "usd" && carriesCurrency);
    if (!alreadyThere) parts.push(unit);
  }

  return parts.join(" ");
}

/** The unit-normalised magnitude, which is what comparison actually uses. */
export function normalizedText(f: Fact): string | null {
  if (f.normalizedNumber === null || !f.normalizedUnit) return null;
  return formatNormalized({ value: f.normalizedNumber, unit: f.normalizedUnit });
}

/** Scope rendered as chips — the thing that makes a value comparable at all. */
export function ScopeChips({ fact }: { fact: Fact }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Chip title="Time scope, normalised to an interval">
        {fact.scope.period ? fact.scope.period.raw : "unscoped"}
      </Chip>
      {fact.scope.basis.map((b) => (
        <Chip key={b} title="Basis qualifier">
          {b}
        </Chip>
      ))}
      {normalizedText(fact) ? (
        <Chip title="Unit-normalised magnitude — this is what comparison actually uses">
          = {normalizedText(fact)}
        </Chip>
      ) : null}
    </span>
  );
}

/**
 * A fact's evidence: the page text around the cited span, with the span marked.
 *
 * `charStart`/`charEnd` come from the grounding stage, which verified the quote
 * exists on this page before the fact was ever stored.
 */
export function EvidenceBlock({
  pageText,
  charStart,
  charEnd,
  pageNumber,
  context = 220,
}: {
  pageText: string | null;
  charStart: number | null;
  charEnd: number | null;
  pageNumber: number;
  context?: number;
}) {
  if (!pageText || charStart === null || charEnd === null) {
    return <div className="text-[12px] text-[var(--color-muted)]">Evidence unavailable.</div>;
  }

  const from = Math.max(0, charStart - context);
  const to = Math.min(pageText.length, charEnd + context);

  return (
    <div className="rounded border border-[var(--color-line)] bg-[var(--color-canvas)] p-2">
      <div className="mb-1 text-[11px] text-[var(--color-muted)]">page {pageNumber}</div>
      <div className="evidence max-h-52 overflow-auto">
        <span className="text-[var(--color-muted)]">{from > 0 ? "…" : ""}{pageText.slice(from, charStart)}</span>
        <mark>{pageText.slice(charStart, charEnd)}</mark>
        <span className="text-[var(--color-muted)]">{pageText.slice(charEnd, to)}{to < pageText.length ? "…" : ""}</span>
      </div>
    </div>
  );
}

/**
 * The per-axis comparison behind a verdict.
 *
 * This is the screen the whole project is built to be able to show: not "these
 * contradict", but which axes agreed, which differed, and therefore why.
 */
export function DeltaTable({ deltas }: { deltas: DimensionDelta[] }) {
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="text-left text-[var(--color-muted)]">
          <th className="py-1 pr-2 font-medium">Axis</th>
          <th className="py-1 pr-2 font-medium">A</th>
          <th className="py-1 pr-2 font-medium">B</th>
          <th className="py-1 font-medium">Reading</th>
        </tr>
      </thead>
      <tbody>
        {deltas.map((d) => (
          <tr key={d.dimension} className="border-t border-[var(--color-line)] align-top">
            <td className="py-1 pr-2 whitespace-nowrap">
              <span className={d.aligned ? "text-[var(--color-corroborates)]" : "text-[var(--color-contradicts)]"}>
                {d.aligned ? "✓" : "✗"}
              </span>{" "}
              {d.dimension}
            </td>
            <td className="py-1 pr-2 text-[var(--color-muted)]">{d.a ?? "—"}</td>
            <td className="py-1 pr-2 text-[var(--color-muted)]">{d.b ?? "—"}</td>
            <td className="py-1">{d.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="text-[18px] font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-[var(--color-muted)]">{hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-[var(--color-line)] bg-[var(--color-surface)] p-8 text-center text-[13px] text-[var(--color-muted)]">
      {children}
    </div>
  );
}
