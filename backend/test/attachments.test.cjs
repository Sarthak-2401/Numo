const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { db, pool, request, apiBase, mailer } = require('./app.cjs');
const { sessionFor } = require('../dist/services/session');

let sender, recipient, other;
before(async () => {
  // Exercise the upgrade path for an existing mailbox database.
  await db.exec('ALTER TABLE attachments DROP COLUMN content');
  const accounts = [];
  for (const digits of ['1111111111', '2222222222', '3333333333']) {
    const { rows } = await pool.query('INSERT INTO users(phone, email) VALUES ($1,$2) RETURNING *', ['+1' + digits, digits + '@numo.test']);
    accounts.push(sessionFor(rows[0]));
  }
  [sender, recipient, other] = accounts;
});
const binary = Buffer.from([0, 13, 10, 128, 255, 42]);
const attachment = { filename: 'résumé.bin', contentType: 'application/octet-stream', content: binary.toString('base64') };
function send(session, to, files, clientMessageId = randomUUID()) {
  return request('/emails/send', { to: [to], clientMessageId, body: '', attachments: files }, session.token);
}
function download(session, message, file) {
  return fetch(`${apiBase()}/emails/${message}/attachments/${file}`, { headers: { Authorization: 'Bearer ' + session.token } });
}

test('files survive sending, listing, retrying and downloading; only message participants have access', async () => {
  const id = randomUUID();
  const result = await send(sender, recipient.user.email, [attachment], id);
  assert.equal(result.status, 201);
  const [file] = result.data.email.attachments;
  assert.equal(file.filename, attachment.filename);
  assert.equal(file.available, true);
  assert.equal(file.size_bytes, binary.length);
  const retry = await send(sender, recipient.user.email, [attachment], id);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.email.attachments, [file]);
  for (const [account, folder] of [[sender, 'sent'], [recipient, 'inbox']]) {
    const inbox = await request('/emails?folder=' + folder, undefined, account.token, 'GET');
    assert.deepEqual(inbox.data.emails.find(email => email.id === id).attachments, [file]);
    const response = await download(account, id, file.id);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Disposition'), /^attachment/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), binary);
  }
  assert.equal((await download(other, id, file.id)).status, 404);
  assert.equal((await request('/emails/' + id, undefined, other.token, 'DELETE')).status, 404);
  const forward = await send(recipient, other.user.email, [{ id: file.id }]);
  assert.equal(forward.status, 201);
  const forwarded = forward.data.email;
  assert.deepEqual(Buffer.from(await (await download(other, forwarded.id, forwarded.attachments[0].id)).arrayBuffer()), binary);
  assert.equal((await send(other, sender.user.email, [{ id: file.id }])).status, 400);
});

test('external delivery receives the file bytes and failed deliveries roll back', async t => {
  const relay = t.mock.method(mailer, 'sendExternalEmail', async (...args) => {
    assert.deepEqual(args.at(-1), [{ filename: attachment.filename, content: binary, contentType: attachment.contentType }]);
    return true;
  });
  assert.equal((await send(sender, 'receiver@example.test', [attachment])).status, 201);
  assert.equal(relay.mock.callCount(), 1);
  relay.mock.mockImplementation(async () => false);
  const id = randomUUID();
  assert.equal((await send(sender, 'receiver@example.test', [attachment], id)).status, 502);
  assert.equal((await pool.query('SELECT id FROM attachments WHERE email_id=$1', [id])).rowCount, 0);
});

test('file count, combined size and encoding are validated; empty files remain downloadable', async () => {
  for (const files of [Array(6).fill(attachment), [{ ...attachment, content: 'invalid' }],
    [attachment, { ...attachment, content: Buffer.alloc(3 * 1024 * 1024).toString('base64') }]]) {
    assert.equal((await send(sender, recipient.user.email, files)).status, 400);
  }
  const empty = await send(sender, recipient.user.email, [{ ...attachment, content: '' }]);
  assert.equal(empty.status, 201);
  const { id, attachments } = empty.data.email;
  assert.equal((await (await download(recipient, id, attachments[0].id)).arrayBuffer()).byteLength, 0);
  await pool.query('UPDATE attachments SET content=NULL WHERE email_id=$1', [id]);
  const old = await request('/emails/' + id, undefined, recipient.token, 'GET');
  assert.equal(old.data.email.attachments[0].available, false);
  assert.equal((await download(recipient, id, attachments[0].id)).status, 404);
});
