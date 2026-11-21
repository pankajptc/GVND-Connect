export function dataUrlToBlob(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const mime = /data:(.*?);/.exec(dataUrl.slice(0, comma))?.[1] || "application/octet-stream";
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

export async function computeBlobHash(blob: Blob): Promise<string> {
  try {
    const buf = await blob.arrayBuffer();
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    const bytes = new Uint8Array(buf);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const step = Math.max(1, Math.floor(bytes.length / 4096));
    for (let i = 0; i < bytes.length; i += step) {
      h1 ^= bytes[i];
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= bytes[i] ^ (i & 0xff);
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0") + blob.size.toString(16);
  } catch {
    return "blob_" + blob.size + "_" + Date.now().toString(16);
  }
}

export function safeUrl(url: string, mime: string): string {
  if (url.startsWith("blob:")) return url;
  if (url.startsWith("data:") && (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf")) {
    return url;
  }
  return "";
}
