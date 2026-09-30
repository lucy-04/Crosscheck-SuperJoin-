# 🔎 Crosscheck

![Node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embedded-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-78%20passing-brightgreen)
![API key](https://img.shields.io/badge/demo-no%20API%20key%20needed-blue)

**A fact knowledge layer that explains its disagreements.** Crosscheck reads PDFs
into *scoped claims*, verifies every claim against the page it came from, and
decides — with reasons — where those claims corroborate, contradict, or only
appear to contradict.

> **A contradiction is a failure to find a reconciling context.**

## 📸 Demo / Visuals

Real output from `npm run demo`, which runs with **no API key**. Two figures that
would both be called "FY23 EBITDA" in conversation, and why they don't conflict:

```text
A  ebitda  Rs. (452 Cr)  [FY23]       B  EBITDA  ₹13 Cr  [Q4 FY23]
   → RECONCILED, axis = period, confidence 0.85
   "Q4 FY23 sits inside FY23 (3 of 12 months) — these measure different windows"
```

And a corroboration across two documents, two scales and two period conventions:

```text
A  (4,516.08) million   [March 31, 2023]   annual report p37
B  Rs. (452 Cr)         [FY23]             earnings deck p5
   → CORROBORATES  (R1b, confidence 0.74)
```

−4,516.08 million normalises to −₹451.61 crore, matching −₹452 crore.

All four required cases — corroboration, contradiction, apparent contradiction
explained by context, and an extraction failure — with source evidence and
axis-by-axis reasoning: **[`docs/cases.md`](docs/cases.md)**.

## 📋 Table of Contents
- [Features](#-features)
- [Tech Stack](#%EF%B8%8F-tech-stack)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
- [Usage](#%EF%B8%8F-usage)
- [Roadmap](#%EF%B8%8F-roadmap)
- [Contributing](#-contributing)
- [License](#-license)

## ✨ Features

- **Facts are scoped claims, not bare values.** `revenue = 8,142` is comparable to
  nothing until you know its period, entity scope, accounting basis and unit.
  Every fact carries that context, so "do these contradict?" stops being an
  opinion and becomes a computation.
- **LLM for perception, code for judgement.** The model only extracts claims and
  cites a quote. Every verdict comes from deterministic code — reproducible run to
  run, able to show its work, and free as the corpus grows.
- **Six-axis comparison with an explained verdict.** Two facts are compared on
  `period`, `entityScope`, `basis`, `unit`, `predicate` and `vintage`; an ordered
  rule table turns the result into a verdict that names the axis responsible.
- **Grounding with a measured error rate.** Every claim must cite a quote that is
  verifiably present on its page, with the value inside it. Failures are
  quarantined and counted, not silently dropped — **72% grounding rate**
  (226 of 312 extractions).
- **A schema that evolves, never declared.** A vocabulary registry resolves new
  labels against what the corpus has already seen — exact match, then lexical
  similarity, then embeddings to shortlist, then an LLM to decide.
- **Incremental by construction.** Facts are compared only within blocks (same
  canonical subject and predicate), so a new document re-reasons only the blocks
  it touches.
- **Reproducible for free.** Every model response is cached by a hash of its
  prompt, and the cache is committed — the whole pipeline replays with no key.

### How it works

```
PDF ─▶ parse      text + per-character coordinates
    ─▶ segment    page units carrying the headings and captions that scope them
    ─▶ extract    LLM → scoped claims                        ← the only LLM step
    ─▶ ground     deterministic: is this claim actually in the document?
    ─▶ normalise  crore/million/bps → one magnitude; FY24/Q4FY24 → intervals
    ─▶ canonicalise   align wording across documents
    ─▶ reason     six-axis comparison → verdict rules
```

The verdict rules (`lib/reason/verdict.ts`):

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

The rules are value-kind agnostic: a director `"in office"` (2022 prospectus) vs
`"resigned"` (FY24 report) fires R6 — the state changed — while the same two
claims from documents of the same vintage fall through to R8 as a genuine
contradiction. Same table, no special case for non-numeric facts.

### Precision over volume

An earlier version reported **151** relations; nearly all were noise. Removing it
was the most valuable work in the project, and the layer now reports **6
defensible relations** from 226 facts, 3 of them cross-document:

| Problem | Fix |
|---|---|
| 36 of 37 "corroborations" were one figure extracted 9 times from one page | Deduplicate identical claims at ingest — corroboration requires *independent* assertions |
| 92 of 113 "reconciliations" were Q1 vs Q2 | A reconciliation must resolve an **apparent** conflict: periods must be confusable, not disjoint siblings |
| 4 compared different people | A `key:value` qualifier names *which entity*; when two differ, the facts are unrelated |

A knowledge layer that cries contradiction at every pair of quarters trains you to
ignore it.

For the full design, every trade-off and the bugs found along the way, see
**[`approach.md`](approach.md)**.

## 🛠️ Tech Stack
- **Frontend:** Next.js 15 (App Router), React 19, Tailwind CSS 4
- **Backend:** Next.js API routes, TypeScript, Zod, `pdfjs-dist` for PDF parsing
  (pure JavaScript — no Python, Docker or OCR tooling)
- **Database:** SQLite via `better-sqlite3`, with open-ended fields in queryable
  JSON columns — chosen over a graph database because reconciliation is
  dominated by indexed blocking joins
- **LLM:** Vercel AI SDK with Groq `openai/gpt-oss-120b` for extraction and
  vocabulary adjudication (also verified against Gemini 2.5 Flash and Claude
  Haiku); the provider is picked from whichever key is present
- **Embeddings:** local Ollama `nomic-embed-text` — the only metered spend in the
  system is extraction
- **Testing:** Vitest — 78 unit tests over the deterministic core
- **Built with:** Claude Code (Opus) as a pair programmer for architecture
  discussion, implementation and debugging

## 🚀 Getting Started

Follow these steps to set up the project locally. Full options, configuration,
scripts, the API reference and troubleshooting are in
**[`setup.md`](setup.md)**.

### Prerequisites
- **Node.js 20+** (built on 24.16)
- **Ollama** — optional, only for local embeddings
- **An API key** — only to ingest *new* PDFs; the demo needs none

### Installation
1. Clone the repo:
   ```bash
   git clone https://github.com/lucy-04/Crosscheck-SuperJoin-.git
   cd Crosscheck-SuperJoin-
   ```
2. Install packages:
   ```bash
   npm install
   ```
3. Optional — to ingest new PDFs, add a provider key to `.env.local`:
   ```bash
   GROQ_API_KEY=gsk_...        # or ANTHROPIC_API_KEY=..., or GEMINI_API_KEY=...
   ```

## 🕹️ Usage

Rebuild the knowledge layer from the committed cache and print the four cases —
no API key required:
```bash
npm run demo
```

Explore it in the browser at `http://localhost:3000` — **Documents** (upload a
PDF, watch ingest), **Relations** (verdicts and their reasoning), **Facts** (with
source evidence), **Vocabulary** (the registry as it grows) and **Quarantine**
(every rejected extraction and why):
```bash
npm run dev
```

Other commands:
```bash
npm test                           # unit tests over the deterministic core
npm run ingest -- --all --force    # re-ingest the starter corpus
npm run reconcile -- --fresh       # rebuild the relation graph (no LLM calls)
```

Everything the UI does is also available over a JSON API (`/api/documents`,
`/api/facts`, `/api/relations`, `/api/quarantine`, …) — see
[`setup.md`](setup.md#api).

### Where to look first in the code
- `lib/reason/verdict.ts` — the rule table that turns a scope comparison into an
  explained verdict. The heart of the system.
- `lib/extract/ground.ts` — the honesty guard that refuses ungrounded claims.
- `lib/registry/registry.ts` — the schema that grows.
- `lib/reason/verdict.test.ts` — the same rule table exercised with a numeric
  pair, a status pair and an entity pair.

## 🗺️ Roadmap
- [x] PDF parsing with table layout reconstruction
- [x] Page-level extraction into scoped claims (~3,250 → ~510 model calls)
- [x] Deterministic grounding with a counted quarantine
- [x] Unit and period normalisation (fiscal-year start is a parameter)
- [x] Evolving vocabulary registry
- [x] Six-axis reasoning with explained verdicts
- [x] Web UI, JSON API and committed LLM cache
- [ ] Fix predicate specificity at the prompt — require the predicate to name the
      table row; the single highest-value change
- [ ] A confidence-weighted review queue for low-confidence contradictions
- [ ] The `DERIVES` verdict — quarters summing to their fiscal year (designed,
      not implemented)
- [ ] Table-structure-aware extraction
- [ ] Streaming ingest with a job queue and progress updates
- [ ] Ingest the remaining starter documents (2 of 6 loaded so far)
- [ ] OCR for image-only pages
- [ ] Currency conversion with dated FX rates and a provenance trail

### Known limitations
- **Extraction quality is the weakest link, and it is measured** — 72% grounding
  rate. Gemini 2.5 Flash produced 148 facts with 2 rejections on the same document
  where `gpt-oss-120b` produced 174 with 60.
- **The contradiction in case 2 is a false positive, reported as one.** FY24
  revenue growth appears as 40% (Part-Truckload segment) and 12.7% (company
  total); the extractor dropped the segment from the predicate, and the engine
  reasoned correctly from information already lost upstream.
- **Cross-document coverage is thin** — both loaded documents are Delhivery, so
  the reachable overlap is small. A corpus limit, not an architectural one.
- **Cross-currency comparison is refused by design.** IMF (USD) and RBI (INR)
  figures are reported as an unresolved `unit` axis rather than reconciled with an
  invented FX rate.

## 🤝 Contributing
Contributions are welcome.
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Make sure `npm test` passes
4. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
5. Push to the Branch (`git push origin feature/AmazingFeature`)
6. Open a Pull Request

## 📄 License
No license has been chosen yet. Until one is added, all rights are reserved by
default.
