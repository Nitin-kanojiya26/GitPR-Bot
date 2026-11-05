import { describe, it, expect } from "vitest";
import { encryptApiKey, decryptApiKey } from "../src/security/crypto.js";

describe("AES-256-GCM Key Encryption & Security", () => {
  const sampleKey = "AIzaSyD-1234567890abcdef_SECRET_KEY_99";

  it("successfully encrypts a plaintext key and extracts last 4 digits", () => {
    const payload = encryptApiKey(sampleKey);

    expect(payload.encryptedKey).toBeDefined();
    expect(payload.encryptedKey.length).toBeGreaterThan(0);
    expect(payload.ivAndTag).toContain(":");
    expect(payload.last4).toBe("Y_99");

    // Ciphertext must not contain the plaintext key in plain text
    expect(payload.encryptedKey).not.toContain("AIzaSy");
  });

  it("round-trips encryption and decryption accurately", () => {
    const payload = encryptApiKey(sampleKey);
    const decrypted = decryptApiKey(payload.encryptedKey, payload.ivAndTag);

    expect(decrypted).toBe(sampleKey);
  });

  it("uses a distinct initialization vector for each encryption call", () => {
    const payload1 = encryptApiKey(sampleKey);
    const payload2 = encryptApiKey(sampleKey);

    // IV and ciphertext should differ even for identical plaintexts
    expect(payload1.ivAndTag).not.toBe(payload2.ivAndTag);
    expect(payload1.encryptedKey).not.toBe(payload2.encryptedKey);

    // But both decrypt back to the same key
    expect(decryptApiKey(payload1.encryptedKey, payload1.ivAndTag)).toBe(sampleKey);
    expect(decryptApiKey(payload2.encryptedKey, payload2.ivAndTag)).toBe(sampleKey);
  });

  it("detects and rejects ciphertext tampering (GCM integrity failure)", () => {
    const payload = encryptApiKey(sampleKey);

    // Corrupt the ciphertext by flipping characters in the hex string
    const tamperedHex =
      payload.encryptedKey.slice(0, -2) +
      (payload.encryptedKey.endsWith("a") ? "b" : "a");

    expect(() => decryptApiKey(tamperedHex, payload.ivAndTag)).toThrow();
  });

  it("detects and rejects authentication tag tampering", () => {
    const payload = encryptApiKey(sampleKey);
    const [ivHex, tagHex] = payload.ivAndTag.split(":");

    // Corrupt authentication tag
    const tamperedTag = tagHex.slice(0, -2) + "00";
    const corruptedIvAndTag = `${ivHex}:${tamperedTag}`;

    expect(() => decryptApiKey(payload.encryptedKey, corruptedIvAndTag)).toThrow();
  });

  it("rejects empty or whitespace-only keys", () => {
    expect(() => encryptApiKey("")).toThrow("Cannot encrypt empty API key.");
    expect(() => encryptApiKey("   ")).toThrow("Cannot encrypt empty API key.");
  });

  it("rejects malformed IV and Tag format", () => {
    expect(() => decryptApiKey("abcdef", "not-a-valid-tag")).toThrow(
      "Malformed IV and authentication tag format."
    );
  });
});

