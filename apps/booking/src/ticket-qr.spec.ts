import { randomUUID } from 'node:crypto';
import { createTicketQrToken, verifyTicketQrToken } from './ticket-qr';

describe('ticket QR tokens', () => {
  it('signs the ticket ID and rejects modified IDs or signatures', () => {
    const ticketId = randomUUID();
    const secret = 'ticket-qr-test-secret';
    const token = createTicketQrToken(ticketId, secret);

    expect(token).toMatch(/^v1\.[0-9a-f-]+\.[A-Za-z0-9_-]{43}$/i);
    expect(verifyTicketQrToken(token, secret)).toBe(ticketId);
    expect(
      verifyTicketQrToken(token.replace(ticketId, randomUUID()), secret),
    ).toBeUndefined();
    expect(
      verifyTicketQrToken(`${token.slice(0, -1)}x`, secret),
    ).toBeUndefined();
    expect(verifyTicketQrToken(token, 'different-secret')).toBeUndefined();
  });
});
