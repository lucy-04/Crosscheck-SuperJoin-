import { getEntry, listAllRelations, listEntries, type Namespace } from "@/lib/registry/store";
import { Chip, Empty } from "../ui";

export const dynamic = "force-dynamic";

const NAMESPACES: { key: Namespace; title: string; blurb: string }[] = [
  {
    key: "predicate",
    title: "Measures",
    blurb:
      "What is being measured, in each document's own words, collapsed to one identity. This is the key facts are blocked on, so a wrong merge here would fabricate a contradiction.",
  },
  {
    key: "subject",
    title: "Subjects",
    blurb:
      "Who or what a fact is about. Resolves honorifics, legal-form suffixes and abbreviations to one entity.",
  },
  {
    key: "value",
    title: "Values",
    blurb:
      "Categorical values and named entities — states, offices, places, addresses. Learned relations here are what let the engine judge non-numeric facts.",
  },
];

const RELATION_LABEL: Record<string, string> = {
  subsumes: "contains",
  exclusive: "cannot co-occur with",
  compatible: "can co-occur with",
};

export default function RegistryPage() {
  const relations = listAllRelations();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[16px] font-semibold">Vocabulary</h1>
        <p className="max-w-3xl text-[13px] text-[var(--color-muted)]">
          There is no fixed schema of facts in this system. Structure is discovered rather than
          declared: each new label is resolved against what the corpus has already seen, and mints a
          new entry when nothing matches. This table therefore <em>is</em> the schema, and it grows
          as documents arrive. Adding a document about a subject nobody has loaded before requires no
          migration and no code change.
        </p>
        <p className="mt-2 max-w-3xl text-[13px] text-[var(--color-muted)]">
          Resolution is deliberately layered — exact match, then lexical similarity, then embeddings
          to shortlist, then a language model to decide. Embeddings alone cannot do this job:
          measured on this corpus, <code>adjusted EBITDA</code> and <code>EBITDA</code> score higher
          together (0.878) than <code>Gurugram</code> and <code>Gurgaon</code> do (0.687), and the
          first pair must stay separate while the second must merge.
        </p>
      </div>

      {relations.length > 0 ? (
        <section>
          <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Learned relations
          </h2>
          <p className="mb-2 text-[12px] text-[var(--color-muted)]">
            These do real work downstream. A <strong>contains</strong> edge makes a component-versus-aggregate
            gap reconcilable instead of contradictory; a <strong>cannot co-occur</strong> edge is what
            makes &ldquo;resigned&rdquo; versus &ldquo;in office&rdquo; a judgeable conflict rather than two unrelated strings.
          </p>
          <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-[var(--color-surface)]">
            <table className="w-full min-w-[700px] border-collapse text-[13px]">
              <tbody>
                {relations.map((r) => {
                  const a = getEntry(r.aId);
                  const b = getEntry(r.bId);
                  return (
                    <tr key={r.id} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2 font-medium">{a?.canonical ?? r.aId}</td>
                      <td className="px-3 py-2 text-[var(--color-muted)]">
                        {RELATION_LABEL[r.kind] ?? r.kind}
                      </td>
                      <td className="px-3 py-2 font-medium">{b?.canonical ?? r.bId}</td>
                      <td className="px-3 py-2 text-right">
                        <Chip>{r.namespace}</Chip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {NAMESPACES.map((ns) => {
        const entries = listEntries(ns.key);
        return (
          <section key={ns.key}>
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {ns.title} ({entries.length})
            </h2>
            <p className="mb-2 max-w-3xl text-[12px] text-[var(--color-muted)]">{ns.blurb}</p>

            {entries.length === 0 ? (
              <Empty>Nothing here yet.</Empty>
            ) : (
              <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-[var(--color-surface)]">
                <table className="w-full min-w-[700px] border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--color-line)] text-left text-[12px] text-[var(--color-muted)]">
                      <th className="px-3 py-2 font-medium">Canonical</th>
                      <th className="px-3 py-2 font-medium">Also written as</th>
                      <th className="px-3 py-2 text-right font-medium">Uses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.slice(0, 120).map((e) => (
                      <tr key={e.id} className="border-b border-[var(--color-line)] last:border-0 align-top">
                        <td className="px-3 py-2 font-medium">{e.canonical}</td>
                        <td className="px-3 py-2">
                          <span className="flex flex-wrap gap-1">
                            {e.aliases
                              .filter((a) => a.toLowerCase() !== e.canonical.toLowerCase())
                              .slice(0, 8)
                              .map((a) => (
                                <Chip key={a}>{a}</Chip>
                              ))}
                            {e.aliases.length <= 1 ? (
                              <span className="text-[12px] text-[var(--color-muted)]">—</span>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--color-muted)]">
                          {e.occurrences}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
