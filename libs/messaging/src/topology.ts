import type { Channel } from 'amqp-connection-manager';
import { routingKeys } from '@tf/contracts';

export const EVENT_EXCHANGE = 'tf.events';

export const QUEUE_BINDINGS = {
  'booking.catalog-events': [
    routingKeys['event.published'],
    routingKeys['event.updated'],
    routingKeys['event.cancelled'],
  ],
  'booking.payment-events': [
    routingKeys['payment.succeeded'],
    routingKeys['payment.failed'],
  ],
  'payment.booking-events': [
    routingKeys['booking.created'],
    routingKeys['booking.cancelled'],
    routingKeys['booking.expired'],
    routingKeys['refund.requested'],
  ],
  'notification.events': [
    routingKeys['user.registered'],
    routingKeys['booking.confirmed'],
    routingKeys['booking.cancelled'],
    routingKeys['booking.expired'],
    routingKeys['payment.refunded'],
  ],
} as const;

export const RETRY_TIERS = [
  { name: '5s', ttl: 5_000 },
  { name: '30s', ttl: 30_000 },
] as const;

export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });

  for (const [queue, bindings] of Object.entries(QUEUE_BINDINGS)) {
    await channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-queue-type': 'classic' },
    });

    for (const routingKey of bindings) {
      await channel.bindQueue(queue, EVENT_EXCHANGE, routingKey);
    }

    await channel.assertQueue(`${queue}.dlq`, { durable: true });

    for (const tier of RETRY_TIERS) {
      await channel.assertQueue(`${queue}.retry.${tier.name}`, {
        durable: true,
        arguments: {
          'x-message-ttl': tier.ttl,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': queue,
        },
      });
    }
  }
}
