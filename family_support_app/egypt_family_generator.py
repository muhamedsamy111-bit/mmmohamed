# -*- coding: utf-8 -*-
"""
مولّد أسر مصرية وهمية (بيانات تجريبية فقط — مش بيانات حقيقية).

- أرقام قومية بصيغة صحيحة: 14 رقم (قرن + تاريخ ميلاد + كود المحافظة + تسلسل + رقم أخير عشوائي).
  الرقم الأخير عشوائي (مش خوارزمية رسمية)، فالأرقام مش بتمثل أشخاص حقيقيين.
- الأسماء: لو مكتبة Faker متثبتة بتستخدم لغة ar_EG، وإلا بتستخدم قوائم أسماء مصرية مدمجة.
- يشتغل لوحده من سطر الأوامر:
    python egypt_family_generator.py --count 200 --seed 1 --out fake_families.csv
"""
import argparse
import csv
import random
from datetime import datetime, timedelta

import health_rules

GENERATED_BY = "مولّد بيانات تجريبية"

# كود المحافظة داخل الرقم القومي + وزن تقريبي (نسبة السكان تقريبية، للتوزيع فقط)
GOVERNORATES = {
    "القاهرة": ("01", 10.1), "الإسكندرية": ("02", 5.6), "بورسعيد": ("03", 0.8),
    "السويس": ("04", 0.8), "دمياط": ("11", 1.7), "الدقهلية": ("12", 6.9),
    "الشرقية": ("13", 7.7), "القليوبية": ("14", 5.9), "كفر الشيخ": ("15", 3.6),
    "الغربية": ("16", 5.3), "المنوفية": ("17", 4.5), "البحيرة": ("18", 6.8),
    "الإسماعيلية": ("19", 1.4), "الجيزة": ("21", 9.4), "بني سويف": ("22", 3.4),
    "الفيوم": ("23", 3.8), "المنيا": ("24", 6.2), "أسيوط": ("25", 4.9),
    "سوهاج": ("26", 5.4), "قنا": ("27", 3.5), "أسوان": ("28", 1.6),
    "الأقصر": ("29", 1.3), "البحر الأحمر": ("31", 0.4), "الوادي الجديد": ("32", 0.3),
    "مطروح": ("33", 0.5), "شمال سيناء": ("34", 0.5), "جنوب سيناء": ("35", 0.1),
}

MALE_FIRST = ["محمد", "أحمد", "محمود", "مصطفى", "علي", "حسن", "حسين", "إبراهيم", "عبدالله", "عمر",
              "يوسف", "خالد", "سيد", "رمضان", "صلاح", "جمال", "ماهر", "ياسر", "هاني", "طارق",
              "سعيد", "عادل", "كمال", "فتحي", "السيد", "عصام", "أشرف", "وليد", "إسماعيل", "شعبان"]
FEMALE_FIRST = ["فاطمة", "سعاد", "نادية", "هدى", "منى", "سامية", "عزة", "نجلاء", "رحاب", "إيمان",
                "سلوى", "حنان", "أمل", "ليلى", "زينب", "مريم", "نوال", "وفاء", "سناء", "شيماء"]
FAMILY_NAMES = ["عبدالرحمن", "السيد", "حسن", "إبراهيم", "عثمان", "الشافعي", "سليمان", "المصري",
                "عبدالعزيز", "فرج", "بدوي", "الجمال", "مبروك", "عوض", "شحاتة", "النجار",
                "الشرقاوي", "عبدالحميد", "الدسوقي", "خليل", "عطية", "زيدان", "عامر", "الصعيدي"]

STATUSES = (["قيد المراجعة"] * 60) + (["مقبول"] * 25) + (["مرفوض"] * 15)


class _Names:
    """مصدر الأسماء: Faker(ar_EG) لو متاح ومطلوب، وإلا القوائم المدمجة."""
    def __init__(self, source="auto", rng=None, seed=None):
        self.rng = rng or random.Random()
        self.fake = None
        if source in ("auto", "faker"):
            try:
                from faker import Faker
                self.fake = Faker("ar_EG")
                if seed is not None:
                    self.fake.seed_instance(seed)
            except Exception:
                if source == "faker":
                    raise RuntimeError("مكتبة Faker مش متثبتة (pip install Faker)")
                self.fake = None

    @property
    def source(self):
        return "faker(ar_EG)" if self.fake else "builtin"

    def full_name(self, female):
        if self.fake:
            try:
                first = self.fake.first_name_female() if female else self.fake.first_name_male()
                father = self.fake.first_name_male()
                if first and father:
                    return f"{first} {father}"
            except Exception:
                pass
        first = self.rng.choice(FEMALE_FIRST if female else MALE_FIRST)
        return f"{first} {self.rng.choice(MALE_FIRST)} {self.rng.choice(FAMILY_NAMES)}"


def make_national_id(rng, gov_code, female, birth):
    """14 رقم: قرن(2/3) + yymmdd + كود المحافظة + تسلسل 4 أرقام (آخره فردي=ذكر/زوجي=أنثى) + رقم أخير."""
    century = "2" if birth.year < 2000 else "3"
    seq = rng.randint(0, 999)
    gender_digit = rng.choice([0, 2, 4, 6, 8]) if female else rng.choice([1, 3, 5, 7, 9])
    return f"{century}{birth:%y%m%d}{gov_code}{seq:03d}{gender_digit}{rng.randint(0, 9)}"


def _kids(rng):
    return rng.choices(range(0, 9), weights=[8, 14, 20, 20, 15, 11, 7, 3, 2])[0]


def generate_families(count, seed=None, governorate=None, existing_nids=None,
                      priority_fn=None, names="auto", median_income=2800,
                      disabled_rate=0.08, orphan_rate=0.06, now=None):
    """يرجّع قائمة dicts بنفس أعمدة families.csv. priority_fn(children, income, disabled, orphans) -> (points, level, ...)."""
    rng = random.Random(seed)
    now = now or datetime.now()
    used = set(existing_nids or ())
    name_src = _Names(names, rng, seed)
    if governorate and governorate not in GOVERNORATES:
        raise ValueError(f"محافظة غير معروفة: {governorate}")
    govs = [governorate] if governorate else list(GOVERNORATES)
    weights = [1] if governorate else [GOVERNORATES[g][1] for g in govs]

    rows = []
    attempts = 0
    while len(rows) < count and attempts < count * 20:
        attempts += 1
        gov = rng.choices(govs, weights=weights)[0]
        female = rng.random() < 0.15
        age = rng.randint(24, 68)
        birth = now.date() - timedelta(days=age * 365 + rng.randint(0, 364))
        nid = make_national_id(rng, GOVERNORATES[gov][0], female, birth)
        if nid in used:
            continue
        used.add(nid)

        children = _kids(rng)
        adults = 1 if female and rng.random() < 0.7 else 2
        size = adults + children + (1 if rng.random() < 0.2 else 0)
        income = int(round(rng.lognormvariate(0, 0.65) * median_income / 50.0)) * 50
        income = max(0, min(income, 20000))
        disabled = "نعم" if rng.random() < disabled_rate else "لا"
        orphans = "نعم" if children and rng.random() < orphan_rate else "لا"
        if priority_fn:
            points, level = priority_fn(children, income, disabled, orphans)[:2]
        else:
            points, level = "", ""
        added = now - timedelta(days=rng.randint(0, 364), minutes=rng.randint(0, 1439))
        row = {
            "اسم رب الأسرة": name_src.full_name(female),
            "الرقم القومي": nid,
            "البريد الإلكتروني": "",
            "المحافظة": gov,
            "عدد الأطفال": children,
            "عدد أفراد الأسرة": size,
            "الدخل الشهري": income,
            "معيل معاق": disabled,
            "أيتام": orphans,
            "مؤهل للدعم": "نعم" if children > 2 else "لا",
            "درجة الأولوية": points,
            "مستوى الأولوية": level,
            "تاريخ الإضافة": added.strftime("%Y-%m-%d %H:%M"),
            "أضيف بواسطة": GENERATED_BY,
            "حالة إشعار البريد": "بيانات تجريبية - لم يتم الإرسال",
            "حالة الطلب": rng.choice(STATUSES),
        }
        row.update(health_rules.generate_health(rng, children, income))
        rows.append(row)
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="توليد أسر مصرية وهمية إلى ملف CSV")
    ap.add_argument("--count", type=int, default=100)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--governorate")
    ap.add_argument("--names", choices=["auto", "faker", "builtin"], default="auto")
    ap.add_argument("--out", default="fake_families.csv")
    a = ap.parse_args()
    data = generate_families(a.count, a.seed, a.governorate, names=a.names)
    with open(a.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(data[0].keys()))
        w.writeheader(); w.writerows(data)
    print(f"تم توليد {len(data)} أسرة في {a.out}")
