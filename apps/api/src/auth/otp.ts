/**
 * How a one-time code reaches the person. `mock` keeps the last code per target in memory so a client
 * (and the tests) can fetch it from the dev-only route; `log` prints it; `msg91` sends an SMS through
 * MSG91's OTP API and emails through SMTP (adapters behind the same interface).
 */
import type { Logger } from 'pino';

import type { Config } from '../config';

import type { OtpSender } from './auth';

export interface MockOtpSender extends OtpSender {
  /** Dev only: the last code sent to a target. */
  last(to: string): string | undefined;
  readonly sent: {
    kind: 'email' | 'phone';
    to: string;
    code: string;
    purpose: string;
    at: number;
  }[];
}

export function mockOtpSender(): MockOtpSender {
  const sent: MockOtpSender['sent'] = [];
  return {
    sent,
    async send(t) {
      sent.push({ ...t, at: Date.now() });
      if (sent.length > 1000) sent.shift();
    },
    last(to) {
      for (let i = sent.length - 1; i >= 0; i--) if (sent[i]!.to === to) return sent[i]!.code;
      return undefined;
    },
  };
}

/** MSG91 "send OTP" with a template that carries the code; email through the SMTP URL when set. */
export function msg91Sender(
  cfg: Config['otp'],
  log: Logger,
  fetchFn: typeof fetch = fetch,
): OtpSender {
  return {
    async send(t) {
      if (t.kind === 'phone') {
        if (!cfg.msg91AuthKey || !cfg.msg91TemplateId)
          throw new Error('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required');
        const res = await fetchFn('https://control.msg91.com/api/v5/otp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authkey: cfg.msg91AuthKey },
          body: JSON.stringify({
            template_id: cfg.msg91TemplateId,
            mobile: t.to.replace(/\D/g, ''),
            otp: t.code,
            otp_expiry: 5,
          }),
        });
        if (!res.ok) throw new Error(`MSG91 answered ${res.status}`);
        log.info({ kind: 'phone' }, 'otp sent');
        return;
      }
      if (!cfg.smtpUrl) throw new Error('SMTP_URL is required to send email codes');
      // SMTP delivery arrives with the messaging prompt (44); until then the email path logs a stub
      log.warn({ kind: 'email' }, 'email OTP: SMTP transport not built yet (prompt 44)');
      throw new Error('email delivery is not available yet');
    },
  };
}

export function logSender(log: Logger): OtpSender {
  return {
    async send(t) {
      // the code is logged on purpose in this mode: it is for a developer's own machine only
      log.info(
        { to: t.to, otp: t.code, purpose: t.purpose, redactedBy: 'none' },
        `one-time code for ${t.to}: ${t.code}`,
      );
    },
  };
}

export function otpSender(config: Config, log: Logger): OtpSender {
  if (config.otp.provider === 'msg91') return msg91Sender(config.otp, log);
  if (config.otp.provider === 'log') return logSender(log);
  return mockOtpSender();
}
