const STRICT_NID_VALIDATION = process.env.STRICT_NID_VALIDATION !== "0";

function normalizeNid(value) {
  let s = String(value !== null && value !== undefined ? value : "").trim();
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹";
  const englishDigits = "01234567890123456789";
  for (let i = 0; i < arabicDigits.length; i++) {
    s = s.replaceAll(arabicDigits[i], englishDigits[i]);
  }
  s = s.replace(/\s+/g, "");
  if (/^\d+\.0$/.test(s)) {
    s = s.slice(0, -2);
  }
  return s;
}

function validateNationalIdFormat(nid) {
  if (!/^\d{14}$/.test(nid)) {
    return { ok: false, msg: "الرقم القومي لازم يكون 14 رقم بالظبط." };
  }
  if (nid[0] !== "2" && nid[0] !== "3") {
    return { ok: false, msg: "الرقم القومي غير صحيح (الرقم الأول لازم يكون 2 أو 3)." };
  }
  const century = nid[0] === "2" ? 1900 : 2000;
  const year = century + parseInt(nid.substring(1, 3), 10);
  const month = parseInt(nid.substring(3, 5), 10);
  const day = parseInt(nid.substring(5, 7), 10);

  const birth = new Date(year, month - 1, day);
  if (
    birth.getFullYear() !== year ||
    birth.getMonth() !== month - 1 ||
    birth.getDate() !== day
  ) {
    return { ok: false, msg: "الرقم القومي غير صحيح (تاريخ الميلاد المضمّن فيه غير منطقي)." };
  }
  if (birth > new Date()) {
    return { ok: false, msg: "الرقم القومي غير صحيح (تاريخ الميلاد في المستقبل)." };
  }
  return { ok: true, msg: "" };
}

function calculatePriority(childrenInput, incomeInput, hasDisabled, hasOrphans) {
  let score = 0;
  const breakdown = {};

  const children = parseInt(childrenInput, 10) || 0;
  let childrenScore = 0;
  if (children === 0) {
    childrenScore = 0;
  } else if (children <= 2) {
    childrenScore = 8;
  } else if (children <= 4) {
    childrenScore = 16;
  } else if (children <= 6) {
    childrenScore = 22;
  } else {
    childrenScore = 25;
  }
  score += childrenScore;
  breakdown.children = childrenScore;

  const income = parseFloat(incomeInput) || 0;
  const familySize = Math.max(children + 2, 1);
  const incomePerPerson = income / familySize;

  let incomeScore = 0;
  if (incomePerPerson === 0) {
    incomeScore = 35;
  } else if (incomePerPerson < 300) {
    incomeScore = 35;
  } else if (incomePerPerson < 600) {
    incomeScore = 28;
  } else if (incomePerPerson < 1000) {
    incomeScore = 20;
  } else if (incomePerPerson < 1500) {
    incomeScore = 10;
  } else if (incomePerPerson < 2000) {
    incomeScore = 5;
  } else {
    incomeScore = 0;
  }
  score += incomeScore;
  breakdown.income = incomeScore;

  const disabilityScore = hasDisabled === "نعم" ? 25 : 0;
  score += disabilityScore;
  breakdown.disability = disabilityScore;

  const orphanScore = hasOrphans === "نعم" ? 15 : 0;
  score += orphanScore;
  breakdown.orphan = orphanScore;

  let riskFactors = 0;
  if (children > 4) riskFactors++;
  if (incomePerPerson < 600) riskFactors++;
  if (hasDisabled === "نعم") riskFactors++;
  if (hasOrphans === "نعم") riskFactors++;

  if (riskFactors >= 3) {
    const bonus = Math.round(score * 0.10);
    score = Math.min(score + bonus, 100);
    breakdown.cumulativeBonus = bonus;
  } else {
    breakdown.cumulativeBonus = 0;
  }

  score = Math.round(score);

  let level = "أولوية منخفضة 🟢";
  let color = "success";
  if (score >= 70) {
    level = "أولوية قصوى 🔴";
    color = "danger";
  } else if (score >= 40) {
    level = "أولوية متوسطة 🟡";
    color = "warning";
  }

  return { score, level, color, breakdown };
}

module.exports = {
  STRICT_NID_VALIDATION,
  normalizeNid,
  validateNationalIdFormat,
  calculatePriority
};
