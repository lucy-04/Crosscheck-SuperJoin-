import { getDocument, getPage, listQuarantine, quarantineCounts, countFacts } from "@/lib/db/repo";
import { Chip, Empty, Stat } from "../ui";

export const dynamic = "force-dynamic";

const REASON_BLURB: Record<string, string> = {
  quote_not_found:
    "The cited quote could not be located on the page it was attributed to, even after whitespace, punctuation and multi-line matching. Most of these are a bare value offered as its own evidence — a quote of “3” proves nothing.",
  value_not_in_quote:
    "The quote is real and was found on the page, but the claimed value does not appear inside it. This usually means the right row was read and the wrong column taken.",
  quote_lacks_context:
    "The span contains the value but no words identifying what it measures. A quote of \u201c34.1%\u201d cannot say WHAT is 34.1%, so it cannot distinguish this claim from any other row in the same table \u2014 and a system that let it through would report every row of that table as contradicting every other.",
  page_not_found: "The claim cited a page number outside this document.",
};

export default function QuarantinePage() {
  const counts = quarantineCounts();
  const rows = listQuarantine(undefined, 120);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const facts = countFacts();
  const attempted = facts + total;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[16px] font-semibold">Quarantine</h1>
        <p className="max-w-3xl text-[13px] text-[var(--color-muted)]">
          Extractions the grounding check refused. They are kept rather than deleted, because a
          system that adjudicates disagreement has no business hiding its own error rate — and
          because a fabricated figure that reaches the reasoning layer does not fail loudly, it
          surfaces as a confident contradiction against a real one.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Kept" value={facts} />
        <Stat label="Rejected" value={total} />
        <Stat
          label="Grounding rate"
          value={attempted ? `${Math.round((facts / attempted) * 100)}%` : "—"}
          hint="measured, not asserted"
        />
        <Stat label="Reasons" value={Object.keys(counts).length} />
      </section>

      {Object.entries(counts).map(([reason, n]) => (
        <p key={reason} className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[12px]">
          <strong>{reason}</strong> <span className="text-[var(--color-muted)]">({n})</span> —{" "}
          <span className="text-[var(--color-muted)]">{REASON_BLURB[reason] ?? "Unclassified."}</span>
        </p>
      ))}

      {rows.length === 0 ? (
        <Empty>Nothing quarantined.</Empty>
      ) : (
        <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-[var(--color-surface)]">
          <table className="w-full min-w-[900px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-line)] text-left text-[12px] text-[var(--color-muted)]">
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">Claimed</th>
                <th className="px-3 py-2 font-medium">Cited quote</th>
                <th className="px-3 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const doc = getDocument(r.documentId);
                const value = r.claim.value as { raw?: string };
                return (
                  <tr key={r.id} className="border-b border-[var(--color-line)] last:border-0 align-top">
                    <td className="px-3 py-2">
                      <Chip>{r.reason}</Chip>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{value.raw ?? "—"}</div>
                      <div className="text-[11px] text-[var(--color-muted)]">
                        {r.claim.subject} · {r.claim.predicate}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="evidence block max-w-md text-[var(--color-muted)]">
                        {r.claim.evidence.quote.slice(0, 220)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-muted)]">
                      {doc?.title ?? doc?.filename ?? "—"}
                      {r.pageNumber ? ` · p${r.pageNumber}` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
