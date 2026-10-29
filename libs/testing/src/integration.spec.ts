import { randomUUID } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import {
  generateTestJwtKeyPair,
  makeTestEvent,
  signTestToken,
  waitFor,
} from './integration';

describe('integration test helpers', () => {
  it('creates verifiable role tokens with a key id', async () => {
    const keys = await generateTestJwtKeyPair();
    const token = await signTestToken({
      privateKeyPem: keys.privateKeyPem,
      keyId: keys.keyId,
      subject: randomUUID(),
      role: 'organizer',
    });
    const publicKey = await importSPKI(keys.publicKeyPem, 'RS256');
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      issuer: 'ticketforge-test',
      audience: 'ticketforge-api',
    });

    expect(protectedHeader.kid).toBe(keys.keyId);
    expect(payload.role).toBe('organizer');
  });

  it('creates schema-validated event fixtures', () => {
    const event = makeTestEvent('payment.failed', {
      paymentId: randomUUID(),
      bookingId: randomUUID(),
      reason: 'declined',
    });

    expect(event.type).toBe('payment.failed');
    expect(event.version).toBe(1);
  });

  it('waits until a condition is met', async () => {
    let checks = 0;
    await expect(
      waitFor(
        async () => {
          checks += 1;
          return Promise.resolve(checks === 2 ? 'ready' : false);
        },
        500,
        1,
      ),
    ).resolves.toBe('ready');
  });
});
