/**
 * Wedding address collector: Google Apps Script backend
 * -----------------------------------------------------
 * Receives submissions from the address form (index.html) and writes one row per
 * guest to the "Guests" tab of the Google Sheet this script is bound to.
 * Every field gets its own column.
 *
 * Spouse / partner: when a guest adds their partner, the partner gets their own row
 * right below, with the same address, phone, email and timestamp. The two rows don't
 * flag each other as duplicates, and each First Name cell gets a note naming the other
 * person, so the pairing is visible without any extra column.
 *
 * One-time setup (full steps in README.md):
 *   1. In your Google Sheet: Extensions → Apps Script. Replace the starter code with this file. Save.
 *   2. Select `setup` in the function dropdown → Run → approve the permissions prompt.
 *   3. Deploy → New deployment → type "Web app"
 *        Execute as: Me      Who has access: Anyone
 *      Copy the Web app URL (ends in /exec) into WEDDING_CONFIG.endpoint in index.html.
 *
 * After you edit this file, publish the change with:
 *   Deploy → Manage deployments → ✏️ (edit) → Version: "New version" → Deploy
 * The /exec URL stays the same.
 *
 * Design rules:
 *   - Never lose a real guest's submission. Odd-looking data is saved and flagged in the
 *     "Review" column (and highlighted) instead of being rejected.
 *   - Every text field is stored as literal text, so ZIP codes keep their leading zero
 *     (07302), "+44 …" phones aren't read as formulas, and "3-4" isn't turned into a date.
 *   - Columns are found by header name, so you can reorder them or add your own columns
 *     (e.g. "Save-the-date sent"). Don't rename these headers. If one goes missing,
 *     it's re-added at the end.
 */

const SHEET_NAME = 'Guests';
const FILTERED_SHEET_NAME = 'Filtered';
const DATE_FORMAT = 'yyyy-mm-dd h:mm am/pm';
const MAX_PAYLOAD_BYTES = 20000;

const COLUMNS = [
  { key: 'submitted', header: 'Submitted',         width: 150 },
  { key: 'firstName', header: 'First Name',        width: 120 },
  { key: 'lastName',  header: 'Last Name',         width: 130 },
  { key: 'street',    header: 'Street Address',    width: 230 },
  { key: 'apt',       header: 'Apt / Unit',        width: 90 },
  { key: 'city',      header: 'City',              width: 140 },
  { key: 'region',    header: 'State / Region',    width: 115 },
  { key: 'postal',    header: 'ZIP / Postal Code', width: 125 },
  { key: 'country',   header: 'Country',           width: 130 },
  { key: 'phone',     header: 'Phone',             width: 150 },
  { key: 'email',     header: 'Email',             width: 220 },
  { key: 'review',    header: 'Review',            width: 280 },
];

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY', 'PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP',
];

// Used only to spot duplicate addresses ("123 Main Street" == "123 main st.").
const STREET_WORDS = {
  street: 'st', str: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd',
  lane: 'ln', court: 'ct', place: 'pl', terrace: 'ter', circle: 'cir', parkway: 'pkwy',
  highway: 'hwy', square: 'sq', trail: 'trl', mount: 'mt', saint: 'st', fort: 'ft',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};


/* ───────────────────────────── Web app entry points ───────────────────────────── */

function doPost(e) {
  let lock = null;
  try {
    const data = parsePayload_(e);
    const size = (e && e.postData && e.postData.length) || 0;
    const ss = getSpreadsheet_();

    lock = LockService.getScriptLock();
    lock.waitLock(25000);

    if (size > MAX_PAYLOAD_BYTES) {
      logFiltered_(ss, 'too large', { bytes: size });
      return json_({ ok: false, error: 'too_large' });
    }
    // Hidden "website" field: people never see it, bots fill it in. Logged, not deleted.
    if (data.website) {
      logFiltered_(ss, 'honeypot', data);
      return json_({ ok: true });
    }

    const rec = normalize_(data);
    if (!rec.firstName && !rec.lastName && !rec.street) {
      logFiltered_(ss, 'empty', data);
      return json_({ ok: false, error: 'empty' });
    }

    const partner = partnerRecord_(rec, data);

    const sheet = getGuestSheet_(ss);
    const map = ensureHeaders_(sheet);
    const block = readBlock_(sheet, map);
    const now = new Date();

    // Both rows are checked against rows that existed before this submission,
    // so a guest and their partner never flag each other as duplicates.
    rec.review = reviewFor_(rec, block, map);
    if (partner) partner.review = reviewFor_(partner, block, map);

    writeRecord_(sheet, map, block.nextRow, rec, now);
    if (partner) {
      writeRecord_(sheet, map, block.nextRow + 1, partner, now);
      noteHousehold_(sheet, map, block.nextRow, rec, partner);
    }
    SpreadsheetApp.flush();
    return json_({ ok: true, rows: partner ? 2 : 1 });
  } catch (err) {
    console.error('doPost failed: ' + (err && err.stack ? err.stack : err));
    return json_({ ok: false, error: 'server' });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (ignored) { /* lock was never acquired */ }
    }
  }
}

// Visiting the /exec URL in a browser confirms the deployment is live. Never returns guest data.
function doGet() {
  return json_({ ok: true, message: 'Wedding address endpoint is live.' });
}


/* ───────────────────────────── Setup & manual tests ───────────────────────────── */

/** Run once from the Apps Script editor. Safe to re-run. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Open this script from your Google Sheet (Extensions → Apps Script), then run setup() again.');
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    const sheets = ss.getSheets();
    const onlyBlank = sheets.length === 1 && sheets[0].getLastRow() === 0 && sheets[0].getLastColumn() === 0;
    sheet = onlyBlank ? sheets[0].setName(SHEET_NAME) : ss.insertSheet(SHEET_NAME, 0);
  }
  props.setProperty('GUESTS_SHEET_ID', String(sheet.getSheetId()));

  const map = ensureHeaders_(sheet);
  formatSheet_(sheet, map);
  getFilteredSheet_(ss);

  const mode = detectWriteMode_(ss);
  props.setProperty('WRITE_MODE', mode);
  ss.setActiveSheet(sheet);

  Logger.log('Setup complete. "' + SHEET_NAME + '" tab is ready. Text-safe write mode: ' + mode + '.');
  Logger.log('Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).');
}

/** Optional: writes a fake guest so you can see exactly what a row looks like. Delete it afterwards. */
function testSubmission() {
  const out = doPost({
    parameter: {
      firstName: 'test', lastName: 'GUEST', countryCode: 'US', country: 'United States',
      street: '1 Test Street', apt: '3-4', city: 'jersey city', region: 'NJ', postal: '07302',
      phone: '201 555 0100', email: 'Test.Guest@Example.com',
    },
    postData: { length: 250, type: 'application/x-www-form-urlencoded', contents: '' },
  });
  Logger.log(out.getContent());
  Logger.log('Check the Guests tab: ZIP should read 07302, Apt 3-4, City "Jersey City". Delete the test row when done.');
}


/* ───────────────────────────── Parsing & normalizing ───────────────────────────── */

function parsePayload_(e) {
  const out = {};
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (k) { out[k] = e.parameter[k]; });
  }
  const pd = e && e.postData;
  if (pd && pd.contents && /json|text\/plain/i.test(pd.type || '')) {
    try {
      const body = JSON.parse(pd.contents);
      if (body && typeof body === 'object') Object.assign(out, body);
    } catch (ignored) { /* not JSON; form-encoded fields are already in e.parameter */ }
  }
  return out;
}

function clean_(value, max) {
  let s = value === null || value === undefined ? '' : String(value);
  if (s.normalize) s = s.normalize('NFC');
  s = s.replace(/[\u0000-\u001F\u007F]+/g, ' ') // control characters and newlines
       .replace(/\s+/g, ' ')
       .trim()
       .replace(/^=+\s*/, '');                   // input never starts a formula
  return s.slice(0, max || 120).trim();
}

/** "jersey city" / "JERSEY CITY" → "Jersey City". Mixed case ("McDonald") is left exactly as typed. */
function smartCase_(s) {
  if (!/[a-z]/i.test(s)) return s;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  return s.toLowerCase()
    .replace(/(^|[\s\-'’.])([a-zß-öø-ÿ])/g, function (m, sep, ch) { return sep + ch.toUpperCase(); })
    .replace(/\b(ii|iii|iv|vi|vii|viii)\b/gi, function (m) { return m.toUpperCase(); })
    .replace(/ And /g, ' and '); // "rose and frank" → "Rose and Frank"
}

function formatZip_(z) {
  const m = z.match(/^(\d{5})(?:[\s-]?(\d{4}))?$/);
  if (!m) return z;
  return m[2] ? m[1] + '-' + m[2] : m[1];
}

function formatPhone_(p, isUS) {
  if (!p) return '';
  const trimmed = p.trim();
  const digits = trimmed.replace(/\D/g, '');
  const plus = trimmed.charAt(0) === '+';
  let us = null;
  if (!plus && isUS && digits.length === 10) us = digits;
  else if (digits.length === 11 && digits.charAt(0) === '1' && (plus ? trimmed.indexOf('+1') === 0 : isUS)) us = digits.slice(1);
  if (us) return '(' + us.slice(0, 3) + ') ' + us.slice(3, 6) + '-' + us.slice(6);
  return trimmed.replace(/\s+/g, ' ');
}

function normalize_(p) {
  const countryCode = clean_(p.countryCode, 2).toUpperCase() || 'US';
  const isUS = countryCode === 'US';
  return {
    isUS: isUS,
    firstName: smartCase_(clean_(p.firstName, 60)),
    lastName: smartCase_(clean_(p.lastName, 60)),
    street: clean_(p.street, 120),
    apt: clean_(p.apt, 40),
    city: smartCase_(clean_(p.city, 60)),
    region: isUS ? clean_(p.region, 40).toUpperCase() : clean_(p.region, 60),
    postal: isUS ? formatZip_(clean_(p.postal, 12)) : clean_(p.postal, 16).toUpperCase(),
    country: clean_(p.country, 60) || (isUS ? 'United States' : countryCode),
    phone: formatPhone_(clean_(p.phone, 30), isUS),
    email: clean_(p.email, 120).toLowerCase(),
  };
}

/** Returns issues to flag for a human. Nothing here rejects a submission. */
function validate_(r) {
  const issues = [];
  if (!r.firstName || !r.lastName) issues.push('Missing name');
  if (!r.street) issues.push('Missing street');
  if (!r.city) issues.push('Missing city');
  if (r.isUS) {
    if (US_STATES.indexOf(r.region) === -1) issues.push('Check state');
    if (!/^\d{5}(-\d{4})?$/.test(r.postal)) issues.push('Check ZIP');
  }
  const digits = r.phone.replace(/\D/g, '');
  if (!r.phone) issues.push('Missing phone');
  else if (digits.length < 7 || digits.length > 15) issues.push('Check phone');
  else if (r.isUS && r.phone.charAt(0) !== '+' && !/^\(\d{3}\) \d{3}-\d{4}$/.test(r.phone)) issues.push('Check phone');
  if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.email)) issues.push('Check email');
  return issues;
}


/** The spouse/partner row: the guest's household details with the partner's name. Null if none given. */
function partnerRecord_(rec, p) {
  const firstName = smartCase_(clean_(p.partnerFirstName, 60));
  const lastName = smartCase_(clean_(p.partnerLastName, 60));
  if (!firstName && !lastName) return null;
  return Object.assign({}, rec, { firstName: firstName, lastName: lastName });
}

/** Flags for the Review column: duplicate check against earlier rows, then data checks. */
function reviewFor_(r, block, map) {
  const issues = validate_(r);
  const dup = findDuplicate_(block, map, r);
  if (dup) issues.unshift(dup);
  return issues.join('; ');
}


/* ───────────────────────────── Duplicate detection ───────────────────────────── */

function splitUnit_(street, apt) {
  // "100 Park Ave Apt 4B" with an empty Apt field → street "100 Park Ave", apt "4B"
  if (apt) return { street: street, apt: apt };
  const m = street.match(/^(.*?)[\s,]+(?:apt|apartment|unit|ste|suite|#)\.?\s*#?\s*([\w-]+)$/i);
  return m ? { street: m[1], apt: m[2] } : { street: street, apt: '' };
}

function streetKey_(street) {
  return street.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map(function (w) { return STREET_WORDS[w] || w; }).join(' ');
}

function aptKey_(apt) {
  return apt.toLowerCase().replace(/\b(apt|apartment|unit|ste|suite|no|number)\b/g, '').replace(/[^a-z0-9]/g, '');
}

function postalKey_(postal) {
  let p = postal.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^\d{9}$/.test(p)) p = p.slice(0, 5);
  if (/^\d{3,4}$/.test(p)) p = ('00000' + p).slice(-5); // a ZIP that lost its leading zero
  return p;
}

function addressKey_(r) {
  if (!r.street) return '';
  const u = splitUnit_(r.street, r.apt || '');
  return [postalKey_(r.postal || ''), streetKey_(u.street), aptKey_(u.apt)].join('|');
}

function findDuplicate_(block, map, rec) {
  const key = addressKey_(rec);
  const email = rec.email;
  if (!key && !email) return '';
  const at = function (row, k) { const v = row[map[k] - block.offset]; return v === null || v === undefined ? '' : String(v); };
  const nameAt = function (row, i) { return (at(row, 'firstName') + ' ' + at(row, 'lastName')).trim() || 'row ' + (i + 2); };
  // Same address = likely the same household. Name the earliest entry.
  for (let i = 0; i < block.rows.length; i++) {
    const row = block.rows[i];
    if (key && key === addressKey_({ street: at(row, 'street'), apt: at(row, 'apt'), postal: at(row, 'postal') })) {
      return 'Possible duplicate of ' + nameAt(row, i) + ' (same address)';
    }
  }
  // Same email at a different address is often one relative entering several households
  // (e.g. an aunt entering her parents), so it's noted, not called a duplicate.
  for (let i = 0; i < block.rows.length; i++) {
    if (email && email === at(block.rows[i], 'email').toLowerCase()) return 'Same email as ' + nameAt(block.rows[i], i);
  }
  return '';
}


/* ───────────────────────────── Sheet helpers ───────────────────────────── */

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Spreadsheet not found. Run setup() from the Apps Script editor first.');
  return ss;
}

function getGuestSheet_(ss) {
  const id = PropertiesService.getScriptProperties().getProperty('GUESTS_SHEET_ID');
  if (id) {
    const byId = ss.getSheets().filter(function (s) { return String(s.getSheetId()) === id; })[0];
    if (byId) return byId; // survives renaming the tab
  }
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME, 0);
    formatSheet_(sheet, ensureHeaders_(sheet));
  }
  return sheet;
}

/** Maps column key → 0-based column index, adding any missing headers at the end. */
function ensureHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); })
    : [];
  const map = {};
  const missing = [];
  COLUMNS.forEach(function (c) {
    const i = headers.indexOf(c.header.toLowerCase());
    if (i === -1) missing.push(c); else map[c.key] = i;
  });
  if (missing.length) {
    const start = headers.length;
    const needed = start + missing.length;
    if (sheet.getMaxColumns() < needed) sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
    const range = sheet.getRange(1, start + 1, 1, missing.length);
    range.setNumberFormat('@');
    range.setValues([missing.map(function (c) { return c.header; })]);
    missing.forEach(function (c, k) { map[c.key] = start + k; });
  }
  return map;
}

function formatSheet_(sheet, map) {
  if (sheet.getMaxRows() < 2) sheet.insertRowsAfter(1, 999);
  const width = sheet.getLastColumn();
  const rows = sheet.getMaxRows() - 1;

  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);
  sheet.getRange(1, 1, 1, width)
    .setFontWeight('bold').setBackground('#F4EEE4').setFontColor('#2B2621').setVerticalAlignment('middle');

  COLUMNS.forEach(function (c) {
    const col = map[c.key] + 1;
    sheet.setColumnWidth(col, c.width);
    sheet.getRange(2, col, rows, 1).setNumberFormat(c.key === 'submitted' ? DATE_FORMAT : '@');
  });

  // Highlight any row with something in the Review column.
  const formula = '=$' + columnLetter_(map.review + 1) + '2<>""';
  const rules = sheet.getConditionalFormatRules();
  const exists = rules.some(function (r) {
    const b = r.getBooleanCondition();
    return b && String(b.getCriteriaValues()[0]) === formula;
  });
  if (!exists) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(formula)
      .setBackground('#FBEFD5')
      .setRanges([sheet.getRange(2, 1, rows, width)])
      .build());
    sheet.setConditionalFormatRules(rules);
  }
}

/** Reads the block of rows covering our columns; finds the next empty row in those columns. */
function readBlock_(sheet, map) {
  const cols = COLUMNS.map(function (c) { return map[c.key]; });
  const minC = Math.min.apply(null, cols);
  const maxC = Math.max.apply(null, cols);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rows: [], offset: minC, nextRow: 2 };

  const values = sheet.getRange(2, minC + 1, lastRow - 1, maxC - minC + 1).getValues();
  let lastUsed = 1;
  values.forEach(function (row, i) {
    const used = cols.some(function (c) { const v = row[c - minC]; return v !== '' && v !== null && v !== undefined; });
    if (used) lastUsed = i + 2;
  });
  // Only rows that hold guest data take part in duplicate checks.
  return { rows: values.slice(0, lastUsed - 1), offset: minC, nextRow: lastUsed + 1 };
}

function writeRecord_(sheet, map, rowNum, rec, when) {
  if (rowNum > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 100);

  sheet.getRange(rowNum, map.submitted + 1).setNumberFormat(DATE_FORMAT).setValue(when || new Date());

  const cells = COLUMNS
    .filter(function (c) { return c.key !== 'submitted'; })
    .map(function (c) { return { col: map[c.key] + 1, value: rec[c.key] === undefined || rec[c.key] === null ? '' : String(rec[c.key]) }; })
    .sort(function (a, b) { return a.col - b.col; });

  const mode = PropertiesService.getScriptProperties().getProperty('WRITE_MODE') || 'plain';
  contiguousRuns_(cells).forEach(function (run) {
    const range = sheet.getRange(rowNum, run[0].col, 1, run.length);
    range.setNumberFormat('@'); // literal text: keeps 07302, "+44 …", "3-4" exactly as typed
    if (mode === 'rich') {
      range.setRichTextValues([run.map(function (c) { return SpreadsheetApp.newRichTextValue().setText(c.value).build(); })]);
    } else {
      range.setValues([run.map(function (c) { return c.value; })]);
    }
  });
}

/** Notes on both First Name cells link a guest and the partner they added, with no extra column. */
function noteHousehold_(sheet, map, rowNum, guest, partner) {
  try {
    const name = function (r) { return (r.firstName + ' ' + r.lastName).trim(); };
    const who = guest.firstName || name(guest) || 'the submitter';
    sheet.getRange(rowNum, map.firstName + 1).setNote('Submitted together with ' + name(partner) + ' (spouse/partner).');
    sheet.getRange(rowNum + 1, map.firstName + 1).setNote('Spouse/partner added by ' + name(guest) + '. Phone and email are from ' + who + '’s entry.');
  } catch (err) {
    console.error('noteHousehold_ failed: ' + err);
  }
}

function contiguousRuns_(cells) {
  const runs = [];
  cells.forEach(function (c) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1].col === c.col - 1) run.push(c); else runs.push([c]);
  });
  return runs;
}

/**
 * Confirms that text written to plain-text cells comes back unchanged (07302 stays 07302).
 * Falls back to rich-text writes if this account's Sheets ever parses them anyway.
 */
function detectWriteMode_(ss) {
  const samples = ['07302', '+44 20 7946 0958', '3-4', 'TRUE', '1e5'];
  const tmp = ss.insertSheet('_setup_check_' + Date.now());
  try {
    const a = tmp.getRange(1, 1, 1, samples.length);
    a.setNumberFormat('@');
    a.setValues([samples]);
    SpreadsheetApp.flush();
    if (sameStrings_(a.getValues()[0], samples)) return 'plain';

    const b = tmp.getRange(2, 1, 1, samples.length);
    b.setNumberFormat('@');
    b.setRichTextValues([samples.map(function (t) { return SpreadsheetApp.newRichTextValue().setText(t).build(); })]);
    SpreadsheetApp.flush();
    if (sameStrings_(b.getValues()[0], samples)) return 'rich';

    Logger.log('WARNING: could not confirm ZIP codes keep their leading zero. Submit a test with a 0xxxx ZIP and check the sheet.');
    return 'plain';
  } finally {
    ss.deleteSheet(tmp);
  }
}

function sameStrings_(got, want) {
  return want.every(function (w, i) { return got[i] === w; });
}

function getFilteredSheet_(ss) {
  let sh = ss.getSheetByName(FILTERED_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(FILTERED_SHEET_NAME);
    sh.getRange(1, 1, 1, 3).setValues([['Received', 'Reason', 'Payload']]).setFontWeight('bold').setBackground('#F4EEE4');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 150);
    sh.setColumnWidth(3, 600);
  }
  return sh;
}

function logFiltered_(ss, reason, payload) {
  try {
    const sh = getFilteredSheet_(ss);
    const r = sh.getLastRow() + 1;
    if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
    sh.getRange(r, 1).setNumberFormat(DATE_FORMAT).setValue(new Date());
    const rest = sh.getRange(r, 2, 1, 2);
    rest.setNumberFormat('@');
    rest.setValues([[reason, JSON.stringify(payload).slice(0, 5000)]]);
  } catch (err) {
    console.error('logFiltered_ failed: ' + err);
  }
}

function columnLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
