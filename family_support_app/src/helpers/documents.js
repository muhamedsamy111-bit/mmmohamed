'use strict';

/**
 * Document recognition engine.
 *
 * Faithful port of app.py's module-level `DOCUMENT_PATTERNS` table and
 * `analyze_document_text(text)` (app.py lines ~2795-2903).
 *
 * Scoring is a weighted keyword + regex match:
 *   - each matched keyword is worth 10 points
 *   - each matched regex is worth that document type's `confidence_boost`
 * The winning type's score is normalised against its own maximum possible
 * score to produce a 0-100 confidence value.
 */

const DOCUMENT_PATTERNS = {
  "بطاقة رقم قومي": {
    keywords: ["رقم قومي", "national id", "جمهورية مصر", "وزارة الداخلية",
      "تاريخ الميلاد", "محل الإقامة", "الجنسية", "مصري"],
    patterns: [String.raw`\b\d{14}\b`],
    confidence_boost: 30
  },
  "شهادة ميلاد": {
    keywords: ["شهادة ميلاد", "birth certificate", "سجل مدني", "مواليد",
      "الأب", "الأم", "رقم القيد", "محافظة"],
    patterns: [String.raw`مواليد\s+\d{4}`, String.raw`رقم القيد\s*:?\s*\d+`],
    confidence_boost: 25
  },
  "إيصال راتب / مرتب": {
    keywords: ["مرتب", "راتب", "salary", "payslip", "صافي", "إجمالي",
      "خصومات", "بدل", "تأمينات", "الشهر"],
    patterns: [String.raw`صافي\s*[\d,\.]+`, String.raw`إجمالي\s*[\d,\.]+`, String.raw`\d+\s*جنيه`],
    confidence_boost: 20
  },
  "عقد إيجار": {
    keywords: ["عقد إيجار", "lease", "مستأجر", "مؤجر", "الوحدة السكنية",
      "الإيجار الشهري", "مدة العقد", "مقدم الإيجار"],
    patterns: [String.raw`مدة\s+العقد\s+\d+`, String.raw`الإيجار\s+الشهري\s*[\d,\.]+`],
    confidence_boost: 20
  },
  "شهادة إعاقة": {
    keywords: ["إعاقة", "disability", "لجنة الإعاقة", "نسبة العجز",
      "وزارة الصحة", "شهادة طبية", "عجز كلي", "عجز جزئي"],
    patterns: [String.raw`نسبة\s+العجز\s*:?\s*\d+%?`, String.raw`درجة\s+الإعاقة`],
    confidence_boost: 25
  },
  "وثيقة وفاة": {
    keywords: ["وفاة", "death certificate", "شهادة وفاة", "المتوفى",
      "سجل الوفيات", "تاريخ الوفاة", "مستشفى"],
    patterns: [String.raw`تاريخ\s+الوفاة`, String.raw`المتوفى\s*:`],
    confidence_boost: 25
  }
};

/**
 * Python: best_type = max(results, key=lambda x: results[x]["score"])
 * `max` returns the first key reaching the top score, so we only replace the
 * winner on a strictly greater score.
 */
function bestResult(results) {
  let bestType = null;
  let bestScore = -Infinity;
  for (const type of Object.keys(results)) {
    const score = results[type].score;
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }
  return { bestType, bestScore };
}

function analyzeDocumentText(text) {
  const raw = text === null || text === undefined ? '' : String(text);
  const textLower = raw.toLowerCase();
  const results = {};

  for (const docType of Object.keys(DOCUMENT_PATTERNS)) {
    const rules = DOCUMENT_PATTERNS[docType];
    let score = 0;
    const matchedKeywords = [];
    const matchedPatterns = [];

    // نقاط الكلمات المفتاحية
    for (const kw of rules.keywords) {
      if (textLower.includes(kw.toLowerCase())) {
        score += 10;
        matchedKeywords.push(kw);
      }
    }

    // نقاط إضافية من الأنماط
    for (const pattern of rules.patterns) {
      if (new RegExp(pattern, 'i').test(raw)) {
        score += rules.confidence_boost;
        matchedPatterns.push(pattern);
      }
    }

    if (score > 0) {
      results[docType] = {
        score,
        matched_keywords: matchedKeywords,
        matched_patterns: matchedPatterns
      };
    }
  }

  if (Object.keys(results).length === 0) {
    return {
      document_type: "غير معروف",
      confidence: 0,
      all_scores: {},
      extracted_info: {}
    };
  }

  const { bestType, bestScore } = bestResult(results);

  // تحويل النقاط إلى نسبة ثقة (0-100)
  const maxPossible =
    10 * DOCUMENT_PATTERNS[bestType].keywords.length +
    DOCUMENT_PATTERNS[bestType].confidence_boost * DOCUMENT_PATTERNS[bestType].patterns.length;
  const confidence = Math.min(Math.round((bestScore / Math.max(maxPossible, 1)) * 100), 100);

  // استخراج معلومات محددة
  const extractedInfo = {};
  const nationalIdMatch = /\b(\d{14})\b/.exec(raw);
  if (nationalIdMatch) {
    extractedInfo["الرقم القومي"] = nationalIdMatch[1];
  }

  const dateMatch = /\b(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})\b/.exec(raw);
  if (dateMatch) {
    extractedInfo["تاريخ مُكتشف"] = dateMatch[1];
  }

  const amountMatch = /(\d[\d,\.]+)\s*جنيه/.exec(raw);
  if (amountMatch) {
    extractedInfo["مبلغ مالي"] = amountMatch[1] + " جنيه";
  }

  const allScores = {};
  for (const k of Object.keys(results)) {
    allScores[k] = results[k].score;
  }

  return {
    document_type: bestType,
    confidence,
    matched_keywords: results[bestType].matched_keywords,
    all_scores: allScores,
    extracted_info: extractedInfo
  };
}

module.exports = {
  analyzeDocumentText,
  DOCUMENT_PATTERNS
};
