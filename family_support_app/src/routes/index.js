'use strict';

/**
 * Route aggregator. Additional ported groups (admin, analytics, records) are
 * mounted here as soon as their modules land — guarded requires keep the app
 * bootable while the port is still in progress.
 */

const express = require('express');

const router = express.Router();

router.use('/', require('./auth'));
router.use('/', require('./families'));
router.use('/', require('./health'));
router.use('/', require('./familydata'));
router.use('/', require('./shop'));
router.use('/', require('./community'));
router.use('/', require('./pipeline'));

function tryMount(path) {
  try {
    router.use('/', require(path));
    console.log(`[routes] mounted .${path}`);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      console.log(`[routes] skipping .${path} (not ported yet)`);
    } else {
      throw err;
    }
  }
}

tryMount('./admin');
tryMount('./analytics');
tryMount('./records');

module.exports = router;
