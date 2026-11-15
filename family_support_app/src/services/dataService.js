const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { HEALTH_FIELDS, loadConfig } = require('../config/healthRules');
const { normalizeNid } = require('./priorityCalculator');

const BASE_DIR = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');
const LABS_DIR = path.join(UPLOADS_DIR, 'labs');

// Ensure essential directories exist
[DATA_DIR, UPLOADS_DIR, LABS_DIR].forEach(dir => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // Ignore in read-only environment
  }
});

const CSV_FIELDNAMES = [
  "اسم رب الأسرة",
  "الرقم القومي",
  "البريد الإلكتروني",
  "المحافظة",
  "عدد الأطفال",
  "عدد أفراد الأسرة",
  "الدخل الشهري",
  "معيل معاق",
  "أيتام",
  "مؤهل للدعم",
  "درجة الأولوية",
  "مستوى الأولوية",
  "العمر",
  "العنوان التفصيلي",
  "لديه تأمين صحي",
  "تصنيف الأسرة",
  "تعدد مواليد الأطفال الحاليين",
  "نوع الحمل الحالي",
  "عدد الأجنة",
  "عدد شهادات ميلاد الأطفال",
  "تاريخ الإضافة",
  "أضيف بواسطة",
  "حالة إشعار البريد",
  "حالة الطلب",
  ...HEALTH_FIELDS
];

const FAMILIES_CSV = path.join(BASE_DIR, 'families.csv');
const LABS_INDEX = path.join(BASE_DIR, 'family_labs.json');
const MENTAL_FILE = path.join(BASE_DIR, 'family_mental_health.json');
const NOTES_FILE = path.join(BASE_DIR, 'family_notes.json');
const VISITS_FILE = path.join(BASE_DIR, 'family_visits.json');
const BIRTHS_FILE = path.join(BASE_DIR, 'births.json');
const CHILDREN_FILE = path.join(BASE_DIR, 'family_children.json');
const USER_ACCOUNTS_FILE = path.join(DATA_DIR, 'user_accounts.json');
const EMPLOYEE_ACCOUNTS_FILE = path.join(DATA_DIR, 'employee_accounts.json');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit_log.json');
const HEALTH_FACILITIES_FILE = path.join(DATA_DIR, 'health_facilities.json');
const HEALTH_SCHEDULE_FILE = path.join(DATA_DIR, 'health_schedule.json');

// Initialize health schedule config
loadConfig(HEALTH_SCHEDULE_FILE);

function loadJson(filePath, defaultValue = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error(`Error loading JSON from ${filePath}:`, err.message);
  }
  return defaultValue;
}

function saveJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn(`Warning: Could not write JSON to ${filePath}:`, err.message);
    return false;
  }
}

// In-memory cache for families
let familiesCache = null;

function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];

  // Parse header
  const headerLine = lines[0].replace(/^\uFEFF/, ''); // strip BOM
  const headers = splitCsvLine(headerLine);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    if (values.length === 0 || (values.length === 1 && !values[0])) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] !== undefined ? values[idx] : '').trim();
    });
    // Ensure all expected fields exist
    CSV_FIELDNAMES.forEach(f => {
      if (row[f] === undefined) row[f] = '';
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function getFamilies(forceReload = false) {
  if (familiesCache && !forceReload) {
    return familiesCache;
  }

  if (fs.existsSync(FAMILIES_CSV)) {
    try {
      const content = fs.readFileSync(FAMILIES_CSV, 'utf8');
      familiesCache = parseCsv(content);
      return familiesCache;
    } catch (err) {
      console.error("Error reading families.csv:", err);
    }
  }
  familiesCache = [];
  return familiesCache;
}

function saveFamilies(rows) {
  familiesCache = rows;
  try {
    const csvOutput = '\uFEFF' + stringify(rows, {
      header: true,
      columns: CSV_FIELDNAMES
    });
    fs.writeFileSync(FAMILIES_CSV, csvOutput, 'utf8');
    return true;
  } catch (err) {
    console.warn("Notice: Operating in serverless environment, in-memory cache updated but disk write skipped.");
    return false;
  }
}

function getFamilyByIndex(index) {
  const families = getFamilies();
  const idx = parseInt(index, 10);
  if (isNaN(idx) || idx < 0 || idx >= families.length) {
    return null;
  }
  return { index: idx, row: families[idx] };
}

function getFamilyByNid(nid) {
  const norm = normalizeNid(nid);
  const families = getFamilies();
  const index = families.findIndex(f => normalizeNid(f["الرقم القومي"]) === norm);
  if (index === -1) return null;
  return { index, row: families[index] };
}

module.exports = {
  BASE_DIR,
  DATA_DIR,
  UPLOADS_DIR,
  LABS_DIR,
  CSV_FIELDNAMES,
  FAMILIES_CSV,
  LABS_INDEX,
  MENTAL_FILE,
  NOTES_FILE,
  VISITS_FILE,
  BIRTHS_FILE,
  CHILDREN_FILE,
  USER_ACCOUNTS_FILE,
  EMPLOYEE_ACCOUNTS_FILE,
  AUDIT_LOG_FILE,
  HEALTH_FACILITIES_FILE,
  HEALTH_SCHEDULE_FILE,
  loadJson,
  saveJson,
  getFamilies,
  saveFamilies,
  getFamilyByIndex,
  getFamilyByNid
};
