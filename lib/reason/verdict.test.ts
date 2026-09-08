/**
 * The verdict table, exercised across value kinds.
 *
 * `decide` is tested against hand-built value comparisons rather than through the
 * registry, so these assert the RULES in isolation: given that the values agree
 * or conflict, does the engine reach the right conclusion about the context?
 *
 * The point each test is really making is that the same rules serve numeric and
 * semantic facts. A quarterly revenue figure and a director's status take
 * identical paths through this table.
 */

import { describe, expect, it } from "vitest";
import { decide } from "./verdict";
import type { Fact } from "@/lib/types";
import { parsePeriod } from "@/lib/normalize/period";
import type { ValueComparison } from "./compare";

let n = 0;
function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: `f${n++}`,
    documentId: "d1",
    claim: "test claim",
    subject: "Delhivery Limited",
    predicate: "revenue from operations",
    factType: "quantity",
    value: { kind: "number", raw: "8,141.7", number: 8141.7, unit: "INR", scale: "crore", currency: "INR" },
    scope: { period: parsePeriod("FY24"), assertedAsOf: "2024-08-08", basis: ["consolidated"] },
    qualifiers: {},
    evidence: { quote: "q", pageNumber: 1, charStart: 0, charEnd: 1 },
    grounding: "grounded",
    canonicalSubjectId: "s1",
    canonicalPredicateId: "p1",
    normalizedNumber: 8.1417e10,
    normalizedUnit: "INR",
    extractionConfidence: 0.9,
    ...over,
  };
}

const same: ValueComparison = { relation: "SAME", detail: "₹8,141.7 crore matches ₹8,141.7 crore" };
const differs: ValueComparison = { relation: "DIFFERENT", detail: "₹8,141.7 crore vs ₹2,194 crore" };
const exclusive: ValueComparison = { relation: "EXCLUSIVE", detail: '"in office" and "resigned" cannot both hold' };
const unknown: ValueComparison = { relation: "UNKNOWN", detail: "Units are not comparable (INR vs USD)" };

describe("R1 — corroboration", () => {
  it("agrees when scope aligns and values match", () => {
    const r = decide(fact(), fact({ documentId: "d2" }), same);
    expect(r.verdict).toBe("CORROBORATES");
    expect(r.ruleId).toBe("R1");
    expect(r.confidence).toBeGreaterThan(0.8);
  });
});

describe("R4 — apparent contradiction explained by context", () => {
  it("names the period as the reason a quarter differs from its year", () => {
    // The classic false positive: Q4 revenue against full-year revenue. A system
    // that compared numbers without scope would call this a contradiction.
    const year = fact();
    const quarter = fact({ documentId: "d2", scope: { ...fact().scope, period: parsePeriod("Q4 FY24") } });
    const r = decide(year, quarter, differs);

    expect(r.verdict).toBe("RECONCILED");
    expect(r.axis).toBe("period");
    expect(r.explanation).toContain("sits inside");
  });

  it("names entity scope when consolidated meets standalone", () => {
    const consolidated = fact();
    const standalone = fact({
      documentId: "d2",
      scope: { ...fact().scope, basis: ["standalone"] },
    });
    const r = decide(consolidated, standalone, differs);

    expect(r.verdict).toBe("RECONCILED");
    expect(r.axis).toBe("entityScope");
  });

  it("prefers the units axis over every other explanation", () => {
    // A units mismatch makes the values incomparable outright, so it must be
    // reported ahead of a period difference that would otherwise be blamed.
    const inr = fact();
    const usd = fact({
      documentId: "d2",
      normalizedUnit: "USD",
      scope: { ...fact().scope, period: parsePeriod("Q4 FY24") },
    });
    const r = decide(inr, usd, unknown);

    expect(r.verdict).toBe("RECONCILED");
    expect(r.axis).toBe("unit");
    expect(r.explanation).toContain("No conversion is attempted");
  });
});

describe("R5/R7 — superseded and provisional", () => {
  it("treats an explicitly restated figure as replacing, not contradicting", () => {
    const original = fact();
    const restated = fact({
      documentId: "d2",
      scope: { ...fact().scope, basis: ["consolidated", "restated"] },
    });
    // The basis axis differs, so R4 would fire first — unless the restatement
    // rule is allowed to claim it. Assert we get the more informative verdict.
    const r = decide(original, restated, differs);
    expect(["SUPERSEDED", "RECONCILED"]).toContain(r.verdict);
    expect(r.explanation.toLowerCase()).toContain("restated");
  });

  it("excuses a projection differing from an outturn", () => {
    const actual = fact({ scope: { ...fact().scope, basis: [] } });
    const projection = fact({ documentId: "d2", scope: { ...fact().scope, basis: ["projection"] } });
    const r = decide(actual, projection, differs);
    expect(["RECONCILED", "SUPERSEDED"]).toContain(r.verdict);
  });
});

describe("R6 — a state that changed over time", () => {
  // The brief's own example, and the test that proves the rules are not numeric.
  const inOffice = fact({
    factType: "state",
    predicate: "office held",
    subject: "Sahil Barua",
    value: { kind: "categorical", raw: "in office", normalized: "in office" },
    normalizedNumber: null,
    normalizedUnit: null,
    scope: { period: parsePeriod("FY22"), assertedAsOf: "2022-05-10", basis: [] },
  });

  it("reads exclusive states from different vintages as a change, not a conflict", () => {
    const resigned = fact({
      documentId: "d2",
      factType: "state",
      predicate: "office held",
      subject: "Sahil Barua",
      value: { kind: "categorical", raw: "resigned", normalized: "resigned" },
      normalizedNumber: null,
      normalizedUnit: null,
      scope: { period: parsePeriod("FY22"), assertedAsOf: "2024-08-08", basis: [] },
    });

    const r = decide(inOffice, resigned, exclusive);
    expect(r.verdict).toBe("SUPERSEDED");
    expect(r.ruleId).toBe("R6-state-changed");
    expect(r.axis).toBe("vintage");
    expect(r.explanation).toContain("later position");
  });

  it("reports a real contradiction when the same vintage asserts both", () => {
    // Same document date, mutually exclusive states, everything else aligned:
    // there is no reconciling context left to find.
    const alsoResigned = fact({
      documentId: "d2",
      factType: "state",
      predicate: "office held",
      subject: "Sahil Barua",
      value: { kind: "categorical", raw: "resigned", normalized: "resigned" },
      normalizedNumber: null,
      normalizedUnit: null,
      scope: { period: parsePeriod("FY22"), assertedAsOf: "2022-05-10", basis: [] },
    });

    const r = decide(inOffice, alsoResigned, exclusive);
    expect(r.verdict).toBe("CONTRADICTS");
    expect(r.explanation).toContain("cannot both hold");
  });
});

describe("R8 — genuine contradiction", () => {
  it("contradicts when every reconciling hypothesis fails", () => {
    const a = fact({ scope: { period: parsePeriod("FY24"), assertedAsOf: "2024-08-08", basis: ["consolidated"] } });
    const b = fact({ documentId: "d2", scope: { period: parsePeriod("FY24"), assertedAsOf: "2024-08-08", basis: ["consolidated"] } });
    const r = decide(a, b, differs);

    expect(r.verdict).toBe("CONTRADICTS");
    expect(r.ruleId).toBe("R8");
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  it("softens confidence and says so when the sources are different vintages", () => {
    // Two dates, no restatement marker: possibly an unflagged revision. The
    // engine should still report the conflict but hedge, and say why.
    const a = fact();
    const b = fact({ documentId: "d2", scope: { ...fact().scope, assertedAsOf: "2022-05-10" } });
    const r = decide(a, b, differs);

    expect(r.verdict).toBe("CONTRADICTS");
    expect(r.confidence).toBeLessThan(0.85);
    expect(r.explanation).toContain("unflagged revision");
  });
});

describe("bookkeeping", () => {
  it("always records the axis deltas the verdict was built from", () => {
    const r = decide(fact(), fact({ documentId: "d2" }), same);
    const dims = r.deltas.map((d) => d.dimension).sort();
    expect(dims).toEqual(["basis", "entityScope", "period", "predicate", "unit", "vintage"]);
    // Every delta explains itself, which is what makes the UI's "why" panel real
    // rather than a restatement of the verdict.
    expect(r.deltas.every((d) => d.note.length > 10)).toBe(true);
  });

  it("does not treat a coincidental value match across scopes as corroboration", () => {
    const a = fact();
    const b = fact({ documentId: "d2", scope: { ...fact().scope, period: parsePeriod("FY23") } });
    const r = decide(a, b, same);
    expect(r.verdict).toBe("UNRELATED");
  });
});

describe("R7b — a breakdown is not a disagreement", () => {
  it("refuses to call rows of one table contradictions of each other", () => {
    // The real failure: a page listing several values under one generic measure
    // produced 28 "contradictions" from a single page, because every reconciling
    // axis genuinely aligned and only the row label — which the extractor lost —
    // distinguished them.
    const row1 = fact({
      predicate: "% of revenue",
      value: { kind: "number", raw: "34.1%", number: 34.1, unit: "%", scale: null, currency: null },
      normalizedNumber: 34.1,
      normalizedUnit: "%",
      evidence: { quote: "Employee benefits 34.1%", pageNumber: 24, charStart: 0, charEnd: 20 },
    });
    const row2 = fact({
      predicate: "% of revenue",
      value: { kind: "number", raw: "18.8%", number: 18.8, unit: "%", scale: null, currency: null },
      normalizedNumber: 18.8,
      normalizedUnit: "%",
      evidence: { quote: "Freight 18.8%", pageNumber: 24, charStart: 30, charEnd: 45 },
    });

    const r = decide(row1, row2, differs);
    expect(r.verdict).toBe("UNRELATED");
    expect(r.ruleId).toBe("R7b-same-page-breakdown");
    expect(r.explanation).toContain("does not distinguish the rows");
  });

  it("still reports a contradiction when the pages differ", () => {
    // The guard must be narrow: two documents, or two pages, disagreeing about
    // the same scoped measure is exactly what this system exists to surface.
    const a = fact({ evidence: { quote: "q", pageNumber: 10, charStart: 0, charEnd: 1 } });
    const b = fact({ documentId: "d2", evidence: { quote: "q", pageNumber: 44, charStart: 0, charEnd: 1 } });
    expect(decide(a, b, differs).verdict).toBe("CONTRADICTS");
  });
});
