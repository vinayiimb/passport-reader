// Passport text → fields. Port of PassportReader/main.swift's parser; runs in the browser and in Node (test.mjs).

// MARK: dates (all UTC so a birthday never shifts by a day)

const pad = (n, w = 2) => String(n).padStart(w, "0");
const ymd = (y, m, d) => ({ y, m, d, display: `${pad(d)}/${pad(m)}/${pad(y, 4)}`, iso: `${pad(y, 4)}-${pad(m)}-${pad(d)}`, date: new Date(Date.UTC(y, m - 1, d)) });

/** Rejects impossible dates such as 31/02. */
function valid(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? ymd(y, m, d) : null;
}

function mrzDate(s, expiry, now) {
  if (!/^\d{6}$/.test(s)) return null;
  const yy = +s.slice(0, 2), cur = now.getUTCFullYear() % 100;
  return valid(expiry ? 2000 + yy : yy > cur ? 1900 + yy : 2000 + yy, +s.slice(2, 4), +s.slice(4, 6));
}

function addYears(dt, years, days = 0) {
  const t = new Date(dt);
  t.setUTCFullYear(t.getUTCFullYear() + years);
  t.setUTCDate(t.getUTCDate() + days);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole years/months/days from a to b (a <= b), like Calendar.dateComponents. */
function diff(a, b) {
  let y = b.getUTCFullYear() - a.getUTCFullYear(), m = b.getUTCMonth() - a.getUTCMonth(), d = b.getUTCDate() - a.getUTCDate();
  if (d < 0) { m--; d += new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate(); }
  if (m < 0) { y--; m += 12; }
  return { y, m, d };
}

// MARK: text helpers

const groups = (s, re) => { const m = re.exec(s); return m ? [...m].map(x => x ?? "") : null; };

/** "भारतीय / INDIAN" -> "INDIAN" (bilingual values keep the Latin part). */
function cleanValue(v) {
  let s = v.trim();
  if (/[^\x00-\x7F]/.test(s)) s = s.split("/").pop();
  return s.trim();
}

const labelWords = ["nationality", "date of", "place of", "passport no", "surname", "sumame", "given name", "republic", "name of",
  "address", "father", "mother", "spouse", "file no", "old passport", "country", "guardian"];

/** Label matching ignores spacing and the l/I mix-up OCR makes ("DateofExpiry", "Place of lssue"). */
const squash = s => s.toLowerCase().replace(/[^a-z]/g, "").replace(/l/g, "i");
const hasKey = (line, key) => squash(line).includes(squash(key));

const isLabel = line => labelWords.some(w => hasKey(line, w)) || /\b(sex|type|code)\b/.test(line.toLowerCase());

/** First plausible value line after a line containing one of `keys` (labels in between are skipped). */
function after(lines, keys, accept, span = 4) {
  for (let i = 0; i < lines.length; i++) {
    if (!keys.some(k => hasKey(lines[i], k))) continue;
    for (let j = i + 1; j < Math.min(i + 1 + span, lines.length); j++) {
      const v = lines[j];
      if (isLabel(v) || v.includes("<")) continue;
      if (accept(v)) return v;
    }
  }
  return null;
}

const datePattern = /(\d{2})\s*[\/.\-]\s*(\d{2})\s*[\/.\-]\s*(\d{4}|[A-Za-z?*]{4})/;
const hasLetters = n => s => new RegExp(`[A-Za-z]{${n}}`).test(s);

/**
 * {d, m, y|null} — y is null when the OCR could not read the year (e.g. "YYYY").
 * When labels share a row ("Date of Issue / Date of Expiry"), the value row holds both dates in the same order.
 */
function printedDate(lines, key) {
  const line = after(lines, [key], s => datePattern.test(s));
  if (!line) return null;
  const label = squash(lines.slice(0, lines.indexOf(line)).reverse().find(l => hasKey(l, key)) ?? "");
  const nth = (label.slice(0, label.indexOf(squash(key))).match(/dateof/g) || []).length;
  const all = [...line.matchAll(new RegExp(datePattern, "g"))];
  const g = all[nth] ?? all[0];
  return { d: +g[1], m: +g[2], y: /^\d{4}$/.test(g[3]) ? +g[3] : null };
}

// MARK: MRZ (the two machine-readable lines at the bottom of the data page)

const digitFix = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
const alphaFix = { 0: "O", 1: "I", 2: "Z", 5: "S", 8: "B" };
const fixDigits = s => [...s].map(c => digitFix[c] ?? c).join("");
const fixAlpha = s => [...s].map(c => alphaFix[c] ?? c).join("");

/** ICAO 9303 check digit: weights 7,3,1; digits as is, A–Z = 10–35, '<' = 0. */
export function checkDigit(s) {
  let t = 0;
  [...s].forEach((c, i) => {
    const v = /\d/.test(c) ? +c : /[A-Z]/.test(c) ? c.charCodeAt(0) - 55 : 0;
    t += v * [7, 3, 1][i % 3];
  });
  return t % 10;
}

// Line-2 fields as [start, end) plus check-digit position; `alnum` fields may hold letters.
const FIELDS = { number: [0, 9, 9, true], dob: [13, 19, 19, false], expiry: [21, 27, 27, false], personal: [28, 42, 42, true] };
const DIGIT_POS = [9, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 42, 43];

const fieldOK = (b, [s, e, c], key) => {
  const f = b.slice(s, e);
  if (key === "personal" && /^<+$/.test(f)) return b[c] === "<" || b[c] === "0";
  if ((key === "dob" || key === "expiry") && !mrzDate(f, key === "expiry", new Date())) return false;
  return String(checkDigit(f)) === b[c];
};
const compositeOK = b => String(checkDigit(b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 43))) === b[43];

// Characters OCR typically confuses, used to repair a field whose check digit fails.
const ALNUM_ALT = { O: "0", 0: "OD", Q: "0", D: "0", I: "1", 1: "I7", L: "1", Z: "2", 2: "Z", S: "5", 5: "S6", B: "8", 8: "B3", G: "6", 6: "G5", K: "<", "<": "K" };
const DIGIT_ALT = { 0: "869", 1: "74", 2: "7", 3: "85", 4: "1", 5: "638", 6: "580", 7: "12", 8: "36095", 9: "80" };

/** Single-character fixes that make the field's own check digit pass. */
function fieldRepairs(b, key) {
  const [s, e, c, alnum] = FIELDS[key], out = [];
  for (let i = s; i <= c; i++) {
    const alts = (i < e && alnum ? ALNUM_ALT[b[i]] ?? "" : "") + (DIGIT_ALT[b[i]] ?? "");
    for (const a of alts ?? "") {
      const v = b.slice(0, i) + a + b.slice(i + 1);
      if (fieldOK(v, FIELDS[key], key)) out.push(v.slice(s, c + 1));
    }
  }
  return out;
}

/**
 * Repairs misread characters only when exactly one combination also satisfies the composite check digit.
 * The composite weights the number exactly like the number's own check, so it can't separate number candidates;
 * `printed` (all page text, letters/digits only) breaks such ties when the printed number or date matches one candidate.
 */
function repairLine2(b, ok, printed = "") {
  const bad = Object.keys(FIELDS).filter(k => !ok[k]);
  if (!bad.length || bad.length > 2) return null;
  let combos = [b];
  for (const k of bad) {
    const [s, , c] = FIELDS[k];
    combos = combos.flatMap(x => fieldRepairs(x, k).map(r => x.slice(0, s) + r + x.slice(c + 1)));
  }
  const seenPrinted = x => bad.every(k => {
    if (k === "number") return printed.includes(x.slice(0, 9).replace(/</g, ""));
    const d = k === "dob" || k === "expiry" ? mrzDate(x.slice(...FIELDS[k]), k === "expiry", new Date()) : null;
    return d ? printed.includes(d.display.replace(/\//g, "")) : false;
  });
  const unique = list => list.length > 1 && list.filter(seenPrinted).length === 1 ? list.filter(seenPrinted) : list;
  let fixed = bad, good = unique([...new Set(combos)].filter(compositeOK));
  if (!good.length) {   // the composite digit itself may be misread too
    good = unique([...new Set(combos.flatMap(x => [...(DIGIT_ALT[x[43]] ?? "")].map(d => x.slice(0, 43) + d)))].filter(compositeOK));
    fixed = [...bad, "composite"];
  }
  return good.length === 1 ? { line: good[0], fixed } : null;
}

function normalize(line) {
  return line.toUpperCase().replace(/«/g, "<<").replace(/\s+/g, "");
}

export function parseMRZ(l1, l2, now = new Date(), printed = "") {
  const a = (l1 + "<".repeat(44)).slice(0, 44);
  let b = (l2 + "<".repeat(44)).slice(0, 44);
  // An empty personal number is all '<' filler, which OCR often reads as K/L/C/E/Z/S runs; no digits there means filler.
  if (/^[<KLCEZS]+$/.test(b.slice(28, 43)) && b.slice(28, 43).includes("<")) b = b.slice(0, 28) + "<".repeat(15) + b.slice(43);
  b = [...b];
  for (const i of DIGIT_POS) if (b[i] !== "<") b[i] = digitFix[b[i]] ?? b[i];
  for (const i of [10, 11, 12, 20]) b[i] = alphaFix[b[i]] ?? b[i];
  b = b.join("");

  const checks = line => ({
    number: fieldOK(line, FIELDS.number, "number"), dob: fieldOK(line, FIELDS.dob, "dob"),
    expiry: fieldOK(line, FIELDS.expiry, "expiry"), personal: fieldOK(line, FIELDS.personal, "personal"), composite: compositeOK(line),
  });
  let ok = checks(b), fixed = [];
  if (!ok.composite) {
    const r = repairLine2(b, ok, printed);
    if (r) { b = r.line; fixed = r.fixed; ok = checks(b); }
  }

  // Names never contain "<<<", so everything from there on is filler (even if OCR read some '<' as 'K').
  const names = a.slice(5).split("<<<")[0].split("<<").filter(Boolean);
  const name = s => (s ?? "").replace(/</g, " ").trim();
  return {
    docType: a.slice(0, 2).replace(/</g, ""), country: fixAlpha(a.slice(2, 5)),
    surname: name(names[0]), given: names.slice(1).map(name).join(" ").trim(),
    number: b.slice(0, 9).replace(/</g, ""), nationality: b.slice(10, 13), sex: b[20],
    personal: b.slice(28, 42).replace(/</g, ""),
    dob: mrzDate(b.slice(13, 19), false, now), expiry: mrzDate(b.slice(21, 27), true, now),
    ok, fixed, line1: a, line2: b,
  };
}

// Names have no check digit, so line 1 is only trusted when shaped like SURNAME<<GIVEN<NAMES<<<… : letters only,
// no run of 4 identical letters (filler misread as LLLL), and mostly '<' after the names (a few misread K/L allowed).
const wellFormedNames = {
  test(s) {
    const k = s.indexOf("<<<"), head = k < 0 ? s : s.slice(0, k), tail = k < 0 ? "" : s.slice(k);
    if (k < 0 && head.length < 37) return false;
    return /^[A-Z]+(<[A-Z]+)*(<<[A-Z]+(<[A-Z]+)*)?<{0,2}$/.test(head) && !/([A-Z])\1{3}/.test(head)
      && (tail.match(/</g) || []).length >= tail.length * 0.6;
  },
};

/**
 * Best (line 1, line 2) pair: line 1 starts "P" + type/filler, line 2 is ~44 chars with digits; scored by passing check digits.
 * Line 2 alone is accepted when its composite check passes — it carries number, birth, sex and expiry; names then come from the printed text.
 */
export function findMRZ(rawLines, now = new Date()) {
  const lines = rawLines.map(normalize);
  const printed = rawLines.join(" ").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const firsts = lines.flatMap((l, i) => {
    let at = l.search(/P[A-Z<][A-Z<]{3}/);   // tolerate a stray character or two OCR adds in front…
    if (at > 2) at = -1;                       // …but not a "P" inside a name ("…<<PRIYA")
    if ((at < 0 && !l.includes("<<")) || l.length - Math.max(at, 0) < 25) return [];
    const l1 = at >= 0 ? l.slice(at) : "P" + l.slice(1);   // no "P" found: only trusted directly above line 2 (checked below)
    // Also try without one stray character in the header ("P<TINDSMITH" → "P<INDSMITH").
    return [l1, ...[1, 2, 3, 4, 5].map(k => l1.slice(0, k) + l1.slice(k + 1))]
        .filter(v => wellFormedNames.test((v + "<".repeat(44)).slice(5, 44))).map(l1 => ({ i, l1, guessed: at < 0 }));
  });
  let best = null;
  lines.forEach((l2, j) => {
    if (l2.length < 40 || l2.length > 46 || (l2.match(/\d/g) || []).length < 10) return;
    for (const { i, l1, guessed } of [...firsts.filter(f => f.i !== j), { i: -1, l1: "" }]) {
      if (guessed && j !== i + 1) continue;
      const m = parseMRZ(l1, l2, now, printed);
      if (i < 0 && !m.ok.composite) continue;
      // Issuing country should equal nationality; one misread letter is tolerated only for the line directly above.
      const off = [...m.country].filter((c, k) => c !== m.nationality[k]).length;
      if (i >= 0 && off > (j === i + 1 ? 1 : 0)) continue;
      if (off) m.country = m.nationality;
      const score = Object.values(m.ok).filter(Boolean).length * 10 - m.fixed.length - (j === i + 1 ? 0 : 1) - (i < 0 ? 5 : 0);
      if (!best || score > best.score) best = { m, score };
    }
  });
  return best?.m ?? null;
}

// MARK: parsing

export function parsePassport(text, now = new Date()) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const rows = [];
  const add = (key, label, value, note = "", iso = null) => { if (value) rows.push({ key, label, value, note, iso }); };
  const note = ok => ok == null ? "MRZ" : ok ? "MRZ ✓ check digit OK" : "MRZ ✗ check digit failed — verify";
  const noteFor = (mrz, k) => mrz.fixed.includes(k) ? "MRZ ✓ auto-corrected a misread character — verify" : note(mrz.ok[k]);

  const mrz = findMRZ(lines, now);
  const vzSurname = after(lines, ["surname", "sumame"], hasLetters(2));
  const vzGiven = after(lines, ["given name"], hasLetters(2));
  const vzNumber = after(lines, ["passport no"], s => /^[A-Z0-9]{7,9}$/.test(s.toUpperCase()))?.toUpperCase();
  const vzNationality = after(lines, ["nationality"], hasLetters(3))?.match(/[A-Za-z]{3,}(?: [A-Za-z]{3,})*/)?.[0];
  const vzSex = after(lines, ["sex"], s => /^[MFX]$/.test(s.toUpperCase()), 2)?.toUpperCase();
  const notDate = s => hasLetters(3)(s) && !datePattern.test(s);
  const vzPOB = after(lines, ["place of birth"], notDate);
  const vzPOI = after(lines, ["place of issue"], notDate);
  const vzDOB = printedDate(lines, "date of birth");
  const vzExpiry = printedDate(lines, "date of expiry");
  const vzIssue = printedDate(lines, "date of issue");

  // MRZ names win (fixed font, no layout guessing) but carry no check digit, so a disagreeing printed name is flagged.
  const nameRow = (key, label, fromMRZ, printed) => {
    const p = printed && cleanValue(printed), letters = s => s.toUpperCase().replace(/[^A-Z]/g, "");
    if (!fromMRZ) return add(key, label, p, "printed");
    const agrees = !p || letters(p).startsWith(letters(fromMRZ));   // the MRZ may truncate long names
    add(key, label, fromMRZ, agrees ? "MRZ" : `MRZ — printed text reads ${p}, check`);
  };
  nameRow("surname", "Surname", mrz?.surname, vzSurname);
  nameRow("given_names", "Given name(s)", mrz?.given, vzGiven);
  add("passport_number", "Passport number", mrz?.number || vzNumber,
    mrz ? (vzNumber && vzNumber !== mrz.number ? `MRZ — printed text reads ${vzNumber}, check` : noteFor(mrz, "number")) : "printed");
  if (mrz?.docType) add("document_type", "Document type", mrz.docType.startsWith("P") ? `${mrz.docType} — Passport` : mrz.docType, "MRZ");
  const natCode = mrz?.nationality.replace(/</g, "") || mrz?.country.replace(/</g, "");
  add("nationality", "Nationality", [vzNationality && cleanValue(vzNationality), natCode && `(${natCode})`].filter(Boolean).join(" "),
    natCode ? "MRZ" : "printed");

  // Date of birth
  let dob = mrz?.dob ?? null, dobNote = mrz ? noteFor(mrz, "dob") : "MRZ";
  if (!dob && vzDOB?.y) { dob = valid(vzDOB.y, vzDOB.m, vzDOB.d); dobNote = "printed"; }
  else if (dob && vzDOB?.y && (vzDOB.y !== dob.y || vzDOB.m !== dob.m || vzDOB.d !== dob.d))
    dobNote += ` · printed text reads ${pad(vzDOB.d)}/${pad(vzDOB.m)}/${vzDOB.y}`;
  add("date_of_birth", "Date of birth", dob?.display, dobNote, dob?.iso);
  if (dob) add("age", "Age", `${diff(dob.date, now).y} years`, "calculated");
  const sex = (mrz?.sex && mrz.sex !== "<" ? mrz.sex : null) ?? vzSex;
  add("sex", "Sex", sex && ({ M: "Male (M)", F: "Female (F)", X: "Unspecified (X)" }[sex] ?? sex), mrz?.sex && mrz.sex !== "<" ? "MRZ" : "printed");

  add("place_of_birth", "Place of birth", vzPOB && cleanValue(vzPOB), "printed");
  add("place_of_issue", "Place of issue", vzPOI && cleanValue(vzPOI), "printed");

  // Date of expiry and date of issue
  let expiry = mrz?.expiry ?? null, expNote = mrz ? noteFor(mrz, "expiry") : "MRZ";
  if (!expiry && vzExpiry?.y) { expiry = valid(vzExpiry.y, vzExpiry.m, vzExpiry.d); expNote = "printed"; }
  let issue = null, issueNote = "printed";
  if (vzIssue?.y && valid(vzIssue.y, vzIssue.m, vzIssue.d)) issue = valid(vzIssue.y, vzIssue.m, vzIssue.d);
  else if (expiry) {
    // Printed year unreadable: issue date = expiry − validity + 1 day (10 years for adults, 5 for minors).
    const cands = [10, 5].map(y => addYears(expiry.date, -y, 1));
    const hit = vzIssue && cands.find(c => c.d === vzIssue.d && c.m === vzIssue.m);
    const seen = !hit && cands.find(c => text.includes(c.display));   // label unreadable, but that exact date is printed
    issue = hit ?? seen ?? cands[0];
    issueNote = hit ? "inferred from expiry (printed day/month match)" : seen ? "printed (matches expiry − validity)"
      : "inferred from expiry (assumes 10-year validity) — verify";
  }
  add("date_of_issue", "Date of issue", issue?.display, issueNote, issue?.iso);
  add("date_of_expiry", "Date of expiry", expiry?.display, expNote, expiry?.iso);
  if (expiry) {
    let status;
    if (expiry.date < now) status = "Expired";
    else {
      const c = diff(now, expiry.date), months = c.y * 12 + c.m;
      status = `Valid — ${c.y} yr ${c.m} mo left` + (months >= 6 ? " (meets 6-month travel rule)" : " (under 6 months — many countries refuse entry)");
    }
    add("validity", "Validity", status, "calculated");
  }
  if (mrz) add("personal_number", "Personal / file no. (MRZ)", mrz.personal, noteFor(mrz, "personal"));

  // Back page (Indian passports): family names, address, old passport
  const person = hasLetters(3);
  const v = s => s && cleanValue(s);
  add("father", "Father / legal guardian", v(after(lines, ["name of father", "father"], person)), "printed");
  add("mother", "Mother", v(after(lines, ["name of mother", "mother"], person)), "printed");
  add("spouse", "Spouse", v(after(lines, ["name of spouse", "spouse"], person)), "printed");
  const ai = lines.findIndex(l => l.toLowerCase().includes("address"));
  if (ai >= 0) {
    const addr = [];
    for (const l of lines.slice(ai + 1, ai + 6)) {
      if (isLabel(l)) break;
      addr.push(cleanValue(l));
      if (/\b\d{6}\b/.test(l)) break;
    }
    add("address", "Address", addr.join(", "), "printed");
  }
  add("old_passport", "Old passport no.", after(lines, ["old passport"], s => /[A-Z0-9]{7,9}/.test(s.toUpperCase())), "printed");

  let summary;
  if (mrz) {
    const passed = Object.values(mrz.ok).filter(Boolean).length, total = Object.keys(mrz.ok).length;
    summary = `MRZ found · ${passed}/${total} check digits pass`;
    if (mrz.fixed.length) summary += " (after auto-correcting a misread character)";
    if (passed < total) summary += " — some characters may be misread, review ✗ rows";
  } else {
    summary = "No MRZ (bottom two lines) found — values come from printed text only; include the bottom of the page for verified results";
  }
  if (!rows.length) summary = "Nothing recognised — is this the data page of a passport?";
  return { rows, summary, mrz };
}

// MARK: export

export function toJSON(rows) {
  const d = {};
  for (const r of rows) { d[r.key] = r.value; if (r.iso) d[r.key + "_iso"] = r.iso; }
  return JSON.stringify(Object.fromEntries(Object.entries(d).sort()), null, 2);
}

export function toCSV(rows) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  return ["Field,Value,Source", ...rows.map(r => `${q(r.label)},${q(r.value)},${q(r.note)}`)].join("\n");
}

export const toTSV = rows => rows.map(r => `${r.label}\t${r.value}`).join("\n");
