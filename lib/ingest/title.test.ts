import { describe, expect, it } from "vitest";
import { titleFromFilename } from "./ingest";

describe("titleFromFilename — stable across uploads of the same file", () => {
  it("strips the upload id so the same PDF hits its own cache", () => {
    // The title is embedded in the extraction prompt and therefore in the cache
    // key. If the per-upload random id leaked into it, the same document
    // uploaded twice would miss its own cache, re-pay for extraction, and return
    // a different set of facts each time.
    expect(titleFromFilename("up_mttm32ve980roy_note.pdf")).toBe("Note");
    expect(titleFromFilename("up_abc123_note.pdf")).toBe(titleFromFilename("up_zzz999_note.pdf"));
  });

  it("still tidies ordinary filenames", () => {
    expect(titleFromFilename("02-delhivery-annual-report-fy24-excerpt.pdf"))
      .toBe("Delhivery Annual Report Fy24 Excerpt");
  });
});
