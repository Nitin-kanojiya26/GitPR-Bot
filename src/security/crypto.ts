import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // Standard 96-bit IV recommended for GCM

/**
 * Returns a consistent 32-byte key buffer derived from the ENCRYPTION_KEY environment variable.
 */
function getMasterKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY || "gitpr-default-dev-encryption-key-32b!";
  if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
    return Buffer.from(envKey, "hex");
  }
  // Deterministically hash to 32 bytes
  return crypto.createHash("sha256").update(envKey).digest();
}

export interface EncryptedPayload {
  encryptedKey: string;
  ivAndTag: string; // Stored as "<ivHex>:<tagHex>"
  last4: string;
}

/**
 * Encrypts a plain API key using AES-256-GCM with a random IV and authenticated tag.
 */
export function encryptApiKey(plainKey: string): EncryptedPayload {
  if (!plainKey || plainKey.trim().length === 0) {
    throw new Error("Cannot encrypt empty API key.");
  }

  const trimmed = plainKey.trim();
  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const ivAndTag = `${iv.toString("hex")}:${tag.toString("hex")}`;
  const last4 = trimmed.slice(-4);

  return {
    encryptedKey: encrypted.toString("hex"),
    ivAndTag,
    last4,
  };
}

/**
 * Decrypts an encrypted key payload.
 * Throws an error if ciphertext or tag was tampered with.
 */
export function decryptApiKey(encryptedHex: string, ivAndTagHex: string): string {
  if (!encryptedHex || !ivAndTagHex) {
    throw new Error("Missing encrypted data or IV/Tag.");
  }

  const [ivHex, tagHex] = ivAndTagHex.split(":");
  if (!ivHex || !tagHex) {
    throw new Error("Malformed IV and authentication tag format.");
  }

  const masterKey = getMasterKey();
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

