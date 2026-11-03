import { describe, expect, it } from "vitest";
import { buildPdf } from "../src/app/pdf";

describe("pdf writer", () => {
  it("writes a valid xref table and one image page per map", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const page = { jpeg, widthPx: 10, heightPx: 7, widthMm: 297, heightMm: 210 };
    const bytes = new Uint8Array(await buildPdf([page, page, page], "Batch (test)").arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 3");
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(3);
    expect(text).toContain("/MediaBox [0 0 841.89 595.28]");
    expect(text).toContain("/Title (Batch \\(test\\))");
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const rows = text.slice(startxref).split("\n");
    const size = Number(rows[1].split(" ")[1]);
    for (let n = 1; n < size; n++) {
      const off = Number(rows[2 + n].slice(0, 10));
      expect(text.slice(off, off + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
    }
  });
});
