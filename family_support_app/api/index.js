'use strict';

/**
 * Vercel serverless entry point.
 *
 * All traffic is rewritten to this function by vercel.json, which then hands
 * the request to the same Express app used by `npm start`.
 */

const { createApp } = require('../src/app');

const app = createApp();

module.exports = app;
