'use strict';

/**
 * One-way sync: a successful register_family POST is mirrored into SQLite.
 * The CSV/JSON files stay the source the pages read; the database is the
 * queryable system of record (mandatory fields, documents, pregnancy, twins).
 * Failures are logged and never break the registration response.
 */

const models = require('./models');
const { safeName } = require('../helpers/uploads');

function syncRegistrationToDb(p) {
  let family = models.getFamilyByNid(p.nationalId);
  if (!family) {
    const res = models.createFamily({
      name: p.name,
      national_id: p.nationalId,
      age: p.age,
      address: p.address,
      governorate: p.governorate,
      email: p.email,
      children_count: p.children,
      income: p.income,
      has_disabled: p.hasDisabled,
      has_orphans: p.hasOrphans,
      eligible: p.eligible,
      priority_score: p.points,
      priority_level: p.priorityLevel,
      added_at: p.currentDate,
      added_by: p.username,
      mail_status: p.emailStatus,
      request_status: 'قيد المراجعة',
      is_pregnant: p.pregnant,
      pregnancy_followup: (p.healthRow || {})['متابعة حمل'] || 'لا ينطبق',
      under_5: parseInt(((p.healthRow || {})['أطفال تحت 5'] || '0'), 10) || 0,
      vaccines_complete: (p.healthRow || {})['تطعيمات مكتملة'] || 'لا ينطبق',
      chronic_disease: (p.healthRow || {})['مرض مزمن'] || 'لا',
      malnutrition: (p.healthRow || {})['سوء تغذية'] || 'لا ينطبق',
      treatment_cost: parseFloat((p.healthRow || {})['تكلفة العلاج الشهرية']) || 0,
      last_pregnancy_visit: (p.healthRow || {})['آخر متابعة حمل'] || '',
      last_vaccine: (p.healthRow || {})['آخر تطعيم'] || '',
      last_delivery: (p.healthRow || {})['تاريخ آخر ولادة'] || '',
      health_score: (p.healthRow || {})['درجة الأولوية الصحية'] || 0,
      health_level: (p.healthRow || {})['مستوى الأولوية الصحية'] || '',
      has_insurance: p.hasInsurance ? 'نعم' : 'لا',
      family_type: p.familyType || '',
      children_multiples: p.childrenMultiples || '',
      pregnancy_kind: p.pregnancyKind || '',
      fetus_count: p.fetusCount || 0
    });
    if (!res.ok) {
      console.error('[db-sync] createFamily failed:', res.msg);
      return null;
    }
    family = models.getFamilyById(res.id);
  }

  const by = p.username || '';
  const docs = Array.isArray(p.uploadedDocuments) ? p.uploadedDocuments : [];
  const safeNid = (safeName(p.nationalId) || 'unknown');
  const findFile = (type) => {
    const hit = docs.find(d => d && d.type === type);
    const name = hit ? (hit.filename || '') : '';
    return name ? `uploads/documents/${safeNid}/${name}` : '';
  };

  if (findFile('بطاقة الرقم القومي')) {
    models.addDocument({
      owner_kind: 'family', owner_id: family.id,
      doc_type: 'national_id_card', doc_number: p.nationalId,
      file_path: findFile('بطاقة الرقم القومي'), uploaded_by: by
    });
  }
  if (p.hasInsurance && findFile('بطاقة التأمين الصحي')) {
    models.addDocument({
      owner_kind: 'family', owner_id: family.id,
      doc_type: 'insurance_1', doc_number: '',
      file_path: findFile('بطاقة التأمين الصحي'), uploaded_by: by
    });
  }
  const certs = Array.isArray(p.childRecords) ? p.childRecords : [];
  const createdChildIds = [];
  certs.forEach((c, i) => {
    const label = `شهادة ميلاد طفل ${i + 1}`;
    const filePath = findFile(label);
    const certNo = (c && c.certificate_number) || '';
    models.addDocument({
      owner_kind: 'family', owner_id: family.id,
      doc_type: 'birth_certificate', doc_number: certNo || ((c && c.child_name) || `طفل ${i + 1}`),
      file_path: filePath, uploaded_by: by
    });
    // Named child row linked to its certificate number + file.
    if (c && c.child_name) {
      const added = models.addChild(family.id, {
        name: c.child_name,
        birth_certificate_no: certNo,
        birth_certificate_file: filePath,
        relation: 'ابن/ابنة'
      });
      if (added.ok) createdChildIds.push(added.id);
    }
  });
  // Declared existing multiples (تعدد المواليد) share one twin group until
  // birth dates refine the relation; kind defaults to 'other'.
  if (createdChildIds.length >= 2
      && (p.childrenMultiples === 'توأم' || p.childrenMultiples === 'ثلاثة توائم أو أكثر')) {
    models.linkChildrenAsTwins(createdChildIds, 'other');
  }

  if (p.pregnant === 'نعم') {
    models.setPregnancy(family.id, {
      status: 'pregnant',
      expected_delivery: '',
      last_visit: (p.healthRow || {})['آخر متابعة حمل'] || '',
      followup: (p.healthRow || {})['متابعة حمل'] || 'لا',
      // The kind (identical/fraternal) is known only after birth;
      // twins_expected comes from the fetus count right now.
      twins_expected: (p.fetusCount || 0) >= 2 ? 1 : 0,
      twin_type: 'other',
      notes: `نوع الحمل: ${p.pregnancyKind || ''}`
    });
  }

  return family.id;
}

module.exports = { syncRegistrationToDb };
