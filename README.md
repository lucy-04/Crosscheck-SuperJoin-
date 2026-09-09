# Crosscheck

**A fact knowledge layer that explains its disagreements.**

Crosscheck reads PDFs into *scoped claims*, verifies every claim against the page
it came from, and then decides — with reasons — where those claims corroborate,
contradict, or only appear to contradict.

Its central idea is one sentence:

> **A contradiction is a failure to find a reconciling context.**

---

## Setup and run instructions

Requires **Node 20+** (built on 24.16). No Python, no Docker, no database server,
no OCR tooling.

```bash
npm install
npm run demo        # rebuild the knowledge layer and print the four required cases
npm run dev         # explore it at http://localhost:3000
```

**`npm run demo` needs no API key.** Every model response is cached by a hash of
its prompt, and `data/cache/` is committed, so the full pipeline — parse,
extract, ground, canonicalise, reconcile — replays exactly, for free. Nothing is
a fixture or a recording.

To ingest **new** PDFs you need a provider key in `.env.local`:

```bash
GROQ_API_KEY=gsk_...        # or ANTHROPIC_API_KEY=..., or GEMINI_API_KEY=...
```

The provider is chosen from whichever key is present. Full options, scripts and
API reference: [`setup.md`](setup.md).

```bash
npm test            # 76 unit tests over the deterministic core
npm run ingest -- --all --force    # re-ingest the starter corpus
npm run reconcile -- --fresh       # rebuild the relation graph (no LLM calls)
```

---

## Video demo

*(link to follow — 3 minutes, showing a PDF being processed and the four cases)*

---

## Approach

### The problem with the obvious build

The obvious pipeline is: chunk → embed → retrieve similar pairs → ask an LLM "do
these contradict?" → draw a graph. It fails in a specific and unrecoverable way.

`revenue = 8,142` is not comparable to anything. Not to `7,225`, not to `81,417`,
not to `2,194`. Whether those numbers agree depends entirely on **what period,
what entity scope, what accounting basis, and what unit** each was measured
under — and a similarity search over raw text has none of that. Ask a model to
adjudicate such a pair and it will produce a fluent answer built on nothing.

### A fact is not a value, it is a scoped claim

Every fact in Crosscheck carries the context that makes it comparable:

```
subject     Delhivery Limited
predicate   revenue from operations
value       8,141.7  (crore, INR)  →  normalised: 81,417,000,000 INR
period      FY2024   →  2023-04-01 … 2024-03-31
basis       [consolidated]
asserted    2024-08-08          ← the source document's own date
evidence    page 63, chars 4021-4088, verified present
```

The same shape holds for non-numeric facts, which the brief asks for explicitly
and where two of its three examples live:

```
subject     Sahil Barua
predicate   office held
value       "resigned"          ← a STATE, not a number
period      31 January 2024
asserted    2024-08-08
```

Once scope is attached, **"do these contradict?" stops being an opinion and
becomes a computation.**

### The engine: LLM for perception, code for judgement

```
PDF ─▶ parse      text + per-character coordinates
    ─▶ segment    page units carrying the headings and captions that scope them
    ─▶ extract    LLM → scoped claims                        ← the only LLM step
    ─▶ ground     deterministic: is this claim actually in the document?
    ─▶ normalise  crore/million/bps → one magnitude; FY24/Q4FY24 → intervals
    ─▶ canonicalise   align wording across documents
    ─▶ reason     six-axis comparison → verdict rules
```

The model is asked to *perceive* — pull a claim and its scope out of a page, and
cite a quote. It is never asked to judge. Every verdict comes from deterministic
code, which buys three things: verdicts are **reproducible** run to run, each one
can **show its work**, and comparison stays **free** as the corpus grows.

Two facts are compared on six axes, each producing a self-explaining delta:

| Axis | Question |
|---|---|
| `period` | equal, nested, overlapping, disjoint? |
| `entityScope` | consolidated vs standalone vs a segment? |
| `basis` | actual vs provisional vs projection vs restated? |
| `unit` | do these reduce to a common base at all? |
| `predicate` | same measure, or is one a component of the other? |
| `vintage` | which document is the later word? |

Then an ordered rule table:

| Rule | Condition | Verdict |
|---|---|---|
| R1 | every axis aligned, values agree | **CORROBORATES** |
| R1b | values agree; one period is an instant on the other's closing date | **CORROBORATES** *(reduced confidence)* |
| R4 | values differ **and an axis explains it** | **RECONCILED** *(names the axis)* |
| R5 | one figure explicitly marked restated | **SUPERSEDED** |
| R6 | mutually exclusive states, different vintages | **SUPERSEDED** *(state changed)* |
| R7 | one side is a projection, the other an outturn | **RECONCILED** |
| R7b | several values under one label on one page | **UNRELATED** *(a breakdown)* |
| R8 | every reconciling hypothesis failed | **CONTRADICTS** |

**The rules are value-kind agnostic**, which is the design's payoff. The brief's
own director example needs no special case:

```
"in office" (2022 prospectus)  vs  "resigned" (FY24 report)
  → values are EXCLUSIVE, vintage axis misaligned
  → R6: SUPERSEDED — "the state changed between these two documents"
```

while the same two claims from documents of the **same** vintage fall through to
R8 and are reported as a genuine contradiction. Same table, no branching on type.

### Grounding: an error rate, not a disclaimer

Every claim must cite a quote that is verifiably present on the page it names,
and the claimed value must appear inside that quote. Failures are **quarantined
and counted**, not silently dropped — the `/quarantine` screen is the system's
own error log.

This matters more than a generic "LLMs hallucinate" caveat, because a fabricated
figure that reaches the reasoning layer *does not fail loudly*. It surfaces as a
confident contradiction against a real figure — the worst possible output for a
system whose entire job is adjudicating disagreement.

### The schema evolves; it is never declared

There is no enumeration anywhere of which facts the system can hold. `predicate`
is free text, `basis` is an open vocabulary, and structure emerges in a
**vocabulary registry** that grows as documents arrive: one canonicaliser over
three namespaces (subjects, predicates, values), resolving each new label against
what the corpus has already seen.

Resolution is layered — exact match, then lexical similarity, then embeddings to
shortlist, then an LLM to decide. **Embeddings shortlist but never decide**, and
that is a measured conclusion, not a preference:

```
0.6950  revenue from operations ↔ number of employees   (different)
0.6871  gurugram                ↔ gurgaon               (SAME)
0.8833  revenue from operations ↔ revenue               (same-ish)
0.8783  adjusted ebitda         ↔ ebitda                (DIFFERENT — the adjustments are the point)
0.8389  registered office       ↔ corporate office      (DIFFERENT — different offices)
```

Two unrelated metrics score *higher* than two spellings of one city, and pairs
that must stay separate sit above pairs that must merge. **No cosine threshold
separates same from different.** Embeddings give recall; a language model gives
precision; the registry persists the answer so each distinct label is adjudicated
once for the life of the corpus.

### Incremental by construction

Facts are compared only within **blocks** — same canonical predicate, same
canonical subject. A new document canonicalises only its new labels and re-reasons
only the blocks it actually touches. Ingest cost does not grow with corpus size.

---

## Important decisions and trade-offs

**One page is the extraction unit, not a fixed-size chunk.** Small chunks optimise
for *context* limits; context was never the constraint here — a page of these
filings is ~7,000 characters. Request count was. Page granularity took the starter
corpus from ~3,250 model calls to ~510, and it is the better unit anyway, because
a financial table stays physically attached to the caption and headings that scope
it rather than depending on heuristics to copy that context onto a fragment.

**Table layout is reconstructed, not flattened.** Horizontal gaps between text
items become runs of spaces (the `pdftotext -layout` trick). A stream-order
extractor turns a ten-column quarterly table into an unreadable ribbon of digits.

**Periods are parsed by us, not by the model.** The model copies `"Q4 FY24"`
verbatim; our tested parser computes the interval. Fiscal-year arithmetic is
exactly where a model errs, and a wrong interval still *looks* like a valid
interval, so nothing downstream could catch it. The fiscal-year start month is a
parameter, not a constant — India's April year is a default, not an assumption.

**Cross-currency comparison is refused, not fudged.** The IMF reports USD
billions, the RBI reports INR crore. An invented FX rate would let the engine
"reconcile" figures it has no basis to reconcile, so those pairs are reported as
an unresolved `unit` axis. *"I cannot compare these"* beats a confident wrong
answer.

**SQLite, not a graph database.** The brief warns that a graph DB alone is not the
solution, and reconciliation is dominated by blocking joins — an indexed lookup
run once per fact. The fixed part of the schema is only the envelope; everything
open-ended lives in queryable JSON columns, so a new kind of fact never requires a
migration. Swapping to Postgres is one file (`lib/db/client.ts`).

**The LLM cache is committed.** Thirty lines that change what the project *is*:
anyone can reproduce every result with no key, re-runs are byte-identical, and the
reasoning layer can be iterated on without re-paying for extraction. That last
property was used repeatedly during development — several grounding fixes were
re-validated across the whole corpus in under a second.

### Rate limits shaped this project more than model quality did

Three providers, three *different* binding constraints, each needing a different
fix. All measured, none assumed:

| Provider | Binding limit | Consequence |
|---|---|---|
| Gemini free tier | **20 requests/day** | Drove page-level chunking (3,250 → 510 calls) |
| Groq free tier | **8,000 tokens/min** | Request pacing is useless; the limiter had to become token-aware |
| Groq, again | reserved output counts toward TPM | Capping `maxOutputTokens` cut cost per call 5,192 → 2,502 |

That last one is the sharpest: Groq bills the *reserved* output budget, not what
is generated, and the SDK sent no cap at all. Setting one roughly doubled
throughput for free — and because `maxOutputTokens` is not part of the cache key,
it invalidated nothing already paid for.

`lib/model.ts` selects a provider from whichever key is present, so switching
mid-project cost two lines. The cache key includes the model id, so results stay
attributable and switching never silently reuses another model's answers.

### AI tools used

Built with **Claude Code** (Opus) as a pair programmer — architecture discussion,
implementation, and debugging. Extraction and vocabulary adjudication run on
**Groq `openai/gpt-oss-120b`** (also verified against Gemini 2.5 Flash and Claude
Haiku). Embeddings run **locally via Ollama `nomic-embed-text`**, so the only
metered spend in the system is extraction.

---

## The four required cases

Full output with evidence and axis-by-axis reasoning: [`docs/cases.md`](docs/cases.md).
Regenerate with `npm run demo` — **verified to run with no API key at all**.

Selected by the engine from its own output, never hardcoded: the demo asks for
the highest-confidence example of each verdict, preferring cross-document pairs.
If the engine stops producing one it prints an absence rather than a fixture.

The knowledge layer holds **226 facts** and reports **6 relations** — 3 of them
cross-document. That ratio is deliberate and is discussed under *Precision over
volume* below.

**1 · Corroborated across documents, expressed differently.**

```
A  (4,516.08) million   [March 31, 2023]   annual report p37
B  Rs. (452 Cr)         [FY23]             earnings deck p5
   → CORROBORATES  (R1b, confidence 0.74)
```

−4,516.08 million normalises to −₹451.61 crore, matching −₹452 crore. Two
documents, two scales, and two different period conventions — one naming the year,
the other labelling it by its closing date — recognised as a single fact.

**2 · A genuine or likely contradiction.** `revenue growth` for FY24 stated as
`40%` on page 5 and `12.7%` on page 6 of the same deck, with every axis aligned.
**This is a false positive and is reported as one**: page 5 is the Part-Truckload
segment and page 6 the company total, but the extractor dropped the segment from
the predicate. The engine reasoned correctly from information already lost
upstream. See *Limitations*.

**3 · An apparent contradiction explained by context.** Four of these, e.g.

```
A  ebitda  Rs. (452 Cr)  [FY23]       B  EBITDA  ₹13 Cr  [Q4 FY23]
   → RECONCILED, axis = period, confidence 0.85
   "Q4 FY23 sits inside FY23 (3 of 12 months) — these measure different windows"
```

Both would be called "FY23 EBITDA" in conversation, which is what makes the
conflict *apparent*; the containment is what dissolves it.

**4 · An extraction failure and how it is handled.** 86 of 312 extractions were
refused by grounding and quarantined:

| Reason | Count | What it means |
|---|---|---|
| `quote_lacks_context` | 47 | The span holds the value but no word saying what it measures — `"834"` alone proves nothing |
| `quote_not_found` | 28 | The cited quote is not on the page it names |
| `value_not_in_quote` | 11 | Real quote, but the claimed value is not inside it |

Rejected claims are stored and counted rather than dropped, browsable at
`/quarantine`. That turns "LLMs hallucinate" from a disclaimer into a measured
**72% grounding rate**.

### Precision over volume

An earlier version of the engine reported **151** relations. Nearly all were
noise, and removing it was the most valuable work in the project:

| Problem | Cause | Fix |
|---|---|---|
| 36 of 37 "corroborations" were one value | The same figure extracted 9 times from one page produces C(9,2)=36 self-confirming pairs | Deduplicate identical claims at ingest — corroboration requires *independent* assertions |
| 92 of 113 "reconciliations" were Q1 vs Q2 | R4 fired on any value difference plus any scope difference | A reconciliation must resolve an **apparent** conflict: the periods must be confusable (nested, overlapping, boundary), not disjoint siblings |
| 4 compared different people | The extractor put the subject into `basis` as `member:…`, so two directors blocked together | A `key:value` qualifier names *which entity*; when two differ, the facts are unrelated, not reconcilable |

6 defensible relations beat 151 that a reader has to sift. A knowledge layer that
cries contradiction at every pair of quarters is worse than useless — it trains
you to ignore it.

---

## Limitations and next steps

Honest list of what does not work yet.

**Extraction quality is the weakest link, and it is measured.** The grounding rate
is **73%** — better than one in four extractions is refused. Most rejections are
correct (the model offering a bare `"34.1%"` as its own evidence), but the rate is
a real ceiling on recall, and a stronger extraction model raises it immediately.
Side-by-side on the same document: Gemini 2.5 Flash produced 148 facts with 2
rejections; `gpt-oss-120b` produced 174 with 60.

**Cross-document coverage is thin: 1 corroboration and 5 reconciliations.** Not an
architectural limit — a corpus one. Only two documents are fully loaded, and both
are Delhivery, so the reachable overlap is small. Every additional document
multiplies the comparable pairs.

**Predicates are sometimes under-specified.** A table of `% of revenue` broken
down by row gets each row extracted with the same generic predicate, losing the
row identity. This produced 28 false contradictions from a single page. Two guards
now catch it — grounding rejects spans with no identifying words, and rule R7b
refuses to treat one page's breakdown as a disagreement — but the *right* fix is
in the prompt: require the predicate to name the row. Not done here because it
would invalidate the committed cache mid-deadline.

**Quotes are sometimes reconstructions, not spans.** For a multi-column row the
model tends to answer `"Pin-code reach(1) 18,793"` — splicing a label onto the
column it means. Faithful, but not contiguous. A bounded "scattered" matcher
(within three lines) accepts these; the better fix is to ask for the complete
printed row and let the period scope pick the column.

**No OCR.** Three pages of the earnings deck are image-only dividers and are
skipped. A scanned filing would currently yield nothing.

**Currency conversion is absent by design**, which means IMF (USD) and RBI (INR)
figures are never compared. Doing it properly needs dated FX rates and an
explicit provenance trail for the conversion.

**Corpus coverage: 2 of 6 documents.** The earnings deck and the FY24 annual
report are loaded (234 facts); the 2022 prospectus is partial and the three
India-macroeconomy reports are not ingested. Free-tier daily token budgets across
three providers were the binding constraint, not the architecture —
`npm run ingest -- --all` with any funded key completes the rest, and because the
cache is committed, every partial run is permanent progress rather than wasted
spend. This is a volume gap, not a capability gap: the pipeline treats an unseen
PDF identically.

### What I would build next, in order

1. **Fix predicate specificity at the prompt**, and re-measure. This is the single
   highest-value change: it lifts extraction quality, removes the need for R7b,
   and raises the grounding rate.
2. **A confidence-weighted review queue.** Low-confidence contradictions are the
   ones a human should see; the UI should rank them, not just list them.
3. **The `DERIVES` verdict.** Quarters summing to their fiscal year is arithmetic
   corroboration and a strong signal that extraction got a whole table right.
   Designed, not implemented.
4. **Table-structure-aware extraction.** Parsing rows and columns explicitly,
   rather than relying on layout reconstruction plus a model, would fix
   under-specified predicates at the source.
5. **Streaming ingest with a job queue.** Upload currently runs inline and a
   100-page PDF takes minutes; it should return a job id and stream progress.

---

## Additional notes

**Where to look first.** `lib/reason/verdict.ts` is the heart — the rule table
that turns a scope comparison into an explained verdict. `lib/extract/ground.ts`
is the honesty guard. `lib/registry/registry.ts` is the schema that grows.

**The tests are the argument.** `lib/reason/verdict.test.ts` exercises the same
rule table with a numeric pair, a status pair and an entity pair, which is the
concrete demonstration that this is not a number scraper.

**`progress.md` is a real build log**, including the bugs. Four of them were
*false rejections* — correct extractions thrown away by my own grounding code —
and those are the ones worth reading, because they look like model failures and
get blamed on the model. One example: `parseNumericLiteral("Rs. 2,194")` returned
`0.2194`, because stripping `"Rs."` left a leading `"."` and `".2194"` parses
cleanly as a *wrong* answer. Silent, three orders of magnitude, invisible to every
later stage.

**On generalisation.** Nothing is keyed to filenames, document types, or the
starter set. The two starter datasets — a logistics company and the Indian
macroeconomy — share a knowledge layer without producing cross-links between
them, because their subjects genuinely differ. Upload any PDF at
`http://localhost:3000` and it goes through the same pipeline.
