const path = require('node:path');
const dotenv = require('dotenv');
const twilio = require('twilio');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

async function run() {
  const [mode, recipient] = process.argv.slice(2);
  if (mode !== 'verify' || !/^\+[1-9]\d{7,14}$/.test(recipient || '')) {
    throw new Error('Usage: node backend/test-twilio.js verify <your verified phone number in E.164 format>');
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error('Set the account SID and Auth Token in .env.');
  if (!TWILIO_VERIFY_SERVICE_SID) throw new Error('Set TWILIO_VERIFY_SERVICE_SID in .env.');
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verifications.create({ to: recipient, channel: 'sms' });
  console.log('Twilio accepted the request.');
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
