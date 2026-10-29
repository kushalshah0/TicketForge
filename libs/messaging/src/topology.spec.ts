import type { Channel } from 'amqp-connection-manager';
import {
  assertTopology,
  EVENT_EXCHANGE,
  QUEUE_BINDINGS,
  RETRY_TIERS,
} from './topology';

describe('RabbitMQ topology', () => {
  it('declares durable queues, retry tiers, and all event bindings', async () => {
    const exchanges: unknown[][] = [];
    const queues: Array<{ name: string; options: unknown }> = [];
    const bindings: unknown[][] = [];
    const channel = {
      assertExchange: (...args: unknown[]) =>
        Promise.resolve(exchanges.push(args)),
      assertQueue: (name: string, options: unknown) =>
        Promise.resolve(queues.push({ name, options })),
      bindQueue: (...args: unknown[]) => Promise.resolve(bindings.push(args)),
    } as unknown as Channel;

    await assertTopology(channel);

    expect(exchanges).toEqual([[EVENT_EXCHANGE, 'topic', { durable: true }]]);
    expect(queues).toHaveLength(
      Object.keys(QUEUE_BINDINGS).length * (RETRY_TIERS.length + 2),
    );
    expect(bindings).toHaveLength(
      Object.values(QUEUE_BINDINGS).reduce(
        (count, keys) => count + keys.length,
        0,
      ),
    );
    expect(queues.map(({ name }) => name)).toContain(
      'booking.payment-events.retry.30s',
    );
    expect(queues.map(({ name }) => name)).toContain('notification.events.dlq');
  });
});
