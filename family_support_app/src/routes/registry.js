'use strict';

/**
 * Route registration helper.
 *
 * Every route declares its Flask endpoint name; that name is used for
 * url_for() in templates and for the role allow-lists, so the Express port
 * behaves like the original app.
 */

const { registerRoute } = require('../jinja/context');
const { requireAuth } = require('../middlewares/authMiddleware');

function def(router, spec) {
  const {
    name,
    method = 'get',
    path,
    handler,
    auth = true,
    middleware = []
  } = spec;

  registerRoute(name, path);

  const pre = [];
  if (auth) pre.push(requireAuth);
  pre.push(...middleware);

  const wrapped = async (req, res, next) => {
    req.endpointName = name;
    try {
      await handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };

  const methods = Array.isArray(method) ? method : [method];
  for (const m of methods) {
    router[String(m).toLowerCase()](path, ...pre, wrapped);
  }
}

module.exports = { def };
