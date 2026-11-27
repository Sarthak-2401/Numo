import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/database';
import { digest, sessionSecret } from '../services/session';

export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
  userPhone?: string;
  sessionHash?: string;
  sessionExpiry?: number;
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }
  const token = header.slice(7);
  try {
    const claims = jwt.verify(token, sessionSecret(), { algorithms: ['HS256'] });
    if (typeof claims === 'string' || !claims.userId || !claims.phone || !claims.email || !claims.exp) {
      throw new Error('Invalid session');
    }
    req.userId = claims.userId;
    req.userEmail = claims.email;
    req.userPhone = claims.phone;
    req.sessionExpiry = claims.exp;
    req.sessionHash = digest(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }
  try {
    const revoked = await pool.query('SELECT 1 FROM numo_revoked_sessions WHERE hash = $1', [req.sessionHash]);
    if (revoked.rowCount) {
      res.status(401).json({ error: 'Signed out' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
