'use strict';

/**
 * One-shot import: families.csv -> SQLite (data/app.db).
 * Derives age from the national ID and backfills a missing address with
 * 'غير مسجل' so the mandatory-field rule holds for every imported row.
 * Idempotent: rows whose national_id already exists are skipped.
 *
 * Run:  node tools/import-csv-to-db.js
 */

const { open, close } = require('../src/db/index');
const { createFamily, importFamily, ageFromNid, getFamilyByNid } = require('../src/db/models');
const { getFamilies } = require('../src/services/dataService');
const { normalizeNid } = require('../src/services/priorityCalculator');

function toInt(v, def = 0) {
  const n = parseInt(String(v === undefined || v === null ? '' : v).trim(), 10);
  return Number.isNaN(n) ? def : n;
}

function toNum(v, def = 0) {
  const n = parseFloat(String(v === undefined || v === null ? '' : v).trim());
  return Number.isNaN(n) ? def : n;
}

function main() {
  open();
  const rows = getFamilies(true);
  let inserted = 0;
  let skipped = 0;
  let noAddress = 0;
  const errors = [];

  for (const r of rows) {
    const nid = normalizeNid(r['الرقم القومي']);
    if (!nid) { skipped++; continue; }
    if (getFamilyByNid(nid)) { skipped++; continue; }

    const age = ageFromNid(nid);
    const address = String(r['العنوان'] || '').trim();
    if (!address) noAddress++;

    const res = importFamily({
      name: String(r['اسم رب الأسرة'] || '').trim() || 'بدون اسم',
      national_id: nid,
      age: age === null ? null : age,
      address: address || 'غير مسجل',
      governorate: r['المحافظة'] || '',
      email: r['البريد الإلكتروني'] || '',
      phone: r['رقم الهاتف'] || r['الهاتف'] || '',
      children_count: toInt(r['عدد الأطفال']),
      family_members: toInt(r['عدد أفراد الأسرة'], 1),
      income: toNum(r['الدخل الشهري']),
      has_disabled: r['معيل معاق'] || 'لا',
      has_orphans: r['أيتام'] || 'لا',
      eligible: r['مؤهل للدعم'] || 'لا',
      priority_score: toNum(r['درجة الأولوية']),
      priority_level: r['مستوى الأولوية'] || '',
      added_at: r['تاريخ الإضافة'] || undefined,
      added_by: r['أضيف بواسطة'] || '',
      mail_status: r['حالة إشعار البريد'] || '',
      request_status: r['حالة الطلب'] || 'قيد المراجعة',
      is_pregnant: r['حامل'] || 'لا',
      pregnancy_followup: r['متابعة حمل'] || 'لا ينطبق',
      under_5: toInt(r['أطفال تحت 5']),
      vaccines_complete: r['تطعيمات مكتملة'] || 'لا ينطبق',
      chronic_disease: r['مرض مزمن'] || 'لا',
      malnutrition: r['سوء تغذية'] || 'لا ينطبق',
      treatment_cost: toNum(r['تكلفة العلاج الشهرية']),
      last_pregnancy_visit: r['آخر متابعة حمل'] || '',
      last_vaccine: r['آخر تطعيم'] || '',
      last_delivery: r['تاريخ آخر ولادة'] || '',
      health_score: toNum(r['درجة الأولوية الصحية']),
      health_level: r['مستوى الأولوية الصحية'] || ''
    });

    if (res.ok) inserted++;
    else {
      skipped++;
      if (errors.length < 10) errors.push(`${nid}: ${res.msg}`);
    }
  }

  console.log(`rows in csv : ${rows.length}`);
  console.log(`inserted    : ${inserted}`);
  console.log(`skipped     : ${skipped} (already in db or invalid)`);
  console.log(`no address  : ${noAddress} (backfilled with 'غير مسجل')`);
  if (errors.length) {
    console.log('sample errors:');
    errors.forEach(e => console.log('  ' + e));
  }
  close();
}

if (require.main === module) main();

module.exports = { main };
