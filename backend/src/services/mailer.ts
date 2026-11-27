import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

function gmailTransport(user: string, pass: string) {
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

export async function sendAccountEmail(to: string, subject: string, text: string) {
  const user = process.env.EXTERNAL_SMTP_USER;
  const pass = process.env.EXTERNAL_SMTP_PASS;
  const testHost = process.env.NODE_ENV === 'development' && process.env.RECOVERY_TEST_SMTP_HOST;
  if (!testHost && (!user || !pass)) throw new Error('Account email delivery is not configured.');
  const transport = testHost
    ? nodemailer.createTransport({ host: testHost, port: 1025, secure: false })
    : gmailTransport(user!, pass!);
  const result = await transport.sendMail({ from: testHost ? 'Numo <accounts@numo.test>' : user, to, subject, text });
  if (!result.accepted.length) throw new Error('Account email was rejected.');
}

export const sendExternalEmail = async (
  recipients: { email: string; type: string }[],
  subject: string,
  text: string,
  html: string,
  senderName: string,
  senderLocalEmail: string,
  emailId: string
): Promise<boolean> => {
  const smtpUser = process.env.EXTERNAL_SMTP_USER;
  const smtpPass = process.env.EXTERNAL_SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    console.error('❌ Missing EXTERNAL_SMTP_USER or EXTERNAL_SMTP_PASS in .env');
    return false;
  }

  try {
    const transporter = gmailTransport(smtpUser, smtpPass);

    // We set the "From" to look like it's from the local address, but authenticated by the real SMTP user
    // We set the "Reply-To" so that if the recipient hits reply, it attempts to send back to the local address.
    const mailOptions = {
      from: `"${senderName}" <${smtpUser}>`, // Gmail overrides 'from' address anyway, so we use the real one but set a custom name
      replyTo: `"${senderName}" <${senderLocalEmail}>`,
      to: recipients.filter(r => r.type === 'to').map(r => r.email),
      cc: recipients.filter(r => r.type === 'cc').map(r => r.email),
      bcc: recipients.filter(r => r.type === 'bcc').map(r => r.email),
      messageId: `<${emailId}@${senderLocalEmail.split('@')[1]}>`,
      subject,
      text,
      html,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ External email sent successfully: %s', info.messageId);
    return info.accepted.length > 0;
  } catch (error) {
    console.error('❌ Failed to send external email:', error);
    return false;
  }
};
