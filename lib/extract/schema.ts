/**
 * The extraction contract: what the model is asked to return, and the prompt that
 * asks for it.
 *
 * Two shape decisions here are about reliability rather than elegance.
 *
 * 1. PERIODS COME BACK AS RAW TEXT. The model copies "Q4 FY24" exactly as printed
 *    and `lib/normalize/period.ts` computes the interval. Asking a model to do
 *    fiscal-year arithmetic invites errors on precisely the edge cases that
 *    matter — and a wrong interval still looks like a valid interval, so nothing
 *    downstream could detect it. Perception to the model, computation to code.
 *
 * 2. VALUE IS FLAT, NOT A DISCRIMINATED UNION. Nested anyOf schemas are where
 *    structured-output calls fail most often. A flat object with a `kind` field
 *    and nullable siblings converts to the tagged union in ten lines of code and
 *    malforms far less.
 */

import { z } from "zod";
import type { FactValue, ScopedClaim } from "@/lib/types";
import { parsePeriod } from "@/lib/normalize/period";
import { parseNumericLiteral } from "@/lib/normalize/units";

/**
 * Bump when the prompt or schema changes in a way that should invalidate cached
 * responses. The cache key includes this, so old entries are simply not hit
 * rather than having to be deleted.
 */
export const PROMPT_VERSION = "v2";

const ValueSchema = z.object({
  kind: z
    .enum(["number", "categorical", "date", "entity"])
    .describe("number = a measured quantity; categorical = a status or class; date = a point in time that IS the value; entity = a named person, place, address or organisation"),
  raw: z
    .string()
    .describe("The value exactly as printed, including separators and symbols, e.g. '8,141.7' or 'Resigned' or 'Plot No. 5, Sector 44'"),
  number: z.number().nullable().describe("Parsed magnitude for kind=number, else null"),
  unit: z
    .string()
    .nullable()
    .describe("Unit family as written: INR, %, bps, days, count, tonnes. Null if none"),
  scale: z
    .string()
    .nullable()
    .describe("Multiplier word in force, taken from the table caption if that is where it is stated: crore, lakh, million, billion, thousand. Null if the number is absolute"),
  currency: z.string().nullable().describe("INR, USD, EUR... Null if not a currency"),
});

const ClaimSchema = z.object({
  claim: z
    .string()
    .describe("One self-contained sentence restating the fact, readable without the source"),
  subject: z
    .string()
    .describe("The entity the fact is about: a company, a country, a person. Resolve 'the Company' to its actual name when the context makes it unambiguous"),
  predicate: z
    .string()
    .describe("The property being asserted, in the document's own words, lowercased: 'revenue from operations', 'office held', 'registered office address', 'real GDP growth'"),
  factType: z.enum(["quantity", "state", "date", "identity"]),
  value: ValueSchema,
  period: z
    .string()
    .nullable()
    .describe("The time scope EXACTLY as written in the document ('FY24', 'Q4 FY2024', 'as at March 31, 2024', '2023-24'). Do NOT convert it to dates. Null only if the document genuinely gives none"),
  basis: z
    .array(z.string())
    .describe("Open list of qualifiers that change what the value means: 'consolidated', 'standalone', 'restated', 'provisional', 'projection', 'seasonally adjusted', or 'segment:Express Parcel' for a business-segment figure. Empty array if none apply"),
  quote: z
    .string()
    .describe("A short verbatim span copied CHARACTER FOR CHARACTER from the excerpt that contains this value. This is checked automatically; an invented or paraphrased quote causes the fact to be discarded"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident you are that this fact and its scope are correct"),
});

export const ExtractionSchema = z.object({
  facts: z.array(ClaimSchema),
});

export type RawClaim = z.infer<typeof ClaimSchema>;

export const SYSTEM_PROMPT = `You extract facts from documents into a knowledge layer that compares claims across sources.

A fact is not a value. A fact is a value plus the scope that makes it comparable: what it is about, what property it measures, over what period, on what basis, in what unit. A number without its scope is worse than useless — it produces false contradictions when compared against a correctly scoped fact elsewhere.

SCOPE IS THE JOB.
Scope qualifiers almost never sit next to the value. They sit in the section heading, the table caption, or a footnote above:

    Consolidated Statement of Profit and Loss    <- basis: consolidated
    for the year ended March 31, 2024            <- period
    (Rs. in crore)                               <- scale: crore, currency: INR
    Revenue from operations        8,141.7       <- the value

You are given SECTION CONTEXT and SCOPE CAPTIONS above the excerpt precisely so you can attribute them. Use them. A revenue figure extracted without its scale is off by seven orders of magnitude.

RULES
- Extract only what is PRINTED. Never compute, sum, convert, annualise or infer a value that does not appear as text.
- The quote must be copied character for character from the excerpt. It is verified by exact string match; a paraphrase discards the fact.
- The quote must contain the value.
- Copy the period as written. Do not convert it to dates. "Q4 FY24" stays "Q4 FY24".
- THE PREDICATE IS A MEASURE, NOT A SENTENCE. It must name something that could be measured again in another document and set side by side with this one. Strip verbs, directions, and commentary:
      "EBITDA increased"      -> "EBITDA"
      "PAT loss reduced"      -> "profit after tax"
      "revenue grew 15%"      -> "revenue growth" (if the value is the 15%)
      "Company was incorporated on" -> "date of incorporation"
  A predicate containing a verb of change is almost always wrong.
- Within that rule, prefer the document's own wording. Do not normalise "revenue from operations" into "revenue" — later stages align wording, and collapsing it early destroys information.
- For a business-segment figure, keep the predicate general and put the segment in basis as "segment:<name>".
- If a value is negative because it is printed in parentheses, the number is negative.

WHAT NOT TO EXTRACT
- Page numbers, section numbers, table-of-contents entries, note references.
- Values whose subject or meaning you cannot determine from the excerpt and its context.
- Restatements of the same value that appear twice on the page. Extract it once.

NON-NUMERIC FACTS MATTER AS MUCH AS NUMBERS.
Directorships and their changes, registered addresses, incorporation dates, auditor and officer appointments, subsidiary relationships, credit ratings, policy stances. For a status that changed, the period is when the state holds or the date it took effect: "Resigned w.e.f. 31 January 2024" is value "Resigned" with period "31 January 2024", not a value of "Resigned w.e.f. 31 January 2024".

Extract every well-scoped fact in the excerpt, up to 25. If the excerpt contains no extractable facts, return an empty array — that is a valid and useful answer.`;

/** Convert the flat wire shape into the tagged union the rest of the system uses. */
function toFactValue(v: RawClaim["value"]): FactValue {
  switch (v.kind) {
    case "number": {
      // The PRINTED literal is the authority on sign.
      //
      // Financial statements write negatives as accounting parentheses, and
      // models routinely return raw "(4,516.08)" alongside number 4516.08 —
      // correct magnitude, lost sign. Trusting `number` flips a loss into a
      // profit, which then reads as a disagreement against the same figure
      // stated elsewhere. Observed suppressing a real cross-document match:
      // "(4,516.08) million" against "Rs. (452 Cr)" are the same value.
      const fromRaw = parseNumericLiteral(v.raw);
      let parsed = v.number ?? fromRaw;

      if (parsed !== null && fromRaw !== null) {
        const rawIsNegative = fromRaw < 0;
        const magnitudesAgree =
          Math.abs(Math.abs(parsed) - Math.abs(fromRaw)) <=
          Math.max(Math.abs(fromRaw), 1) * 1e-9;
        // Only correct when both refer to the same magnitude; a genuine
        // disagreement between the two fields is left alone rather than papered
        // over, and the grounding check will catch it.
        if (magnitudesAgree && rawIsNegative !== parsed < 0) {
          parsed = rawIsNegative ? -Math.abs(parsed) : Math.abs(parsed);
        }
      }

      return {
        kind: "number",
        raw: v.raw,
        number: parsed ?? NaN,
        unit: v.unit,
        scale: v.scale,
        currency: v.currency,
      };
    }
    case "date": {
      const p = parsePeriod(v.raw);
      return { kind: "date", raw: v.raw, iso: p?.start ?? null };
    }
    case "entity":
      return { kind: "entity", raw: v.raw, normalized: v.raw };
    case "categorical":
    default:
      return { kind: "categorical", raw: v.raw, normalized: v.raw };
  }
}

/**
 * Lift a raw model response into a ScopedClaim, parsing the period with our own
 * tested parser rather than trusting the model's arithmetic.
 */
export function toScopedClaim(
  raw: RawClaim,
  ctx: { pageNumber: number; assertedAsOf: string | null },
): ScopedClaim {
  return {
    claim: raw.claim,
    subject: raw.subject,
    predicate: raw.predicate,
    factType: raw.factType,
    value: toFactValue(raw.value),
    scope: {
      period: parsePeriod(raw.period),
      assertedAsOf: ctx.assertedAsOf,
      basis: raw.basis.map((b) => b.trim().toLowerCase()).filter(Boolean),
    },
    qualifiers: {},
    evidence: { quote: raw.quote, pageNumber: ctx.pageNumber },
    extractionConfidence: raw.confidence,
  };
}
