const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { pool, db, sms, mailer, outbox, request } = require('./app.cjs');
const auth = (route, body) => request('/auth/' + route, body);
const settings = token => request('/auth/me', undefined, token, 'GET');
const who = async phone => (await pool.query('SELECT id FROM users WHERE phone=$1', [phone])).rows[0];
function lastCode(email) {
  return outbox.findLast(message => message.to === email && message.subject.includes('Verify')).body.match(/\b\d{8}\b/)[0];
}
function lastLink(email) {
  const body = outbox.findLast(message => message.to === email && message.subject.includes('link')).body;
  const link = new URL(body.match(/http:\/\/[^\s]+/)[0]);
  assert.equal(link.origin + link.pathname, 'http://localhost:3000/recover');
  return link.hash.slice(1);
}
function checkLifetime(token) {
  const claims = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(claims.exp - claims.iat, 14 * 24 * 60 * 60);
  return claims;
}
async function phoneStep(phone, registrationId) {
  const reply = await auth('verify-otp', { phone, code: sms.localTestCode, registrationId });
  assert.equal(reply.status, 200);
  return reply.data;
}
async function enroll(enrollmentToken, email) {
  assert.equal((await auth('enrollment/email', { enrollmentToken, email })).status, 200);
  return auth('enrollment/confirm', { enrollmentToken, code: lastCode(email) });
}

test('signup requires phone and email; confirmation is atomic and the chosen address is permanent', async () => {
  const phone = '+15550101001';
  const email = 'first@example.test';
  const start = await auth('send-otp', { phone });
  assert.equal(start.data.isNewUser, true);
  assert.equal((await auth('verify-otp', { phone, code: '999999' })).status, 400);
  const proof = await phoneStep(phone, start.data.registrationId);
  assert.equal(proof.requiresRecoveryEmail, true);
  assert.equal(proof.token, undefined);
  assert.equal(await who(phone), undefined);
  const { enrollmentToken } = proof;
  assert.equal((await auth('enrollment/email', { enrollmentToken, email: 'me@numo.test' })).status, 400);
  assert.equal((await auth('enrollment/email', { enrollmentToken, email })).status, 200);
  assert.equal((await auth('enrollment/email', { enrollmentToken, email })).status, 429);
  assert.equal((await auth('enrollment/confirm', { enrollmentToken, code: '00000000' })).status, 400);
  assert.equal(await who(phone), undefined);
  const code = lastCode(email);
  const confirmations = await Promise.all([1, 2].map(() => auth('enrollment/confirm', { enrollmentToken, code })));
  assert.deepEqual(confirmations.map(response => response.status).sort(), [201, 400]);
  const session = confirmations.find(response => response.status === 201).data;
  assert.equal(checkLifetime(session.token).userId, session.user.id);
  assert.equal((await who(phone)).id, session.user.id);
  const secondSession = await phoneStep(phone);
  assert.equal(secondSession.user.id, session.user.id);
  assert.equal(secondSession.enrollmentToken, undefined);
  assert.equal((await auth('enrollment/email', { enrollmentToken, email: 'other@example.test' })).status, 410);
  const update = await request('/settings', { recoveryEmail: 'other@example.test' }, session.token, 'PUT');
  assert.equal(update.status, 400);
  await assert.rejects(db.query('UPDATE numo_recovery_contacts SET email=$1 WHERE user_id=$2',
    ['other@example.test', session.user.id]), /verified recovery address is permanent/);
  assert.equal((await pool.query('SELECT email FROM numo_recovery_contacts WHERE user_id=$1', [session.user.id])).rows[0].email, email);
});

test('recovery works during an SMS outage, hides unknown numbers, and rejects expired or reused links', async t => {
  const phone = '+15550101002';
  const email = 'second@example.test';
  const proof = await phoneStep(phone);
  const original = (await enroll(proof.enrollmentToken, email)).data;
  t.mock.method(sms, 'sendOTP', async () => false);
  t.mock.method(sms, 'verifyOTP', async () => false);
  assert.equal((await auth('send-otp', { phone })).status, 503);
  const count = outbox.length;
  const unknown = await auth('recovery/request', { phone: '+15550101999' });
  assert.equal(outbox.length, count);
  const known = await auth('recovery/request', { phone, email: 'ignored@example.test' });
  assert.deepEqual(known, unknown);
  assert.equal(outbox.at(-1).to, email);
  const expired = lastLink(email);
  assert.deepEqual(await auth('recovery/request', { phone }), known);
  assert.equal(outbox.length, count + 1);
  await pool.query("UPDATE numo_recovery_contacts SET link_expires_at = now() - interval '1 second' WHERE user_id=$1", [original.user.id]);
  assert.equal((await auth('recovery/confirm', { token: expired })).status, 400);
  await pool.query('DELETE FROM numo_auth_limits');
  await auth('recovery/request', { phone });
  const replaced = lastLink(email);
  await pool.query('DELETE FROM numo_auth_limits');
  await auth('recovery/request', { phone });
  assert.equal((await auth('recovery/confirm', { token: replaced })).status, 400);
  const token = lastLink(email);
  const clicks = await Promise.all([1, 2].map(() => auth('recovery/confirm', { token })));
  assert.deepEqual(clicks.map(reply => reply.status).sort(), [200, 400]);
  const fresh = clicks.find(reply => reply.status === 200).data;
  assert.equal(checkLifetime(fresh.token).userId, original.user.id);
  assert.equal((await settings(fresh.token)).status, 200);
  assert.equal((await request('/auth/logout', {}, fresh.token)).status, 204);
  assert.equal((await settings(fresh.token)).status, 401);
  assert.equal((await settings(original.token)).status, 200);
  const ended = jwt.sign({ userId: original.user.id, phone, email: original.user.email }, process.env.JWT_SECRET, { expiresIn: -1 });
  assert.equal((await settings(ended)).status, 401);
});

test('pre-existing users enroll once after phone verification and keep their mailbox', async () => {
  const phone = '+15550101003';
  const mailbox = '5550101003@numo.test';
  const old = (await pool.query('INSERT INTO users (phone,email,display_name) VALUES ($1,$2,$3) RETURNING id', [phone, mailbox, 'Existing User'])).rows[0];
  const oldToken = jwt.sign({ userId: old.id, phone, email: mailbox }, process.env.JWT_SECRET, { expiresIn: '7d' });
  assert.equal((await settings(oldToken)).status, 200);
  const n = outbox.length;
  await auth('recovery/request', { phone });
  assert.equal(outbox.length, n);
  const setup = await phoneStep(phone);
  const done = await enroll(setup.enrollmentToken, 'legacy@example.test');
  assert.equal(done.status, 200);
  assert.equal(done.data.user.id, old.id);
  assert.equal(done.data.user.displayName, 'Existing User');
  assert.equal((await phoneStep(phone)).enrollmentToken, undefined);
});

test('password signup requires both verifications and retains the chosen password', async () => {
  const phone = '+15550101004';
  const password = 'test-only-password';
  const start = await auth('register', { phone, password });
  assert.equal(start.data.token, undefined);
  assert.equal((await auth('login', { phone, password })).status, 404);
  assert.equal((await auth('verify-otp', { phone, code: sms.localTestCode, registrationId: 'expired' })).status, 400);
  const proof = await phoneStep(phone, start.data.registrationId);
  assert.equal((await enroll(proof.enrollmentToken, 'password@example.test')).status, 201);
  assert.equal((await auth('login', { phone, password: 'wrong' })).status, 401);
  checkLifetime((await auth('login', { phone, password })).data.token);
});

test('mail delivery failure and expired, superseded or exhausted signup codes cannot finish signup', async t => {
  const phone = '+15550101005';
  const email = 'retry@example.test';
  const { enrollmentToken } = await phoneStep(phone);
  const failing = t.mock.method(mailer, 'sendAccountEmail', async () => { throw new Error('Test delivery failure'); });
  assert.equal((await auth('enrollment/email', { enrollmentToken, email })).status, 503);
  assert.equal(await who(phone), undefined);
  failing.mock.restore();
  await pool.query('DELETE FROM numo_auth_limits');
  await auth('enrollment/email', { enrollmentToken, email });
  const code = lastCode(email);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await auth('enrollment/confirm', { enrollmentToken, code: '00000000' })).status, 400);
  }
  assert.equal((await auth('enrollment/confirm', { enrollmentToken, code })).status, 400);
  const restarted = (await phoneStep(phone)).enrollmentToken;
  await pool.query('DELETE FROM numo_auth_limits');
  await auth('enrollment/email', { enrollmentToken: restarted, email });
  assert.equal((await auth('enrollment/confirm', { enrollmentToken, code })).status, 400);
  await pool.query("UPDATE numo_enrollments SET code_expires_at = now() - interval '1 second' WHERE phone=$1", [phone]);
  assert.equal((await auth('enrollment/confirm', { enrollmentToken: restarted, code: lastCode(email) })).status, 400);
  assert.equal(await who(phone), undefined);
});
