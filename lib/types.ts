/**
 * The domain model.
 *
 * The central idea of this project: a fact is not a value, it is a SCOPED CLAIM.
 * "revenue = 8,142" is not comparable to anything. "(Delhivery, consolidated)
 * (revenue from operations) (FY2024) (INR crore) = 8,142" is. Likewise "is a
 * director" means nothing until it carries OF WHOM and AS ASSERTED WHEN.
 *
 * Everything downstream — grounding, normalisation, the registry, the
 * reconciliation engine — exists to fill in and then compare these scopes.
 *
 * Note what is NOT here: any enumeration of which facts the system can hold.
 * `predicate` is free text, `basis` is an open vocabulary, and `qualifiers` is an
 * open map. A document about shipping logistics and a document about monetary
 * policy produce the same shape of record without a schema change.
 */

/** Which of the four value families a claim carries. Drives comparator dispatch. */
export type FactType = "quantity" | "state" | "date" | "identity";

/**
 * A measured number, with everything needed to make it comparable to another
 * number: the literal as printed, the parsed magnitude, and the unit/scale that
 * magnitude is expressed in. `raw` is retained verbatim because the grounding
 * check asserts it appears in the evidence quote.
 */
export interface NumberValue {
  kind: "number";
  raw: string;
  number: number;
  /** Unit family as written: "INR", "%", "bps", "days", "count", "tonnes", ... */
  unit: string | null;
  /** Multiplier word as written: "crore", "lakh", "million", "billion", ... */
  scale: string | null;
  currency: string | null;
}

/** A categorical state: "resigned", "Managing Director", "provisional", "AA+". */
export interface CategoricalValue {
  kind: "categorical";
  raw: string;
  normalized: string;
}

/** A point in time asserted as the value itself (e.g. a date of appointment). */
export interface DateValue {
  kind: "date";
  raw: string;
  iso: string | null;
}

/** A named thing: a person, a place, an address, an organisation. */
export interface EntityValue {
  kind: "entity";
  raw: string;
  normalized: string;
}

export type FactValue = NumberValue | CategoricalValue | DateValue | EntityValue;

export type PeriodKind =
  | "fiscal_year"
  | "quarter"
  | "half_year"
  | "calendar_year"
  | "month"
  | "instant"
  | "range";

/**
 * A time scope, normalised to a half-open interval [start, end) so that periods
 * of different kinds are directly comparable. FY2024 and Q4 FY2024 are not
 * "different strings", they are intervals in a containment relation — which is
 * what lets the engine say "these differ because one is a quarter of the other".
 */
export interface Period {
  raw: string;
  kind: PeriodKind;
  /** ISO date, inclusive. */
  start: string;
  /** ISO date, inclusive. */
  end: string;
}

/**
 * Everything that must match before two values may be compared at all.
 *
 * `basis` is deliberately an open string list rather than an enum: documents
 * invent qualifiers we have not seen ("seasonally adjusted", "annualised",
 * "excluding one-offs", "pro forma"). New qualifiers flow through the system and
 * show up as reconciliation axes without any code or schema change.
 */
export interface Scope {
  period: Period | null;
  /** The document's own as-of date, used for vintage ordering of claims. */
  assertedAsOf: string | null;
  basis: string[];
}

/** Where a fact came from, precisely enough to be checked by a human. */
export interface Evidence {
  /** Copied character-for-character from the page; verified in lib/extract/ground.ts. */
  quote: string;
  /** Page index within the PDF, 1-based. */
  pageNumber: number;
  /** Character offsets of the quote within the page's extracted text. */
  charStart: number | null;
  charEnd: number | null;
}

/** What the LLM returns per extraction unit, before grounding and normalisation. */
export interface ScopedClaim {
  claim: string;
  subject: string;
  predicate: string;
  factType: FactType;
  value: FactValue;
  scope: Scope;
  qualifiers: Record<string, unknown>;
  evidence: { quote: string; pageNumber: number };
  extractionConfidence: number;
}

/** Outcome of the deterministic grounding check. */
export type GroundingStatus =
  | "grounded"
  | "quote_not_found"
  | "value_not_in_quote"
  /** The span contains the value but no words saying what it measures. */
  | "quote_lacks_context";

/** A claim that survived grounding and has been normalised and canonicalised. */
export interface Fact extends Omit<ScopedClaim, "evidence"> {
  id: string;
  documentId: string;
  evidence: Evidence;
  grounding: GroundingStatus;
  /** Registry ids assigned in stage 6; null until canonicalisation has run. */
  canonicalSubjectId: string | null;
  canonicalPredicateId: string | null;
  /** Unit-normalised magnitude, comparable across scales. Numbers only. */
  normalizedNumber: number | null;
  normalizedUnit: string | null;
}

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

/** How two time scopes relate. The vocabulary the explanations are written in. */
export type PeriodRelation =
  | "EQUAL"
  /** One side is an instant falling exactly on the other's closing date. */
  | "BOUNDARY"
  | "A_CONTAINS_B"
  | "B_CONTAINS_A"
  | "OVERLAP"
  | "DISJOINT"
  | "MISSING";

/** How two predicates relate, per the registry. */
export type PredicateRelation =
  | "SAME"
  | "A_SUBSUMES_B"
  | "B_SUBSUMES_A"
  | "DIFFERENT";

/** What a value comparator concluded, independent of scope. */
export type ValueRelation =
  | "SAME"
  | "DIFFERENT"
  | "EXCLUSIVE"
  | "COMPATIBLE"
  | "UNKNOWN";

/**
 * One axis on which two facts were compared. The engine emits one of these per
 * dimension, and the explanation is assembled from them — which is why a verdict
 * can always name the reason it reached it.
 */
export interface DimensionDelta {
  dimension: "period" | "entityScope" | "basis" | "unit" | "vintage" | "predicate";
  aligned: boolean;
  a: string | null;
  b: string | null;
  /** Human-readable statement of this axis alone, e.g. "Q4 FY2024 sits inside FY2024". */
  note: string;
}

export type Verdict =
  | "CORROBORATES"
  | "CONTRADICTS"
  | "RECONCILED"
  | "SUPERSEDED"
  | "DERIVES"
  | "UNRELATED";

export interface Relation {
  id: string;
  factAId: string;
  factBId: string;
  verdict: Verdict;
  confidence: number;
  /** Which axis explains the difference, for RECONCILED/SUPERSEDED. */
  axis: DimensionDelta["dimension"] | null;
  valueRelation: ValueRelation;
  deltas: DimensionDelta[];
  explanation: string;
  /** "rule" when the deterministic engine decided; "llm" when it escalated. */
  decidedBy: "rule" | "llm";
  /** Which numbered rule fired, so a verdict can be traced back to its cause. */
  ruleId: string;
}
