import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

export interface SmsSender {
  /** Must never log the message body (it contains an OTP). */
  sendOtp(phoneE164: string, code: string): Promise<void>;
}

const MSG91_OTP_URL = 'https://control.msg91.com/api/v5/otp';

/**
 * One-time codes by SMS.
 *  - dev:   sends and logs nothing; the code goes back to the caller in `devCode` (never in production).
 *  - msg91: MSG91 OTP API v5. We generate and check the code ourselves (hashed, 5-minute expiry, 5 tries);
 *           MSG91 only delivers it, using your DLT-approved template (its OTP variable is filled with the code).
 *           Needs MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID.
 */
@Injectable()
export class SmsProvider implements SmsSender {
  private readonly log = new Logger('Sms');

  get isDev() {
    return env().SMS_PROVIDER === 'dev' && env().NODE_ENV !== 'production';
  }

  async sendOtp(phoneE164: string, code: string): Promise<void> {
    if (this.isDev) return;
    if (env().SMS_PROVIDER === 'msg91') return this.msg91(phoneE164, code);
    this.log.error(`SMS provider ${env().SMS_PROVIDER} not configured; cannot send OTP to ${maskPhone(phoneE164)}`);
    throw new Error('SMS provider not configured');
  }

  private async msg91(phone: string, code: string) {
    const key = env().MSG91_AUTH_KEY;
    const template = env().MSG91_OTP_TEMPLATE_ID;
    if (!key || !template) {
      this.log.error('MSG91 selected but MSG91_AUTH_KEY / MSG91_OTP_TEMPLATE_ID are not set');
      throw new Error('SMS provider not configured');
    }
    const digits = phone.replace(/\D/g, '');
    const mobile = digits.length === 10 ? `91${digits}` : digits; // country code, no "+"
    const qs = new URLSearchParams({ template_id: template, mobile, otp: code, otp_length: String(code.length), otp_expiry: '5' });
    let res: Response;
    try {
      res = await fetch(`${MSG91_OTP_URL}?${qs}`, {
        method: 'POST',
        headers: { authkey: key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ OTP: code, otp: code }), // template variable, whichever name the template uses
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.log.error(`MSG91 unreachable sending OTP to ${maskPhone(phone)}: ${(e as Error).name}`);
      throw new Error('Could not send the SMS. Try again in a moment.');
    }
    // MSG91 can report failures with HTTP 200, so read the body too. Never log the request (it has the OTP).
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string; code?: string };
    if (!res.ok || body.type !== 'success') {
      this.log.error(`MSG91 rejected OTP to ${maskPhone(phone)}: HTTP ${res.status} ${body.type ?? ''} ${String(body.message ?? '').slice(0, 120)}`);
      throw new Error('Could not send the SMS. Try again in a moment.');
    }
  }
}

export function maskPhone(p: string) {
  return p.length > 4 ? `${p.slice(0, 3)}******${p.slice(-2)}` : '****';
}
