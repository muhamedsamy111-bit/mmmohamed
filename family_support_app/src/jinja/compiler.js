'use strict';

/**
 * Jinja2 template -> EJS compiler.
 *
 * The project's 48 templates are Jinja2. Rather than hand-porting them we
 * flatten the `{% extends %}` / `{% block %}` inheritance chain and translate
 * the tag syntax to EJS, then compile once with EJS and cache the render fn.
 *
 * Only text inside {{ }} / {% %} / {# #} is touched; HTML and inline <script>
 * are copied through verbatim.
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { translateExpression, isSafe } = require('./expr');

const EXTENDS_RE = /\{%-?\s*extends\s+["']([^"']+)["']\s*-?%\}/;
const EXTENDS_ANY_RE = /\{%-?\s*extends\s+([\s\S]+?)\s*-?%\}/;
const BLOCK_RE = /\{%-?\s*block\s+([A-Za-z_][A-Za-z0-9_]*)\s*-?%\}/g;
const ENDBLOCK_RE = /\{%-?\s*endblock(\s+[A-Za-z_][A-Za-z0-9_]*)?\s*-?%\}/g;

function splitBlocks(src) {
  const blocks = {};
  let body = src;
  let guard = 0;

  for (;;) {
    BLOCK_RE.lastIndex = 0;
    const m = BLOCK_RE.exec(body);
    if (!m) break;
    if (++guard > 500) throw new Error('block scanner runaway');
    const name = m[1];
    const contentStart = m.index + m[0].length;
    ENDBLOCK_RE.lastIndex = contentStart;
    const em = ENDBLOCK_RE.exec(body);
    if (!em) throw new Error(`unclosed block '${name}'`);
    blocks[name] = body.slice(contentStart, em.index);
    body = body.slice(0, m.index) + `@@BLOCK:${name}@@` + body.slice(em.index + em[0].length);
  }
  return { body, blocks };
}

function preprocess(exprSrc) {
  // keyword argument used by Jinja's flashed-message helper
  return exprSrc.replace(/with_categories\s*=\s*true/gi, 'true');
}

let loopSeq = 0;

function outputTag(tag) {
  const inner = tag.replace(/^\{\{-?/, '').replace(/-?\}\}$/, '').trim();
  const src = preprocess(inner);
  if (!src) return '';
  let code;
  try {
    code = translateExpression(src);
  } catch (err) {
    throw new Error(`cannot translate {{ ${src} }}: ${err.message}`);
  }
  const out = `__s(${code})`;
  return isSafe(src) ? `<%- ${out} %>` : `<%= ${out} %>`;
}

function translateStatement(src, stack) {
  if (src.startsWith('if ')) {
    stack.push({ type: 'if' });
    return `<% if (${translateExpression(src.slice(3).trim())}) { %>`;
  }
  if (src.startsWith('elif ')) {
    return `<% } else if (${translateExpression(src.slice(5).trim())}) { %>`;
  }
  if (src === 'else') {
    const top = stack[stack.length - 1];
    if (top && top.type === 'for') {
      // Jinja's loop-else runs when the iterable is empty.
      top.hasElse = true;
      return `<% } if (!${top.ran}) { %>`;
    }
    return '<% } else { %>';
  }
  if (src === 'endif') {
    if (stack.length) stack.pop();
    return '<% } %>';
  }

  if (src.startsWith('for ')) {
    const m = /^for\s+([\s\S]+?)\s+in\s+([\s\S]+)$/.exec(src);
    if (!m) throw new Error(`cannot parse for loop: ${src}`);
    const target = m[1].trim();
    const iterable = translateExpression(m[2].trim());
    const id = ++loopSeq;
    const it = `__it${id}`;
    const ix = `__i${id}`;
    const ran = `__ran${id}`;
    stack.push({ type: 'for', ran });
    let decl;
    if (target.includes(',')) {
      const names = target.split(',').map(s => s.trim()).filter(Boolean);
      decl = `const [${names.join(', ')}] = ${it}[${ix}];`;
    } else {
      decl = `const ${target} = ${it}[${ix}];`;
    }
    return `<% { const ${it} = (${iterable}) || []; let ${ran} = false; ` +
      `for (let ${ix} = 0; ${ix} < ${it}.length; ${ix}++) { ${ran} = true; ` +
      `const loop = { index: ${ix} + 1, index0: ${ix}, first: ${ix} === 0, ` +
      `last: ${ix} === ${it}.length - 1, length: ${it}.length, revindex: ${it}.length - ${ix} }; ` +
      `${decl} %>`;
  }
  if (src === 'endfor') {
    if (stack.length) stack.pop();
    return '<% } } %>';
  }

  if (src.startsWith('set ')) {
    const eq = src.indexOf('=');
    if (eq === -1) return '';
    const name = src.slice(4, eq).trim();
    const value = translateExpression(src.slice(eq + 1).trim());
    return `<% let ${name} = ${value}; %>`;
  }
  if (src.startsWith('with ')) {
    const eq = src.indexOf('=');
    if (eq === -1) return '';
    const name = src.slice(5, eq).trim();
    const value = translateExpression(src.slice(eq + 1).trim());
    stack.push({ type: 'with' });
    return `<% { let ${name} = ${value}; %>`;
  }
  if (src === 'endwith') {
    if (stack.length) stack.pop();
    return '<% } %>';
  }

  if (src.startsWith('block ') || src.startsWith('endblock') || src.startsWith('extends ')) {
    return '';
  }
  if (src.startsWith('include ')) {
    throw new Error('{% include %} is not supported by the Jinja compatibility layer');
  }
  if (src.startsWith('macro ') || src.startsWith('endmacro')) {
    throw new Error('{% macro %} is not supported by the Jinja compatibility layer');
  }
  // unknown tag: leave a no-op so rendering still succeeds
  return `<% /* unsupported tag: ${src.replace(/\*\//g, '* /') } */ %>`;
}

function translateTags(text) {
  const re = /\{#[\s\S]*?#\}|\{\{-?[\s\S]*?-?\}\}|\{%-?[\s\S]*?-?%\}/g;
  let out = '';
  let last = 0;
  const stack = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const tag = m[0];
    if (tag.startsWith('{#')) continue;
    if (tag.startsWith('{{')) {
      out += outputTag(tag);
      continue;
    }
    const inner = tag.replace(/^\{%-?/, '').replace(/-?%\}$/, '').trim();
    const prepped = preprocess(inner);
    try {
      out += translateStatement(prepped, stack);
    } catch (err) {
      throw new Error(`cannot translate {% ${inner} %}: ${err.message}`);
    }
  }
  out += text.slice(last);
  return out;
}

class TemplateEngine {
  constructor(templatesDir) {
    this.dir = templatesDir;
    this.cache = new Map();
  }

  read(name) {
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) throw new Error(`template not found: ${name}`);
    return fs.readFileSync(file, 'utf8');
  }

  /** Parse the extends tag: { static:true, parent } or { static:false, expr }. */
  extendsOf(src) {
    const m = src.match(EXTENDS_ANY_RE);
    if (!m) return null;
    const raw = m[1].trim();
    const q = raw.match(/^["']([^"']+)["']$/);
    if (q) return { static: true, parent: q[1] };
    return { static: false, expr: translateExpression(preprocess(raw)) };
  }

  /** True when the template picks its parent layout from the context (extends layout). */
  isDynamic(name) {
    const ext = this.extendsOf(this.read(name));
    return Boolean(ext && !ext.static);
  }

  /** Preferred parent candidates for compiling dynamic templates offline. */
  dynamicParents() {
    return ['base.html', 'base_employee.html', 'base_public.html'];
  }

  /** Resolve extends/block inheritance and return flat Jinja source. */
  flatten(name, parentOverride) {
    const frames = [];
    let cur = name;
    let first = true;
    const seen = new Set();
    while (cur) {
      if (seen.has(cur)) throw new Error(`circular extends: ${cur}`);
      seen.add(cur);
      const src = this.read(cur);
      const { body, blocks } = splitBlocks(src);
      let parent = null;
      if (first && parentOverride !== undefined) {
        parent = parentOverride;
      } else {
        const ext = this.extendsOf(src);
        if (ext && !ext.static) {
          throw new Error(`dynamic extends in '${cur}' needs an explicit parent name`);
        }
        parent = ext ? ext.parent : null;
      }
      frames.push({ name: cur, body, blocks });
      cur = parent;
      first = false;
    }

    let result = frames[frames.length - 1].body;
    for (let i = frames.length - 2; i >= 0; i--) {
      const child = frames[i];
      const parent = frames[i + 1];
      result = result.replace(/@@BLOCK:([A-Za-z0-9_]+)@@/g, (m, n) => {
        if (child.blocks[n] !== undefined) return child.blocks[n];
        if (parent.blocks[n] !== undefined) return parent.blocks[n];
        return '';
      });
    }
    return result;
  }

  compileFor(name, parentName) {
    const key = `${name}@@${parentName || ''}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const flat = this.flatten(name, parentName === undefined ? undefined : parentName);
    const translated = translateTags(flat);
    let fn;
    try {
      fn = ejs.compile(translated, {
        filename: path.join(this.dir, name + '.ejs'),
        cache: false,
        rmWhitespace: false,
        _with: true
      });
    } catch (err) {
      err.message = `template ${name}: ${err.message}`;
      throw err;
    }
    this.cache.set(key, fn);
    return fn;
  }

  /** Compile (and cache) a template into a render function. */
  compile(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    if (this.isDynamic(name)) {
      // Parent layout comes from the context (e.g. `layout`); compile per parent on demand.
      const src = this.read(name);
      const ext = this.extendsOf(src);
      const pickParent = new Function('ctx', `with (ctx) { return (${ext.expr}); }`);
      const self = this;
      const fn = (ctx) => {
        const parentName = pickParent(ctx || {});
        return self.compileFor(name, parentName)(ctx || {});
      };
      this.cache.set(name, fn);
      return fn;
    }
    return this.compileFor(name);
  }

  /** Render a template with a context object. */
  render(name, ctx) {
    return this.compile(name)(ctx || {});
  }

  /** Expose the translated EJS source (used by the conversion checker). */
  translatedSource(name, parentName) {
    return translateTags(this.flatten(name, parentName));
  }
}

module.exports = { TemplateEngine, translateTags, splitBlocks, preprocess };
