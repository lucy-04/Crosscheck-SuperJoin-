import Link from "next/link";
import { getPage, listDocuments, listFacts } from "@/lib/db/repo";
import { Chip, Empty, EvidenceBlock, ScopeChips, valueText } from "../ui";

export const dynamic = "force-dynamic";

const TYPES = [
  { key: "", label: "All" },
  { key: "quantity", label: "Quantities" },
  { key: "state", label: "States" },
  { key: "identity", label: "Identities" },
  { key: "date", label: "Dates" },
];

export default async function FactsPage({
  searchParams,
}: {
  searchParams: Promise<{ documentId?: string; factType?: string; q?: string }>;
}) {
  const { documentId, factType, q } = await searchParams;
  const documents = listDocuments();
  const facts = listFacts({ documentId, factType, search: q, limit: 150 });

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { documentId, factType, q, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/facts?${s}` : "/facts";
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[16px] font-semibold">Facts</h1>
        <p className="text-[13px] text-[var(--color-muted)]">
          Every stored claim carries the scope that makes it comparable and a quote that was
          verified against its page before the fact was kept.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-center gap-2">
        {documentId ? <input type="hidden" name="documentId" value={documentId} /> : null}
        {factType ? <input type="hidden" name="factType" value={factType} /> : null}
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search subject, measure or claim…"
          className="w-72 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[13px]"
        />
        <button className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1 text-[13px]">
          Search
        </button>
        {q ? (
          <Link href={qs({ q: undefined })} className="text-[12px] text-[var(--color-muted)] underline">
            clear
          </Link>
        ) : null}
      </form>

      <div className="flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <Link
            key={t.key}
            href={qs({ factType: t.key || undefined })}
            className={`rounded border px-2.5 py-1 text-[12px] ${
              (factType ?? "") === t.key
                ? "border-[var(--color-ink)] bg-[var(--color-surface)]"
                : "border-[var(--color-line)] text-[var(--color-muted)]"
            }`}
          >
            {t.label}
          </Link>
        ))}
        <span className="mx-1 w-px bg-[var(--color-line)]" />
        <Link
          href={qs({ documentId: undefined })}
          className={`rounded border px-2.5 py-1 text-[12px] ${
            !documentId
              ? "border-[var(--color-ink)] bg-[var(--color-surface)]"
              : "border-[var(--color-line)] text-[var(--color-muted)]"
          }`}
        >
          All documents
        </Link>
        {documents.map((d) => (
          <Link
            key={d.id}
            href={qs({ documentId: d.id })}
            title={d.filename}
            className={`max-w-56 truncate rounded border px-2.5 py-1 text-[12px] ${
              documentId === d.id
                ? "border-[var(--color-ink)] bg-[var(--color-surface)]"
                : "border-[var(--color-line)] text-[var(--color-muted)]"
            }`}
          >
            {d.title ?? d.filename}
          </Link>
        ))}
      </div>

      {facts.length === 0 ? (
        <Empty>No facts match. Try clearing the filters, or ingest a document first.</Empty>
      ) : (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--color-muted)]">Showing {facts.length} facts.</p>
          {facts.map((f) => {
            const page = getPage(f.documentId, f.evidence.pageNumber);
            return (
              <details
                key={f.id}
                className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] p-3"
              >
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-[13px] text-[var(--color-muted)]">{f.subject}</span>
                    <span className="text-[13px] font-medium">{f.predicate}</span>
                    <span className="text-[15px] font-semibold tabular-nums">{valueText(f)}</span>
                    <ScopeChips fact={f} />
                    <Chip title="Value family">{f.factType}</Chip>
                    <span className="ml-auto text-[11px] text-[var(--color-muted)]">
                      p{f.evidence.pageNumber}
                    </span>
                  </div>
                </summary>
                <div className="mt-3 space-y-2">
                  <p className="text-[13px]">{f.claim}</p>
                  <EvidenceBlock
                    pageText={page?.text ?? null}
                    charStart={f.evidence.charStart}
                    charEnd={f.evidence.charEnd}
                    pageNumber={f.evidence.pageNumber}
                  />
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
