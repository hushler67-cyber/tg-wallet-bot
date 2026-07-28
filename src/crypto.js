// Encryption for private keys at rest.
// AES-256-GCM: authenticated encryption, so tampering/corruption is detected on decrypt.
// The MASTER_KEY never touches the database — only ciphertext does.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getMasterKey() {
  const b64 = process.env.MASTER_KEY;
  if (!b64) {
    throw new Error(
      'MASTER_KEY is not set. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
      'and put it in your .env file. Never commit it, never log it.'
    );
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('MASTER_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

/**
 * Encrypts a plaintext string (e.g. a private key hex/base58 string).
 * Returns a single string safe to store in a DB column: iv:authTag:ciphertext (all base64).
 */
function encrypt(plaintext) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12); // 96-bit IV is recommended for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * Reverses encrypt(). Throws if the ciphertext was tampered with or the key is wrong.
 */
function decrypt(payload) {
  const key = getMasterKey();
  const [ivB64, authTagB64, dataB64] = payload.split(':');
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload.');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
