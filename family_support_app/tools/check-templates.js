'use strict';

/**
 * Compiles every Jinja template through the compatibility layer and reports
 * any template that fails to translate/compile. Templates with a dynamic
 * parent ({% extends layout %}) are compiled once per candidate layout.
 * Run with:  node tools/check-templates.js
 */

const fs = require('fs');
const path = require('path');
const { TemplateEngine } = require('../src/jinja/compiler');

const dir = path.join(__dirname, '..', 'templates');
const engine = new TemplateEngine(dir);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort();

let ok = 0;
const failures = [];

for (const file of files) {
  try {
    if (engine.isDynamic(file)) {
      for (const parent of engine.dynamicParents()) engine.compileFor(file, parent);
    } else {
      engine.compile(file);
    }
    ok++;
  } catch (err) {
    failures.push({ file, message: String(err.message).split('\n')[0] });
  }
}

console.log(`compiled OK: ${ok}/${files.length}`);
if (failures.length) {
  console.log(`\nfailures (${failures.length}):`);
  for (const f of failures) console.log(`  ${f.file}: ${f.message}`);
  process.exit(1);
}
