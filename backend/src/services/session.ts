import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

const developmentSecret = 'numo-local-development-key';
const sessionKey = process.env.JWT_SECRET || developmentSecret;
if (process.env.NODE_ENV === 'production' && sessionKey === developmentSecret) {
  throw new Error('Configure a private JWT_SECRET before starting Numo in production.');
}
export const sessionSecret = () => sessionKey;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export interface Account {
  id: string;
  phone: string;
  email: string;
  display_name: string;
  profile_picture?: string;
  language?: string;
}

export function sessionFor(user: Account) {
  return {
    user: { id: user.id, phone: user.phone, email: user.email, displayName: user.display_name,
      profilePicture: user.profile_picture, language: user.language },
    token: jwt.sign({ userId: user.id, phone: user.phone, email: user.email }, sessionSecret(),
      { jwtid: randomUUID(), expiresIn: '14d' }),
  };
}
