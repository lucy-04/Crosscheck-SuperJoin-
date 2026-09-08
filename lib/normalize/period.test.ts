import { describe, expect, it } from "vitest";
import { comparePeriods, parsePeriod, periodMonths } from "./period";

const span = (raw: string) => {
  const p = parsePeriod(raw);
  return p ? `${p.start}..${p.end}` : null;
};

describe("parsePeriod — Indian fiscal years", () => {
  it("reads a fiscal year named for the year it ends in", () => {
    expect(span("FY24")).toBe("2023-04-01..2024-03-31");
    expect(span("FY2024")).toBe("2023-04-01..2024-03-31");
    expect(span("FY 2024")).toBe("2023-04-01..2024-03-31");
    expect(span("F.Y. 2024")).toBe("2023-04-01..2024-03-31");
  });

  it("reads the spanning form the macro documents prefer", () => {
    // "2023-24" and "FY24" are the same year written two ways. Getting this
    // wrong by one year would silently turn corroborations into contradictions.
    expect(span("2023-24")).toBe("2023-04-01..2024-03-31");
    expect(span("FY2023-24")).toBe("2023-04-01..2024-03-31");
    expect(span("2024-25")).toBe("2024-04-01..2025-03-31");
    expect(span("FY2024/25")).toBe("2024-04-01..2025-03-31");
  });
});

describe("parsePeriod — sub-annual windows", () => {
  it("places quarters inside the fiscal year, not the calendar year", () => {
    expect(span("Q1 FY24")).toBe("2023-04-01..2023-06-30");
    expect(span("Q3FY24")).toBe("2023-10-01..2023-12-31");
    // Q4 of an April-March year falls in the NEXT calendar year.
    expect(span("Q4 FY24")).toBe("2024-01-01..2024-03-31");
    expect(span("Q4 FY2023-24")).toBe("2024-01-01..2024-03-31");
  });

  it("reads halves and cumulative windows", () => {
    expect(span("H1FY25")).toBe("2024-04-01..2024-09-30");
    expect(span("H2 FY25")).toBe("2024-10-01..2025-03-31");
    expect(span("9M FY24")).toBe("2023-04-01..2023-12-31");
  });
});

describe("parsePeriod — instants and calendar years", () => {
  it("reads written dates in the forms filings actually use", () => {
    expect(span("as at March 31, 2024")).toBe("2024-03-31..2024-03-31");
    expect(span("as on 31 March 2024")).toBe("2024-03-31..2024-03-31");
    expect(span("31st March, 2024")).toBe("2024-03-31..2024-03-31");
    expect(span("2024-03-31")).toBe("2024-03-31..2024-03-31");
    expect(span("31/03/2024")).toBe("2024-03-31..2024-03-31");
  });

  it("treats 'year ended <date>' as the year, not the closing day", () => {
    // A balance-sheet total "as at 31 March 2024" is an instant; a revenue figure
    // "for the year ended 31 March 2024" spans twelve months. Same date, different
    // scope — and comparing one to the other is a period mismatch, not a conflict.
    expect(span("for the year ended March 31, 2024")).toBe("2023-04-01..2024-03-31");
  });

  it("distinguishes calendar years from fiscal years", () => {
    expect(span("CY2024")).toBe("2024-01-01..2024-12-31");
    expect(span("calendar year 2024")).toBe("2024-01-01..2024-12-31");
  });

  it("returns null rather than guessing when there is no time information", () => {
    expect(parsePeriod("consolidated")).toBeNull();
    expect(parsePeriod("")).toBeNull();
    expect(parsePeriod(null)).toBeNull();
  });
});

describe("parsePeriod — configurable fiscal calendar", () => {
  it("is not hard-wired to India's April-March year", () => {
    const us = parsePeriod("FY2024", { fiscalYearStartMonth: 10 });
    expect(`${us!.start}..${us!.end}`).toBe("2023-10-01..2024-09-30");
    const cal = parsePeriod("FY2024", { fiscalYearStartMonth: 1 });
    expect(`${cal!.start}..${cal!.end}`).toBe("2024-01-01..2024-12-31");
  });
});

describe("comparePeriods", () => {
  const fy24 = parsePeriod("FY24")!;
  const q4fy24 = parsePeriod("Q4 FY24")!;
  const fy25 = parsePeriod("FY25")!;

  it("recognises containment, which is what reconciles most apparent conflicts", () => {
    expect(comparePeriods(fy24, q4fy24)).toBe("A_CONTAINS_B");
    expect(comparePeriods(q4fy24, fy24)).toBe("B_CONTAINS_A");
  });

  it("recognises equality and disjointness", () => {
    expect(comparePeriods(fy24, parsePeriod("2023-24")!)).toBe("EQUAL");
    expect(comparePeriods(fy24, fy25)).toBe("DISJOINT");
  });

  it("reports MISSING when either side is unscoped", () => {
    expect(comparePeriods(fy24, null)).toBe("MISSING");
  });
});

describe("periodMonths", () => {
  it("measures window length, used by the numeric ratio diagnostic", () => {
    expect(periodMonths(parsePeriod("FY24")!)).toBe(12);
    expect(periodMonths(parsePeriod("Q4 FY24")!)).toBe(3);
    expect(periodMonths(parsePeriod("H1FY25")!)).toBe(6);
  });
});
