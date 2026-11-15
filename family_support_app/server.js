'use strict';

/** Local development / self-hosted server. */

const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(PORT, () => {
  console.log(`Family Support portal (Express) listening on http://localhost:${PORT}`);
  console.log(`Storage driver: ${require('./src/storage').driverName}`);
});
