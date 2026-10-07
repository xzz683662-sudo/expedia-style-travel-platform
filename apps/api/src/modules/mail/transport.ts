import { config } from '../../config/env';
import { logger } from '../../lib/logger';

/**
 * ---------------------------------------------------------------------------
 * Outbound mail
 * ---------------------------------------------------------------------------
 *
 * One narrow job: deliver a plain-text (and optional HTML) message. Kept behind
 * an interface because the platform's default is deliberately *no provider* —
 * `console` writes the message to the log, so local development and the
 * end-to-end test work with zero keys.
 *
 * Two transports ship:
 *
 *   - `console` (default) — logs the message. Not a stub: it is the intended
 *     behaviour for development, and the code is readable from the API log.
 *   - `resend` — a real provider over `fetch`, so no dependency is added.
 *
 * SMTP is not implemented on purpose. It needs a mail library, and adding one
 * for a path nothing uses yet is cargo culting; the interface below is the
 * extension point when a deployment actually needs it.
 */

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type MailTransportKind = 'console' | 'resend';

export interface MailTransport {
  readonly kind: MailTransportKind;
  send(message: MailMessage): Promise<void>;
}

/**
 * Development transport. Logs at info so the code is visible in the API log,
 * which is how a developer (or the E2E test) reads it without a mailbox.
 */
const consoleTransport: MailTransport = {
  kind: 'console',
  async send(message) {
    logger.info('mail.console', {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  },
};

/**
 * Resend (https://resend.com) over the REST API.
 *
 * Uses `fetch` rather than the SDK: one POST, and Node 22 already provides
 * `fetch`, so the dependency budget stays at zero.
 */
function resendTransport(apiKey: string): MailTransport {
  return {
    kind: 'resend',
    async send(message) {
      const response = await fetch(`${config.mail.resendBaseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.mail.fromAddress,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // Throwing is correct here: unlike a notification, an undelivered
        // verification code means the shopper cannot proceed at all, so the
        // caller must surface the failure rather than silently continue.
        throw new Error(`resend_http_${response.status}: ${body.slice(0, 200)}`);
      }
    },
  };
}

let cached: MailTransport | null = null;

/** Resolves the configured transport, falling back to console when misconfigured. */
export function mailTransport(): MailTransport {
  if (cached) return cached;

  if (config.mail.transport === 'resend') {
    if (!config.mail.resendApiKey) {
      // A provider selected without a key is a configuration error, but it must
      // not take the whole API down — degrade to console and say so loudly.
      logger.warn('mail.resend_missing_key', {
        note: 'MAIL_TRANSPORT=resend without RESEND_API_KEY — falling back to console',
      });
      cached = consoleTransport;
      return cached;
    }
    cached = resendTransport(config.mail.resendApiKey);
    return cached;
  }

  cached = consoleTransport;
  return cached;
}

/** Test/teardown helper: forget the resolved transport. */
export function resetMailTransport(): void {
  cached = null;
}

export async function sendMail(message: MailMessage): Promise<void> {
  await mailTransport().send(message);
}
