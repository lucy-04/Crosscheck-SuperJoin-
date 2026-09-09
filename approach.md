# Approach

How Crosscheck works, why it is built this way, what the trade-offs cost, and
what I got wrong on the way.

Companion documents: [`README.md`](README.md) (setup and results) ·
[`docs/cases.md`](docs/cases.md) (the four required cases) ·

---

## 1. The problem, and why the obvious build fails

The obvious pipeline is: chunk the PDFs → embed the chunks → retrieve similar
pairs → ask an LLM "do these contradict?" → draw a graph. I want to be precise
about why that fails, because the failure is not "it's a bit inaccurate" — it is
structural.

Consider four numbers pulled from the starter documents:

```
8,141.7      7,225.3      81,417      2,194
```

Do any of them agree? **The question is unanswerable as posed.** The answer
depends entirely on what period each covers, which entity, on what accounting
basis, and in what unit. `8,141.7` (₹ crore, FY24, consolidated) and `81,417`
(₹ million, FY24, consolidated) are *the same fact*. `8,141.7` and `2,194` differ
by 4× and are *also* consistent, because one is a year and the other a quarter
within it.

A similarity search over raw text has access to none of that. So when you hand
the pair to a model and ask "do these contradict?", it produces a fluent, confident
answer built on nothing — and you cannot tell which of its answers are grounded
and which are invented, because they look identical.

The assignment's own brief says as much: *"A graph database or visualization alone
is not the solution. The interesting part is how facts are discovered, grounded,
compared, and explained."*

---

## 2. The core idea: a fact is not a value, it is a scoped claim

Everything follows from one commitment. Every fact carries the context that makes
it comparable:

```
subject     Delhivery Limited
predicate   revenue from operations
value       8,141.7  (crore, INR)   →  normalised: 81,417,000,000 INR
period      FY2024                  →  2023-04-01 … 2024-03-31
basis       [consolidated]
assertedAsOf 2024-08-08             ←  the source document's own publication date
evidence    page 63, chars 4021-4088, verified present on that page
```

The same shape holds for non-numeric facts. This matters because two of the
brief's three worked examples are semantic, not numeric:

```
subject     Sahil Barua
predicate   office held
value       "resigned"       ← a STATE, not a number
period      31 January 2024
assertedAsOf 2024-08-08
```

Once scope is attached, **"do these contradict?" stops being an opinion and
becomes a computation.** That single reframing is what the whole system is built
to exploit:

> **A contradiction is a failure to find a reconciling context.**

The engine searches a space of reconciling hypotheses — different period, entity
scope, accounting basis, unit, data vintage, restatement, metric subsumption —
and reports a genuine contradiction only when every hypothesis fails.

Of the 226 facts currently in the layer, 159 are quantities, 47 are states, 13 are
identities and 7 are dates — so the non-numeric path is exercised, not decorative.

---

## 3. Architecture

```
PDF ─▶ 1 parse        text + per-character coordinates
    ─▶ 2 segment      page-sized units carrying the headings/captions that scope them
    ─▶ 3 extract      LLM → scoped claims                    ← the ONLY LLM step
    ─▶ 4 ground       deterministic: is this claim really in the document?
    ─▶ 5 normalise    crore/million/bps → one magnitude; FY24/Q4FY24 → intervals
    ─▶ 6 canonicalise align wording across documents (the schema that grows)
    ─▶ 7 reason       block → six-axis comparison → ordered verdict rules
    ─▶ API / UI
```

Roughly 7,300 lines of TypeScript. The load-bearing files:

| File | Role |
|---|---|
| `lib/reason/verdict.ts` | The rule table — where a scope comparison becomes an explained verdict |
| `lib/reason/algebra.ts` | The six axes; emits a self-explaining delta per axis |
| `lib/extract/ground.ts` | The honesty guard |
| `lib/registry/registry.ts` | One canonicaliser over three namespaces — the evolving schema |
| `lib/normalize/period.ts` | Fiscal-period parsing; the single most error-prone thing here |

### The central division of labour

**The model perceives. The code judges.**

The LLM is asked to do exactly one thing: read a page and pull out claims with
their scope and a verbatim quote. It is never asked whether two things agree.
Every verdict comes from deterministic code, which buys three properties:

1. **Reproducible** — the same corpus produces the same verdicts, run to run.
2. **Explainable** — each verdict is assembled *from* the axis comparison, so the
   explanation is the reasoning, not a post-hoc justification of a decision
   already made.
3. **Free to scale** — comparison costs no tokens, so adding documents grows the
   graph without growing the bill.

### Stage 1 — parse (`lib/ingest/parse.ts`)

Text extraction that preserves **character-to-bounding-box** mapping, so a fact's
evidence can be located on the page it came from.

The decision that mattered: horizontal gaps between text items are reconstructed
as runs of spaces — the trick `pdftotext -layout` uses. A stream-order extractor
flattens a ten-column quarterly table into an unreadable ribbon of digits. With
gap reconstruction it survives as a table:

```
₹ Cr             Q1 FY23  Q2 FY23  Q3 FY23  ...   FY23   FY24
Express Parcel       94      134      190   ...    636    934
% margin           8.9%    11.9%    15.9%   ...  14.0%  18.4%
```

Measured: a 27-page deck parses in 0.7 s; a 100-page annual report in 1.0 s
(703,522 characters, 30,954 spans). Pages are released as they convert, so peak
memory tracks the largest page rather than the document.

### Stage 2 — segment (`lib/ingest/segment.ts`)

**A page is the extraction unit.** Scope qualifiers never sit beside their
numbers:

```
Consolidated Statement of Profit and Loss     ← entity scope
for the year ended March 31, 2024             ← period
(Rs. in crore)                                ← unit and scale
   ...
Revenue from operations         8,141.7       ← all a naive chunker would send
```

Sending that last line alone forces the model to invent a scope or omit one, and
either poisons every downstream comparison. Units carry the headings and captions
standing above them, never cross a page boundary (evidence must resolve to one
page to be highlightable), and running headers repeated on ≥50% of pages are
detected and stripped.

The salience prefilter is deliberately **not** digits-only — a numeric filter
would silently discard every director and address fact, which is two thirds of
the brief's examples.

### Stage 3 — extract (`lib/extract/`)

Two schema decisions, both about reliability rather than elegance:

- **Periods come back as raw text.** The model copies `"Q4 FY24"` verbatim and our
  tested parser computes the interval. Fiscal-year arithmetic is exactly where a
  model errs, and a wrong interval still *looks* like a valid interval — nothing
  downstream could catch it.
- **`value` is a flat object with a `kind` field**, not a zod discriminated union.
  Nested `anyOf` is where structured-output calls fail most often; the tagged
  union is reconstructed in ten lines of code.

### Stage 4 — ground (`lib/extract/ground.ts`)

Deterministic, no LLM. A claim's quote must be locatable on the page it cites, and
the claimed value must appear inside that quote. Matching escalates through six
tiers: exact → whitespace-collapsed → caseless → punctuation-folded →
scattered-within-3-lines → token-anchored.

Failures are **quarantined and counted**, not dropped. This matters more than a
generic "LLMs hallucinate" caveat, because a fabricated figure that reaches the
reasoning layer *does not fail loudly* — it surfaces as a confident contradiction
against a real figure, which is the worst possible output for a system whose
entire job is adjudicating disagreement.

### Stage 6 — the registry (`lib/registry/`)

There is no enumeration anywhere of which facts the system can hold. `predicate`
is free text, `basis` is an open vocabulary, and structure emerges in a
**vocabulary registry** that grows as documents arrive — one canonicaliser over
three namespaces (subjects, predicates, values). It currently holds 154
predicates, 19 subjects and 2 values.

Resolution is layered: exact match → lexical similarity → embeddings shortlist →
LLM adjudicates → mint a new entry.

### Stage 7 — reason (`lib/reason/`)

Facts are compared only within **blocks** — same canonical predicate, same
canonical subject — so comparison is linear in corpus size, not quadratic. The
current layer has 37 blocks and compares 140 pairs.

Each pair is scored on six axes, every one emitting a sentence explaining itself:

| Axis | Question it answers |
|---|---|
| `period` | equal, nested, overlapping, boundary-dated, disjoint? |
| `entityScope` | consolidated vs standalone vs a named segment? |
| `basis` | actual vs provisional vs projection vs restated? |
| `unit` | do these reduce to a common base at all? |
| `predicate` | same measure, or is one a component of the other? |
| `vintage` | which document is the later word? |

Then an ordered rule table:

| Rule | Condition | Verdict |
|---|---|---|
| R-different-entities | the two `key:value` qualifiers name different things | **UNRELATED** |
| R0 | values not comparable; units differ | **RECONCILED** (unit) |
| R1 | every axis aligned, values agree | **CORROBORATES** |
| R1b | values agree; one period is an instant on the other's closing date | **CORROBORATES** (reduced confidence) |
| R2 | values agree but scope differs | **UNRELATED** (coincidence) |
| R4 | values differ **and a confusable axis explains it** | **RECONCILED** (names the axis) |
| R5 | one figure explicitly marked restated | **SUPERSEDED** |
| R6 | mutually exclusive states, different vintages | **SUPERSEDED** (state changed) |
| R7 | one side is a projection, the other an outturn | **RECONCILED** |
| R7b | several values under one label on one page | **UNRELATED** (a breakdown) |
| R8 | every reconciling hypothesis failed | **CONTRADICTS** |

**The rules are value-kind agnostic**, which is the design's payoff. The brief's
director example needs no special case:

```
"in office" (2022 prospectus)  vs  "resigned" (FY24 report)
  → values are EXCLUSIVE, vintage axis misaligned
  → R6: SUPERSEDED — "the state changed between these two documents"
```

while the same two claims from documents of the **same** vintage fall through to
R8 and are reported as a genuine contradiction. Same table, no branching on type.

---

## 4. Important decisions and trade-offs

### A page is the extraction unit, not a fixed-size chunk

Small chunks optimise for *context* limits — and context was never the binding
constraint. A page of these filings is ~7,000 characters, which any current model
swallows whole. **Request count** was the constraint. Page granularity took the
starter corpus from ~3,250 model calls to ~510.

It is also better on the merits: a financial table stays physically attached to
the caption and headings that scope it, rather than depending on heuristics to
copy that context onto a fragment.

*Trade-off:* a page yields more facts per call, so the per-call fact cap can bind
on very dense tables. Accepted — recall lost there is smaller than the scope
fidelity gained.

### Periods are parsed by us, not by the model

`FY24`, `2023-24`, `Q4FY24`, `H1FY25`, `9M FY24`, `as at March 31 2024`, `CY2024`
and `for the year ended March 31, 2024` all collapse to `[start, end]` intervals,
so "is one inside the other?" is interval arithmetic rather than string matching.

The fiscal-year start month is a **parameter, not a constant**. India's April year
is the default because the starter documents use it; a US 10-K needs only a
different option.

*Trade-off:* a written form the parser does not recognise yields an unscoped fact
rather than a wrong one. Unscoped facts cannot be contradicted — a deliberate
choice of silence over confident error.

### Cross-currency comparison is refused, not fudged

The IMF reports USD billions; the RBI reports INR crore. An invented FX rate would
let the engine "reconcile" figures it has no basis to reconcile, so those pairs
are reported as an unresolved `unit` axis. *"I cannot compare these"* beats a
confident wrong answer.

### SQLite, not a graph database

The brief warns that a graph DB alone is not the solution, and reconciliation is
dominated by **blocking joins** — "every fact sharing this canonical predicate and
subject", run once per fact. That is an indexed lookup, which relational storage
does well.

The fixed part of the schema is only the *envelope* every claim shares: subject,
predicate, value, scope, evidence. Everything open-ended lives in queryable JSON
columns, so **a new kind of fact never requires a migration**. Swapping to
Postgres is one file (`lib/db/client.ts`).

### The LLM cache is committed to the repository

Thirty lines of content-addressed caching that changed what the project *is*:

- anyone can reproduce every result with **no API key** — verified, `exit 0`
- re-runs are byte-identical, so the reasoning layer can be iterated on without
  re-paying for extraction
- a partial run is permanent progress rather than wasted spend

That third property was load-bearing under free-tier limits, and the second was
used constantly: several grounding fixes were re-validated across the whole corpus
in about a second.

### Embeddings shortlist; they never decide

This is a **measured** conclusion, not a preference. Cosine similarity on the real
label set:

```
0.6950  revenue from operations ↔ number of employees   (different)
0.6871  gurugram                ↔ gurgaon               (SAME)
0.8833  revenue from operations ↔ revenue               (same-ish)
0.8783  adjusted ebitda         ↔ ebitda                (DIFFERENT — the adjustments are the point)
0.8389  registered office       ↔ corporate office      (DIFFERENT — different offices)
```

Two unrelated financial metrics score **higher** than two spellings of one city,
and pairs that must stay separate sit above pairs that must merge. **No cosine
threshold separates same from different.** So embeddings provide recall and a
language model provides precision, with the whole shortlist judged in one call and
the answer persisted — each distinct label is adjudicated once for the life of the
corpus.

### Precision over volume — the most valuable change in the project

An earlier build reported **151 relations**. Almost all were noise, and removing
it mattered more than anything else I did:

| Problem | Cause | Fix |
|---|---|---|
| 36 of 37 "corroborations" were one value | One figure extracted 9 times from a page produces C(9,2)=36 self-confirming pairs | Deduplicate identical claims at ingest — corroboration requires *independent* assertions |
| 92 of 113 "reconciliations" were Q1 vs Q2 | R4 fired on any value difference plus any scope difference | A reconciliation must resolve an **apparent** conflict: periods must be *confusable* (nested, overlapping, boundary), not disjoint siblings |
| 4 compared different people | The extractor put the subject into `basis` as `member:…`, so two directors blocked together | A `key:value` qualifier names *which entity*; when two differ the facts are unrelated |

The result is **6 relations from 226 facts**, all defensible, 3 of them
cross-document. Six that a reader can trust beat 151 they must sift — a knowledge
layer that cries contradiction at every pair of quarters trains you to ignore it.

---

## 5. What the infrastructure cost, and what it taught

More of this build was spent on rate limits than on extraction quality. Four
*different* binding constraints, each needing a different fix, each measured from
the actual error rather than assumed:

| Provider | Binding limit | Consequence |
|---|---|---|
| Gemini free tier | **20 requests/day** | Drove page-level chunking: 3,250 → 510 calls |
| Groq free tier | **8,000 tokens/minute** | Request pacing is useless; the limiter had to become token-aware |
| Groq | reserved output counts toward TPM | Capping `maxOutputTokens` cut cost per call 5,192 → 2,502 |
| Groq | **200,000 tokens/day, per model** | A model fallback chain turns three budgets into one |

The sharpest of these: Groq bills the *reserved* output budget, not what is
generated, and the AI SDK sent no cap at all. Setting one roughly **doubled
throughput for free** — and because `maxOutputTokens` is not part of the cache
key, it invalidated nothing already paid for.

`lib/model.ts` selects a provider from whichever key is present, so switching
mid-project cost two lines. The cache key includes the model id, so results stay
attributable and switching never silently reuses another model's answers.

**A negative result worth keeping:** disabling Gemini's thinking budget for
extraction looked like free latency — extraction is transcription under a schema,
not deduction. But 48 of 51 calls then failed to produce a valid object and the
run yielded 7 facts instead of 148. On that model the reasoning pass is
load-bearing for structured output. This is recorded in `lib/model.ts` so nobody
repeats the experiment.

---

## 6. AI tools used

| Tool | Role |
|---|---|
| **Claude Code (Opus)** | Pair programmer throughout — architecture, implementation, debugging, and the code review that found several of the bugs listed below |
| **Groq `openai/gpt-oss-120b`** | Fact extraction and vocabulary adjudication (final corpus) |
| **Google Gemini 2.5 Flash** | Extraction, earlier in the build; benchmarked side by side |
| **Ollama `nomic-embed-text`** | Embeddings — runs **locally**, so the only metered spend in the system is extraction |

Provider comparison on the same document with the same prompt:

| Model | Facts | Quarantined | Call failures |
|---|---|---|---|
| gemini-2.5-flash | 148 | 2 | 0 |
| groq gpt-oss-120b | 174 | 60 | 3 |
| groq gpt-oss-20b | 105 | 9 | 16 |

Gemini produced visibly cleaner extractions; Groq was used for the final corpus
because Gemini's free tier allows 20 requests per day, which is not enough to
ingest a single document.

---

## 7. Measured results

```
2 documents        226 facts        86 quarantined        72% grounding rate
37 blocks          140 pairs compared                     6 relations
154 predicates     19 subjects      2 values              413 cached responses
76 unit tests passing
```

Facts by kind: 159 quantities · 47 states · 13 identities · 7 dates.

Relations: 1 corroboration (cross-document), 4 reconciliations, 1 contradiction.

Quarantine, by reason: 47 `quote_lacks_context`, 27 `quote_not_found`, 12
`value_not_in_quote`.

**Live upload, measured end to end:** an unseen 1-page PDF ingested in 17.5 s,
produced 9 facts at 100% grounding, and formed 2 correct cross-document relations
after a 9.6 s reconcile. That is the generalisation claim demonstrated rather than
asserted — and it used a period phrasing (`"For the year ended March 31, 2024"`)
that appears in none of the starter documents.

---

## 8. Bugs worth reporting

Six real bugs, and the instructive fact is that **four were silent suppressions in
my own code** — correct extractions thrown away, which look exactly like model
failures and get blamed on the model.

| Bug | Effect |
|---|---|
| `parseNumericLiteral("Rs. 2,194")` → `0.2194` | Stripping `"Rs."` left a leading `"."`; `".2194"` parses cleanly as a *wrong* answer. Three orders of magnitude, silent |
| The same bug again in `digitsOf` | Fixed in one file, left in another |
| Space treated as a digit separator | `"Total equity 9,177 9,145"` matched as `91779145` — two table columns welded into one nonsense number |
| `normalizeOrgName("The Company")` → `"the"` | Would have merged every self-referring issuer into one subject |
| Subjects folded by predicate-derived rules | `"Delhivery"` and `"Delhivery Limited"` became different subjects, so their facts never met in a block |
| `allModels()` derived from the active provider | With no key the list was empty, so a fully cached document reported `0/26 cached` — this broke the headline no-key promise |

Two lessons generalise. **A derived value computed in two places will diverge** —
the cache key was rebuilt by a near-identical second function and silently missed
every entry. And **a probe that is not representative of the workload measures the
probe**: I tested remaining quota with a 50-token request, concluded "capacity
available", and then watched 89 real 3,300-token pages fail against the same
budget.

---

## 9. What I would do next, in order

1. **Fix predicate specificity in the prompt.** A table of `% of revenue` broken
   down by row gets each row extracted with the same generic predicate, losing the
   row identity. Two guards now catch the consequences, but the right fix is to
   require the predicate to name the row. This is also the cause of the one
   remaining false-positive contradiction.
2. **A confidence-weighted review queue.** Low-confidence contradictions are the
   ones a human should see; the UI should rank them, not just list them.
3. **The `DERIVES` verdict.** Quarters summing to their fiscal year is arithmetic
   corroboration and a strong signal that a whole table was read correctly.
   Designed, not implemented.
4. **Table-structure-aware extraction.** Parsing rows and columns explicitly would
   fix under-specified predicates at the source rather than downstream.
5. **Streaming ingest with a job queue.** Upload runs inline today; a 100-page PDF
   holds the request open for minutes. It should return a job id and stream
   progress.
