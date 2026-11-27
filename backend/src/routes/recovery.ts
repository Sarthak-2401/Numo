import { Router } from 'express';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import pool from '../config/database';
import { sendAccountEmail } from '../services/mailer';
import { digest, sessionFor } from '../services/session';
import { normalizePhone } from '../services/twilio';

const router = Router();
const mailboxDomain = process.env.SMTP_DOMAIN || 'numo.local';
const genericReply = { message: 'If this number has a verified recovery email, we’ve sent a sign-in link.' };
const newToken = () => randomBytes(32).toString('hex');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const codeHash = (proof: string, code: string) => createHmac('sha256', proof).update(code).digest('hex');

export async function beginEnrollment(phone: string, userId: string | null, method: string, passwordHash?: string) {
  const proof = newToken();
  await pool.query('DELETE FROM numo_enrollments WHERE expires_at <= now()');
  await pool.query(`INSERT INTO numo_enrollments (phone, proof_hash, expires_at, existing_user_id, method, password_hash)
    VALUES ($1, $2, now() + interval '30 minutes', $3, $4, $5)
    ON CONFLICT (phone) DO UPDATE SET proof_hash = EXCLUDED.proof_hash, expires_at = EXCLUDED.expires_at,
      existing_user_id = EXCLUDED.existing_user_id, method = EXCLUDED.method, password_hash = EXCLUDED.password_hash,
      email = NULL, code_hash = NULL, code_expires_at = NULL, attempts = 0`,
    [phone, digest(proof), userId, method, passwordHash || null]);
  return { requiresRecoveryEmail: true, enrollmentToken: proof };
}

// Atomic counters are shared by all API instances. Only hashes of destinations are stored here.
async function allow(key: string, max: number, seconds: number) {
  const result = await pool.query(`INSERT INTO numo_auth_limits (key, count, expires_at)
    VALUES ($1, 1, now() + $2 * interval '1 second') ON CONFLICT (key) DO UPDATE
    SET count = CASE WHEN numo_auth_limits.expires_at <= now() THEN 1 ELSE numo_auth_limits.count + 1 END,
        expires_at = CASE WHEN numo_auth_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE numo_auth_limits.expires_at END
    WHERE numo_auth_limits.expires_at <= now() OR numo_auth_limits.count < $3 RETURNING count`,
    [digest(key), seconds, max]);
  return Boolean(result.rowCount);
}

function externalAddress(input: unknown) {
  if (typeof input !== 'string' || input.length > 254) return;
  const email = input.trim();
  const parts = email.split('@');
  if (parts.length !== 2) return;
  const [local, domain] = parts;
  if (local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local)) return;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) return;
  if (domain.toLowerCase() === mailboxDomain.toLowerCase()) return;
  return local + '@' + domain.toLowerCase();
}

router.post('/enrollment/email', async (req, res, next) => {
  const { enrollmentToken } = req.body;
  const email = externalAddress(req.body.email);
  if (!email || !validToken(enrollmentToken)) {
    res.status(400).json({ error: 'Enter an external email address you can access.' }); return;
  }
  try {
    const hash = digest(enrollmentToken);
    const pending = await pool.query('SELECT phone FROM numo_enrollments WHERE proof_hash=$1 AND expires_at > now()', [hash]);
    if (!pending.rowCount) { res.status(410).json({ error: 'Setup expired. Verify your phone again.' }); return; }
    await pool.query('DELETE FROM numo_auth_limits WHERE expires_at <= now()');
    if (!await allow('setup:' + pending.rows[0].phone, 1, 60) || !await allow('email:' + email.toLowerCase(), 5, 3600)) {
      res.status(429).json({ error: 'Too many code requests. Try again later.' }); return;
    }
    const code = randomInt(10000000, 100000000).toString();
    const saved = await pool.query(`UPDATE numo_enrollments SET email=$2, code_hash=$3,
      code_expires_at=now() + interval '15 minutes', attempts=5
      WHERE proof_hash=$1 AND expires_at > now()`, [hash, email, codeHash(enrollmentToken, code)]);
    if (!saved.rowCount) { res.status(410).json({ error: 'Setup expired. Verify your phone again.' }); return; }
    try {
      await sendAccountEmail(email, 'Verify your Numo recovery email',
        `Enter this code in the Numo signup window: ${code}\nIt expires in 15 minutes. Once verified, this address is permanent. If you did not request this code, ignore this email.`);
    } catch {
      res.status(503).json({ error: 'Numo could not send the verification email. Check mail delivery and try again.' }); return;
    }
    res.json({ message: 'Verification code sent.' });
  } catch (err) { next(err); }
});

router.post('/enrollment/confirm', async (req, res, next) => {
  const { enrollmentToken, code } = req.body;
  if (!validToken(enrollmentToken) || typeof code !== 'string' || !/^\d{8}$/.test(code)) {
    res.status(400).json({ error: 'Enter the eight-digit code from your email.' }); return;
  }
  const client = await pool.connect().catch(next);
  if (!client) return;
  try {
    await client.query('BEGIN');
    const hash = digest(enrollmentToken);
    const pending = await client.query(`SELECT * FROM numo_enrollments WHERE proof_hash=$1 AND expires_at > now()
      AND code_expires_at > now() AND attempts > 0 FOR UPDATE`, [hash]);
    const row = pending.rows[0];
    if (!row || row.code_hash !== codeHash(enrollmentToken, code)) {
      if (row) await client.query('UPDATE numo_enrollments SET attempts=attempts-1 WHERE proof_hash=$1', [hash]);
      await client.query('COMMIT');
      res.status(400).json({ error: 'Invalid or expired code. Request a new email code if needed.' }); return;
    }
    const digits = row.phone.replace(/\D/g, '').slice(-10);
    const account = row.existing_user_id
      ? await client.query('SELECT * FROM users WHERE id=$1 AND phone=$2 FOR UPDATE', [row.existing_user_id, row.phone])
      : await client.query(`INSERT INTO users (phone,email,display_name,registration_method,password_hash)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,
          [row.phone, digits + '@' + mailboxDomain, digits, row.method, row.password_hash]);
    const user = account.rows[0];
    const inserted = user && await client.query(`INSERT INTO numo_recovery_contacts (user_id,email)
      VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, row.email]);
    if (!inserted?.rowCount) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'This account or mailbox is already registered. Sign in again.' }); return;
    }
    await client.query('DELETE FROM numo_enrollments WHERE proof_hash=$1', [hash]);
    const session = sessionFor(user);
    await client.query('COMMIT');
    res.status(row.existing_user_id ? 200 : 201).json({ ...session, isNewUser: !row.existing_user_id });
  } catch (error) {
    await client.query('ROLLBACK'); next(error);
  } finally { client.release(); }
});

function recoveryUrl(token: string) {
  const configured = process.env.APP_PUBLIC_URL || (process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : '');
  const url = new URL(configured);
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Invalid APP_PUBLIC_URL');
  return new URL('/recover#' + token, url.origin).href;
}

router.post('/recovery/request', async (req, res, next) => {
  const phone = typeof req.body.phone === 'string' ? normalizePhone(req.body.phone) : '';
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    res.status(400).json({ error: 'Enter a phone number with its country code.' }); return;
  }
  try {
    const raw = newToken();
    const link = recoveryUrl(raw);
    await pool.query('DELETE FROM numo_auth_limits WHERE expires_at <= now()');
    if (await allow('recovery-ip:' + req.ip, 40, 900) && await allow('recovery:' + phone, 1, 60)
        && await allow('recovery-hour:' + phone, 5, 3600)) {
      const contact = await pool.query(`UPDATE numo_recovery_contacts r SET link_hash=$2,
        link_expires_at=now() + interval '15 minutes' FROM users u
        WHERE u.id=r.user_id AND u.phone=$1 RETURNING r.email`, [phone, digest(raw)]);
      if (contact.rowCount) {
        try {
          await sendAccountEmail(contact.rows[0].email, 'Your Numo sign-in link',
            `Open this link and select Sign in to access your Numo mailbox:\n${link}\n\nThe link works once and expires in 15 minutes. If you did not request it, ignore this email.`);
        } catch { console.error('Recovery email delivery failed. Check the configured mail relay.'); }
      }
    }
    res.json(genericReply);
  } catch (err) { next(err); }
});

router.post('/recovery/confirm', async (req, res, next) => {
  const { token } = req.body;
  const invalid = { error: 'This link expired or was already used. Request a new sign-in link.' };
  if (!validToken(token)) { res.status(400).json(invalid); return; }
  try {
    const account = await pool.query(`UPDATE numo_recovery_contacts r SET link_hash=NULL, link_expires_at=NULL
      FROM users u WHERE r.user_id=u.id AND r.link_hash=$1 AND r.link_expires_at > now() RETURNING u.*`, [digest(token)]);
    if (!account.rowCount) { res.status(400).json(invalid); return; }
    res.json(sessionFor(account.rows[0]));
  } catch (err) { next(err); }
});

export default router;
