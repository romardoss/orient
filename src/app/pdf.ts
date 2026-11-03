/** Minimal PDF writer: one full-page JPEG image per page, no dependencies. */

export interface PdfImagePage {
  /** JPEG file bytes. */
  jpeg: Uint8Array;
  /** Image size in pixels. */
  widthPx: number;
  heightPx: number;
  /** Page size in millimetres. */
  widthMm: number;
  heightMm: number;
}

const PT_PER_MM = 72 / 25.4;

export function buildPdf(pages: PdfImagePage[], title = "Orienteering maps"): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    parts.push(bytes);
    offset += bytes.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = offset;
    push(`${n} 0 obj\n`);
    body();
    push("\nendobj\n");
  };

  // Object numbers: 1 catalog, 2 page tree, 3 info, then 3 objects per page (page, image, content).
  const first = 4;
  const pageObj = (i: number) => first + i * 3;
  const total = first + pages.length * 3;

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`));
  obj(3, () => push(`<< /Title (${pdfString(title)}) /Producer (Orient map generator) >>`));

  pages.forEach((p, i) => {
    const w = (p.widthMm * PT_PER_MM).toFixed(2);
    const h = (p.heightMm * PT_PER_MM).toFixed(2);
    const n = pageObj(i);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(n, () =>
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>`),
    );
    obj(n + 1, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${p.widthPx} /Height ${p.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      );
      push(p.jpeg);
      push("\nendstream");
    });
    obj(n + 2, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  });

  const xref = offset;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

/** Escapes a PDF literal string; non-ASCII characters are dropped (Info strings are PDFDocEncoding). */
function pdfString(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "").replace(/[\\()]/g, (c) => `\\${c}`);
}
