import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { formatMoney } from '../common/money';

export interface CommissionExportData {
  perMiniLotMinor: bigint; perMegaLotMinor: bigint; totalMinor: bigint;
  lines: { username: string; miniLots: number; megaLots: number; commissionMinor: bigint }[];
}

/** Exports only the broker's earnings; trader brokerage is deliberately excluded. */
export async function renderCommission(report: CommissionExportData, month: string, format: 'PDF' | 'XLSX', platform = false) {
  const fileName = `commission-${month}.${format.toLowerCase()}`;
  if (format === 'XLSX') {
    const book = new ExcelJS.Workbook();
    book.creator = 'The K';
    const sheet = book.addWorksheet('Commission');
    sheet.columns = [{ width: 32 }, { width: 18 }, { width: 18 }, { width: 24 }];
    sheet.addRow(['Commission report', month]);
    sheet.addRow(platform ? ['Calculation', 'Brokerage less broker commission'] : ['Mini rate (INR)', Number(formatMoney(report.perMiniLotMinor))]);
    sheet.addRow(platform ? ['Basis', 'Executed trades'] : ['Mega rate (INR)', Number(formatMoney(report.perMegaLotMinor))]);
    sheet.addRow([]);
    sheet.addRow(['Trader', 'Mini lots', 'Mega lots', 'Commission (INR)']).font = { bold: true };
    for (const line of report.lines) sheet.addRow([line.username, line.miniLots, line.megaLots, Number(formatMoney(line.commissionMinor))]);
    sheet.addRow(['Total', '', '', Number(formatMoney(report.totalMinor))]).font = { bold: true };
    sheet.getColumn(4).numFmt = '#,##0.00';
    sheet.views = [{ state: 'frozen', ySplit: 5 }];
    sheet.autoFilter = { from: 'A5', to: `D${5 + report.lines.length}` };
    return { fileName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: Buffer.from(await book.xlsx.writeBuffer()).toString('base64') };
  }
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Commission ${month}` } });
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => { doc.on('data', (b: Buffer) => chunks.push(b)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  doc.fontSize(20).text('Commission report');
  doc.fontSize(11).text(`Month: ${month} (India time)`).moveDown();
  doc.text(platform ? 'Brokerage less broker commission' : `Per mini lot: INR ${formatMoney(report.perMiniLotMinor)} | Per mega lot: INR ${formatMoney(report.perMegaLotMinor)}`).moveDown();
  const header = () => { const y = doc.y; doc.font('Helvetica-Bold').fontSize(10); doc.text('Trader', 42, y, { width: 210 }); doc.text('Mini lots', 255, y, { width: 65 }); doc.text('Mega lots', 325, y, { width: 65 }); doc.text('Commission (INR)', 395, y, { width: 115, align: 'right' }); doc.y = y + 25; doc.font('Helvetica'); };
  header();
  for (const line of report.lines) {
    if (doc.y > 730) { doc.addPage(); header(); }
    const y = doc.y;
    doc.text(line.username, 42, y, { width: 210 }); doc.text(String(line.miniLots), 255, y, { width: 65 }); doc.text(String(line.megaLots), 325, y, { width: 65 }); doc.text(formatMoney(line.commissionMinor), 395, y, { width: 115, align: 'right' }); doc.y = y + 25;
  }
  if (doc.y > 730) doc.addPage();
  doc.moveDown().font('Helvetica-Bold').text(`Total commission: INR ${formatMoney(report.totalMinor)}`, 42);
  doc.end();
  return { fileName, mimeType: 'application/pdf', base64: (await complete).toString('base64') };
}
