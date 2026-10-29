import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const keysDir = path.resolve(process.cwd(), 'keys');
await fs.mkdir(keysDir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

await fs.writeFile(path.join(keysDir, 'private.pem'), privateKey);
await fs.writeFile(path.join(keysDir, 'public.pem'), publicKey);

console.log(`Generated JWT keypair in ${keysDir}`);
