import { createHmac, timingSafeEqual } from 'node:crypto';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTicketQrToken(ticketId: string, secret: string): string {
  if (!uuidPattern.test(ticketId)) throw new Error('Ticket ID is invalid');
  const signature = createHmac('sha256', secret)
    .update(ticketId)
    .digest('base64url');
  return `v1.${ticketId}.${signature}`;
}

export function verifyTicketQrToken(
  token: string,
  secret: string,
): string | undefined {
  const [version, ticketId, encodedSignature, ...extra] = token.split('.');
  if (
    version !== 'v1' ||
    !ticketId ||
    !uuidPattern.test(ticketId) ||
    !encodedSignature ||
    extra.length > 0 ||
    !/^[A-Za-z0-9_-]{43}$/.test(encodedSignature)
  ) {
    return undefined;
  }

  const signature = Buffer.from(encodedSignature, 'base64url');
  const expected = createHmac('sha256', secret).update(ticketId).digest();
  if (
    signature.length !== expected.length ||
    signature.toString('base64url') !== encodedSignature ||
    !timingSafeEqual(signature, expected)
  ) {
    return undefined;
  }
  return ticketId;
}
