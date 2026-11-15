'use strict';

/**
 * Storage driver selection.
 *
 *   STORAGE_DRIVER=local        (default) files live in the project directory
 *   STORAGE_DRIVER=vercel-blob  files live in Vercel Blob (serverless-safe)
 *
 * The vercel-blob driver is required on Vercel because a serverless function's
 * filesystem is read-only apart from an ephemeral /tmp.
 */

const driver = process.env.STORAGE_DRIVER || 'local';

if (driver === 'vercel-blob') {
  module.exports = require('./blob');
} else {
  module.exports = require('./local');
}

module.exports.driverName = driver;
