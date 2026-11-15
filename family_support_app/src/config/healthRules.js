const fs = require('fs');
const path = require('path');

const HEALTH_FIELDS = [
  "حامل", "متابعة حمل", "أطفال تحت 5", "تطعيمات مكتملة", "مرض مزمن", "سوء تغذية",
  "تكلفة العلاج الشهرية", "آخر متابعة حمل", "آخر تطعيم", "تاريخ آخر ولادة",
  "درجة الأولوية الصحية", "مستوى الأولوية الصحية"
];

const YES = "نعم";
const NO = "لا";
const NA = "لا ينطبق";

const DEFAULT_CONFIG = {
  pregnancy_followup_days: 30,
  vaccination_followup_days: 90,
  schedule_source: "",
  catastrophic_threshold_pct: 10,
  severe_threshold_pct: 25,
  threshold_source: "",
  ppd_window_months: 12,
  epds_cutoff: 10,
  epds_source: ""
};

let CONFIG = { ...DEFAULT_CONFIG };

function loadConfig(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      CONFIG = { ...DEFAULT_CONFIG, ...data };
    }
  } catch (err) {
    console.error("Error loading health config:", err);
  }
  return CONFIG;
}

const WEIGHTS = {
  "حامل بدون متابعة": 30,
  "حامل بمتابعة": 5,
  "تطعيمات ناقصة": 25,
  "سوء تغذية": 30,
  "مرض مزمن": 15,
  "عبء علاج كارثي": 15,
  "عبء علاج مرتفع جدًا": 25,
  "متأخر عن الموعد": 10
};

const LEVEL_HIGH = 50;
const LEVEL_MID = 25;
const SOCIAL_W = 0.6;
const HEALTH_W = 0.4;

const ALERT_TYPES = {
  pregnant: "حامل بدون متابعة",
  vaccines: "تطعيمات ناقصة",
  malnutrition: "علامات سوء تغذية",
  overdue: "متأخر عن موعد المتابعة",
  burden: "عبء علاج مرتفع على الدخل",
  chronic: "مرض مزمن (متابعة دورية)",
  ppd: "مطلوب مسح اكتئاب ما بعد الولادة"
};

const ALERT_BADGE = {
  pregnant: "danger",
  vaccines: "warning",
  malnutrition: "danger",
  overdue: "warning",
  burden: "dark",
  chronic: "info",
  ppd: "secondary"
};

const URGENT = new Set(["pregnant", "vaccines", "malnutrition", "overdue"]);
const PPD_RANK = { "عاجل": 0, "يحتاج تقييم": 1, "لم يُمسح": 2, "لم تُسجَّل درجة": 3, "لا مؤشر": 4 };

function toNum(v, def = 0.0) {
  if (v === null || v === undefined || v === "") return def;
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function hasHealthData(row) {
  return Boolean((row["حامل"] || "").trim());
}

function burdenPct(row) {
  const cost = toNum(row["تكلفة العلاج الشهرية"]);
  if (cost <= 0) return null;
  const income = toNum(row["الدخل الشهري"]);
  if (income <= 0) return Infinity;
  return Math.round((cost / income) * 1000) / 10;
}

function daysSince(dateStr, today = new Date()) {
  if (!dateStr || !dateStr.trim() || dateStr.trim() === "لا ينطبق") return null;
  const d = new Date(dateStr.trim());
  if (isNaN(d.getTime())) return null;
  const diffTime = (today.getTime() - d.getTime());
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

function isOverdue(row, today = new Date()) {
  if (row["حامل"] === YES && row["متابعة حمل"] === YES) {
    const d = daysSince(row["آخر متابعة حمل"], today);
    if (d !== null && d > CONFIG.pregnancy_followup_days) {
      return true;
    }
  }
  if (toNum(row["أطفال تحت 5"]) > 0) {
    const d = daysSince(row["آخر تطعيم"], today);
    if (d !== null && d > CONFIG.vaccination_followup_days) {
      return true;
    }
  }
  return false;
}

function healthAlerts(row) {
  if (!hasHealthData(row)) return [];
  const alerts = [];
  if (row["حامل"] === YES && row["متابعة حمل"] === NO) {
    alerts.push("pregnant");
  }
  if (row["تطعيمات مكتملة"] === NO) {
    alerts.push("vaccines");
  }
  if (row["سوء تغذية"] === YES) {
    alerts.push("malnutrition");
  }
  if (isOverdue(row)) {
    alerts.push("overdue");
  }
  const b = burdenPct(row);
  if (b !== null && b >= CONFIG.catastrophic_threshold_pct) {
    alerts.push("burden");
  }
  if (row["مرض مزمن"] === YES) {
    alerts.push("chronic");
  }
  return alerts;
}

function healthScore(row) {
  if (!hasHealthData(row)) {
    return { score: "", level: "" };
  }
  let pts = 0;
  if (row["حامل"] === YES) {
    pts += (row["متابعة حمل"] === NO) ? WEIGHTS["حامل بدون متابعة"] : WEIGHTS["حامل بمتابعة"];
  }
  if (row["تطعيمات مكتملة"] === NO) {
    pts += WEIGHTS["تطعيمات ناقصة"];
  }
  if (row["سوء تغذية"] === YES) {
    pts += WEIGHTS["سوء تغذية"];
  }
  if (row["مرض مزمن"] === YES) {
    pts += WEIGHTS["مرض مزمن"];
  }
  if (isOverdue(row)) {
    pts += WEIGHTS["متأخر عن الموعد"];
  }
  const b = burdenPct(row);
  if (b !== null) {
    if (b >= CONFIG.severe_threshold_pct) {
      pts += WEIGHTS["عبء علاج مرتفع جدًا"];
    } else if (b >= CONFIG.catastrophic_threshold_pct) {
      pts += WEIGHTS["عبء علاج كارثي"];
    }
  }
  pts = Math.min(pts, 100);
  let level = "لا يوجد";
  if (pts >= LEVEL_HIGH) level = "عالية";
  else if (pts >= LEVEL_MID) level = "متوسطة";
  else if (pts > 0) level = "منخفضة";

  return { score: pts, level };
}

function totalScore(row) {
  const social = Math.min(toNum(row["درجة الأولوية"]), 100);
  const health = toNum(row["درجة الأولوية الصحية"]);
  return Math.round((SOCIAL_W * social + HEALTH_W * health) * 10) / 10;
}

function needsFollowup(row) {
  const alerts = healthAlerts(row);
  return alerts.some(a => URGENT.has(a));
}

function isPostpartum(row, today = new Date()) {
  const d = daysSince(row["تاريخ آخر ولادة"], today);
  return d !== null && d >= 0 && d <= CONFIG.ppd_window_months * 30.4375;
}

function ppdRisk(record) {
  if (!record) return "لم يُمسح";
  if (record.self_harm === YES) return "عاجل";
  const epds = parseInt(record.epds, 10);
  if (isNaN(epds)) return "لم تُسجَّل درجة";
  return epds >= CONFIG.epds_cutoff ? "يحتاج تقييم" : "لا مؤشر";
}

module.exports = {
  HEALTH_FIELDS,
  YES,
  NO,
  NA,
  CONFIG,
  loadConfig,
  WEIGHTS,
  ALERT_TYPES,
  ALERT_BADGE,
  URGENT,
  PPD_RANK,
  toNum,
  hasHealthData,
  burdenPct,
  daysSince,
  isOverdue,
  healthAlerts,
  healthScore,
  totalScore,
  needsFollowup,
  isPostpartum,
  ppdRisk
};
