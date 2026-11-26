import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();

export const localSmsTesting = process.env.NODE_ENV === 'development' &&
  ![accountSid, authToken, verifyServiceSid].some(Boolean);
export const localTestCode = '000011';

let client: twilio.Twilio | null = null;

/**
 * Normalize any phone number to E.164 format (+91XXXXXXXXXX)
 * This MUST be used everywhere to ensure Twilio send and verify
 * use the exact same phone string.
 */
export const normalizePhone = (phone: string): string => {
  // Strip everything except digits and leading +
  let cleaned = phone.replace(/[^0-9+]/g, '');
  
  // If it's a 10-digit Indian number without country code
  if (/^\d{10}$/.test(cleaned)) {
    cleaned = '+91' + cleaned;
  }
  
  // If it starts with 91 and is 12 digits (missing +)
  if (/^91\d{10}$/.test(cleaned)) {
    cleaned = '+' + cleaned;
  }
  
  // Ensure it starts with +
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  
  return cleaned;
};

const isTwilioConfigured = (): boolean => !!(accountSid && /^AC[0-9a-f]{32}$/i.test(accountSid) && authToken);

const getClient = (): twilio.Twilio => {
  if (!client && isTwilioConfigured()) {
    client = twilio(accountSid, authToken);
  }
  if (!client) {
    throw new Error('Twilio is not configured');
  }
  return client;
};

export const sendOTP = async (phone: string): Promise<boolean> => {
  const toPhone = normalizePhone(phone);

  if (localSmsTesting) return true;
  if (!isTwilioConfigured() || !verifyServiceSid) return false;

  try {
    const twilioClient = getClient();
    await twilioClient.verify.v2.services(verifyServiceSid)
      .verifications
      .create({ to: toPhone, channel: 'sms' });
      
    console.log(`📱 Twilio Verify OTP sent to ${toPhone}`);
    return true;
  } catch (error: any) {
    console.error('❌ Failed to send Twilio Verify OTP:', error.message);
    return false;
  }
};

/**
 * Verify OTP via Twilio Verify API
 */
export const verifyOTP = async (phone: string, code: string): Promise<boolean> => {
  const normalizedPhone = normalizePhone(phone);

  if (localSmsTesting) return code === localTestCode;

  if (!isTwilioConfigured() || !verifyServiceSid) {
    return false;
  }

  try {
    const twilioClient = getClient();
    const verificationCheck = await twilioClient.verify.v2.services(verifyServiceSid)
      .verificationChecks
      .create({ to: normalizedPhone, code });

    if (verificationCheck.status === 'approved') {
      console.log(`📱 [VERIFY] OTP code verified for ${normalizedPhone}`);
      return true;
    }
    
    console.log(`📱 [VERIFY] Failed verification for ${normalizedPhone}. Status: ${verificationCheck.status}`);
    return false;
  } catch (error: any) {
    console.error('❌ Failed to verify Twilio OTP:', error.message);
    return false;
  }
};

