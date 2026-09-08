import Link from "next/link";
import {
  getDocument,
  getFact,
  getPage,
  listRelations,
  relationCounts,
} from "@/lib/db/repo";
import type { Fact, Relation, Verdict } from "@/lib/types";
import { DeltaTable, Empty, EvidenceBlock, ScopeChips, VerdictBadge, valueText } from "../ui";

export const dynamic = "force-dynamic";

const VERDICT_ORDER: Verdict[] = ["CONTRADICTS", "RECONCILED", "SUPERSEDED", "CORROBORATES", "DERIVES"];

const VERDICT_BLURB: Record<string, string> = {
  CONTRADICTS:
    "Same subject, measure, period, entity scope, basis and unit — and still different values. Every reconciling hypothesis was tried and none fits.",
  RECONCILED:
    "Looks like a conflict, is not. The engine names the axis that explains the gap: a different period, entity scope, unit, or basis.",
  SUPERSEDED:
    "One claim replaces the other rather than disagreeing with it — an explicit restatement, or a state that changed between two documents.",
  CORROBORATES:
    "Two sources independently state the same thing for the same scope, even when they express it differently.",
  DERIVES: "One value is arithmetically implied by others.",
};

/** One side of a pair: the claim, its scope, and the evidence behind it. */
function FactCard({ fact, side }: { fact: Fact; side: "A" | "B" }) {
  const doc = getDocument(fact.documentId);
  const page = getPage(fact.documentId, fact.evidence.pageNumber);

  return (
    <div className="min-w-0 flex-1 space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-[var(--color-canvas)] px-1.5 text-[11px] font-semibold text-[var(--color-muted)]">
          {side}
        </span>
        <span className="truncate text-[12px] text-[var(--color-muted)]" title={doc?.title ?? ""}>
          {doc?.title ?? doc?.filename ?? "unknown document"}
          {doc?.publishedAt ? ` · ${doc.publishedAt}` : ""}
        </span>
      </div>

      <div>
        <div className="text-[13px]">
          <span className="text-[var(--color-muted)]">{fact.subject}</span>
          {" · "}
          <span className="font-medium">{fact.predicate}</span>
        </div>
        <div className="text-[17px] font-semibold tabular-nums">{valueText(fact)}</div>
      </div>

      <ScopeChips fact={fact} />

      <EvidenceBlock
        pageText={page?.text ?? null}
        charStart={fact.evidence.charStart}
        charEnd={fact.evidence.charEnd}
        pageNumber={fact.evidence.pageNumber}
        context={140}
      />
    </div>
  );
}

function RelationCard({ relation }: { relation: Relation }) {
  const a = getFact(relation.factAId);
  const b = getFact(relation.factBId);
  if (!a || !b) return null;

  const crossDocument = a.documentId !== b.documentId;

  return (
    <article className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={relation.verdict} ruleId={relation.ruleId} />
        {relation.axis ? (
          <span className="text-[12px] text-[var(--color-muted)]">
            explained by <strong className="text-[var(--color-ink)]">{relation.axis}</strong>
          </span>
        ) : null}
        <span className="text-[12px] text-[var(--color-muted)]">
          confidence {relation.confidence.toFixed(2)}
        </span>
        <span className="text-[12px] text-[var(--color-muted)]">
          {crossDocument ? "cross-document" : "same document"}
        </span>
        <span className="ml-auto text-[11px] text-[var(--color-muted)]">
          decided by {relation.decidedBy}
        </span>
      </header>

      <p className="mb-3 text-[13px] leading-relaxed">{relation.explanation}</p>

      <div className="mb-3 flex flex-col gap-4 md:flex-row">
        <FactCard fact={a} side="A" />
        <div className="hidden w-px shrink-0 bg-[var(--color-line)] md:block" />
        <FactCard fact={b} side="B" />
      </div>

      <details className="rounded border border-[var(--color-line)] bg-[var(--color-canvas)] p-2">
        <summary className="cursor-pointer text-[12px] font-medium text-[var(--color-muted)]">
          Why — the six axes this verdict was computed from
        </summary>
        <div className="mt-2">
          <DeltaTable deltas={relation.deltas} />
        </div>
      </details>
    </article>
  );
}

export default async function RelationsPage({
  searchParams,
}: {
  searchParams: Promise<{ verdict?: string }>;
}) {
  const { verdict } = await searchParams;
  const counts = relationCounts();
  const relations = listRelations({ verdict, limit: 60 });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[16px] font-semibold">Relations</h1>
        <p className="text-[13px] text-[var(--color-muted)]">
          Every pair the engine judged, with the reasoning that produced the verdict. A contradiction
          here means a reconciling context was searched for and not found.
        </p>
      </div>

      <nav className="flex flex-wrap gap-2">
        <Link
          href="/relations"
          className={`rounded border px-2.5 py-1 text-[12px] ${
            !verdict
              ? "border-[var(--color-ink)] bg-[var(--color-surface)]"
              : "border-[var(--color-line)] text-[var(--color-muted)]"
          }`}
        >
          All ({Object.values(counts).reduce((a, b) => a + b, 0)})
        </Link>
        {VERDICT_ORDER.filter((v) => counts[v]).map((v) => (
          <Link
            key={v}
            href={`/relations?verdict=${v}`}
            className={`rounded border px-2.5 py-1 text-[12px] ${
              verdict === v
                ? "border-[var(--color-ink)] bg-[var(--color-surface)]"
                : "border-[var(--color-line)] text-[var(--color-muted)]"
            }`}
          >
            {v} ({counts[v]})
          </Link>
        ))}
      </nav>

      {verdict && VERDICT_BLURB[verdict] ? (
        <p className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[12px] text-[var(--color-muted)]">
          {VERDICT_BLURB[verdict]}
        </p>
      ) : null}

      {relations.length === 0 ? (
        <Empty>
          No relations yet. Ingest at least two documents, then run <code>npm run reconcile</code>.
        </Empty>
      ) : (
        <div className="space-y-3">
          {relations.map((r) => (
            <RelationCard key={r.id} relation={r} />
          ))}
        </div>
      )}
    </div>
  );
}
