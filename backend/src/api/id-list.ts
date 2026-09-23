import ExcelJS from "exceljs";
import { parseUserId, userIdKey } from "../user-id.js";

// Reading a list of device user IDs out of whatever a site hands over.
//
// The IDs already exist somewhere — in the attendance software the terminal
// was previously attached to, in a spreadsheet somebody keeps, in an email.
// That export is a far better source than any scan: it is complete, it takes
// minutes, and it needs no guessing about numbering. So the job here is to
// accept the file as it arrives rather than dictating a format.
//
// Everything converges on one shape: a list of validated IDs plus what was
// rejected and why. The operator sees both before a single command is queued,
// because a scan commits the device's command queue for a long time and
// "it found nobody" is a miserable way to learn the file was wrong.

export interface IdListResult {
  ids: string[];
  /** Values that were not usable IDs, capped — enough to see the pattern. */
  rejected: string[];
  /** Rows read, before validation and de-duplication. */
  read: number;
}

const MAX_REJECTED_SHOWN = 20;

/**
 * Take the first field of every row. One ID per line, first column of a
 * spreadsheet — the only convention that cannot be got wrong by a
 * non-technical person, and a header row simply fails validation and is
 * reported as rejected rather than silently scanned for.
 */
function collect(values: string[]): IdListResult {
  const seen = new Set<string>();
  const ids: string[] = [];
  const rejected: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const id = parseUserId(trimmed);
    if (id === null) {
      if (rejected.length < MAX_REJECTED_SHOWN) rejected.push(trimmed);
      continue;
    }
    // De-duplicated case-insensitively: an export routinely repeats an ID, and
    // asking the terminal the same question twice is queue time somebody at
    // the barrier is waiting on.
    if (seen.has(userIdKey(id))) continue;
    seen.add(userIdKey(id));
    ids.push(id);
  }
  return { ids, rejected, read: values.filter((v) => v.trim() !== "").length };
}

/** Pasted text, CSV or TXT: one ID per line, first column if separated. */
export function parseIdListText(text: string): IdListResult {
  const rows = text.split(/\r?\n/).map((line) => {
    const first = line.split(/[,;\t]/)[0] ?? "";
    // Excel quotes any field it feels like quoting.
    return first.replace(/^"|"$/g, "");
  });
  return collect(rows);
}

/** XLSX: worksheet 1, column A. */
export async function parseIdListXlsx(buffer: Buffer): Promise<IdListResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { ids: [], rejected: [], read: 0 };

  const rows: string[] = [];
  sheet.eachRow((row) => {
    const cell = row.getCell(1).value;
    if (cell === null || cell === undefined) return;
    // A cell holding `WCTPL070` is a string; one holding `1001` is a number,
    // and a formula cell is an object carrying its result. All three are
    // ordinary in an export nobody prepared for us.
    if (typeof cell === "object" && "result" in cell) {
      rows.push(String((cell as { result: unknown }).result ?? ""));
    } else {
      rows.push(String(cell));
    }
  });
  return collect(rows);
}

/** Dispatch on the uploaded filename; anything not .xlsx is read as text. */
export async function parseIdList(fileName: string, body: Buffer): Promise<IdListResult> {
  return /\.xlsx$/i.test(fileName)
    ? parseIdListXlsx(body)
    : parseIdListText(body.toString("utf8"));
}
