import { PoolClient } from 'pg';
import pool from '../config/database';

export const attachmentFields = 'id, filename, mime_type, size_bytes, content IS NOT NULL AS available';
export const mailAccess = `(e.sender_id = $2 OR EXISTS (
  SELECT 1 FROM email_recipients r WHERE r.email_id = e.id AND r.recipient_email = $3))`;
const maxBytes = 3 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
let schemaReady: Promise<unknown> | undefined;

export function ensureAttachmentStorage() {
  return schemaReady ??= pool.query('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS content BYTEA')
    .catch(err => { schemaReady = undefined; throw err; });
}

export class AttachmentError extends Error {}
export interface MailFile { filename: string; contentType: string; content: Buffer }

export async function readAttachments(client: PoolClient, values: unknown, userId?: string, email?: string) {
  if (!Array.isArray(values) || values.length > 5) throw new AttachmentError('Choose up to 5 attachments.');
  const files: MailFile[] = [];
  let remaining = maxBytes;
  for (const item of values) {
    let file: MailFile;
    if (typeof item?.id === 'string' && uuid.test(item.id)) {
      const result = await client.query(`SELECT a.filename, a.mime_type AS "contentType", a.content
        FROM attachments a JOIN emails e ON e.id = a.email_id
        WHERE a.id = $1 AND a.content IS NOT NULL AND ${mailAccess}`, [item.id, userId, email]);
      if (!result.rowCount) throw new AttachmentError('A forwarded file is unavailable.');
      file = result.rows[0];
    } else {
      const { filename, content, contentType } = item || {};
      if (typeof filename !== 'string' || !filename.trim() || filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(filename))
        throw new AttachmentError('An attachment has an invalid filename.');
      if (typeof content !== 'string' || content.length > Math.ceil(remaining / 3) * 4)
        throw new AttachmentError('Attachments must total 3 MiB or less.');
      const bytes = Buffer.from(content, 'base64');
      if (bytes.toString('base64') !== content) throw new AttachmentError('Invalid attachment data.');
      const mime = typeof contentType === 'string' && contentType.length <= 100 &&
        /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType) ? contentType : 'application/octet-stream';
      file = { filename, content: bytes, contentType: mime };
    }
    remaining -= file.content.length;
    if (remaining < 0) throw new AttachmentError('Attachments must total 3 MiB or less.');
    files.push(file);
  }
  return files;
}
