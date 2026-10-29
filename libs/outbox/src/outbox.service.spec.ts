import { Test, TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { makeEnvelope } from '@tf/contracts';
import { writeOutbox, OutboxService } from './outbox.service';

describe('OutboxService', () => {
  let service: OutboxService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OutboxService],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('stores the envelope and traceparent in the caller transaction', async () => {
    const values = jest.fn(() => Promise.resolve([]));
    const insert = jest.fn(() => ({ values }));
    const transaction = { insert };
    const envelope = makeEnvelope(
      'user.registered',
      {
        userId: randomUUID(),
        email: 'user@example.test',
        displayName: 'Ticket User',
        role: 'customer',
      },
      { correlationId: randomUUID() },
    );

    await writeOutbox(transaction as never, envelope, '00-trace-id-span-id-01');

    expect(insert).toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith({
      messageId: envelope.id,
      type: 'user.registered',
      payload: envelope,
      headers: {
        'x-correlation-id': envelope.correlationId,
        traceparent: '00-trace-id-span-id-01',
      },
    });
  });
});
