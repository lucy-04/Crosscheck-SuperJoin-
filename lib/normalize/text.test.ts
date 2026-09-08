import { describe, expect, it } from "vitest";
import {
  normalizeAddress,
  normalizeByHint,
  normalizeCategorical,
  normalizeOrgName,
  normalizePersonName,
  normalizeSubject,
  textSimilarity,
} from "./text";

describe("normalizePersonName", () => {
  it("strips honorifics so the same person matches across documents", () => {
    expect(normalizePersonName("Mr. Sahil Barua")).toBe(normalizePersonName("Sahil Barua"));
    expect(normalizePersonName("Shri Ajay Kumar")).toBe(normalizePersonName("Ajay Kumar"));
  });

  it("is insensitive to written order", () => {
    // Shareholding tables invert names; directors' reports do not.
    expect(normalizePersonName("Barua, Sahil")).toBe(normalizePersonName("Sahil Barua"));
  });
});

describe("normalizeOrgName", () => {
  it("ignores legal-form suffixes that vary between filings", () => {
    expect(normalizeOrgName("Delhivery Limited")).toBe("delhivery");
    expect(normalizeOrgName("Delhivery Ltd.")).toBe("delhivery");
  });

  it("keeps the name when it is nothing but a suffix", () => {
    expect(normalizeOrgName("The Company")).toBe("the company");
  });
});

describe("normalizeAddress — the brief's own example", () => {
  it("resolves differently written addresses to the same place", () => {
    expect(normalizeAddress("Plot No. 5, Sector-44, Gurgaon")).toBe(
      normalizeAddress("Plot 5, Sector 44, Gurugram"),
    );
  });

  it("expands abbreviations and applies renamed cities", () => {
    expect(normalizeAddress("12 MG Rd., Bangalore")).toBe("12 mahatma gandhi road bengaluru");
  });

  it("never drops house or sector numbers", () => {
    // Numbers are the highest-signal tokens in an address; losing them would make
    // two different units in the same building look identical.
    expect(normalizeAddress("Plot No. 5, Sector 44")).toContain("5");
    expect(normalizeAddress("Plot No. 5, Sector 44")).not.toBe(
      normalizeAddress("Plot No. 7, Sector 44"),
    );
  });
});

describe("normalizeCategorical", () => {
  it("separates the state from the date it took effect", () => {
    // "Resigned w.e.f. 31.01.2024" carries two facts. The state is "resigned";
    // the date belongs in the scope, not glued to the value.
    expect(normalizeCategorical("Resigned w.e.f. 31.01.2024")).toBe("resigned");
    expect(normalizeCategorical("Resigned with effect from 31 January 2024")).toBe("resigned");
  });
});

describe("normalizeByHint", () => {
  it("routes a value by its own predicate, with no manual classification", () => {
    expect(normalizeByHint("Plot No. 5, Sector-44, Gurgaon", "registered office address")).toBe(
      normalizeAddress("Plot 5, Sector 44, Gurugram"),
    );
    expect(normalizeByHint("Mr. Sahil Barua", "name of director")).toBe(
      normalizePersonName("Sahil Barua"),
    );
  });
});

describe("textSimilarity", () => {
  it("scores overlap so obvious matches skip the embedding call", () => {
    expect(textSimilarity("revenue from operations", "revenue from operations")).toBe(1);
    expect(textSimilarity("revenue from operations", "total income")).toBe(0);
    expect(textSimilarity("revenue from operations", "revenue operations")).toBeGreaterThan(0.7);
  });
});

describe("normalizeSubject — the fold that blocking depends on", () => {
  it("folds a company written with and without its legal form", () => {
    // Blocking is keyed on the canonical subject. If these differ, the earnings
    // deck's "Delhivery" facts and the annual report's "Delhivery Limited" facts
    // land in separate blocks and are never compared — silently losing the
    // cross-document corroboration the system exists to find.
    expect(normalizeSubject("Delhivery")).toBe(normalizeSubject("Delhivery Limited"));
    expect(normalizeSubject("Delhivery Ltd.")).toBe(normalizeSubject("Delhivery"));
  });

  it("folds a person written with and without an honorific", () => {
    expect(normalizeSubject("Mr. Sahil Barua")).toBe(normalizeSubject("Sahil Barua"));
  });

  it("preserves token order, because word order carries identity", () => {
    // Sorting tokens would merge two different institutions.
    expect(normalizeSubject("Bank of India")).not.toBe(normalizeSubject("India Bank"));
  });

  it("does not strip a subject down to nothing", () => {
    expect(normalizeSubject("The Company")).toBe("the company");
  });
});
