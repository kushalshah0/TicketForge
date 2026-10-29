import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@tf/contracts';
import { getTraceparent, type DrizzleTransaction } from '@tf/common';
import { outbox } from './schema';

@Injectable()
export class OutboxService {
  write(
    transaction: DrizzleTransaction,
    envelope: EventEnvelope,
    traceparent = getTraceparent(),
  ): Promise<unknown> {
    return writeOutbox(transaction, envelope, traceparent);
  }
}

export function writeOutbox(
  transaction: DrizzleTransaction,
  envelope: EventEnvelope,
  traceparent = getTraceparent(),
): Promise<unknown> {
  const headers = {
    'x-correlation-id': envelope.correlationId,
    ...(traceparent ? { traceparent } : {}),
  };

  return transaction.insert(outbox).values({
    messageId: envelope.id,
    type: envelope.type,
    payload: envelope,
    headers,
  });
}
