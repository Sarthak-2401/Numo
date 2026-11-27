import { Router, Response } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pool from '../config/database';
import redis from '../config/redis';
import { sendOTP, verifyOTP, localSmsTesting, localTestCode, normalizePhone } from '../services/twilio';
import { sessionFor, digest } from '../services/session';
import { beginEnrollment } from './recovery';
import { AuthRequest, authMiddleware } from '../middleware/auth';

const router = Router();
const phoneFrom = (value: unknown) => {
  const phone = typeof value === 'string' ? normalizePhone(value) : '';
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : '';
};

async function findAccount(phone: string) {
  const result = await pool.query(`SELECT u.*, r.user_id IS NOT NULL AS enrolled
    FROM users u LEFT JOIN numo_recovery_contacts r ON r.user_id=u.id WHERE u.phone=$1`, [phone]);
  return result.rows[0];
}

router.post(['/register', '/send-otp'], async (req, res, next) => {
  const phone = phoneFrom(req.body.phone);
  if (!phone) { res.status(400).json({ error: 'Enter a valid phone number.' }); return; }
  try {
    const user = await findAccount(phone);
    const registering = req.path === '/register';
    if (registering && user) { res.status(409).json({ error: 'Account already exists.' }); return; }
    if (!await sendOTP(phone)) {
      res.status(503).json({ error: 'SMS is unavailable. For an existing account, use email recovery.' }); return;
    }
    // A password supplied by an API client travels only with that client's signup attempt.
    let registrationId: string | undefined;
    if (!user) {
      registrationId = randomBytes(32).toString('hex');
      const passwordHash = registering && req.body.password ? await bcrypt.hash(req.body.password, 12) : undefined;
      await redis.setex('pending_reg:' + digest(registrationId), 600,
        JSON.stringify({ phone, method: String(req.body.method || 'web').slice(0, 20), passwordHash }));
    }
    res.json({ message: 'OTP sent', requiresOTP: true, isNewUser: !user, registrationId,
      ...(localSmsTesting && { devHint: 'Local test code: ' + localTestCode }) });
  } catch (err) { next(err); }
});

router.post('/verify-otp', async (req, res, next) => {
  const phone = phoneFrom(req.body.phone);
  const { code, registrationId } = req.body;
  if (!phone || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: 'Enter the six-digit SMS code.' }); return;
  }
  try {
    if (!await verifyOTP(phone, code)) { res.status(400).json({ error: 'Invalid or expired OTP.' }); return; }
    const user = await findAccount(phone);
    if (user?.enrolled) { res.json({ ...sessionFor(user), isNewUser: false }); return; }
    let method = 'web';
    let passwordHash: string | undefined;
    if (!user && registrationId !== undefined) {
      const pending = typeof registrationId === 'string' && /^[0-9a-f]{64}$/.test(registrationId)
        ? await redis.get('pending_reg:' + digest(registrationId)) : null;
      const registration = pending && JSON.parse(pending);
      if (!registration || registration.phone !== phone) {
        res.status(400).json({ error: 'This signup attempt expired. Request a new SMS code.' }); return;
      }
      method = registration.method;
      passwordHash = registration.passwordHash;
    }
    res.json(await beginEnrollment(phone, user?.id || null, method, passwordHash));
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  const phone = phoneFrom(req.body.phone);
  if (!phone) { res.status(400).json({ error: 'Enter a valid phone number.' }); return; }
  try {
    const user = await findAccount(phone);
    if (!user) { res.status(404).json({ error: 'Account not found' }); return; }
    if (user.password_hash) {
      if (!req.body.password || !await bcrypt.compare(req.body.password, user.password_hash)) {
        res.status(401).json({ error: 'Invalid password' }); return;
      }
      if (user.enrolled) { res.json(sessionFor(user)); return; }
    }
    if (!await sendOTP(phone)) { res.status(503).json({ error: 'Failed to send OTP' }); return; }
    res.json({ message: 'OTP sent', requiresOTP: true });
  } catch (err) { next(err); }
});

router.post('/logout', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    await pool.query('DELETE FROM numo_revoked_sessions WHERE expires_at <= now()');
    await pool.query('INSERT INTO numo_revoked_sessions (hash,expires_at) VALUES ($1,to_timestamp($2)) ON CONFLICT DO NOTHING',
      [req.sessionHash, req.sessionExpiry]);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

/**
 * GET /api/auth/me
 * Get current user profile
 */
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT id, phone, email, display_name, profile_picture, language, 
              registration_method, has_mobile_app, created_at
       FROM users WHERE id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = result.rows[0];
    
    // Get aliases
    const aliases = await pool.query(
      'SELECT id, alias_email, display_name, is_active FROM aliases WHERE user_id = $1',
      [req.userId]
    );

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        displayName: user.display_name,
        profilePicture: user.profile_picture,
        language: user.language,
        registrationMethod: user.registration_method,
        hasMobileApp: user.has_mobile_app,
        createdAt: user.created_at,
        aliases: aliases.rows,
      },
    });
  } catch (error) {
    console.error('❌ Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
