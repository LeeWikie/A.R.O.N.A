import { crc32 } from 'node:zlib';
import ExcelJS from 'exceljs';

/** Small uncompressed OOXML packages containing synthetic test content only. */
export function archiveFixture(files: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const file = Buffer.from(name), bytes = Buffer.from(value), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(file.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(file.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, file, bytes); central.push(directory, file); offset += header.length + file.length + bytes.length;
  }
  const end = Buffer.alloc(22), index = Buffer.concat(central); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
export function documentFixture() {
  return archiveFixture({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic 中文 document</w:t><w:tab/><w:t>violet-17</w:t><w:br/><w:t>Second line.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table value 42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  });
}
export async function workbookFixture() {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('中文表');
  sheet.addRow(['Name', 'Value', 'Calculated']); sheet.addRow(['violet-17', 21, { formula: 'B2*2', result: 42 }]);
  const hidden = workbook.addWorksheet('Hidden', { state: 'hidden' }); hidden.addRow(['HIDDEN_CANARY']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
export function pdfFixture() {
  const stream = 'BT /F1 12 Tf 72 720 Td (Synthetic PDF violet-17) Tj 0 -18 Td (Second page line 42) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(text); text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(text);
}
