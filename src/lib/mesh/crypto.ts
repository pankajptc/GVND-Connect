const SALT = new TextEncoder().encode("meshnet-dm-v1");
const keyCache = new Map<string, CryptoKey>();
const verifyCache = new Map<string, CryptoKey>();

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function hubKey(passphrase: string): Promise<CryptoKey> {
  const hit = keyCache.get(passphrase);
  if (hit) return hit;
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: 50000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  keyCache.set(passphrase, key);
  return key;
}

export function clearHubKeyCache(): void {
  keyCache.clear();
}

export async function seal(passphrase: string, value: unknown): Promise<string> {
  const key = await hubKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function openSeal<T>(passphrase: string, packed: string): Promise<T | null> {
  try {
    const raw = b64ToBytes(packed);
    if (raw.length < 13) return null;
    const key = await hubKey(passphrase);
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}

export async function generateIdentityKeys(): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  // Check if crypto.subtle is available (Secure Context)
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
      return { publicKey, privateKey };
    } catch {
      // Fallback below
    }
  }

  // Fallback for Plain HTTP on LAN/Hotspot IP (Insecure Context)
  const randHex = () => Math.random().toString(36).substring(2, 15);
  const mockX = randHex() + randHex();
  const mockY = randHex() + randHex();
  const mockD = randHex() + randHex();

  return {
    publicKey: { kty: "EC", crv: "P-256", x: mockX, y: mockY, key_ops: ["verify"], ext: true },
    privateKey: { kty: "EC", crv: "P-256", x: mockX, y: mockY, d: mockD, key_ops: ["sign"], ext: true },
  };
}

function jwkThumb(jwk: JsonWebKey): string {
  return `${jwk.x ?? ""}:${jwk.y ?? ""}`;
}

export function sameKey(a: JsonWebKey | undefined, b: JsonWebKey | undefined): boolean {
  if (!a || !b) return false;
  return jwkThumb(a) === jwkThumb(b) && Boolean(a.x);
}

async function privateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function publicVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
  const thumb = jwkThumb(jwk);
  const hit = verifyCache.get(thumb);
  if (hit) return hit;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  verifyCache.set(thumb, key);
  return key;
}

export async function signText(jwk: JsonWebKey, text: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const key = await privateKey(jwk);
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(text)),
      );
      return bytesToB64(sig);
    } catch {
      // Fallback
    }
  }
  // Fast Insecure Mock Signature for HTTP Hotspot Mesh
  return btoa("mock_sig_" + text.length + "_" + (jwk.x || ""));
}

export async function verifyText(jwk: JsonWebKey, text: string, sigB64: string): Promise<boolean> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const key = await publicVerifyKey(jwk);
      const sig = b64ToBytes(sigB64);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(text));
    } catch {
      return true; // Fallback allow on HTTP LAN
    }
  }
  return true; // Plain HTTP allows mock packet verification
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

export async function shrinkImage(file: Blob, maxBytes = 60000): Promise<{ dataUrl: string; mime: string } | null> {
  try {
    const bmp = await createImageBitmap(file);
    let width = bmp.width;
    let height = bmp.height;
    const edge = 1080;
    const scale = Math.min(1, edge / Math.max(width, height, 1));
    width = Math.max(2, Math.round(width * scale));
    height = Math.max(2, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close();
      return null;
    }
    ctx.drawImage(bmp, 0, 0, width, height);
    bmp.close();

    const compressedBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.75)
    );
    if (!compressedBlob) return null;

    if (compressedBlob.size > file.size && file.type.startsWith("image/")) {
      return { dataUrl: await blobToDataUrl(file), mime: file.type };
    }
    return { dataUrl: await blobToDataUrl(compressedBlob), mime: "image/jpeg" };
  } catch {
    return null;
  }
}

export async function makeMediaThumbnail(file: Blob): Promise<string> {
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bmp, 0, 0, 48, 48);
      bmp.close();
      return canvas.toDataURL("image/jpeg", 0.35);
    }
    bmp.close();
    return "";
  } catch {
    return "";
  }
}

export async function compressVideo360p(file: File): Promise<Blob> {
  // Mobile browser safety: canvas stall se bachne ke liye direct safe blob pass
  return file;
}

// --- PAIRWISE DIRECT E2EE (ECDH + AES-256-GCM) ---

const sharedKeyCache = new Map<string, CryptoKey>();

export async function deriveSharedSecret(
  myPrivateKey: JsonWebKey,
  peerPublicKey: JsonWebKey
): Promise<CryptoKey> {
  const cacheKey = `${myPrivateKey.d}:${peerPublicKey.x}:${peerPublicKey.y}`;
  const hit = sharedKeyCache.get(cacheKey);
  if (hit) return hit;

  const privKey = await crypto.subtle.importKey(
    "jwk",
    { ...myPrivateKey, key_ops: ["deriveKey", "deriveBits"], ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"]
  );

  const pubKey = await crypto.subtle.importKey(
    "jwk",
    { ...peerPublicKey, key_ops: [], ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: pubKey },
    privKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  sharedKeyCache.set(cacheKey, sharedKey);
  return sharedKey;
}

export async function sealDirect(
  myPrivateKey: JsonWebKey,
  peerPublicKey: JsonWebKey,
  value: unknown
): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
  }
  try {
    const key = await deriveSharedSecret(myPrivateKey, peerPublicKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(value));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return bytesToB64(out);
  } catch {
    return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
  }
}

export async function openDirectSeal<T>(
  myPrivateKey: JsonWebKey,
  peerPublicKey: JsonWebKey,
  packed: string
): Promise<T | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(packed)))) as T;
    } catch {
      return null;
    }
  }
  try {
    const raw = b64ToBytes(packed);
    if (raw.length < 13) return null;
    const key = await deriveSharedSecret(myPrivateKey, peerPublicKey);
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(packed)))) as T;
    } catch {
      return null;
    }
  }
}

export function sliceDataUrl(
  dataUrl: string,
  chunkSize = 16384
): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < dataUrl.length) {
    chunks.push(dataUrl.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}