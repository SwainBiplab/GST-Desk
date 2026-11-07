import { ResendEmailAdapter, WhatsAppCloudAdapter } from '@gst/messaging';

import type { Config } from '../config';

import type { Providers } from './service';

/** The channels the configuration has credentials for; the rest are off. */
export function providersFrom(config: Config): Providers & {
  whatsappLive: WhatsAppCloudAdapter | null;
  resendLive: ResendEmailAdapter | null;
} {
  const whatsappLive = config.whatsapp ? new WhatsAppCloudAdapter(config.whatsapp) : null;
  const resendLive = config.resend ? new ResendEmailAdapter(config.resend) : null;
  return { whatsapp: whatsappLive, email: resendLive, whatsappLive, resendLive };
}
