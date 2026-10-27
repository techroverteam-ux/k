import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

export interface SmsSender {
  /** Must never log the message body (it contains an OTP). */
  sendOtp(phoneE164: string, code: string): Promise<void>;
}

/**
 * Development sender: does NOT send or log anything. The OTP is returned to the caller
 * in the `devCode` field only when NODE_ENV !== 'production' (env validation forbids
 * SMS_PROVIDER=dev in production).
 */
@Injectable()
export class SmsProvider implements SmsSender {
  private readonly log = new Logger('Sms');

  get isDev() {
    return env().SMS_PROVIDER === 'dev' && env().NODE_ENV !== 'production';
  }

  async sendOtp(phoneE164: string, _code: string): Promise<void> {
    if (this.isDev) return;
    // Integrate your DLT-registered SMS gateway here (MSG91 / Twilio / etc.) using credentials from the secrets vault.
    this.log.error(`SMS provider ${env().SMS_PROVIDER} not configured; cannot send OTP to ${maskPhone(phoneE164)}`);
    throw new Error('SMS provider not configured');
  }
}

export function maskPhone(p: string) {
  return p.length > 4 ? `${p.slice(0, 3)}******${p.slice(-2)}` : '****';
}
