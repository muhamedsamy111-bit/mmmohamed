# Database layer (SQLite today, PostgreSQL path for Vercel)

The Express backend now has a real relational database instead of only
CSV/JSON files. It runs on **`node:sqlite`** (built into Node 24, no new
dependency, synchronous API that matches the codebase style).

- File: `data/app.db` (override with `APP_DB=/path/to.db`)
- Schema: `src/db/schema.sql` — plain portable SQL
- Access: `src/db/models.js` (validation + CRUD), `src/db/sync.js` (CSV→DB mirror)

## Tables

| table | purpose |
|---|---|
| `families` | household head — all CSV columns **plus** `age`, `address`, `phone`, `has_insurance`, `family_type`, `children_multiples`, `pregnancy_kind`, `fetus_count` |
| `children` | every child: name, birth date, gender, `birth_certificate_no` + file, `is_twin`, `twin_group_id`, `twin_type` |
| `documents` | `national_id_card`, `birth_certificate`, `insurance_1/2/3`, `other` — owned by a family or a child |
| `pregnancies` | current + history per family: `status` (`pregnant`/`delivered`/`not_pregnant`), `twins_expected`, `twin_type` |

## Mandatory rules (enforced on every new registration)

`name`, `national_id` (valid 14-digit Egyptian NID), `age` (0–120 and
consistent with the NID birth date ±2 years), `address`. The register form
already collects all four and the backend rejects anything else.

## Twins — how the backend knows

- Twin children share one `twin_group_id`; `twin_type` is `identical`
  (متماثل) / `fraternal` (غير متماثل) / `other` (unknown/other kind).
- Non-twins are `is_twin = 0` (the "other" bucket).
- `register_birth` auto-links: a second child with the same family +
  birth date is marked twin and joined to the same group.
- `GET /api/families/:id/children` returns `twin_groups` with kind + members.

## Pregnancy — why the customer differs

`familySummary()` returns `customer_kind: 'pregnant' | 'standard'`
(`حامل (متابعة خاصة)` vs `غير حامل`). A family is pregnant when its current
pregnancy record says so (or the CSV flag says `نعم`).

## Health insurance — the 3 IDs

`insuranceStatus()` counts `insurance_1/2/3` documents per family and reports
`complete` + `missing_labels` in Arabic. Birth certificates are counted per
child (`birth_certificates_count`).

## JSON API (auth required; employee governorate-scoped, users own-families-only)

```
GET  /api/family/lookup?nid=...      -> { id, name }
GET  /api/families/:id/summary       -> full customer object
GET  /api/families/:id/children      -> children + twin_groups
POST /api/families/:id/children      -> add child (twin-aware, auto-links)
GET  /api/families/:id/pregnancy     -> current + history
POST /api/families/:id/pregnancy     -> set status/twins_expected/twin_type
GET  /api/families/:id/documents     -> documents + insurance readiness
```

## Import & tests

```
node tools/import-csv-to-db.js   # families.csv -> app.db (idempotent)
node tools/test-db.js            # 21 checks: validation, twins, pregnancy, insurance
```

Import notes: 5006/5012 rows imported, 6 duplicates skipped. ~5000 legacy
dataset rows carry 17-digit external identifiers (not standard 14-digit NIDs)
and predate the `address` column — they import with `address='غير مسجل'`.
New registrations must still pass full validation.

## Vercel caveat

Serverless functions cannot keep a local SQLite file. For production on Vercel
use PostgreSQL (Neon/Supabase): the schema and queries are portable SQL — only
`src/db/index.js` (the driver) needs swapping for `pg`.
