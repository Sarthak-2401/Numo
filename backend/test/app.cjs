const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { createPgConfig } = require('@electric-sql/pglite/node-postgres');
const { Pool } = require('pg');

// Use isolated storage, local phone verification and a capture-only mailer.
Object.assign(process.env, {
  NODE_ENV: 'development', VERCEL: '1', REDIS_URL: '', DATABASE_URL: 'postgres://localhost/test',
  JWT_SECRET: 'isolated-integration-tests', SMTP_DOMAIN: 'numo.test', APP_PUBLIC_URL: 'http://localhost:3000',
  TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_VERIFY_SERVICE_SID: '',
  EXTERNAL_SMTP_USER: '', EXTERNAL_SMTP_PASS: '', RECOVERY_TEST_SMTP_HOST: '',
});
const db = new PGlite({ extensions: { pgcrypto } });
const pool = new Pool({ ...createPgConfig(db), max: 1, idleTimeoutMillis: 0 });
require('../dist/config/database').default = pool;
const app = require('../dist/index').default;
const mailer = require('../dist/services/mailer');
const sms = require('../dist/services/twilio');
const outbox = [];
let server;
let base;

before(async () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/init.sql'), 'utf8');
  await db.exec(schema);
  mailer.sendAccountEmail = async (to, subject, body) => { outbox.push({ to, subject, body }); };
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port + '/api';
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
  await db.close();
});

async function request(route, body, token, method = 'POST') {
  const response = await fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

module.exports = { pool, db, sms, mailer, outbox, request, apiBase: () => base };
