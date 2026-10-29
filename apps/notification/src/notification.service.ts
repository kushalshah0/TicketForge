import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createDrizzle, createPgPool } from '@tf/common';
import {
  createTransport,
  type SendMailOptions,
  type Transporter,
} from 'nodemailer';
import type { Pool } from 'pg';

export const NOTIFICATION_POOL = Symbol('NOTIFICATION_POOL');
export const NOTIFICATION_DATABASE = Symbol('NOTIFICATION_DATABASE');

@Injectable()
export class NotificationService implements OnModuleDestroy {
  private transporter?: Transporter;

  constructor(@Inject(NOTIFICATION_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    this.transporter?.close();
    await this.pool.end();
  }

  async sendMail(options: Omit<SendMailOptions, 'from'>): Promise<void> {
    const smtpUrl = process.env.SMTP_URL;
    if (!smtpUrl) throw new Error('SMTP_URL is required to send notifications');
    this.transporter ??= createTransport(smtpUrl);
    const result = await this.transporter.sendMail({
      from:
        process.env.NOTIFICATION_FROM ??
        'TicketForge <tickets@ticketforge.local>',
      ...options,
    });
    if (!result.accepted?.length || (result.rejected?.length ?? 0) > 0) {
      throw new Error('SMTP did not accept the notification recipient');
    }
  }

  getHello(): string {
    return 'Hello World!';
  }
}

export function createNotificationPool(): Pool {
  const connectionString = process.env.NOTIFICATION_DATABASE_URL;
  if (!connectionString)
    throw new Error('NOTIFICATION_DATABASE_URL is required');
  return createPgPool({ connectionString });
}

export function createNotificationDatabase(pool: Pool) {
  return createDrizzle(pool);
}
