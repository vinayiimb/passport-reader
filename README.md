# Passport Reader

Reads a passport data page in the browser: OCR → MRZ (machine-readable zone) with ICAO 9303 check digits → fields ready to copy into a visa form (Excel/TSV, JSON, CSV).

**Nothing is uploaded.** OCR runs on the visitor's device with [Tesseract.js](https://github.com/naptha/tesseract.js); the page has no backend and no analytics.

## How it reads a passport

1. Full-page OCR (English model) for the printed fields: names, places, dates.
2. A second pass on the MRZ band with a model trained on the OCR-B font (`lang/mrz.traineddata.gz`, from [DoubangoTelecom/tesseractMRZ](https://github.com/DoubangoTelecom/tesseractMRZ), BSD-3-Clause, see `lang/LICENSE-mrz-traineddata.txt`).
3. `parser.js` picks the MRZ reading that passes the most check digits, and repairs a misread character only when exactly one correction satisfies the check digits. When the check digits allow several corrections, the copy of the number or date printed on the page decides. Names have no check digit, so a name that disagrees with the printed text is flagged.

The same `parser.js` is used by the macOS app (`~/MacApps/PassportReader`, via JavaScriptCore), so both read passports identically.

## Develop

```sh
python3 -m http.server 8791   # then open http://127.0.0.1:8791
node test.mjs                 # parser tests; SWIFT_BIN=<mac app binary> also checks the Mac app gives identical output
```

`fixtures/` holds synthetic passports (made-up people) and real OCR output used by the tests.
