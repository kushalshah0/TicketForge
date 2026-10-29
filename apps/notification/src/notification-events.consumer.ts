import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDatabase, DrizzleTransaction } from '@tf/common';
import type { EventEnvelope } from '@tf/contracts';
import { MessagingService } from '@tf/messaging';
import type { SendMailOptions } from 'nodemailer';
import QRCode from 'qrcode';
import {
  NOTIFICATION_DATABASE,
  NotificationService,
} from './notification.service';
import { notifications, recipients } from './database/schema';

@Injectable()
export class NotificationEventsConsumer implements OnModuleInit {
  constructor(
    private readonly messaging: MessagingService,
    @Inject(NOTIFICATION_DATABASE) private readonly database: DrizzleDatabase,
    private readonly notificationService: NotificationService,
  ) {}

  async onModuleInit(queue = 'notification.events'): Promise<void> {
    await this.messaging.consume(
      queue,
      (envelope, transaction) => this.handle(envelope, transaction),
      { database: this.database, consumer: 'notification.events' },
    );
  }

  async handle(
    envelope: EventEnvelope,
    transaction: DrizzleTransaction,
  ): Promise<void> {
    if (envelope.type === 'user.registered') {
      const { userId, email, displayName, role } = envelope.data;
      await transaction
        .insert(recipients)
        .values({ userId, email, displayName, role })
        .onConflictDoNothing({ target: recipients.userId });
      return;
    }

    if (
      envelope.type !== 'booking.confirmed' &&
      envelope.type !== 'booking.cancelled' &&
      envelope.type !== 'booking.expired' &&
      envelope.type !== 'payment.refunded'
    ) {
      throw new Error(`Unsupported notification event: ${envelope.type}`);
    }

    const userId = envelope.data.userId;
    const [recipient] = await transaction
      .select()
      .from(recipients)
      .where(eq(recipients.userId, userId))
      .limit(1);
    if (!recipient)
      throw new Error(`Notification recipient ${userId} has not registered`);

    const email = await createEmail(envelope, recipient.displayName);
    const [notification] = await transaction
      .insert(notifications)
      .values({
        userId,
        type: envelope.type,
        sourceEventId: envelope.id,
        subject: email.subject,
        body: email.text,
      })
      .onConflictDoNothing({
        target: [
          notifications.type,
          notifications.sourceEventId,
          notifications.userId,
        ],
      })
      .returning({ id: notifications.id });
    if (!notification) return;

    await this.notificationService.sendMail({
      to: recipient.email,
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
      ...(email.attachments ? { attachments: email.attachments } : {}),
    });
    await transaction
      .update(notifications)
      .set({ status: 'SENT', sentAt: sql`now()` })
      .where(
        and(
          eq(notifications.id, notification.id),
          eq(notifications.status, 'PENDING'),
        ),
      );
  }
}

async function createEmail(
  envelope: Extract<
    EventEnvelope,
    {
      type:
        | 'booking.confirmed'
        | 'booking.cancelled'
        | 'booking.expired'
        | 'payment.refunded';
    }
  >,
  displayName: string,
): Promise<{
  subject: string;
  text: string;
  html?: string;
  attachments?: NonNullable<SendMailOptions['attachments']>;
}> {
  if (envelope.type === 'booking.confirmed') {
    const { eventTitle, startsAt, totalMinor, currency, tickets } =
      envelope.data;
    const ticketRows = await Promise.all(
      tickets.map(async (ticket) => ({
        ...ticket,
        cid: `ticket-${ticket.ticketId}@ticketforge.local`,
        qr: await QRCode.toBuffer(ticket.qrToken, { type: 'png' }),
      })),
    );
    const formattedTotal = formatMinorCurrency(totalMinor, currency);
    const seats = tickets.map(({ seatId }) => seatId).join(', ');
    return {
      subject: `Your tickets for ${eventTitle}`,
      text: [
        `Hello ${displayName},`,
        '',
        `Your booking for ${eventTitle} is confirmed.`,
        `Starts: ${new Date(startsAt).toISOString()}`,
        `Seats: ${seats}`,
        `Total: ${formattedTotal}`,
        '',
        ...ticketRows.map(
          ({ seatId }) => `Seat ${seatId}: QR code included in the HTML email.`,
        ),
      ].join('\n'),
      html: [
        `<p>Hello ${escapeHtml(displayName)},</p>`,
        `<p>Your booking for <strong>${escapeHtml(eventTitle)}</strong> is confirmed.</p>`,
        `<p>Starts: ${escapeHtml(new Date(startsAt).toISOString())}<br>`,
        `Seats: ${escapeHtml(seats)}<br>Total: ${escapeHtml(formattedTotal)}</p>`,
        ...ticketRows.map(
          ({ seatId, cid }) =>
            `<p>Seat ${escapeHtml(seatId)}<br><img src="cid:${cid}" alt="Ticket QR code for seat ${escapeHtml(seatId)}"></p>`,
        ),
      ].join(''),
      attachments: ticketRows.map(({ seatId, qr, cid }) => ({
        filename: `ticket-${seatId}.png`,
        content: qr,
        contentType: 'image/png',
        cid,
      })),
    };
  }

  if (envelope.type === 'booking.cancelled') {
    return {
      subject: `Booking ${envelope.data.bookingId} cancelled`,
      text: `Hello ${displayName},\n\nYour booking has been cancelled. Reason: ${envelope.data.reason}.`,
    };
  }
  if (envelope.type === 'booking.expired') {
    return {
      subject: `Booking ${envelope.data.bookingId} expired`,
      text: `Hello ${displayName},\n\nYour booking expired before payment was completed.`,
    };
  }
  return {
    subject: `Payment refunded for booking ${envelope.data.bookingId}`,
    text: [
      `Hello ${displayName},`,
      '',
      `Your payment refund has been initiated.`,
      `Amount: ${
        envelope.data.currency
          ? formatMinorCurrency(
              envelope.data.amountMinor,
              envelope.data.currency,
            )
          : `${envelope.data.amountMinor} minor units (currency not included in this event)`
      }`,
      `Reason: ${envelope.data.reason}.`,
    ].join('\n'),
  };
}

function formatMinorCurrency(amountMinor: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
  if (fractionDigits === undefined)
    throw new Error(`Could not determine minor unit scale for ${currency}`);
  return formatter.format(amountMinor / 10 ** fractionDigits);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}
