'use strict';

/**
 * Shared template engine instance. Keeping one instance means every template is
 * flattened + compiled exactly once per server process.
 */

const path = require('path');
const { TemplateEngine } = require('./compiler');

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

module.exports = {
  engine: new TemplateEngine(TEMPLATES_DIR),
  TEMPLATES_DIR
};
