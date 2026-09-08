/**
 * Text normalisation for the non-numeric half of the knowledge layer.
 *
 * The brief's own examples are mostly semantic: a director active in one document
 * and resigned in a later one, or "differently written addresses referring to the
 * same place". Those facts need the same treatment numbers get — fold away the
 * ways writing varies, so that what remains can be compared.
 *
 * Everything here is a FAST PATH, not the decision procedure. Two strings that
 * normalise identically are certainly the same; two that do not are passed on to
 * embeddings and, if still ambiguous, to an LLM adjudicator. That ordering is why
 * the lexicons below can stay small without limiting what the system can resolve
 * — deleting them costs LLM calls, not correctness.
 */

/** Honorifics, English and Indian, that carry no identifying information. */
const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "dr", "prof", "shri", "sri", "smt", "sh", "md",
  "cs", "ca", "adv", "hon", "honble", "justice",
]);

/** Legal-form suffixes that vary by document without changing the company. */
const ORG_SUFFIXES = new Set([
  "limited", "ltd", "private", "pvt", "plc", "llp", "inc", "incorporated",
  "corporation", "corp", "company", "co", "holdings", "group",
]);

/** Address abbreviations, expanded so "Rd." and "Road" agree. */
const ADDRESS_EXPANSIONS: Record<string, string> = {
  rd: "road", st: "street", ave: "avenue", ln: "lane", blvd: "boulevard",
  hwy: "highway", mg: "mahatma gandhi", no: "", nos: "", flr: "floor",
  fl: "floor", bldg: "building", bldgs: "building", opp: "opposite",
  nr: "near", ph: "phase", sec: "sector", ext: "extension", dist: "district",
  po: "post office", ps: "police station", apt: "apartment", ste: "suite",
};

/**
 * Renamed places. Purely a cost optimisation: without this table the pair still
 * resolves, it just costs an embedding lookup and possibly one LLM call.
 */
export const PLACE_ALIASES: Record<string, string> = {
  gurgaon: "gurugram",
  bangalore: "bengaluru",
  bombay: "mumbai",
  calcutta: "kolkata",
  madras: "chennai",
  poona: "pune",
  baroda: "vadodara",
  trivandrum: "thiruvananthapuram",
  cochin: "kochi",
  mysore: "mysuru",
  pondicherry: "puducherry",
  orissa: "odisha",
  uttaranchal: "uttarakhand",
  gauhati: "guwahati",
};

/** Lowercase, strip punctuation and diacritics, collapse whitespace. */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeText(s).split(" ").filter(Boolean);
}

/**
 * "Mr. Sahil Barua" / "Barua, Sahil" / "SAHIL BARUA" -> "barua sahil".
 *
 * Tokens are sorted so that written order stops mattering, which is what makes
 * the comma-inverted form in a shareholding table match the natural form in a
 * directors' report.
 */
export function normalizePersonName(input: string): string {
  const parts = tokens(input).filter((t) => !HONORIFICS.has(t));
  return parts.sort().join(" ");
}

/** Articles that carry no identity on their own. */
const ARTICLES = new Set(["the", "a", "an", "of", "and"]);

/**
 * "Delhivery Limited" / "Delhivery Ltd." -> "delhivery".
 *
 * Suffixes are stripped only from the END, and only while something identifying
 * survives. Without that guard the self-reference filings use constantly — "the
 * Company" — reduces to "the", which would then match every other document's
 * "the Company" and merge two unrelated issuers into one subject.
 */
export function normalizeOrgName(input: string): string {
  const all = tokens(input);
  const parts = [...all];
  while (parts.length && ORG_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  const identifying = parts.filter((t) => !ARTICLES.has(t));
  return (identifying.length ? parts : all).join(" ");
}

/**
 * "Plot No. 5, Sector-44, Gurgaon" -> "plot 5 sector 44 gurugram".
 *
 * Digits are kept glued to their preceding word only insofar as ordering is
 * preserved; house and sector numbers are the highest-signal tokens in an
 * address, so they are never dropped.
 */
export function normalizeAddress(input: string): string {
  const out: string[] = [];
  for (const t of tokens(input)) {
    const expanded = ADDRESS_EXPANSIONS[t];
    const word = expanded === undefined ? t : expanded;
    if (!word) continue;
    for (const w of word.split(" ")) {
      out.push(PLACE_ALIASES[w] ?? w);
    }
  }
  return out.join(" ");
}

/** Categorical states: "Resigned w.e.f. 31.01.2024" -> "resigned". */
export function normalizeCategorical(input: string): string {
  return normalizeText(input)
    .replace(/\bw\s*e\s*f\b.*$/, "")
    .replace(/\bwith effect from\b.*$/, "")
    .replace(/\bas (?:at|on|of)\b.*$/, "")
    .replace(/\b\d{1,2}\s+\d{4}\b.*$/, "")
    .trim();
}

/**
 * Fold a SUBJECT — the thing a fact is about — to a comparable form.
 *
 * Subjects get their own normaliser rather than being routed by predicate, and
 * that distinction matters more than it looks. Blocking is keyed on the canonical
 * subject, so if "Delhivery" and "Delhivery Limited" fold differently they land
 * in different blocks and are NEVER compared — silently suppressing exactly the
 * cross-document corroboration this system exists to find. A predicate like
 * "revenue from operations" carries no clue that its subject is a company, so
 * predicate-derived routing cannot be trusted here.
 *
 * Both variance sources are stripped, since they cannot collide: honorifics only
 * lead a personal name, legal forms only trail an organisation's. Token order is
 * PRESERVED — "Bank of India" and "India Bank" are different institutions, and
 * sorting would merge them.
 */
export function normalizeSubject(input: string): string {
  const all = tokens(input);
  const withoutHonorifics = all.filter((t) => !HONORIFICS.has(t));

  const parts = [...(withoutHonorifics.length ? withoutHonorifics : all)];
  while (parts.length && ORG_SUFFIXES.has(parts[parts.length - 1])) parts.pop();

  const identifying = parts.filter((t) => !ARTICLES.has(t));
  return (identifying.length ? parts : withoutHonorifics).join(" ");
}

/**
 * Route a string through the right normaliser. The hint comes from the fact's own
 * predicate, so the caller does not have to classify anything by hand.
 */
export function normalizeByHint(value: string, hint: string): string {
  const h = normalizeText(hint);
  if (/\b(address|office|premises|location|situated|registered)\b/.test(h)) {
    return normalizeAddress(value);
  }
  if (/\b(director|officer|person|name|chairman|ceo|cfo|secretary|auditor|promoter)\b/.test(h)) {
    return normalizePersonName(value);
  }
  if (/\b(company|subsidiary|entity|issuer|firm|bank|institution)\b/.test(h)) {
    return normalizeOrgName(value);
  }
  return normalizeText(value);
}

/**
 * Dice coefficient over token sets — a cheap deterministic similarity used to
 * short-circuit obvious matches before spending an embedding call.
 */
export function textSimilarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}
