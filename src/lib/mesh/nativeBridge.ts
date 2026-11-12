export interface AndroidNativeBridge {
  getHostUrl(): string;
  getDiscoveredNodes(): string;
  saveAndOpenFile(base64Data: string, fileName: string, mimeType: string): void;
  getContacts(): string;
  sendSms(phoneNumber: string, message: string): boolean;
  getHttpsHostUrl?(): string;
  getLocalIp?(): string;
  requestPermissionsNow?(): void;
  openAppSettings?(): void;
  isSmsVerified?(): boolean;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidNativeBridge;
  }
}

export function isApkEnvironment(): boolean {
  return typeof window !== "undefined" && Boolean(window.AndroidBridge);
}

export function getLocalHostShareUrl(): string {
  if (typeof window !== "undefined" && window.AndroidBridge) {
    return window.AndroidBridge.getHostUrl();
  }
  return typeof window !== "undefined" ? window.location.origin : "";
}

export function getLanDiscoveredNodes(): string[] {
  if (typeof window === "undefined" || !window.AndroidBridge) return [];
  try {
    return JSON.parse(window.AndroidBridge.getDiscoveredNodes()) as string[];
  } catch {
    return [];
  }
}

export async function openFileWithAndroidBridge(
  blobUrl: string,
  fileName: string,
  mimeType: string
): Promise<boolean> {
  if (typeof window === "undefined" || !window.AndroidBridge) return false;
  try {
    const res = await fetch(blobUrl);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        window.AndroidBridge?.saveAndOpenFile(String(reader.result), fileName, mimeType);
        resolve(true);
      };
      reader.onerror = () => resolve(false);
      reader.readAsDataURL(blob);
    });
  } catch {
    return false;
  }
}
