'use strict';

/**
 * Local filesystem storage driver. Paths are relative to the project root.
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = path.resolve(__dirname, '..', '..');

function resolve(key) {
  return path.join(BASE_DIR, key);
}

function exists(key) {
  try { return fs.existsSync(resolve(key)); } catch { return false; }
}

function readFile(key) {
  return fs.readFileSync(resolve(key));
}

function readText(key) {
  return fs.readFileSync(resolve(key), 'utf8');
}

function writeFile(key, data) {
  const file = resolve(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return true;
}

function remove(key) {
  try {
    fs.unlinkSync(resolve(key));
    return true;
  } catch {
    return false;
  }
}

function list(prefix) {
  const dir = resolve(prefix);
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function stat(key) {
  try {
    const s = fs.statSync(resolve(key));
    return { size: s.size, mtime: s.mtime };
  } catch {
    return null;
  }
}

module.exports = { BASE_DIR, resolve, exists, readFile, readText, writeFile, remove, list, stat, persistent: true };
