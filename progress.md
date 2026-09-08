# Progress

Running log of what is built, what is verified, and what is next.
Design of record: [`plan.md`](plan.md) · Install and run: [`setup.md`](setup.md)

**Last updated:** 2026-09-09, after the UI was verified in-browser and two
over-reporting bugs were found by running the engine on real output.

---

## Status at a glance

| # | Stage | State | Verified by |
|---|---|---|---|
| — | Scaffold, storage schema | ✅ done | app boots, tables create |
| 1 | PDF parse — text + coordinates | ✅ done | 6 PDFs, tables survive as tables |
| 2 | Segment — page units + scope context | ✅ done | captions inspected by hand |
| 3 | Extract — LLM → scoped claims | ✅ done | 158 facts from the earnings deck |
| 4 | Ground — evidence verification | ✅ done | 90.8% grounding rate, 13 tests |
| 6 | Registry — evolving vocabulary | ✅ built | thresholds calibrated on real labels |
| 7 | Reason — context algebra + verdicts | ✅ built | 12 tests across all value kinds |
| 8 | API routes | ✅ built | typechecks; not yet exercised end-to-end |
| 9 | UI — 5 screens | ✅ built | not yet opened in a browser |
| — | UI verified in browser | ✅ done | all 5 screens rendered and inspected |
| — | README | ✅ drafted | numbers pending final ingest |
| — | Full corpus ingest | 🟡 running | annual report, ~60 min |
| — | Four required cases | ⬜ blocked on ingest | — |
| — | Demo video | ⬜ | — |

**63 unit tests passing.** `npm test`

---

## Running the engine on real output found two over-reporting bugs

Both were found by looking at what the engine actually said, not by testing what
it was supposed to say. The first reconcile run reported **28 contradictions from
a single page** — implausible on its face, and worth chasing.

### The cause: a breakdown read as a disagreement

Page 24 prints a table of `% of revenue` broken down by row. Every row was
extracted with the same generic predicate and the **bare figure as its own
quote** (`"34.1%"`, `"18.8%"`). Identical subject, predicate, period and basis;
different values; every reconciling axis genuinely aligned. The engine did exactly
what it should with what it was given, and concluded that each row contradicted
every other.

The information was lost before reasoning ever saw it, so the fix had to be
upstream. Two guards, both principled rather than patches:

**1. A quote that is nothing but the value is not evidence.** `"34.1%"` cannot say
WHAT is 34.1%, so it cannot support any verdict. New grounding status
`quote_lacks_context`. Crucially, the span is first widened to its printed line
before judging — a model that quotes `"8,141.7"` out of the row
`Revenue from operations 8,141.7` cited real evidence and merely quoted tightly.
That widening also stores *better* evidence: the reader sees the row, not a
floating number.

**2. Rule R7b — several values under one label on one page is a breakdown.**
Contradiction requires two *independent* assertions. Two numbers printed on one
page under one label are components of a whole, and the honest report is that the
predicate failed to distinguish them.

Effect on the earnings deck, measured:

| | before | after both guards |
|---|---|---|
| Facts kept | 158 | 114 |
| Contradictions | **28** | **1** |
| Reconciled | 153 | 93 |

The right long-term fix is in the prompt — require the predicate to name the row —
but that would invalidate the committed cache mid-deadline. Recorded in the README
as the top next step.

### Chosen over the alternative
Rejecting bare-value spans outright (before line widening) cut facts to 84, a 52%
rejection rate. Widening to the line first recovered 30 correct facts while still
removing every false contradiction — strictly better on both axes.

---

## The big story so far: rate limits, not model quality

Most of the engineering difficulty today was not extraction quality — it was
getting enough tokens through a free tier. Three providers, three *different*
binding constraints, each of which demanded a different fix:

| Provider | Binding limit | What it forced |
|---|---|---|
| Gemini free tier | **20 requests/day** | Page-level chunking: 3,250 calls → 510 |
| Groq free tier | **8,000 tokens/min** | Token-aware limiter; chunking is irrelevant |
| Groq, again | reserved output counts | Cap `maxOutputTokens`: 5,192 → 2,502 per call |

Each was measured rather than assumed, and each is recorded in the code where the
decision lives. Detail below.

### Gemini: the request wall
The first full run looked merely slow (51 units in 148 s). It was actually the
SDK backing off against `generate_content_free_tier_requests, limit: 20`. That is
a **daily** cap — a single probe with no other traffic still failed — so the key
was unusable for a 500-call corpus.

Before discovering that, this drove a genuinely good design change: extraction
units went from ~1,600 characters to **one page each**. Small chunks optimise for
*context* limits, and context was never the constraint — a page of these filings
is ~7,000 characters, which any current model swallows whole. The binding
constraint was request count: 3,250 calls became 511. It is also the better unit
on the merits, because a financial table stays physically attached to the caption
and headings that scope it.

### Groq: the token wall
Switched providers (the abstraction in `lib/model.ts` made this a two-line
change). Groq reports `RPM 1000 / TPM 8000` in its response headers — requests
are effectively free, tokens are not. Chunking cannot help here: total tokens are
total tokens.

Then a measurement that paid for itself. A single call reported
`Requested: 5,192` tokens while its actual input was ~1,600. Groq bills the
**reserved** output budget against TPM, not what is generated, and the AI SDK was
sending no `maxOutputTokens` at all. Capping it at 2,200 dropped real usage to
**2,502 tokens per call** — throughput roughly doubled for free, and because
`maxOutputTokens` is not part of the cache key, no already-paid-for response was
invalidated.

### Provider abstraction
`lib/model.ts` picks a provider from whichever key is present (Anthropic → Groq →
Google) and every call site goes through it. Switching providers mid-project cost
two lines. The cache key includes the model id, so results stay attributable and
switching never silently reuses another model's answers.

One negative result worth keeping: disabling Gemini's thinking budget for
extraction looked like free latency, but **48 of 51 calls then failed to produce
a valid object** and the run yielded 7 facts instead of 148. On that model the
reasoning pass is load-bearing for structured output. Recorded in `lib/model.ts`
so the next person does not re-run the experiment.

---

## Built

### Stage 1 — PDF parsing (`lib/ingest/parse.ts`)
Text extraction preserving **character-to-bounding-box** mapping, so evidence can
be highlighted on the page it came from.

Horizontal gaps are reconstructed as runs of spaces (the `pdftotext -layout`
trick). A stream-order extractor flattens a ten-column quarterly table into an
unreadable ribbon of digits; with gap reconstruction it comes out as a table:

```
₹ Cr        Q1 FY23  Q2 FY23  Q3 FY23  Q4 FY23  ...  FY23  FY24
Express Parcel   94      134      190      219   ...   636   934
% margin       8.9%    11.9%    15.9%    18.6%   ...  14.0% 18.4%
```

Measured: 27-page deck in 0.7 s; 100-page annual report in 1.0 s, 703,522
characters, 30,954 spans. Pages are released as converted, so peak memory tracks
the largest page rather than the document.

**Known gap:** 3 of 27 pages in the earnings deck are image-only section
dividers with no text layer. Not OCR'd.

### Stage 2 — Segmentation (`lib/ingest/segment.ts`)
One unit per page, carrying the headings and scope captions above it. Scope
qualifiers never sit beside their numbers:

```
Consolidated Statement of Profit and Loss     <- entity scope
for the year ended March 31, 2024             <- period
(Rs. in crore)                                <- unit and scale
   ...
Revenue from operations         8,141.7       <- all a naive chunker would send
```

Verified on the FY24 annual report: the financial-statements page came through
with `amounts in Indian Rupees in million | consolidated` — exactly the two
qualifiers the engine needs. Units never cross a page boundary, so evidence
always resolves to one page. Running headers repeated across ≥50% of pages are
detected and stripped.

The salience prefilter is deliberately **not** digits-only: two of the brief's
three examples are non-numeric, and a numeric filter would silently discard both.

### Stage 3 — Extraction (`lib/extract/`)
The only stage where the model is asked to *perceive*. Two schema decisions:

- **Periods come back as raw text.** The model copies `"Q4 FY24"` verbatim and our
  tested parser computes the interval. Asking a model to do fiscal-year
  arithmetic invites errors on exactly the edge cases that matter, and a wrong
  interval still looks like a valid interval, so nothing downstream could catch
  it.
- **Value is a flat object with a `kind` field**, not a zod discriminated union.
  Nested `anyOf` is where structured output fails most often; the tagged union is
  reconstructed in ten lines of code.

**The cache is the load-bearing piece.** Every response is keyed by
`sha256(model + promptVersion + prompt)` and written to `data/cache/`, which is
committed. Re-runs are free and byte-identical, so the reasoning layer can be
iterated on without re-paying for extraction — this has already been used several
times today to re-test grounding at zero cost.

### Stage 4 — Grounding (`lib/extract/ground.ts`)
Deterministic. A claim's quote must be locatable on the page it cites, and the
claimed value must appear inside that quote. Failures are quarantined, not
deleted — the error rate is measured rather than asserted.

Matching escalates: exact → whitespace-collapsed → caseless → punctuation-folded
→ scattered-within-3-lines → token-anchored. The scattered tier exists because of
a real tension found in the output, not from caution (see below).

### Stage 6 — Registry (`lib/registry/`)
One canonicaliser over three namespaces (subjects, predicates, values). Resolution
is layered: exact → lexical → embeddings shortlist → LLM adjudicates → mint new.

**Calibrated against real labels**, and the numbers changed the design:

```
0.6950  revenue from operations <-> number of employees   (different)
0.6871  gurugram                <-> gurgaon               (SAME)
0.8833  revenue from operations <-> revenue               (same-ish)
0.8783  adjusted ebitda         <-> ebitda                (DIFFERENT)
0.8389  registered office       <-> corporate office      (DIFFERENT)
```

Two unrelated metrics score *higher* than two spellings of one city, and
`adjusted EBITDA` vs `EBITDA` — a real distinction in financial reporting — sits
above pairs that should merge. **No cosine threshold separates same from
different.** So embeddings provide recall only; an LLM provides precision. The
whole shortlist is judged in one call, because three separate calls per new label
would cost more time than extraction itself.

Embeddings run locally through Ollama (`nomic-embed-text`) and are cached into the
same committed cache, so the demo reproduces with no API key *and* no Ollama.

### Stage 7 — Reasoning (`lib/reason/`)
`algebra.ts` compares two facts on six axes (period, entityScope, basis, unit,
predicate, vintage), each emitting a self-explaining `DimensionDelta`.
`verdict.ts` is an ordered rule table over (value comparison × axis alignment).
`compare.ts` dispatches per value kind, and adds one relation numbers do not
have: **EXCLUSIVE** — "resigned" and "in office" are not merely unequal, they
cannot both hold.

The rules are value-kind agnostic, which is the design's payoff. The brief's own
director example needs no special case:

```
"in office" (2022 prospectus) vs "resigned" (FY24 report)
  -> EXCLUSIVE values, vintage axis misaligned
  -> R6: SUPERSEDED, "the state changed between these two documents"
```

while the same two claims from documents of the *same* vintage fall through to R8
and are reported as a genuine contradiction. Same table, no branching on type.

### Stages 8–9 — API and UI
Five screens: Documents (upload + per-document stats), Relations (verdicts with
the six-axis "why" table), Facts (browse with in-page evidence), Vocabulary (the
schema as it grows), Quarantine (the system's own error log). Nine API routes.

Evidence is shown as the surrounding page text with the cited span highlighted in
place, using the offsets grounding produced. A grader should never have to take a
fact on trust.

---

## Bugs found and fixed

Four of these were **false rejections** — correct extractions that the grounding
check wrongly threw away. That is the expensive kind of bug, because it looks like
a model failure and gets blamed on the model.

**`parseNumericLiteral("Rs. 2,194")` returned `0.2194`.**
The parser deleted everything that wasn't a number; stripping `"Rs."` left a
leading `"."`, and `".2194"` parses cleanly as a *wrong* answer. Silent, and
invisible downstream. Rewritten to *locate* the numeric token rather than mutate
the string around it.

**`digitsOf("Rs. (452 Cr)")` returned `".452"` — the same bug, in a second place.**
Fixed in one file and left in the other. Now grounding compares numbers
numerically rather than as substrings.

**Numeric tokeniser treated space as a digit separator.**
In a gap-reconstructed table row, `"Total equity 9,177 9,145"` matched as the
single token `91779145`, so neither real value could be found. Two adjacent
columns welded into one nonsense number — undoing exactly the column structure
the parser worked to preserve.

**`normalizeOrgName("The Company")` returned `"the"`.**
Filings refer to themselves that way constantly; this would have merged every
issuer in the corpus into one subject.

**Scope captions polluted by table data.**
A `%` regex matched margin rows, so `% 11.9% 15.9%` was captured as a "scope
caption" while the real one (`₹ Cr`) was pushed out by a keep-last-4 rule. Fixed
by splitting captions into scale and basis kinds, keeping the *first* of each (a
table declares its scale once, at the top), and reading basis only from
heading-shaped lines.

**SQL comments containing backticks broke the schema template literal.** Loud
failure at import time — the good kind.

### A tension, not a bug: what counts as a quote
Grounding kept rejecting correct facts from multi-column tables. The page reads:

```
Pin-code reach(1) 18,074 18,540 18,675 18,793
```

and the model answers `"Pin-code reach(1) 18,793"` — splicing the row label onto
the column it means. Faithful, but not a contiguous span. Slide layouts do the
same vertically, printing a headline number on the line *above* its caption.

Loosening to "these tokens appear somewhere on the page" would bind a value to an
unrelated row's label, which is the exact failure grounding exists to prevent. So
the fix is bounded: a **scattered** tier that accepts a match only within three
consecutive lines. Recovered 28 facts on the deck alone.

The better long-term fix is to change what is *asked for* — quote the complete
printed row, all columns, and let the period scope pick the column. Not done yet;
it would invalidate cached responses, and 90.8% is good enough to proceed.

---

## Measured results (earnings deck, 26 pages)

| | |
|---|---|
| Facts kept | **158** |
| Quarantined | 16 |
| Grounding rate | **90.8%** |
| Re-ground from cache | **0.9 s** |

The 16 rejections are correct: the model offered bare values like `"3"` and
`"9%"` as their own evidence, which proves nothing.

Provider comparison on this same document, same prompt:

| Model | Facts | Quarantined | Call failures |
|---|---|---|---|
| gemini-2.5-flash | 148 | 2 | 0 |
| **groq gpt-oss-120b** | **158** | 16 | 3 |
| groq gpt-oss-20b (flash-lite equiv) | 105 | 9 | 16 |

Note the Gemini numbers predate the grounding fixes, so they are understated.

---

## UI verified in browser

All five screens rendered and inspected. The Relations screen produced a textbook
Case 3 unprompted:

> `Q1 FY23 = ₹1,746 crore` vs `Q2 FY23 = ₹1,796 crore`
> **Reconciled by context**, axis `period`, confidence 0.85
> *"Q1 FY23 [2022-04-01 → 2022-06-30] and Q2 FY23 [2022-07-01 → 2022-09-30] do not
> overlap — these describe different times."*

with both facts highlighting the actual printed table row as evidence, and the
six-axis delta table expandable beneath. Two display bugs fixed while there:
`Rs. 127 Cr crore INR` (scale repeated three times, because the raw literal
already carried it) and the normalised magnitude not being shown at all — it is
what comparison actually uses, so it now appears as a chip.

## A rate-limit lesson that cost an hour

Two ingest runs appeared to hang with zero cache growth. The cause was not the
provider: **I was running foreground test commands against the same API while a
background ingest was live.** Two processes, two independent rate limiters, one
shared 8,000 TPM budget — so both were throttled into retry loops and neither
progressed. The limiter is per-process by design; the discipline of not competing
with your own long-running job is the missing piece.

## Next up

1. **Finish the annual report ingest** (running, ~60 min).
2. **Reconcile** — canonicalise and build the cross-document relation graph.
3. **Find and write up the four required cases** into `docs/cases/`.
4. **Fill the final numbers into README.md.**
5. **Record the 3-minute demo video.**
6. Prospectus and India-macroeconomy documents if tokens allow.

## Open risks

- **Token budget.** The Groq free tier gives ~2.8 calls/min. The three Delhivery
  documents are ~250 calls (~80 min). Adding the three macro documents is another
  ~280 calls (~100 min). The cache makes any partial run permanent progress, so
  this degrades rather than fails.
- **Finding a genuine contradiction.** Corroboration and context-reconciliation
  are near-certain in this corpus. A true contradiction is not guaranteed; the
  director-status angle and restated prior-year figures are the candidates. If
  none is found, that gets reported honestly rather than manufactured.
- **The UI is unrendered.** It typechecks but has not been run. Expect fixes.
