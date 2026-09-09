import { describe, expect, it } from "vitest";
import { toScopedClaim } from "./schema";

const claim = (value: Record<string, unknown>) =>
  toScopedClaim(
    {
      claim: "c",
      subject: "Delhivery",
      predicate: "EBITDA",
      factType: "quantity",
      value: { kind: "number", raw: "0", number: 0, unit: "INR", scale: null, currency: "INR", ...value } as never,
      period: "FY23",
      basis: [],
      quote: "q",
      confidence: 0.9,
    } as never,
    { pageNumber: 1, assertedAsOf: null },
  );

describe("toScopedClaim — the printed literal is the authority on sign", () => {
  it("restores the sign lost from accounting parentheses", () => {
    // Models return raw "(4,516.08)" with number 4516.08: right magnitude, wrong
    // sign. Trusting `number` turns a loss into a profit, which then reads as a
    // disagreement against the same figure stated elsewhere.
    const v = claim({ raw: "(4,516.08)", number: 4516.08 }).value;
    expect(v.kind).toBe("number");
    expect((v as { number: number }).number).toBeCloseTo(-4516.08);
  });

  it("leaves an already-negative value alone", () => {
    expect((claim({ raw: "(452)", number: -452 }).value as { number: number }).number).toBe(-452);
    expect((claim({ raw: "-452", number: -452 }).value as { number: number }).number).toBe(-452);
  });

  it("does not invent a sign for a positive literal", () => {
    expect((claim({ raw: "8,141.7", number: 8141.7 }).value as { number: number }).number).toBeCloseTo(8141.7);
  });

  it("defers to the model when the two fields disagree on magnitude", () => {
    // A real conflict is not a sign problem; leave it and let grounding catch it.
    expect((claim({ raw: "(452)", number: 999 }).value as { number: number }).number).toBe(999);
  });

  it("parses the period with our own parser, not the model's arithmetic", () => {
    const scope = claim({ raw: "1", number: 1 }).scope;
    expect(scope.period?.start).toBe("2022-04-01");
    expect(scope.period?.end).toBe("2023-03-31");
  });
});
