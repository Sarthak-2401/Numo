import { Router, Response } from 'express';
import pool from '../config/database';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { sendExternalEmail } from '../services/mailer';
import { attachmentFields, AttachmentError, ensureAttachmentStorage, mailAccess, readAttachments } from '../services/attachments';

const router = Router();

// All email routes require authentication
router.use(authMiddleware);
router.use((_req, _res, next) => { ensureAttachmentStorage().then(() => next(), next); });

const SMTP_DOMAIN = process.env.SMTP_DOMAIN || 'numo.local';

/**
 * GET /api/emails
 * Get all emails / inbox with filters
 */
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Auto-delete trash older than 15 days
    await pool.query(
      `DELETE FROM emails WHERE is_trash = TRUE AND created_at < NOW() - INTERVAL '15 days'`
    );

    const { filter = 'all', folder = 'inbox', page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = '';
    let params: any[] = [req.userEmail, Number(limit), offset];

    if (folder === 'sent') {
      query = `
        SELECT e.*, u.display_name as sender_name, u.phone as sender_phone
        FROM emails e
        LEFT JOIN users u ON e.sender_id = u.id
        WHERE e.sender_email = $1
        AND e.is_draft = FALSE AND e.is_trash = FALSE AND e.is_spam = FALSE
      `;
    } else if (folder === 'drafts') {
      query = `
        SELECT e.*, u.display_name as sender_name, u.phone as sender_phone
        FROM emails e
        LEFT JOIN users u ON e.sender_id = u.id
        WHERE e.sender_id = (SELECT id FROM users WHERE email = $1)
        AND e.is_draft = TRUE
      `;
    } else if (folder === 'spam') {
      query = `
        SELECT e.*, u.display_name as sender_name, u.phone as sender_phone
        FROM emails e
        LEFT JOIN users u ON e.sender_id = u.id
        JOIN email_recipients er ON e.id = er.email_id
        WHERE er.recipient_email = $1
        AND e.is_spam = TRUE AND e.is_trash = FALSE
      `;
    } else if (folder === 'trash') {
      query = `
        SELECT e.*, u.display_name as sender_name, u.phone as sender_phone
        FROM emails e
        LEFT JOIN users u ON e.sender_id = u.id
        JOIN email_recipients er ON e.id = er.email_id
        WHERE (er.recipient_email = $1 OR e.sender_email = $1)
        AND e.is_trash = TRUE
      `;
    } else {
      // inbox
      query = `
        SELECT e.*, u.display_name as sender_name, u.phone as sender_phone,
               er.is_read as recipient_read
        FROM emails e
        LEFT JOIN users u ON e.sender_id = u.id
        JOIN email_recipients er ON e.id = er.email_id
        WHERE er.recipient_email = $1
        AND e.is_draft = FALSE AND e.is_trash = FALSE AND e.is_spam = FALSE
      `;
    }

    // Apply filters
    if (filter === 'unread') {
      if (folder === 'inbox') {
        query += ` AND er.is_read = FALSE`;
      } else {
        query += ` AND e.is_read = FALSE`;
      }
    } else if (filter === 'attachments') {
      query += ` AND e.has_attachments = TRUE`;
    } else if (filter === 'favorites') {
      query += ` AND e.is_favorite = TRUE`;
    }

    query += ` ORDER BY e.created_at DESC LIMIT $2 OFFSET $3`;

    const result = await pool.query(query, params);
    const withFiles = result.rows.filter(email => email.has_attachments).map(email => email.id);
    const filesByEmail = new Map<string, any[]>();
    if (withFiles.length) {
      const files = await pool.query(`SELECT email_id, ${attachmentFields} FROM attachments
        WHERE email_id = ANY($1::uuid[]) ORDER BY created_at, id`, [withFiles]);
      for (const { email_id, ...file } of files.rows) {
        if (!filesByEmail.has(email_id)) filesByEmail.set(email_id, []);
        filesByEmail.get(email_id)!.push(file);
      }
    }

    // Get recipients for each email
    const emails = await Promise.all(
      result.rows.map(async (email) => {
        const recipients = await pool.query(
          'SELECT recipient_email, recipient_type, is_read FROM email_recipients WHERE email_id = $1',
          [email.id]
        );
        return {
          ...email,
          is_read: folder === 'inbox' ? email.recipient_read : email.is_read,
          attachments: filesByEmail.get(email.id) || [],
          recipients: recipients.rows,
        };
      })
    );

    res.json({ emails, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('❌ Get emails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/emails/:id/read
 * Mark an email as read
 */
router.put('/:id/read', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    
    // Update sender's read status (if they sent it and opened it from Sent box)
    await pool.query('UPDATE emails SET is_read = TRUE WHERE id = $1 AND sender_email = $2', [id, req.userEmail]);
    
    // Update recipient's read status (if they received it and opened it from Inbox)
    await pool.query('UPDATE email_recipients SET is_read = TRUE WHERE email_id = $1 AND recipient_email = $2', [id, req.userEmail]);
    
    res.json({ success: true, message: 'Email marked as read' });
  } catch (error) {
    console.error('❌ Mark as read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/emails/conversations
 * Get all conversations (chat-style grouping)
 */
router.get('/conversations', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT c.*, 
              (SELECT COUNT(*) FROM emails e 
               JOIN email_recipients er ON e.id = er.email_id
               WHERE e.conversation_id = c.id 
               AND er.recipient_email = $1 
               AND er.is_read = FALSE) as unread_count,
              (SELECT json_build_object(
                'subject', e2.subject, 
                'body', LEFT(e2.body, 100), 
                'created_at', e2.created_at,
                'sender_name', u2.display_name
              ) FROM emails e2 
              LEFT JOIN users u2 ON e2.sender_id = u2.id
              WHERE e2.conversation_id = c.id 
              ORDER BY e2.created_at DESC LIMIT 1) as last_email
       FROM conversations c
       JOIN conversation_participants cp ON c.id = cp.conversation_id
       WHERE cp.user_id = (SELECT id FROM users WHERE email = $1)
       ORDER BY c.last_message_at DESC`,
      [req.userEmail]
    );

    // Get participants for each conversation
    const conversations = await Promise.all(
      result.rows.map(async (conv) => {
        const participants = await pool.query(
          `SELECT u.id, u.phone, u.email, u.display_name, u.profile_picture
           FROM conversation_participants cp
           JOIN users u ON cp.user_id = u.id
           WHERE cp.conversation_id = $1`,
          [conv.id]
        );
        return {
          ...conv,
          participants: participants.rows,
        };
      })
    );

    res.json({ conversations });
  } catch (error) {
    console.error('❌ Get conversations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/emails/conversation/:id
 * Get all emails in a conversation
 */
router.get('/conversation/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT e.*, u.display_name as sender_name, u.phone as sender_phone,
              u.profile_picture as sender_picture
       FROM emails e
       LEFT JOIN users u ON e.sender_id = u.id
       WHERE e.conversation_id = $1 AND ${mailAccess}
       ORDER BY e.created_at ASC`,
      [id, req.userId, req.userEmail]
    );

    // Mark as read
    await pool.query(
      `UPDATE email_recipients SET is_read = TRUE
       WHERE email_id IN (SELECT id FROM emails WHERE conversation_id = $1)
       AND recipient_email = $2`,
      [id, req.userEmail]
    );

    // Get recipients for each email
    const emails = await Promise.all(
      result.rows.map(async (email) => {
        const recipients = await pool.query(
          'SELECT recipient_email, recipient_type, is_read FROM email_recipients WHERE email_id = $1',
          [email.id]
        );
        const attachments = await pool.query(
          `SELECT ${attachmentFields} FROM attachments WHERE email_id = $1 ORDER BY created_at, id`,
          [email.id]
        );
        return {
          ...email,
          recipients: recipients.rows,
          attachments: attachments.rows,
        };
      })
    );

    res.json({ emails });
  } catch (error) {
    console.error('❌ Get conversation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/emails/send
 * Send a new email
 */
router.post('/send', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { to, cc = [], bcc = [], subject, body, htmlBody, isDraft = false, replyToEmailId, clientMessageId } = req.body;
    if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientMessageId))) {
      res.status(400).json({ error: 'Invalid message identifier' });
      return;
    }

    if (!isDraft && (!to || to.length === 0)) {
      res.status(400).json({ error: 'At least one recipient is required' });
      return;
    }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (clientMessageId) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clientMessageId]);
          const previous = await client.query(
            'SELECT id, sender_id, conversation_id, subject, created_at FROM emails WHERE id = $1', [clientMessageId]
          );
          if (previous.rows.length) {
            const email = previous.rows[0];
            if (email.sender_id !== req.userId) {
              await client.query('ROLLBACK');
              res.status(409).json({ error: 'Message identifier unavailable' });
              return;
            }
            const acceptedFiles = await client.query(`SELECT ${attachmentFields} FROM attachments WHERE email_id=$1`, [email.id]);
            await client.query('COMMIT');
            res.json({ message: 'Already sent', email: {
              id: email.id, conversationId: email.conversation_id, subject: email.subject, createdAt: email.created_at,
              attachments: acceptedFiles.rows
            } });
            return;
          }
        }

        // Check if local recipients exist in the DB
        const allInputRecipients = [...(to || []), ...(cc || []), ...(bcc || [])];
        if (!isDraft) {
          for (const recipient of allInputRecipients) {
            const recipientEmail = recipient.includes('@')
              ? recipient
              : `${recipient.replace(/[^0-9]/g, '').slice(-10)}@${SMTP_DOMAIN}`;
              
            if (recipientEmail.endsWith(`@${SMTP_DOMAIN}`)) {
              const userCheck = await client.query('SELECT id FROM users WHERE email = $1', [recipientEmail]);
              if (userCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                const displayId = recipient.includes('@') ? recipient : recipient.replace(/[^0-9]/g, '').slice(-10);
                res.status(400).json({ error: `This number/email (${displayId}) is not registered with numo` });
                return;
              }
            }
          }
        }

      const files = await readAttachments(client, req.body.attachments ?? [], req.userId, req.userEmail);
      // Determine if this is a reply
      const isReply = !!replyToEmailId;
      let conversationId: string | null = null;

      if (isReply && replyToEmailId) {
        // Check if original email has been replied to
        const originalEmail = await client.query(
          'SELECT conversation_id, has_been_replied FROM emails WHERE id = $1',
          [replyToEmailId]
        );

        if (originalEmail.rows.length > 0) {
          if (originalEmail.rows[0].has_been_replied) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: 'This message has already been replied to' });
            return;
          }
          conversationId = originalEmail.rows[0].conversation_id;

          // Mark original as replied
          await client.query(
            'UPDATE emails SET has_been_replied = TRUE WHERE id = $1',
            [replyToEmailId]
          );
        }
      }

      if (!conversationId && !isDraft) {
        // Find or create conversation
        const allRecipients = [...to, ...(cc || [])];

        if (allRecipients.length === 1) {
          // 1-to-1: find existing conversation
          const recipientEmail = allRecipients[0].includes('@') 
            ? allRecipients[0] 
            : `${allRecipients[0].replace(/[^0-9]/g, '').slice(-10)}@${SMTP_DOMAIN}`;

          const existingConv = await client.query(
            `SELECT c.id FROM conversations c
             JOIN conversation_participants cp1 ON c.id = cp1.conversation_id
             JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
             WHERE cp1.user_id = (SELECT id FROM users WHERE email = $1)
             AND cp2.user_id = (SELECT id FROM users WHERE email = $2)
             AND c.is_group = FALSE
             LIMIT 1`,
            [req.userEmail, recipientEmail]
          );

          if (existingConv.rows.length > 0) {
            conversationId = existingConv.rows[0].id;
          }
        }

        if (!conversationId) {
          // Create new conversation
          const isGroup = allRecipients.length > 1;
          const convResult = await client.query(
            `INSERT INTO conversations (is_group, last_message_at) VALUES ($1, NOW()) RETURNING id`,
            [isGroup]
          );
          conversationId = convResult.rows[0].id;

          // Add sender as participant
          await client.query(
            `INSERT INTO conversation_participants (conversation_id, user_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [conversationId, req.userId]
          );

          // Add recipients as participants
          for (const recipient of allRecipients) {
            const recipientEmail = recipient.includes('@')
              ? recipient
              : `${recipient.replace(/[^0-9]/g, '').slice(-10)}@${SMTP_DOMAIN}`;

            const recipientUser = await client.query(
              'SELECT id FROM users WHERE email = $1',
              [recipientEmail]
            );

            if (recipientUser.rows.length > 0) {
              await client.query(
                `INSERT INTO conversation_participants (conversation_id, user_id)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [conversationId, recipientUser.rows[0].id]
              );
            }
          }
        }
      }

      // Update conversation last_message_at
      if (conversationId) {
        await client.query(
          'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
          [conversationId]
        );
      }

      // Insert email
      const emailResult = await client.query(
        `INSERT INTO emails (id, conversation_id, sender_id, sender_email, subject, body, html_body,
                             is_reply, reply_to_email_id, is_draft, has_attachments)
         VALUES (COALESCE($10::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $11) RETURNING *`,
        [conversationId, req.userId, req.userEmail, subject, body, htmlBody || body,
         isReply, replyToEmailId || null, isDraft, clientMessageId || null, files.length > 0]
      );

      const email = emailResult.rows[0];
      const acceptedFiles = [];
      for (const file of files) {
        const stored = await client.query(`INSERT INTO attachments (email_id, filename, mime_type, size_bytes, content, storage_path)
          VALUES ($1, $2, $3, $4, $5, 'database') RETURNING ${attachmentFields}`,
          [email.id, file.filename, file.contentType, file.content.length, file.content]);
        acceptedFiles.push(stored.rows[0]);
      }

      // Insert recipients
      const allRecipientEntries = [
        ...(to || []).map((r: string) => ({ email: r, type: 'to' })),
        ...(cc || []).map((r: string) => ({ email: r, type: 'cc' })),
        ...(bcc || []).map((r: string) => ({ email: r, type: 'bcc' })),
      ];

      for (const recipient of allRecipientEntries) {
        const recipientEmail = recipient.email.includes('@')
          ? recipient.email
          : `${recipient.email.replace(/[^0-9]/g, '').slice(-10)}@${SMTP_DOMAIN}`;

        await client.query(
          `INSERT INTO email_recipients (email_id, recipient_email, recipient_type)
           VALUES ($1, $2, $3)`,
          [email.id, recipientEmail, recipient.type]
        );
      }

      const externalRecipients = allRecipientEntries.filter(r =>
        r.email.includes('@') && !r.email.endsWith(`@${SMTP_DOMAIN}`));
      if (!isDraft && externalRecipients.length) {
        const relayAccepted = await sendExternalEmail(
          externalRecipients, subject || '(No Subject)', body || '', htmlBody || body || '',
          req.userPhone || 'Numo user', req.userEmail || '', email.id, files
        );
        if (!relayAccepted) {
          await client.query('ROLLBACK');
          res.status(502).json({ error: 'The outgoing mail service could not accept this message.' });
          return;
        }
      }
      await client.query('COMMIT');

      res.status(201).json({
        message: isDraft ? 'Draft saved' : 'Email sent successfully',
        email: {
          id: email.id,
          attachments: acceptedFiles,
          conversationId: email.conversation_id,
          subject: email.subject,
          createdAt: email.created_at,
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof AttachmentError) { res.status(400).json({ error: error.message }); return; }
    console.error('❌ Send email error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/emails/:id
 * Get a single email by ID
 */
router.get('/:emailId/attachments/:id', async (req: AuthRequest, res: Response, next) => {
  try {
    const result = await pool.query(`SELECT a.filename, a.content FROM attachments a
      JOIN emails e ON e.id = a.email_id WHERE a.id = $1 AND e.id = $4 AND a.content IS NOT NULL
      AND ${mailAccess}`, [req.params.id, req.userId, req.userEmail, req.params.emailId]);
    if (!result.rowCount) { res.status(404).json({ error: 'File unavailable' }); return; }
    const { filename, content } = result.rows[0];
    res.attachment(filename).type('application/octet-stream')
      .set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(content);
  } catch (error) { next(error); }
});

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT e.*, u.display_name as sender_name, u.phone as sender_phone,
              u.profile_picture as sender_picture
       FROM emails e
       LEFT JOIN users u ON e.sender_id = u.id
       WHERE e.id = $1 AND ${mailAccess}`,
      [id, req.userId, req.userEmail]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Email not found' });
      return;
    }

    const email = result.rows[0];

    // Get recipients
    const recipients = await pool.query(
      'SELECT recipient_email, recipient_type FROM email_recipients WHERE email_id = $1',
      [id]
    );

    // Get attachments
    const attachments = await pool.query(
      `SELECT ${attachmentFields} FROM attachments WHERE email_id = $1 ORDER BY created_at, id`,
      [id]
    );

    // Mark as read
    await pool.query(
      'UPDATE email_recipients SET is_read = TRUE WHERE email_id = $1 AND recipient_email = $2',
      [id, req.userEmail]
    );

    res.json({
      email: {
        ...email,
        recipients: recipients.rows,
        attachments: attachments.rows,
      },
    });
  } catch (error) {
    console.error('❌ Get email error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/emails/:id
 * Update email (mark as read, favorite, spam, trash)
 */
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { isRead, isFavorite, isSpam, isTrash } = req.body;

    const updates: string[] = [];
    const values: any[] = [id, req.userId, req.userEmail];
    let paramCount = values.length + 1;

    if (isRead !== undefined) {
      updates.push(`is_read = $${paramCount++}`);
      values.push(isRead);
    }
    if (isFavorite !== undefined) {
      updates.push(`is_favorite = $${paramCount++}`);
      values.push(isFavorite);
    }
    if (isSpam !== undefined) {
      updates.push(`is_spam = $${paramCount++}`);
      values.push(isSpam);
    }
    if (isTrash !== undefined) {
      updates.push(`is_trash = $${paramCount++}`);
      values.push(isTrash);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    const updated = await pool.query(
      `UPDATE emails e SET ${updates.join(', ')} WHERE e.id = $1 AND ${mailAccess}`,
      values
    );
    if (!updated.rowCount) { res.status(404).json({ error: 'Email not found' }); return; }

    res.json({ message: 'Email updated' });
  } catch (error) {
    console.error('❌ Update email error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/emails/:id
 * Permanently delete an email
 */
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const deleted = await pool.query(`DELETE FROM emails e WHERE e.id = $1 AND ${mailAccess}`,
      [id, req.userId, req.userEmail]);
    if (!deleted.rowCount) { res.status(404).json({ error: 'Email not found' }); return; }
    res.json({ message: 'Email deleted permanently' });
  } catch (error) {
    console.error('❌ Delete email error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
