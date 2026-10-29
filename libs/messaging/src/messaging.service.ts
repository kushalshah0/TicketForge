import {
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';
import {
  connect,
  type Channel,
  type ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConsumeMessage, Message, Options } from 'amqplib';
import { MetricsService } from '@tf/common';
import { parseEvent, routingKeys, type EventEnvelope } from '@tf/contracts';
import {
  runWithCorrelationId,
  withTx,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from '@tf/common';
import { runOnce } from './idempotency';
import { assertTopology, EVENT_EXCHANGE, RETRY_TIERS } from './topology';

@Injectable()
export class MessagingService implements OnModuleInit, OnModuleDestroy {
  readonly registry: Registry;
  readonly processedCount: Counter<string>;
  readonly handlerDuration: Histogram<string>;
  readonly retries: Counter<string>;
  readonly deadLetters: Counter<string>;

  private connection?: ReturnType<typeof connect>;
  private channel?: ChannelWrapper;

  constructor(@Optional() metrics?: MetricsService) {
    this.registry = metrics?.registry ?? new Registry();
    this.processedCount = new Counter({
      name: 'mq_consumer_processed_total',
      help: 'Messages processed by result',
      labelNames: ['queue', 'result'],
      registers: [this.registry],
    });
    this.handlerDuration = new Histogram({
      name: 'mq_consumer_handler_duration_seconds',
      help: 'Message handler duration in seconds',
      labelNames: ['queue'],
      registers: [this.registry],
    });
    this.retries = new Counter({
      name: 'mq_retries_total',
      help: 'Messages scheduled for retry',
      labelNames: ['queue'],
      registers: [this.registry],
    });
    this.deadLetters = new Counter({
      name: 'dlq_messages_total',
      help: 'Messages published to a dead-letter queue',
      labelNames: ['queue', 'reason'],
      registers: [this.registry],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureConnected();
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  async publish(envelope: EventEnvelope, traceparent?: string): Promise<void> {
    const channel = await this.ensureConnected();
    const headers: Record<string, unknown> = {
      'x-correlation-id': envelope.correlationId,
      'x-attempt': 0,
    };
    if (traceparent) headers.traceparent = traceparent;

    await channel.publish(
      EVENT_EXCHANGE,
      routingKeys[envelope.type],
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.id,
        type: envelope.type,
        headers,
      },
    );
  }

  async consume(
    queue: string,
    handler: MessageHandler,
    options: ConsumeOptions,
  ): Promise<void> {
    const channel = await this.ensureConnected();
    const consumerName = options.consumer ?? queue;

    await channel.addSetup(async (rawChannel: Channel) => {
      await rawChannel.prefetch(options.prefetch ?? 10);
      await rawChannel.consume(
        queue,
        (message: ConsumeMessage | null) => {
          if (message) {
            void this.handleMessage(
              queue,
              message,
              handler,
              options,
              consumerName,
            ).catch(() => this.channel?.nack(message, false, true));
          }
        },
        { noAck: false },
      );
    });
  }

  private async ensureConnected(): Promise<ChannelWrapper> {
    if (!this.connection) {
      this.connection = connect(
        [process.env.AMQP_URL ?? 'amqp://guest:guest@127.0.0.1:5672'],
        {
          heartbeatIntervalInSeconds: 5,
          reconnectTimeInSeconds: 2,
        },
      );
      this.channel = this.connection.createChannel({
        confirm: true,
        json: false,
        setup: async (channel: Channel) => assertTopology(channel),
      });
    }

    const channel = this.channel;
    if (!channel) throw new Error('AMQP channel failed to initialize');
    await channel.waitForConnect();
    return channel;
  }

  private async handleMessage(
    queue: string,
    message: ConsumeMessage,
    handler: MessageHandler,
    options: ConsumeOptions,
    consumerName: string,
  ): Promise<void> {
    const channel = this.channel;
    if (!channel) return;

    let envelope: EventEnvelope;
    try {
      const payload: unknown = JSON.parse(message.content.toString());
      const messageType =
        typeof message.properties.type === 'string'
          ? message.properties.type
          : undefined;
      const type = getEventType(payload, messageType);
      envelope = parseEvent(type, payload);
    } catch {
      await this.moveToDeadLetter(queue, message, 'invalid_payload');
      channel.ack(message);
      return;
    }

    const headers = getMessageHeaders(message);
    const correlationHeader = headers['x-correlation-id'];
    const correlationId =
      typeof correlationHeader === 'string'
        ? correlationHeader
        : envelope.correlationId;
    const traceparent =
      typeof headers.traceparent === 'string' ? headers.traceparent : undefined;
    const context = { correlationId, ...(traceparent ? { traceparent } : {}) };
    const startedAt = process.hrtime.bigint();

    try {
      const ran = await runWithCorrelationId(
        correlationId,
        () =>
          withTx(options.database, (transaction) =>
            runOnce(transaction, envelope.id, consumerName, (tx) =>
              handler(envelope, tx, context),
            ),
          ),
        traceparent,
      );
      this.handlerDuration.observe(
        { queue },
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
      this.processedCount.inc({
        queue,
        result: ran ? 'processed' : 'duplicate',
      });
      channel.ack(message);
    } catch {
      this.handlerDuration.observe(
        { queue },
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
      await this.retryOrDeadLetter(queue, message);
      channel.ack(message);
    }
  }

  private async retryOrDeadLetter(
    queue: string,
    message: Message,
  ): Promise<void> {
    const channel = this.channel;
    if (!channel) throw new Error('AMQP channel is unavailable');

    const headers = { ...getMessageHeaders(message) };
    const attempt = toAttempt(headers['x-attempt']);
    const tier = RETRY_TIERS[attempt];
    if (!tier) {
      await this.moveToDeadLetter(queue, message, 'handler_failed');
      return;
    }

    headers['x-attempt'] = attempt + 1;
    await channel.sendToQueue(`${queue}.retry.${tier.name}`, message.content, {
      ...copyMessageOptions(message.properties),
      persistent: true,
      headers,
    });
    this.retries.inc({ queue });
  }

  private async moveToDeadLetter(
    queue: string,
    message: Message,
    reason: 'invalid_payload' | 'handler_failed',
  ): Promise<void> {
    const channel = this.channel;
    if (!channel) throw new Error('AMQP channel is unavailable');
    await channel.sendToQueue(`${queue}.dlq`, message.content, {
      ...copyMessageOptions(message.properties),
      persistent: true,
      headers: { ...getMessageHeaders(message), 'x-dlq-reason': reason },
    });
    this.deadLetters.inc({ queue, reason });
    this.processedCount.inc({ queue, result: 'dead_letter' });
  }
}

export interface MessageContext {
  correlationId: string;
  traceparent?: string;
}

export interface ConsumeOptions {
  database: DrizzleDatabase;
  consumer?: string;
  prefetch?: number;
}

export type MessageHandler = (
  envelope: EventEnvelope,
  transaction: DrizzleTransaction,
  context: MessageContext,
) => Promise<unknown>;

function getEventType(
  payload: unknown,
  messageType: string | undefined,
): string {
  if (payload && typeof payload === 'object' && 'type' in payload) {
    const type = (payload as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return messageType ?? '';
}

function toAttempt(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0)
    return value;
  return 0;
}

function getMessageHeaders(message: Message): Record<string, unknown> {
  const headers: unknown = message.properties.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    return headers as Record<string, unknown>;
  }
  return {};
}

function copyMessageOptions(
  properties: Message['properties'],
): Options.Publish {
  return {
    contentType: 'application/json',
    ...(typeof properties.messageId === 'string'
      ? { messageId: properties.messageId }
      : {}),
    ...(typeof properties.type === 'string' ? { type: properties.type } : {}),
    ...(typeof properties.correlationId === 'string'
      ? { correlationId: properties.correlationId }
      : {}),
  };
}
