import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { dayStart, type DayResult, type MonthlyStatus, type PersonMonth } from "../services/monthly-status.js";

// Excel and PDF renderings of the Monthly Status report, laid out like the
// eTimeTrackLite "Monthly Status Report (Detailed Work Duration)" that sites
// already read: Days header, then per employee a totals line and a grid of
// Status / InTime / OutTime / Duration. Ported from 0.4.24 (F3 F-f) without
// the shift rows (Late By, Early By, OT, Shift), which come with F4.

export const TITLE = "Monthly Status Report (Detailed Work Duration)";
const WEEKDAYS = ["S", "M", "T", "W", "Th", "F", "St"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ROWS = ["Status", "InTime", "OutTime", "Duration"] as const;

export interface RenderMeta {
  printedAt: Date; // local wall clock as UTC fields
  generatedBy: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** eTimeTrackLite's duration format: 00:25, 4:32, 12:46. */
export const duration = (minutes: number) =>
  `${Math.floor(minutes / 60) === 0 ? "00" : Math.floor(minutes / 60)}:${pad(minutes % 60)}`;
const clock = (ms: number | null) => {
  if (ms === null) return "";
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const longDate = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()}`;
export const rangeLabel = (r: MonthlyStatus) => `${longDate(new Date(dayStart(r.from)))}  To  ${longDate(new Date(dayStart(r.to)))}`;
export const printedLabel = (m: RenderMeta) =>
  `Printed On : ${longDate(m.printedAt)} ${pad(m.printedAt.getUTCHours())}:${pad(m.printedAt.getUTCMinutes())}`;
export const dayLabel = (day: string) => {
  const d = new Date(dayStart(day));
  return `${d.getUTCDate()} ${WEEKDAYS[d.getUTCDay()]}`;
};

/** The four grid rows for one person, as text. */
export function gridRows(p: PersonMonth): string[][] {
  const cell = (d: DayResult, row: (typeof ROWS)[number]): string => {
    if (d.status === "") return "";
    switch (row) {
      case "Status": return d.status;
      case "InTime": return clock(d.inAt);
      case "OutTime": return clock(d.outAt);
      case "Duration": return duration(d.workedMinutes);
    }
  };
  return ROWS.map((row) => [row, ...p.days.map((d) => cell(d, row))]);
}

export function totalsLine(p: PersonMonth): string {
  const t = p.totals;
  return (
    `Total Work Duration: ${duration(t.workMinutes)} Hrs. Present: ${t.present} Absent: ${t.absent} ` +
    `Average Working Hrs: ${duration(t.averageMinutes)}`
  );
}

// --- Excel ---------------------------------------------------------------

export async function toExcel(report: MonthlyStatus, meta: RenderMeta): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Monthly Status", {
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  // At least 31 day columns, as the source report (and the PDF below) does.
  // The header places "Printed On" 7 columns from the right edge, so a range
  // under 8 days used to ask for a negative column and the download failed
  // (a 0.4.24 bug, found by the F3 e2e run on a one-day range).
  const lastCol = Math.max(31, report.days.length) + 1;
  sheet.columns = [{ width: 11 }, ...Array.from({ length: lastCol - 1 }, () => ({ width: 7 }))];
  const thin = { style: "thin" as const, color: { argb: "FF999999" } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const banner = (text: string, bold = false, size = 10) => {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, lastCol);
    row.getCell(1).font = { bold, size };
    row.getCell(1).alignment = { horizontal: "center" };
  };
  const labelled = (label: string, value: string, extra?: string) => {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    sheet.mergeCells(row.number, 2, row.number, extra ? Math.max(2, lastCol - 8) : lastCol);
    if (extra) {
      row.getCell(lastCol - 7).value = extra;
      sheet.mergeCells(row.number, lastCol - 7, row.number, lastCol);
      row.getCell(lastCol - 7).alignment = { horizontal: "right" };
    }
    return row;
  };

  banner(TITLE, true, 12);
  banner(rangeLabel(report));
  let company: string | null = null;
  let department: string | null = null;
  for (const p of report.people) {
    if (p.company !== company) {
      company = p.company;
      department = null;
      sheet.addRow([]);
      labelled("Company:", p.company, printedLabel(meta));
      const days = sheet.addRow(["Days", ...report.days.map(dayLabel)]);
      days.eachCell((c) => { c.border = box; c.font = { bold: true, size: 9 }; });
    }
    if (p.department !== department) {
      department = p.department;
      labelled("Department:", p.department);
    }
    const employee = labelled("Employee:", `${p.esslUserId} : ${p.name}`);
    employee.getCell(2).font = { bold: true };
    const totals = sheet.addRow(["", totalsLine(p)]);
    sheet.mergeCells(totals.number, 2, totals.number, lastCol);
    totals.getCell(2).alignment = { wrapText: true };
    for (const cells of gridRows(p)) {
      const row = sheet.addRow(cells);
      row.eachCell({ includeEmpty: true }, (c, col) => {
        if (col <= lastCol) c.border = box;
        c.font = { size: 9, bold: col === 1 };
      });
    }
    sheet.addRow([]);
  }
  sheet.addRow([`Generated By: ${meta.generatedBy}`]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// --- PDF -----------------------------------------------------------------

const PAGE = { width: 842, height: 595, margin: 20 }; // A4 landscape, points
const LABEL_W = 46;
const ROW_H = 12;

export function toPdf(report: MonthlyStatus, meta: RenderMeta): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: PAGE.margin, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Always 31 day columns, as the source report does, so a short range keeps
  // the familiar proportions.
  const dayW = (PAGE.width - 2 * PAGE.margin - LABEL_W) / Math.max(31, report.days.length);
  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const bottom = PAGE.height - PAGE.margin - 18;
  let y = 0;

  const grid = (cells: string[], top: number, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(6.5);
    doc.rect(left, top, right - left, ROW_H).lineWidth(0.4).strokeColor("#888888").stroke();
    cells.forEach((text, i) => {
      const x = i === 0 ? left : left + LABEL_W + (i - 1) * dayW;
      if (i > 0) doc.moveTo(x, top).lineTo(x, top + ROW_H).dash(1, { space: 1 }).stroke().undash();
      if (text) doc.fillColor("#000000").text(text, x + 1.5, top + 3, { width: (i === 0 ? LABEL_W : dayW) - 2, lineBreak: false });
    });
  };
  const header = (company: string) => {
    y = PAGE.margin;
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#000000").text(TITLE, left, y, { width: right - left, align: "center" });
    doc.font("Helvetica").fontSize(8).text(rangeLabel(report), left, y + 16, { width: right - left, align: "center" });
    y += 40;
    doc.font("Helvetica-Bold").fontSize(9).text("Company:", left, y);
    doc.font("Helvetica").text(company, left + 50, y);
    doc.fontSize(8).text(printedLabel(meta), left, y, { width: right - left, align: "right" });
    y += 13;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor("#000000").stroke();
    y += 6;
    grid(["Days", ...report.days.map(dayLabel)], y, true);
    y += ROW_H + 8;
  };
  const labelled = (label: string, value: string) => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000").text(label, left, y);
    doc.font("Helvetica").text(value, left + 70, y, { width: 150 });
  };

  const blockHeight = 3 * 9 + ROWS.length * ROW_H + 18;
  let company: string | null = null;
  let department: string | null = null;
  let first = true;
  for (const p of report.people) {
    const newCompany = p.company !== company;
    if (newCompany || y + blockHeight > bottom) {
      if (!first) doc.addPage();
      first = false;
      company = p.company;
      header(p.company);
      department = null;
    }
    if (p.department !== department) {
      department = p.department;
      labelled("Department:", p.department);
      y += 14;
    }
    labelled("Employee:", `${p.esslUserId} : ${p.name}`);
    doc.font("Helvetica").fontSize(7).text(totalsLine(p), left + 230, y, { width: right - left - 230 });
    y = Math.max(y + 12, doc.y) + 7;
    for (const cells of gridRows(p)) {
      grid(cells, y, false);
      y += ROW_H;
    }
    y += 10;
  }
  if (first) {
    header("—");
    doc.font("Helvetica").fontSize(9).text("No people match these filters.", left, y);
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // or writing the footer itself starts a new page
    const footerY = PAGE.height - PAGE.margin - 10;
    doc.moveTo(left, footerY - 4).lineTo(right, footerY - 4).lineWidth(0.6).strokeColor("#000000").stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#000000");
    doc.text(`Generated By: ${meta.generatedBy}`, left, footerY, { lineBreak: false });
    doc.text(`Page No  ${i + 1}`, left, footerY, { width: right - left, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}
