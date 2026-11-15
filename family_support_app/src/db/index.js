'use strict';

/**
 * Database connection. Uses node's built-in SQLite (node:sqlite, sync) with
 * the file at data/app.db. Schema is applied idempotently on first open.
 *
 * NOTE for Vercel: serverless functions cannot keep a local SQLite file, so
 * production on Vercel needs PostgreSQL (Neon/Supabase). The schema and all
 * queries here are plain portable SQL; only this file's driver would change.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BASE_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const DB_PATH = process.env.APP_DB || path.join(DATA_DIR, 'app.db');

let db = null;

function open(dbPath = DB_PATH) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

/** Additive migration for databases created by an older schema revision. */
function migrate(handle) {
  const wanted = {
    has_insurance: "TEXT DEFAULT 'لا'",
    family_type: 'TEXT DEFAULT ' + "''",
    children_multiples: 'TEXT DEFAULT ' + "''",
    pregnancy_kind: 'TEXT DEFAULT ' + "''",
    fetus_count: 'INTEGER DEFAULT 0'
  };
  let cols = [];
  try {
    cols = handle.prepare('PRAGMA table_info(families)').all().map(c => c.name);
  } catch {
    return;
  }
  for (const [name, decl] of Object.entries(wanted)) {
    if (!cols.includes(name)) {
      try { handle.exec(`ALTER TABLE families ADD COLUMN ${name} ${decl}`); } catch { /* exists */ }
    }
  }
}

function getDb() {
  return db || open();
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { open, getDb, close, DB_PATH, BASE_DIR, DATA_DIR };
