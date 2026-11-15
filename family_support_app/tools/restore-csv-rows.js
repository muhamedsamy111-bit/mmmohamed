'use strict';

/**
 * Restores CSV rows from the SQLite mirror (safety net for accidental CSV edits).
 * Usage: node tools/restore-csv-rows.js <nid> [<nid> ...]
 * Appends any listed national ID that exists in the DB but not in families.csv.
 */

const { getFamilies, saveFamilies, CSV_FIELDNAMES } = require('../src/services/dataService');
const { getDb } = require('../src/db/index');
const { normalizeNid } = require('../src/services/priorityCalculator');

const DB_TO_CSV = {
  name: 'اسم رب الأسرة', national_id: 'الرقم القومي', age: 'العمر',
  address: 'العنوان التفصيلي', governorate: 'المحافظة', email: 'البريد الإلكتروني',
  children_count: 'عدد الأطفال', family_members: 'عدد أفراد الأسرة',
  income: 'الدخل الشهري', has_disabled: 'معيل معاق', has_orphans: 'أيتام',
  eligible: 'مؤهل للدعم', priority_score: 'درجة الأولوية',
  priority_level: 'مستوى الأولوية', added_at: 'تاريخ الإضافة',
  added_by: 'أضيف بواسطة', mail_status: 'حالة إشعار البريد',
  request_status: 'حالة الطلب', is_pregnant: 'حامل',
  pregnancy_followup: 'متابعة حمل', under_5: 'أطفال تحت 5',
  vaccines_complete: 'تطعيمات مكتملة', chronic_disease: 'مرض مزمن',
  malnutrition: 'سوء تغذية', treatment_cost: 'تكلفة العلاج الشهرية',
  last_pregnancy_visit: 'آخر متابعة حمل', last_vaccine: 'آخر تطعيم',
  last_delivery: 'تاريخ آخر ولادة', health_score: 'درجة الأولوية الصحية',
  health_level: 'مستوى الأولوية الصحية', has_insurance: 'لديه تأمين صحي',
  family_type: 'تصنيف الأسرة', children_multiples: 'تعدد مواليد الأطفال الحاليين',
  pregnancy_kind: 'نوع الحمل الحالي', fetus_count: 'عدد الأجنة'
};

function main() {
  const wanted = process.argv.slice(2).map(normalizeNid);
  if (!wanted.length) {
    console.log('usage: node tools/restore-csv-rows.js <nid> [...]');
    process.exit(2);
  }
  const rows = getFamilies(true);
  const have = new Set(rows.map(r => normalizeNid(r['الرقم القومي'])));
  const db = getDb();
  let added = 0;
  for (const nid of wanted) {
    if (have.has(nid)) { console.log(`skip (already in csv): ${nid}`); continue; }
    const fam = db.prepare('SELECT * FROM families WHERE national_id = ?').get(nid);
    if (!fam) { console.log(`skip (not in db): ${nid}`); continue; }
    const row = {};
    for (const col of CSV_FIELDNAMES) row[col] = '';
    for (const [dbCol, csvCol] of Object.entries(DB_TO_CSV)) {
      if (CSV_FIELDNAMES.includes(csvCol) && fam[dbCol] !== null && fam[dbCol] !== undefined) {
        row[csvCol] = fam[dbCol];
      }
    }
    // birth certificate count column lives outside the DB mirror
    if (CSV_FIELDNAMES.includes('عدد شهادات ميلاد الأطفال')) {
      row['عدد شهادات ميلاد الأطفال'] = db
        .prepare("SELECT COUNT(*) n FROM documents WHERE owner_kind='family' AND owner_id=? AND doc_type='birth_certificate'")
        .get(fam.id).n;
    }
    rows.push(row);
    added++;
    console.log(`restored: ${nid} (${fam.name})`);
  }
  if (added) saveFamilies(rows);
  console.log(`done. added=${added} csv_rows=${rows.length}`);
}

if (require.main === module) main();
