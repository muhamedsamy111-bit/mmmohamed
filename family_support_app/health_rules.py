# -*- coding: utf-8 -*-
"""
الطبقة الصحية (تنبيهات وترشيح للمتابعة فقط — مفيش تشخيص ولا علاج).
الأوزان والحدود تقديرية وقابلة للتعديل (WEIGHTS + ملف data/health_schedule.json)، ومش مأخوذة من مرجع طبي رسمي
إلا لو كتبت المرجع بنفسك في الملف.
"""
import json
import os
import random
from datetime import datetime, timedelta

HEALTH_FIELDS = [
    "حامل", "متابعة حمل", "أطفال تحت 5", "تطعيمات مكتملة", "مرض مزمن", "سوء تغذية",
    "تكلفة العلاج الشهرية", "آخر متابعة حمل", "آخر تطعيم", "تاريخ آخر ولادة",
    "درجة الأولوية الصحية", "مستوى الأولوية الصحية",
]
YES, NO, NA = "نعم", "لا", "لا ينطبق"

# إعدادات قابلة للتعديل من data/health_schedule.json (القيم هنا افتراضية للعرض فقط)
CONFIG = {
    "pregnancy_followup_days": 30,       # أقصى فترة بين زيارتي متابعة الحمل قبل ما تتحسب "متأخرة"
    "vaccination_followup_days": 90,     # أقصى فترة بين زيارتي التطعيم/المتابعة للأطفال تحت 5
    "schedule_source": "",               # لازم تكتب مصدر الجدول الرسمي (وزارة الصحة)
    "catastrophic_threshold_pct": 10,    # نسبة تكلفة العلاج من الدخل = "إنفاق صحي كارثي"
    "severe_threshold_pct": 25,          # حد أعلى للنسبة
    "threshold_source": "",              # لازم تكتب المرجع المنشور للنسب دي
    "ppd_window_months": 12,             # فترة "ما بعد الولادة" اللي بنعتبر الأم فيها محتاجة مسح اكتئاب
    "epds_cutoff": 10,                   # درجة المقياس (0-30) اللي من عندها "يحتاج تقييم" — افتراضي للعرض
    "epds_source": "",                   # لازم تكتب مرجع المقياس والحد المعتمد
}

DEFAULT_CONFIG_NOTE = ("القيم دي افتراضية للعرض فقط. استبدلها بالجدول الرسمي لوزارة الصحة، "
                       "واكتب المصدر في schedule_source و threshold_source.")


def configure(path):
    """يقرأ الإعدادات من ملف JSON (وينشئه بالقيم الافتراضية لو مش موجود)."""
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"_note": DEFAULT_CONFIG_NOTE, **CONFIG}, f, ensure_ascii=False, indent=2)
        return
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for k in CONFIG:
            if k in data and data[k] is not None:
                CONFIG[k] = data[k]
    except Exception:
        pass  # لو الملف بايظ نكمّل بالقيم الافتراضية


# أوزان تقديرية (قابلة للتعديل)
WEIGHTS = {
    "حامل بدون متابعة": 30,
    "حامل بمتابعة": 5,
    "تطعيمات ناقصة": 25,
    "سوء تغذية": 30,
    "مرض مزمن": 15,
    "عبء علاج كارثي": 15,
    "عبء علاج مرتفع جدًا": 25,
    "متأخر عن الموعد": 10,
}
LEVEL_HIGH, LEVEL_MID = 50, 25            # عتبات مستوى الأولوية الصحية
SOCIAL_W, HEALTH_W = 0.6, 0.4             # وزن الدرجة الاجتماعية/الصحية في الترتيب الإجمالي

ALERT_TYPES = {
    "pregnant": "حامل بدون متابعة",
    "vaccines": "تطعيمات ناقصة",
    "malnutrition": "علامات سوء تغذية",
    "overdue": "متأخر عن موعد المتابعة",
    "burden": "عبء علاج مرتفع على الدخل",
    "chronic": "مرض مزمن (متابعة دورية)",
    "ppd": "مطلوب مسح اكتئاب ما بعد الولادة",
}
ALERT_BADGE = {"pregnant": "danger", "vaccines": "warning", "malnutrition": "danger",
               "overdue": "warning", "burden": "dark", "chronic": "info", "ppd": "secondary"}
URGENT = {"pregnant", "vaccines", "malnutrition", "overdue"}


def has_health_data(row):
    """الأسرة اتسجلت لها بيانات صحية لو حقل 'حامل' مش فاضي."""
    return bool((row.get("حامل") or "").strip())


def needs_backfill(row):
    """صف ناقصه بيانات صحية أو الحقول الإضافية (تكلفة/تواريخ)."""
    return ((not has_health_data(row)) or row.get("تكلفة العلاج الشهرية") in (None, "")
            or row.get("تاريخ آخر ولادة") in (None, ""))


def to_num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def burden_pct(row):
    """نسبة تكلفة العلاج الشهرية من دخل الأسرة (%). None لو مفيش تكلفة. inf لو الدخل صفر والتكلفة موجودة."""
    cost = to_num(row.get("تكلفة العلاج الشهرية"))
    if cost <= 0:
        return None
    income = to_num(row.get("الدخل الشهري"))
    return float("inf") if income <= 0 else round(cost / income * 100, 1)


def _days_since(date_str, today=None):
    try:
        d = datetime.strptime((date_str or "").strip(), "%Y-%m-%d")
    except ValueError:
        return None
    return ((today or datetime.now()) - d).days


def is_overdue(row, today=None):
    """متأخر عن موعد متابعة الحمل أو الزيارة الدورية للأطفال تحت 5 (حسب الفترات في CONFIG)."""
    if row.get("حامل") == YES and row.get("متابعة حمل") == YES:
        d = _days_since(row.get("آخر متابعة حمل"), today)
        if d is not None and d > CONFIG["pregnancy_followup_days"]:
            return True
    if to_num(row.get("أطفال تحت 5")) > 0:
        d = _days_since(row.get("آخر تطعيم"), today)
        if d is not None and d > CONFIG["vaccination_followup_days"]:
            return True
    return False


def health_alerts(row):
    """قائمة أكواد التنبيهات (للأخصائي كتذكير، مش تشخيص)."""
    if not has_health_data(row):
        return []
    out = []
    if row.get("حامل") == YES and row.get("متابعة حمل") == NO:
        out.append("pregnant")
    if row.get("تطعيمات مكتملة") == NO:
        out.append("vaccines")
    if row.get("سوء تغذية") == YES:
        out.append("malnutrition")
    if is_overdue(row):
        out.append("overdue")
    b = burden_pct(row)
    if b is not None and b >= CONFIG["catastrophic_threshold_pct"]:
        out.append("burden")
    if row.get("مرض مزمن") == YES:
        out.append("chronic")
    return out


def health_score(row):
    """(درجة 0-100, مستوى) أو ("", "") لو مفيش بيانات صحية مسجلة."""
    if not has_health_data(row):
        return "", ""
    pts = 0
    if row.get("حامل") == YES:
        pts += WEIGHTS["حامل بدون متابعة"] if row.get("متابعة حمل") == NO else WEIGHTS["حامل بمتابعة"]
    if row.get("تطعيمات مكتملة") == NO:
        pts += WEIGHTS["تطعيمات ناقصة"]
    if row.get("سوء تغذية") == YES:
        pts += WEIGHTS["سوء تغذية"]
    if row.get("مرض مزمن") == YES:
        pts += WEIGHTS["مرض مزمن"]
    if is_overdue(row):
        pts += WEIGHTS["متأخر عن الموعد"]
    b = burden_pct(row)
    if b is not None:
        if b >= CONFIG["severe_threshold_pct"]:
            pts += WEIGHTS["عبء علاج مرتفع جدًا"]
        elif b >= CONFIG["catastrophic_threshold_pct"]:
            pts += WEIGHTS["عبء علاج كارثي"]
    pts = min(pts, 100)
    level = "عالية" if pts >= LEVEL_HIGH else "متوسطة" if pts >= LEVEL_MID else "منخفضة" if pts > 0 else "لا يوجد"
    return pts, level


def total_score(row):
    """الدرجة الإجمالية = 0.6 × الاجتماعية (حد أقصى 100) + 0.4 × الصحية."""
    return round(SOCIAL_W * min(to_num(row.get("درجة الأولوية")), 100) + HEALTH_W * to_num(row.get("درجة الأولوية الصحية")), 1)


def needs_followup(row):
    """تحتاج متابعة صحية؟ (حامل بدون متابعة / تطعيمات ناقصة / سوء تغذية / متأخر عن الموعد). المرض المزمن والعبء المالي تنبيهات منفصلة."""
    return bool(URGENT & set(health_alerts(row)))


def _extra_fields(rng, row, now=None):
    """تكلفة علاج وتواريخ متابعة تجريبية (وهمية) متسقة مع باقي الحقول الصحية."""
    now = now or datetime.now()
    cost = 0.0
    if rng.random() < 0.35:
        cost += rng.uniform(40, 150)
    if row.get("مرض مزمن") == YES:
        cost += rng.lognormvariate(0, 0.5) * 350
    if row.get("حامل") == YES:
        cost += rng.uniform(100, 400)
    if row.get("سوء تغذية") == YES:
        cost += rng.uniform(100, 300)
    fmt = lambda days: (now - timedelta(days=days)).strftime("%Y-%m-%d")
    preg_date = fmt(int(rng.expovariate(1 / 25)) + 2) if row.get("حامل") == YES and row.get("متابعة حمل") == YES else ""
    vacc_date = fmt(int(rng.expovariate(1 / 60)) + 5) if to_num(row.get("أطفال تحت 5")) > 0 else ""
    delivery = "لا ينطبق"
    if to_num(row.get("أطفال تحت 5")) > 0 and row.get("حامل") != YES and rng.random() < 0.22:
        delivery = fmt(int(rng.uniform(10, 420)))
    return {"تكلفة العلاج الشهرية": str(int(round(cost / 10.0)) * 10),
            "آخر متابعة حمل": preg_date, "آخر تطعيم": vacc_date, "تاريخ آخر ولادة": delivery}


def generate_health(rng, children, income):
    """بيانات صحية تجريبية (وهمية). الفقر بيزوّد الاحتمالات شوية."""
    try:
        inc = float(income)
    except (TypeError, ValueError):
        inc = 3000.0
    risk = 1.3 if inc < 2000 else 1.0
    under5 = sum(1 for _ in range(int(children)) if rng.random() < 0.35)
    pregnant = rng.random() < 0.07
    row = {
        "حامل": YES if pregnant else NO,
        "متابعة حمل": (YES if rng.random() < 0.6 / risk else NO) if pregnant else NA,
        "أطفال تحت 5": str(under5),
        "تطعيمات مكتملة": (YES if rng.random() > 0.25 * risk else NO) if under5 else NA,
        "مرض مزمن": YES if rng.random() < 0.18 * min(risk, 1.15) else NO,
        "سوء تغذية": (YES if rng.random() < 0.07 * risk else NO) if children else NA,
        "الدخل الشهري": income,
    }
    row.update(_extra_fields(rng, row))
    row.pop("الدخل الشهري")
    full = dict(row, **{"الدخل الشهري": income})
    row["درجة الأولوية الصحية"], row["مستوى الأولوية الصحية"] = health_score(full)
    return row


def backfill_row(row, seed):
    """يملّا الحقول الصحية الناقصة لصف تجريبي (بنفس seed يطلع نفس الناتج)."""
    rng = random.Random(seed)
    if not has_health_data(row):
        try:
            children = int(float(row.get("عدد الأطفال") or 0))
        except ValueError:
            children = 0
        row.update(generate_health(rng, children, row.get("الدخل الشهري")))
    else:
        extra = _extra_fields(random.Random(seed + 1_000_003), row)
        if row.get("تكلفة العلاج الشهرية") not in (None, ""):
            extra = {"تاريخ آخر ولادة": extra["تاريخ آخر ولادة"]}   # الحقول الأقدم موجودة بالفعل، منغيّرهاش
        row.update(extra)
        row["درجة الأولوية الصحية"], row["مستوى الأولوية الصحية"] = health_score(row)
    return row


def is_postpartum(row, today=None):
    """الأم في فترة ما بعد الولادة (حسب ppd_window_months) بناءً على "تاريخ آخر ولادة"."""
    d = _days_since(row.get("تاريخ آخر ولادة"), today)
    return d is not None and 0 <= d <= CONFIG["ppd_window_months"] * 30.4375


PPD_RANK = {"عاجل": 0, "يحتاج تقييم": 1, "لم يُمسح": 2, "لم تُسجَّل درجة": 3, "لا مؤشر": 4}


def ppd_risk(record):
    """تصنيف نتيجة آخر مسح (يدخله الأخصائي النفسي). ترشيح للتقييم وليس تشخيصًا."""
    if not record:
        return "لم يُمسح"
    if record.get("self_harm") == YES:
        return "عاجل"
    try:
        e = int(record.get("epds"))
    except (TypeError, ValueError):
        return "لم تُسجَّل درجة"
    return "يحتاج تقييم" if e >= CONFIG["epds_cutoff"] else "لا مؤشر"
