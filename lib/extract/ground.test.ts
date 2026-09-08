import { describe, expect, it } from "vitest";
import { boxesForRange, groundClaim } from "./ground";
import type { ScopedClaim } from "@/lib/types";

/** A page as our parser produces it: gap-padded columns, hard line breaks. */
const PAGE = [
  "Consolidated Statement of Profit and Loss",
  "for the year ended March 31, 2024",
  "(Rs. in crore)",
  "Revenue from operations            8,141.7        7,225.3",
  "Other income                         249.2          193.1",
  "Mr. Sahil Barua, Managing Director and Chief Executive Officer",
  "Registered office: Plot No. 5, Sector 44, Gurgaon 122003",
].join("\n");

const claim = (over: Partial<ScopedClaim>): ScopedClaim => ({
  claim: "test",
  subject: "Delhivery Limited",
  predicate: "revenue from operations",
  factType: "quantity",
  value: { kind: "number", raw: "8,141.7", number: 8141.7, unit: "INR", scale: "crore", currency: "INR" },
  scope: { period: null, assertedAsOf: null, basis: [] },
  qualifiers: {},
  evidence: { quote: "Revenue from operations            8,141.7", pageNumber: 1 },
  extractionConfidence: 0.9,
  ...over,
});

describe("groundClaim — accepting honest citations", () => {
  it("grounds an exact quote", () => {
    const r = groundClaim(claim({}), PAGE);
    expect(r.status).toBe("grounded");
    expect(r.method).toBe("exact");
    expect(PAGE.slice(r.charStart!, r.charEnd!)).toContain("8,141.7");
  });

  it("grounds a quote whose column padding was collapsed", () => {
    // Models routinely tidy the runs of spaces our layout reconstruction inserts.
    // Rejecting that would quarantine most correct table extractions.
    const r = groundClaim(
      claim({ evidence: { quote: "Revenue from operations 8,141.7", pageNumber: 1 } }),
      PAGE,
    );
    expect(r.status).toBe("grounded");
    expect(r.method).toBe("whitespace");
  });

  it("accepts a value printed with a trailing zero", () => {
    const page = "Other income 249.20";
    const r = groundClaim(
      claim({
        value: { kind: "number", raw: "249.2", number: 249.2, unit: "INR", scale: "crore", currency: "INR" },
        evidence: { quote: "Other income 249.20", pageNumber: 1 },
      }),
      page,
    );
    expect(r.status).toBe("grounded");
  });

  it("grounds non-numeric values by token containment", () => {
    const r = groundClaim(
      claim({
        factType: "state",
        predicate: "office held",
        value: { kind: "categorical", raw: "Managing Director", normalized: "managing director" },
        evidence: {
          quote: "Mr. Sahil Barua, Managing Director and Chief Executive Officer",
          pageNumber: 1,
        },
      }),
      PAGE,
    );
    expect(r.status).toBe("grounded");
  });
});

describe("groundClaim — regressions from real quarantine output", () => {
  // Every case here was a CORRECT extraction that the grounding check wrongly
  // rejected. False rejections are the expensive kind of bug: they look like
  // model failures, so they get blamed on the model and never investigated.

  it("does not weld adjacent table columns into one number", () => {
    // "Total equity 9,177 9,145" is current year and prior year in two columns.
    // A numeric tokeniser that treats space as a digit separator reads this as
    // the single value 91,779,145 and then cannot find either real figure —
    // undoing the very column structure the PDF parser worked to preserve.
    const page = "Total equity            9,177         9,145";
    for (const raw of ["9,177", "9,145"]) {
      const r = groundClaim(
        claim({
          value: { kind: "number", raw, number: Number(raw.replace(/,/g, "")), unit: "INR", scale: "crore", currency: "INR" },
          evidence: { quote: "Total equity 9,177 9,145", pageNumber: 1 },
        }),
        page,
      );
      expect(r.status, `value ${raw}`).toBe("grounded");
    }
  });

  it("finds a value written with a currency prefix containing a full stop", () => {
    // "Rs. (452 Cr)" once normalised to ".452" — the dot came from "Rs." — and
    // failed to match the very quote it was copied out of.
    const page = "FY24 EBITDA increased by Rs. 578 Cr to Rs. 127 Cr from Rs. (452 Cr) in FY23";
    const r = groundClaim(
      claim({
        value: { kind: "number", raw: "Rs. (452 Cr)", number: -452, unit: "INR", scale: "crore", currency: "INR" },
        evidence: { quote: page, pageNumber: 1 },
      }),
      page,
    );
    expect(r.status).toBe("grounded");
  });

  it("tolerates footnote markers that the layout positions separately", () => {
    // The page draws the superscript apart from its label; the quote does not.
    const page = "Pin-code reach (1)     18,793";
    const r = groundClaim(
      claim({
        value: { kind: "number", raw: "18,793", number: 18793, unit: "count", scale: null, currency: null },
        evidence: { quote: "Pin-code reach(1) 18,793", pageNumber: 1 },
      }),
      page,
    );
    expect(r.status).toBe("grounded");
    expect(r.method).toBe("folded");
  });
});

describe("groundClaim — rejecting what it should", () => {
  it("rejects a quote that is not on the page", () => {
    // The failure mode that matters most: a fabricated citation would otherwise
    // surface as a confident contradiction against a real figure.
    const r = groundClaim(
      claim({ evidence: { quote: "Revenue from operations 9,999.9", pageNumber: 1 } }),
      PAGE,
    );
    expect(r.status).toBe("quote_not_found");
  });

  it("distinguishes a real quote carrying the wrong value", () => {
    // A genuine span, but the model read the prior-year column. This is a
    // different defect from a fabricated quote and is reported separately.
    const r = groundClaim(
      claim({
        value: { kind: "number", raw: "9,999.9", number: 9999.9, unit: "INR", scale: "crore", currency: "INR" },
        evidence: { quote: "Revenue from operations            8,141.7", pageNumber: 1 },
      }),
      PAGE,
    );
    expect(r.status).toBe("value_not_in_quote");
    // The quote was still located, so a reviewer can see what went wrong.
    expect(r.charStart).not.toBeNull();
  });

  it("rejects a quote too short to be evidence of anything", () => {
    const r = groundClaim(claim({ evidence: { quote: "8", pageNumber: 1 } }), PAGE);
    expect(r.status).toBe("quote_not_found");
  });

  it("rejects a span that carries the value but no word identifying it", () => {
    // The failure that produced 28 false contradictions from one page: a table of
    // "% of revenue" where every row was cited as a bare figure. Identical scope,
    // different values, nothing to tell the rows apart — so the engine had no
    // choice but to call each row a contradiction of every other.
    const page = "Cost breakdown as % of revenue\n34.1%\n18.8%\n12.2%";
    const r = groundClaim(
      claim({
        predicate: "% of revenue",
        value: { kind: "number", raw: "34.1%", number: 34.1, unit: "%", scale: null, currency: null },
        evidence: { quote: "34.1%", pageNumber: 1 },
      }),
      page,
    );
    expect(r.status).toBe("quote_lacks_context");
  });

  it("still accepts a terse but identifying table row", () => {
    // The rule must not be so strict that real, sparse rows are lost.
    const page = "Gateways 111\nAutomated sort centers 29";
    const r = groundClaim(
      claim({
        predicate: "gateways",
        value: { kind: "number", raw: "111", number: 111, unit: "count", scale: null, currency: null },
        evidence: { quote: "Gateways 111", pageNumber: 1 },
      }),
      page,
    );
    expect(r.status).toBe("grounded");
  });

  it("does not count currency or scale words as identifying", () => {
    // "Rs. 8,142 Cr" says how a number is printed, not what it measures.
    const page = "Highlights\nRs. 8,142 Cr\nFY24 revenue from services";
    const r = groundClaim(
      claim({
        value: { kind: "number", raw: "8,142", number: 8142, unit: "INR", scale: "crore", currency: "INR" },
        evidence: { quote: "Rs. 8,142 Cr", pageNumber: 1 },
      }),
      page,
    );
    expect(r.status).toBe("quote_lacks_context");
  });
});

describe("boxesForRange", () => {
  const spans = [
    { s: 0, e: 7, x: 10, y: 100, w: 40, h: 10 },
    { s: 8, e: 18, x: 55, y: 100, w: 60, h: 10 },
    { s: 19, e: 26, x: 10, y: 120, w: 45, h: 10 },
  ];

  it("merges spans on the same line into one rectangle", () => {
    const boxes = boxesForRange(spans, 0, 18);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x: 10, y: 100, w: 105 });
  });

  it("returns one rectangle per line when a quote wraps", () => {
    expect(boxesForRange(spans, 0, 26)).toHaveLength(2);
  });

  it("returns nothing for a range covering no text", () => {
    expect(boxesForRange(spans, 500, 600)).toEqual([]);
  });
});
