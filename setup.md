# Setup

How to install and run Crosscheck. For the design and its trade-offs see
[`approach.md`](approach.md).

## Requirements

| Thing | Version used | Notes |
|---|---|---|
| Node.js | 24.16.0 | Node 20+ should work; 24 is what this was built on. |
| npm | 11.13.0 | Ships with Node 24. |
| Ollama | any recent | **Optional.** Only for local embeddings — see below. |

No Python, no Docker, no database server. SQLite is embedded, and PDF parsing is
pure JavaScript (`pdfjs-dist`), so there is no `poppler` or native OCR to install.

## Install

```bash
npm install
```

`better-sqlite3` is the only native dependency and installs from a prebuilt
binary on macOS and Linux — no compiler toolchain needed. If the install times
out (this happened once on a slow connection during development), retry with:

```bash
npm install --fetch-timeout=600000 --fetch-retries=5
```

## Configuration

Create `.env.local` in the project root:

```bash
# Required only to ingest NEW documents. Every result already in this repo
# replays from the committed cache without it — see "Running with no API key".
# Set any ONE of these; the provider is chosen from whichever key is present.
GROQ_API_KEY=gsk_...              # default model: openai/gpt-oss-120b
ANTHROPIC_API_KEY=sk-ant-...      # default model: claude-haiku-4-5-20251001
GEMINI_API_KEY=...                # default model: gemini-2.5-flash

# Optional overrides
CROSSCHECK_MODEL=openai/gpt-oss-120b         # extraction model
CROSSCHECK_CONCURRENCY=8                     # parallel extraction calls
CROSSCHECK_DB=./data/knowledge.db            # database location
CROSSCHECK_EMBED=ollama                      # 'ollama' | 'off'
```

`.env.local` is gitignored. No credentials are committed to this repository.

### Local embeddings (optional)

The vocabulary registry uses embeddings to decide whether two differently-worded
labels mean the same thing. These run **locally and free** through Ollama:

```bash
ollama pull nomic-embed-text
```

With `CROSSCHECK_EMBED=off`, or if Ollama is not running, the registry falls back
to deterministic string similarity plus LLM adjudication. It still works; it
simply spends more LLM calls to reach the same answers.

## Running with no API key

Every LLM response is cached by a content hash of its prompt, and **that cache is
committed to this repository**. So the full pipeline reproduces from scratch with
no key and no cost:

```bash
npm run demo
```

This replays every starter PDF the cache covers (currently the FY24 annual report
and the Q4 FY24 earnings deck; documents less than half cached are skipped and
listed), rebuilds the knowledge layer, and prints the four required cases. If a key *is* present, cache hits still short-circuit — you
only pay for documents the cache has never seen.

## The app

```bash
npm run dev          # http://localhost:3000
```

Five screens: **Documents** (upload, ingest progress), **Relations** (the verdicts
and the reasoning behind each), **Facts** (browse with source evidence),
**Vocabulary** (the registry as it grows), and **Quarantine** (every extraction
the grounding check rejected, and why).

To add a document, drag a PDF onto the Documents screen. Requires an API key,
since an unseen document has no cache entries.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the web UI and API. |
| `npm run demo` | Replay the cached starter PDFs and print the four required cases. |
| `npm run ingest <path.pdf>` | Ingest one document from the command line. |
| `npm run reconcile` | Re-run reasoning over all stored facts. Deterministic, no LLM. |
| `npm test` | Run the unit tests over the deterministic core. |
| `npm run reset` | Delete the database and start clean. Does not touch the cache. |

## API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/documents` | Upload a PDF (multipart). Returns a document id. |
| `GET` | `/api/documents` | List documents with ingest stats. |
| `GET` | `/api/documents/:id/status` | Ingest progress. |
| `GET` | `/api/facts` | Facts, filterable by document, predicate, subject, type. |
| `GET` | `/api/facts/:id` | One fact with its evidence and relations. |
| `GET` | `/api/relations` | Relations, filterable by verdict. |
| `GET` | `/api/registry` | The vocabulary and its learned relations. |
| `GET` | `/api/quarantine` | Extractions rejected by the grounding check. |
| `POST` | `/api/reconcile` | Re-run the reasoning pass. |

## Troubleshooting

**`npm install` times out.** Retry with the longer-timeout command above; npm
keeps what it already downloaded.

**Ingest is slow on a 100-page PDF.** Expected on a cold cache: one extraction
call per page, paced by the provider's rate limit (about 510 calls for the whole
starter corpus). Raise `CROSSCHECK_CONCURRENCY`, or use
`npm run demo`, which replays from cache in seconds.

**Embeddings unavailable.** Start Ollama (`ollama serve`) or set
`CROSSCHECK_EMBED=off`. Neither blocks ingestion.
