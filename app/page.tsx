import Link from "next/link";
import { countFacts, listDocuments, quarantineCounts, relationCounts } from "@/lib/db/repo";
import { registryCounts } from "@/lib/registry/store";
import { Empty, Stat } from "./ui";
import { UploadBox } from "./upload";

// The knowledge layer changes as documents are ingested, so nothing here is
// prerendered — every view reads the current state of the store.
export const dynamic = "force-dynamic";

interface Stats {
  pages?: number;
  units?: number;
  unitsSkipped?: number;
  claims?: number;
  facts?: number;
  quarantined?: number;
  cacheHits?: number;
  cacheMisses?: number;
  seconds?: number;
}

export default function DocumentsPage() {
  const documents = listDocuments();
  const facts = countFacts();
  const relations = relationCounts();
  const quarantine = quarantineCounts();
  const registry = registryCounts();

  const totalRelations = Object.values(relations).reduce((a, b) => a + b, 0);
  const totalQuarantined = Object.values(quarantine).reduce((a, b) => a + b, 0);
  const grounded = facts + totalQuarantined;

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Documents" value={documents.length} />
        <Stat
          label="Grounded facts"
          value={facts}
          hint={grounded ? `${Math.round((facts / grounded) * 100)}% of extractions survived grounding` : undefined}
        />
        <Stat label="Relations" value={totalRelations} hint="cross-document and intra-document" />
        <Stat label="Vocabulary" value={Object.values(registry).reduce((a, b) => a + b, 0)} hint="subjects · predicates · values" />
        <Stat label="Quarantined" value={totalQuarantined} hint="rejected by the grounding check" />
      </section>

      <section>
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Add a document
        </h2>
        <UploadBox />
      </section>

      <section>
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Documents
        </h2>

        {documents.length === 0 ? (
          <Empty>
            No documents yet. Upload a PDF above, or run <code>npm run demo</code> to load the
            starter set from the committed cache.
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-[var(--color-surface)]">
            <table className="w-full min-w-[900px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[12px] text-[var(--color-muted)]">
                  <th className="px-3 py-2 font-medium">Document</th>
                  <th className="px-3 py-2 font-medium">Published</th>
                  <th className="px-3 py-2 text-right font-medium">Pages</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 text-right font-medium">Facts</th>
                  <th className="px-3 py-2 text-right font-medium">Quarantined</th>
                  <th className="px-3 py-2 text-right font-medium">Cache</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => {
                  const s = d.stats as Stats;
                  const cacheTotal = (s.cacheHits ?? 0) + (s.cacheMisses ?? 0);
                  return (
                    <tr key={d.id} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">
                        <Link href={`/facts?documentId=${d.id}`} className="font-medium hover:underline">
                          {d.title ?? d.filename}
                        </Link>
                        <div className="text-[11px] text-[var(--color-muted)]">{d.filename}</div>
                      </td>
                      <td className="px-3 py-2 text-[var(--color-muted)]">{d.publishedAt ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{d.pageCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {s.units ?? "—"}
                        {s.unitsSkipped ? (
                          <span className="text-[var(--color-muted)]"> (−{s.unitsSkipped})</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.facts ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-[var(--color-muted)]">
                        {s.quarantined ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-[var(--color-muted)]">
                        {cacheTotal ? `${s.cacheHits}/${cacheTotal}` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            d.status === "ingested"
                              ? "text-[var(--color-corroborates)]"
                              : "text-[var(--color-muted)]"
                          }
                        >
                          {d.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] p-4 text-[13px] leading-relaxed">
        <h2 className="mb-1 font-semibold">How this works</h2>
        <p className="text-[var(--color-muted)]">
          Each document is parsed with its text coordinates intact, split into page-sized units
          that carry the headings and unit captions scoping them, and read into{" "}
          <strong className="text-[var(--color-ink)]">scoped claims</strong> — a value plus the
          subject, measure, period, basis and unit that make it comparable. Every claim must cite a
          quote that is verifiably present on its page, or it is quarantined rather than stored.
        </p>
        <p className="mt-2 text-[var(--color-muted)]">
          Facts are then grouped by canonical measure and subject, and compared on six axes. A
          disagreement is only reported as a{" "}
          <strong className="text-[var(--color-ink)]">contradiction</strong> when no reconciling
          context can be found — see <Link href="/relations" className="underline">Relations</Link>.
        </p>
      </section>
    </div>
  );
}
