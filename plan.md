# Crosscheck — a Fact Knowledge Layer that explains its disagreements

> **Status:** approved design, dated 2026-09-08. This is the plan of record.
> For what has actually been built and verified, see [`progress.md`](progress.md).
> For how to install and run it, see [`setup.md`](setup.md).
> Where the implementation has since diverged from this document, `progress.md`
> is the authority and records the reason.

## Context

Superjoin VIT 2026 engineering-intern assignment, due in ~12 hours. Six PDFs
(`starter-datasets/delhivery/*`, `starter-datasets/india-macroeconomy/*`) must be turned
into a system that extracts facts, grounds each one in source evidence, and identifies
corroboration / contradiction / context-explained-difference across documents — exposed
through an API or UI that accepts new PDFs.

The brief warns explicitly: *"A graph database or visualization alone is not the
solution. The interesting part is how facts are discovered, grounded, compared, and
explained."* Most submissions will be chunk → embed → ask an LLM "do these contradict?"
→ draw a graph. The graded differentiator is the **comparison and explanation layer**.

**The thesis this project is built on: a fact is not a value, it is a scoped claim.**
`revenue = 8,142` is not comparable to anything. `(Delhivery, consolidated)
(revenue from operations) (FY2024) (₹ crore) = 8,142` is. Equally, "is a director" is
not comparable to anything until it carries *of whom, asserted as of when*. Once every
fact carries its scope, contradiction stops being an LLM opinion and becomes a
computation:

> **A contradiction is a failure to find a reconciling context.**

The engine searches a space of reconciliation hypotheses — period, entity scope,
accounting basis, unit/scale, data vintage, restatement, predicate subsumption — and
reports a genuine contradiction only when every hypothesis fails. So the system does not
just label a pair; it **names the axis of disagreement**. The LLM does perception; a
symbolic engine does the reasoning, so every verdict is auditable and reproducible.

**Decisions already made:** Anthropic API key for extraction · all-TypeScript Next.js ·
local-only with committed cache + demo DB (no deploy) · ingest all 6 PDFs.

**Environment:** Node 24 / npm 11. Ollama present with `nomic-embed-text` (free local
embeddings, no key). No poppler/pdftotext — PDF text comes from `pdfjs-dist` in Node.
The six PDFs are digitally generated filings with real text layers; no OCR needed.

### Two constraints this plan deliberately answers

**1. Facts are numeric *and* semantic.** The brief says "numerical or semantic facts,"
and two of its three examples are non-numeric (a director active in one document and
resigned in a later one; differently written addresses referring to the same place).
Numbers are therefore *one* value type among four, and the reasoning engine is built
around a **pluggable value comparator** so status, date, and entity facts are first-class
rather than bolted on. See "Value comparators" below.

**2. Open fact schema on top of a relational store.** The brief forbids hard-coded
*fact* schemas but explicitly leaves *storage* schema to us. The fixed part here is only
the envelope — subject, predicate, value, scope, evidence. The contents are open:
`predicate` is free text, `basis` is an open qualifier vocabulary, `value` is a tagged
union, and anything genuinely novel lands in a `qualifiers` JSON column (SQLite JSON1 is
queryable). **A new kind of fact never requires a migration.** SQLite is chosen because
reconciliation constantly runs *blocking* joins — "every fact sharing this canonical
predicate and subject" — which is an indexed lookup run thousands of times. Swapping to
Postgres is one file (`lib/db/client.ts`). This trade-off gets written up in the README.

## Architecture

```
PDF ─▶ [1 parse]  pdfjs-dist → page text + char→bbox spans
    ─▶ [2 segment] page-bounded units + salience prefilter + heading context
    ─▶ [3 extract] LLM → scoped claims, any value type (cached by content hash)
    ─▶ [4 ground]  deterministic: quote must exist, value must be in quote ─▶ quarantine
    ─▶ [5 normalize] units/scales, fiscal periods → intervals, text canonical forms
    ─▶ [6 registry] subjects · predicates · categorical values  ← the schema that grows
    ─▶ [7 reason]  blocking → context algebra → value comparator → verdict rules
    ─▶ [8 API / 9 UI]
```

Stages 4, 5, 7 are pure deterministic functions — the testable core.

## Layout

```
app/
  page.tsx                      Documents: upload, ingest progress, per-doc stats
  facts/page.tsx                Fact browser + evidence panel (quote + PDF highlight)
  relations/page.tsx            THE demo screen: verdicts + dimension-delta "why" table
  registry/page.tsx             Live vocabulary: subjects, predicates, value relations
  api/documents/route.ts        POST upload (multipart) · GET list
  api/documents/[id]/status/route.ts
  api/facts/route.ts            filter by doc / predicate / subject / type / text
  api/facts/[id]/route.ts       fact + evidence + its relations
  api/relations/route.ts        filter by verdict
  api/registry/route.ts         the three namespaces + learned relations
  api/quarantine/route.ts       rejected extractions (Case 4 surface)
  api/reconcile/route.ts        re-run reasoning (deterministic, no LLM)
lib/
  db/schema.ts, client.ts       better-sqlite3; open fields in JSON columns
  ingest/parse.ts               pdfjs-dist → { pageText, spans[{start,end,x,y,w,h}] }
  ingest/segment.ts             units + salience prefilter + heading/caption context
  extract/schema.ts             zod ScopedClaim schema (4 value kinds)
  extract/extract.ts            AI SDK generateObject, concurrency pool, retries
  extract/cache.ts              sha256(model+promptVersion+text) → data/cache/*.json
  extract/ground.ts             quote locate (exact→ws→fuzzy) + value-in-quote check
  normalize/units.ts            crore/lakh/mn/bn/%/bps → canonical
  normalize/period.ts           FY24 / Q4FY24 / H1FY25 / "as at 31 Mar 2024" → interval
  normalize/text.ts             case/punct/abbreviation folding for names & addresses
  registry/embed.ts             Ollama nomic-embed-text (local, free)
  registry/registry.ts          ONE canonicalizer, three namespaces + learned relations
  reason/block.ts               candidate pairs by (canonical predicate, canonical subject)
  reason/algebra.ts             dimension deltas: period/entityScope/basis/unit/vintage
  reason/compare/               value comparators: numeric · date · categorical · entity
  reason/verdict.ts             ordered rules → verdict + structured explanation
  reason/adjudicate.ts          LLM escalation for ambiguous pairs only
scripts/demo.ts                 ingest all 6 starter PDFs (from cache) + print 4 cases
data/cache/                     COMMITTED — lets graders run with no API key
data/knowledge.db               COMMITTED — pre-built demo database
docs/cases/                     the four required cases, written up with evidence
```

## Core data model

```ts
ScopedClaim {
  claim: string                  // one-sentence natural-language restatement
  subject: string                // "Delhivery Limited" | "India" | "Sahil Barua"
  predicate: string              // free-form label AS WRITTEN — no fixed enum
                                 //   "revenue from operations" | "office held" |
                                 //   "registered office" | "date of appointment"
  factType: "quantity" | "state" | "date" | "identity"
  value: { kind:"number",      raw, number, unit, scale, currency }
        | { kind:"categorical", raw, normalized }      // "resigned", "Managing Director"
        | { kind:"date",        raw, iso }
        | { kind:"entity",      raw, normalized }      // an address, a person, a place
  scope: {
    period: { raw, kind:"fiscal_year"|"quarter"|"instant"|"calendar_year"|"range",
              start, end } | null      // for states: the validity interval
    assertedAsOf: string | null        // the document's own as-of date
    basis: string[]                    // consolidated | standalone | provisional |
  }                                    //   projection | restated | segment:<x> | ...
  qualifiers: Record<string, unknown>  // open escape hatch → JSON column
  evidence: { quote, pageNumber }      // quote copied character-for-character
  extractionConfidence: number
}
```

No fixed fact schema — `predicate` is free text, `basis` an open list, `qualifiers` an
open map. Structure emerges in the registry (stage 6) rather than being imposed up
front. That *is* the "schema evolves dynamically" brownie point, and it applies to
semantic facts just as much as numeric ones.

## Key implementation notes

**Stage 2 — heading context is load-bearing.** Scope qualifiers ("Consolidated",
"₹ in millions", "FY2024", "as at 31 March 2024") live in table headers, captions and
section titles, not in the row with the value. Each extraction unit must carry document
title, page number, nearest preceding headings and any table caption. Get this wrong and
the entire thesis collapses. The salience prefilter (unit contains a digit, a date
token, or a person/place-shaped capitalised span) skips boilerplate — report the skip
count in the README as a perf number. Note it is *not* digits-only, or we would drop
every director and address fact.

**Stage 4 — grounding is the honesty guard.** Locate the quote in page text (exact →
whitespace-normalized → fuzzy token match), then assert the fact's raw value appears
inside that quote — as a digit sequence for numbers, as a normalized substring for text.
Verdicts: `grounded` / `quote_not_found` / `value_not_in_quote`. Non-grounded facts go
to `quarantine`, visible in the UI, never entering the reasoning graph. This yields a
*measured* extraction-precision number and supplies required Case 4 directly.

**Stage 6 — one registry, three namespaces.** The same loop — normalize → embed with
local `nomic-embed-text` → cosine search → high similarity auto-aliases, an ambiguous
band costs one cheap LLM call, low similarity mints a new canonical entry — runs over:

| Namespace | Resolves | Learned relations |
|---|---|---|
| **subjects** | "Sahil Barua" = "Mr. S. Barua"; "Delhivery Ltd" = "the Company" | — |
| **predicates** | "Revenue from operations" vs "Total income" vs "Net sales" | `subsumes` / `component_of` |
| **values** | "Gurugram" = "Gurgaon"; "Plot 5, Sector 44" = "Plot No. 5, Sector-44" | `same` / `exclusive` / `compatible` |

Persisted across documents, so ingestion is incremental and gets cheaper as the corpus
grows. Two relations do real work in stage 7: predicate subsumption ("revenue from
operations ⊂ total income") makes a value gap *reconcilable* rather than contradictory;
value exclusivity ("resigned" ⊥ "in office", while "Director" and "Chairman" are
compatible) is what lets the engine judge non-numeric facts at all.

**Stage 7a — value comparators (pluggable, per value kind).** Each returns
`SAME | DIFFERENT | EXCLUSIVE | COMPATIBLE | UNKNOWN` plus detail:

- `number` — unit-normalized relative-ε equality, plus a **ratio diagnostic**: a gap of
  exactly ×10/×100/×0.1 is almost always a scale error, and a ratio near a Q4/FY
  proportion hints at a period mismatch. The diagnostic feeds the explanation text.
- `date` — interval/instant comparison with tolerance.
- `categorical` — registry lookup for `same`/`exclusive`/`compatible`; this is what
  turns "in office" vs "resigned" into a real verdict.
- `entity` — abbreviation-folded normalization → embedding → LLM tiebreak; handles the
  brief's "differently written addresses" example.

**Stage 7b — the engine.** Block on (canonical predicate, canonical subject) so
comparison is O(pairs within block), never a global O(n²) — a new document compares only
against existing block members. For each pair compute deltas on `period`
(EQUAL/NESTED/DISJOINT/OVERLAP/MISSING), `entityScope`, `basis`, `unit`, `vintage`
(source publication date), `predicateRelation`. Then run the comparator, then ordered
rules:

| # | Condition | Verdict |
|---|---|---|
| 1 | dimensions aligned, comparator SAME | **CORROBORATES** |
| 2 | dimensions aligned, comparator DIFFERENT or EXCLUSIVE | **CONTRADICTS** |
| 3 | a dimension differs and explains the gap | **RECONCILED** (+ named axis) |
| 4 | aligned, differ, one is restated / later vintage | **SUPERSEDED** |
| 5 | components sum to the aggregate (quarters → year) | **DERIVES** |
| 6 | nothing fires cleanly | escalate to LLM adjudicator, flagged in UI |

Rules 1–3 are value-kind agnostic, which is the design's payoff: *director in office
(FY22 prospectus)* vs *director resigned (FY24 report)* is EXCLUSIVE on value, so it is
a **CONTRADICTS** when the validity periods overlap and a **RECONCILED-by-time** when
they do not — same table, no special-casing. Every relation persists the verdict,
confidence, structured dimension deltas, a human explanation, and whether it was
rule-derived or LLM-adjudicated, so the provenance of every judgement is visible.

**Cost/reproducibility.** Every LLM call is cached by
`sha256(model + promptVersion + unitText)` into `data/cache/`, committed. Re-runs are
free and deterministic; graders run the full pipeline with no key.

## Build order (12h, with cut lines)

| Hours | Work |
|---|---|
| 0–1 | Scaffold Next.js + SQLite schema; `pdfjs-dist` page text + bboxes proven on one PDF |
| 1–3 | zod schema, extraction prompt, cache, concurrency pool; one doc end-to-end |
| 3–4 | Grounding check + quarantine |
| 4–5 | Normalizers (units, periods, text) with vitest tests on tricky strings |
| 5–6.5 | Registry: one canonicalizer over all three namespaces + Ollama embeddings |
| 6.5–8.5 | Context algebra + value comparators + verdict rules (+ vitest) |
| 8.5–10 | UI: documents, facts + evidence, relations "why" panel, registry |
| 10–11 | Ingest all 6 PDFs; hunt and write up the four required cases in `docs/cases/` |
| 11–12 | README (5 required sections) + 3-minute demo video |

**Cut first if behind:** `DERIVES` arithmetic check → PDF-page highlight overlay (fall
back to quote + page number) → registry screen becomes a tab, not a page. **Never cut:**
grounding, the context algebra, non-numeric comparators, the four cases.

Commit meaningfully at each stage boundary — the brief asks for it explicitly.

## The four required cases

Found by running the pipeline, not hardcoded; then documented in `docs/cases/`. At least
one of the first three must be **non-numeric**, to show the layer is not a number
scraper. Expected sources, to be confirmed against real output:

1. **Corroborated** — FY24 revenue in the annual report vs the Q4 FY24 earnings deck,
   one stated in ₹ crore and the other in ₹ millions. *(numeric, differently expressed)*
2. **Contradiction** — a director in office per the 2022 prospectus vs resigned per the
   FY24 report, with overlapping validity; fallback candidate is a same-period,
   same-basis figure differing between two documents. *(semantic)*
3. **Reconciled by context** — Q4 FY24 vs full-year FY24 (period), consolidated vs
   standalone (entity scope), IMF projection vs RBI actual (basis + vintage), or the
   same registered office written two ways. *(one numeric, one entity, if both surface)*
4. **Failure** — drawn from the quarantine table with a real quote and an honest note on
   handling and improvement.

## Verification

- `npm run test` — vitest over the deterministic core: period parser (`FY24`, `Q4 FY24`,
  `H1FY25`, `as at March 31, 2024`, `2024-25`), unit normalizer (crore/lakh/mn/bn/bps),
  text normalizer (name and address folding), and the verdict table against hand-built
  fact pairs covering all six verdicts **for each value kind** — a numeric pair, a
  status pair, and an entity pair at minimum.
- `npm run demo` — ingests all 6 starter PDFs from the committed cache and prints the
  four cases; must complete with **no API key set**.
- `npm run dev` — upload a **seventh, unseen PDF** through the UI and confirm facts,
  evidence and cross-document relations appear with no code changes. This is the real
  generalization test; do it before recording the video.
- Manual audit: pick 10 random facts across at least two value kinds, open each evidence
  quote in the source PDF, confirm the value and its scope are as recorded. Report the
  hit rate honestly in the README.
