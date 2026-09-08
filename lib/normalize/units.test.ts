import { describe, expect, it } from "vitest";
import { normalizeNumber, parseNumericLiteral, unitsComparable } from "./units";
import type { NumberValue } from "@/lib/types";

const num = (over: Partial<NumberValue>): NumberValue => ({
  kind: "number",
  raw: "0",
  number: 0,
  unit: null,
  scale: null,
  currency: null,
  ...over,
});

describe("parseNumericLiteral", () => {
  it("handles Indian digit grouping, which is not every three digits", () => {
    // 1,23,456 is 123456 — a positional every-third-comma parser corrupts this.
    expect(parseNumericLiteral("1,23,456.78")).toBeCloseTo(123456.78);
    expect(parseNumericLiteral("8,141.7")).toBeCloseTo(8141.7);
  });

  it("reads accounting negatives written as parentheses", () => {
    expect(parseNumericLiteral("(1,234)")).toBe(-1234);
    expect(parseNumericLiteral("(249.20)")).toBeCloseTo(-249.2);
  });

  it("tolerates currency symbols left on the token", () => {
    expect(parseNumericLiteral("₹ 8,141.7")).toBeCloseTo(8141.7);
    expect(parseNumericLiteral("Rs. 2,194")).toBe(2194);
  });

  it("returns null when there is no number at all", () => {
    expect(parseNumericLiteral("not applicable")).toBeNull();
  });
});

describe("normalizeNumber — the corroboration this system must not miss", () => {
  it("makes ₹ crore and INR millions the same magnitude", () => {
    // The brief's opening example: the same revenue in two scales. If these do
    // not collapse to one number, the engine reports a false contradiction.
    const crore = normalizeNumber(
      num({ raw: "8,141.7", number: 8141.7, unit: "INR", scale: "crore", currency: "INR" }),
    )!;
    const millions = normalizeNumber(
      num({ raw: "81,417", number: 81417, unit: "INR", scale: "million", currency: "INR" }),
    )!;
    expect(crore.unit).toBe("INR");
    expect(crore.value).toBeCloseTo(millions.value, -3);
  });

  it("understands lakh and crore", () => {
    expect(normalizeNumber(num({ number: 1, scale: "crore", currency: "INR" }))!.value).toBe(1e7);
    expect(normalizeNumber(num({ number: 1, scale: "lakh", currency: "INR" }))!.value).toBe(1e5);
    expect(normalizeNumber(num({ number: 1, scale: "lakh crore", currency: "INR" }))!.value).toBe(1e12);
  });

  it("folds basis points into percent", () => {
    // Central-bank documents mix "25 bps" and "0.25 per cent" freely.
    const bps = normalizeNumber(num({ number: 25, unit: "bps" }))!;
    const pct = normalizeNumber(num({ number: 0.25, unit: "%" }))!;
    expect(bps.unit).toBe("%");
    expect(bps.value).toBeCloseTo(pct.value);
  });

  it("passes an unrecognised unit through instead of discarding the fact", () => {
    const odd = normalizeNumber(num({ number: 42, unit: "parsecs" }))!;
    expect(odd).toEqual({ value: 42, unit: "parsecs" });
  });

  it("returns null only when the literal itself is unreadable", () => {
    expect(normalizeNumber(num({ raw: "n/a", number: NaN }))).toBeNull();
  });
});

describe("unitsComparable", () => {
  it("refuses to compare across currencies rather than inventing a rate", () => {
    // The IMF reports USD billions, the RBI reports INR crore. An FX rate we made
    // up would let the engine "reconcile" figures it cannot actually reconcile.
    expect(unitsComparable("INR", "USD")).toBe(false);
    expect(unitsComparable("INR", "INR")).toBe(true);
  });
});
