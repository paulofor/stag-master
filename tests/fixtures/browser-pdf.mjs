// Small PDF generated from code; no client document, filesystem access or external asset.
export function syntheticBrowserPdf() {
  const stream = "1 0 0 rg 20 20 300 300 re f\nBT /F1 22 Tf 30 340 Td (SYNTHETIC PDF) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

// Text pages, dense text, an image-only page and inert document JavaScript for reader tests.
export function syntheticReaderPdf({
  texts = ["REQUISITO 10039", "REGRA DE REMESSA"],
  imageOnly = false,
  encrypted = false,
  imageWidth = 2,
} = {}) {
  const objects = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const imageId = imageOnly
    ? objects.push(
        `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageWidth} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 26 >>\nstream\n0000FF0000FF0000FF0000FF>\nendstream`,
      )
    : null;
  const pages = [];
  for (const text of texts) {
    const page = objects.length + 1,
      content = page + 1;
    pages.push(`${page} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 3 0 R >> ${imageId ? `/XObject << /Im1 ${imageId} 0 R >>` : ""} >> /Contents ${content} 0 R >>`,
    );
    const escaped = text.replace(/[\\()]/g, "\\$&");
    const stream = imageOnly
      ? "q 300 0 0 300 20 20 cm /Im1 Do Q\n"
      : escaped.length > 500
        ? `BT /F1 0.5 Tf 20 300 Td ${escaped
            .match(/.{1,600}/g)
            .map((line) => `(${line}) Tj 0 -1 Td`)
            .join("\n")} ET\n`
        : `BT /F1 16 Tf 20 300 Td (${escaped}) Tj ET\n`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R /OpenAction ${objects.length + 1} 0 R >>`;
  objects[1] = `<< /Type /Pages /Kids [${pages.join(" ")}] /Count ${pages.length} >>`;
  objects.push("<< /Type /Action /S /JavaScript /JS (app.alert\\(SYNTHETIC_INERT_ONLY\\)) >>");
  // Synthetic empty credentials: enough to exercise PasswordException, never decrypt client data.
  if (encrypted)
    objects.push(
      "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>",
    );
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? `/Encrypt ${objects.length} 0 R /ID [<00000000000000000000000000000000><00000000000000000000000000000000>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
