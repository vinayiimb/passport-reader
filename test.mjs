// node test.mjs — parser checks; also diffs against the Mac app (`--text` mode) when SWIFT_BIN is set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parsePassport, checkDigit, toCSV } from "./parser.js";

const now = new Date(Date.UTC(2026, 9, 28));
const L1 = "P<INDSHARMA<<RAHUL<KUMAR<<<<<<<<<<<<<<<<<<<<";
const L2 = "K1234567<6IND9008157M2803098<<<<<<<<<<<<<<<2";
const field = (r, k) => r.rows.find(x => x.key === k)?.value;
const noteOf = (r, k) => r.rows.find(x => x.key === k)?.note;

// ICAO 9303 specimen check digits
assert.equal(checkDigit("L898902C3"), 6);
assert.equal(checkDigit("740812"), 2);

// Clean MRZ: every check passes
let r = parsePassport(`${L1}\n${L2}`, now);
assert.match(r.summary, /5\/5/);
assert.equal(field(r, "surname"), "SHARMA");
assert.equal(field(r, "given_names"), "RAHUL KUMAR");
assert.equal(field(r, "date_of_birth"), "15/08/1990");
assert.equal(field(r, "age"), "36 years");
assert.equal(field(r, "date_of_expiry"), "09/03/2028");

// One misread digit in the DOB (5 → 6) is repaired via the composite check
r = parsePassport(`${L1}\n${L2.replace("9008157", "9008167")}`, now);
assert.equal(field(r, "date_of_birth"), "15/08/1990");
assert.match(noteOf(r, "date_of_birth"), /auto-corrected/);
assert.match(r.summary, /5\/5/);

// Letter/digit confusion in the passport number (1 → I) is repaired
r = parsePassport(`${L1}\n${L2.replace("K1234567", "KI234567")}`, now);
assert.equal(field(r, "passport_number"), "K1234567");

// Two misread fields with several equally valid fixes: never guess, leave them flagged ✗
r = parsePassport(`${L1}\n${L2.replace("K1234567", "KI234567").replace("280309", "280809")}`, now);
assert.match(noteOf(r, "date_of_expiry"), /✗/);

// Tesseract-style noise: '<' read as 'K' / '«', spaces inside the lines, a stray char before "P<", diplomatic "PD" type
r = parsePassport(`.PDINDSHARMA<<RAHUL<KUMAR«<KK<<K<<<<<<<<<<KK\nK1234567<6IND 9008157M2803098<<<<KKK<<<<<<<<2`, now);
assert.equal(field(r, "given_names"), "RAHUL KUMAR");
assert.equal(field(r, "document_type"), "PD — Passport");
assert.match(r.summary, /5\/5/);

// No MRZ: printed fields only; issue date inferred from expiry when the printed year is unreadable
r = parsePassport("Surname\nSHARMA\nDate of Issue\n10/03/YYYY\nDate of Expiry\n09/03/2028", now);
assert.equal(field(r, "surname"), "SHARMA");
assert.equal(field(r, "date_of_issue"), "10/03/2018");
assert.match(noteOf(r, "date_of_issue"), /printed day\/month match/);

// Expired / under-6-months validity
r = parsePassport(`${L1}\n${"K1234567<6IND9008157M2701015<<<<<<<<<<<<<<<6"}`, now);
assert.ok(field(r, "validity").startsWith("Valid") || field(r, "validity") === "Expired");

// Real Vision OCR output of the synthetic passport image (fixtures/)
const vision = readFileSync(new URL("./fixtures/vision_synthetic.txt", import.meta.url), "utf8");
r = parsePassport(vision, now);
assert.equal(field(r, "place_of_birth"), "DELHI");
assert.equal(field(r, "nationality"), "INDIAN (IND)");

// Real Tesseract output of the tilted, blurred photo: line 1 is garbled, '<' filler read as 'L'.
// Line 2 alone still verifies number/birth/expiry; names come from the printed text.
const tess = readFileSync(new URL("./fixtures/tesseract_photo.txt", import.meta.url), "utf8");
r = parsePassport(tess, now);
assert.match(r.summary, /5\/5/);
assert.equal(field(r, "surname"), "SHARMA");
assert.equal(noteOf(r, "surname"), "printed");
assert.equal(field(r, "given_names"), "RAHUL KUMAR");
assert.equal(noteOf(r, "date_of_birth"), "MRZ ✓ check digit OK");
assert.equal(field(r, "nationality"), "INDIAN (IND)");

// A garbled line 1 whose country disagrees with line 2 must not supply names
r = parsePassport(`Surname\nSHARMA\nP<XYZSHRRMA<<RRHUL<<<<<<<<<<<<<<<<<<<<<<<<<<<\n${L2}`, now);
assert.equal(field(r, "surname"), "SHARMA");

// MRZ-model output from the tilted Indian-style photo: "P" read as "D", "I" as "T", 9→0 in the number, 8→6 in the composite digit
const indianMRZ = "D<TNDVERMA<<PRIYA<ANAND<<<<<<<<<<<<<<<<<<<<<\nV0876543<1IND0111023F3107140<<<<<<<<<<<<<<<6";
r = parsePassport(indianMRZ, now);
assert.match(noteOf(r, "passport_number"), /✗/);   // several numbers fit the check digits and nothing printed to choose by
r = parsePassport(`Type Country Code Passport No.\nP IND V9876543\n${indianMRZ}`, now);
assert.equal(field(r, "passport_number"), "V9876543");
assert.match(noteOf(r, "passport_number"), /auto-corrected/);
assert.equal(field(r, "surname"), "VERMA");
assert.equal(field(r, "given_names"), "PRIYA ANAND");
assert.equal(field(r, "sex"), "Female (F)");

// Indian layout: labels share rows, so value rows carry several columns
r = parsePassport("Nationality / Sex / Date of Birth\nINDIAN F 02/11/2001\nDate of Issue / Date of Expiry\n15/07/2021 14/07/2031", now);
assert.equal(field(r, "nationality"), "INDIAN");
assert.equal(field(r, "date_of_issue"), "15/07/2021");
assert.equal(field(r, "date_of_expiry"), "14/07/2031");
assert.equal(field(r, "date_of_birth"), "02/11/2001");

// Vision-style garbled labels: "DateofExpiry", "Place of lssue", issue label unreadable but its date is printed
r = parsePassport("Place of lssue\nJAIPUR\nfDateoIssu\n15/07/2021\nDateofExpiry\n14/07/2031", now);
assert.equal(field(r, "place_of_issue"), "JAIPUR");
assert.equal(field(r, "date_of_expiry"), "14/07/2031");
assert.equal(field(r, "date_of_issue"), "15/07/2021");
assert.match(noteOf(r, "date_of_issue"), /^printed/);

// Parity with the Mac app on the same text (its clock is real "now", so compare on today's date)
if (process.env.SWIFT_BIN) {
  for (const text of [vision, `${L1}\n${L2}`]) {
    const swift = execFileSync(process.env.SWIFT_BIN, ["--text"], { input: text }).toString().trim();
    const js = parsePassport(text);
    assert.equal(`${js.summary}\n${toCSV(js.rows)}`, swift);
  }
  console.log("parity with Mac app: ok");
}
console.log("all parser tests passed");
