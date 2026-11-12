export type Category = "all" | "friends" | "groups";

export type Reply = {
  id: string;
  author: string;
  authorId: string;
  text: string;
  time: number;
  likedBy: string[];
  dislikedBy: string[];
  subReplies: { id: string; author: string; text: string; time: number }[];
};

export type Post = {
  id: string;
  author: string;
  globalId: string;
  content: string;
  category: Category;
  groupId?: string;
  mediaKey?: string;
  mediaMime?: string;
  mediaName?: string;
  likes: string[];
  reposts: string[];
  reports: string[];
  replies: Reply[];
  timestamp: number;
  rev: number;
  deleted?: boolean;
  localOnly?: boolean;
};

export type Quote = { id: string; author: string; preview: string };

export type Msg = {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  status: "queued" | "sent" | "delivered" | "read";
  editedAt?: number;
  isDeleted?: boolean;
  system?: boolean;
  replyTo?: Quote;
  location?: { lat: number; lng: number };
  contactCard?: { name: string; tag: string };
  mediaKey?: string;
  mediaName?: string;
  mediaMime?: string;
  mediaThumb?: string;     // Lightweight inline thumbnail (1-2KB)
  mediaSize?: number;      // File size in bytes
  isDownloaded?: boolean;  // False = WhatsApp style tap to download
  transferProgress?: number; // 0 to 100% transfer indicator
  groupMeta?: Group;
  // --- MULTI-HOP MESH FIELDS ---
  ttl?: number;
  hopPath?: string[];
};

export type Contact = { name: string; tag: string };
export type Group = { id: string; name: string; members: string[] };

export type CallLog = {
  id: string;
  tag: string;
  name: string;
  mode: "voice" | "video";
  direction: "in" | "out";
  result: "done" | "missed" | "declined" | "failed";
  duration: number;
  at: number;
};

export type VerificationType = "none" | "sim" | "self_sms" | "peer_vouched";

export type VerificationInfo = {
  verified: boolean;
  type: VerificationType;
  level: 0 | 1 | 2; // 0: Hardware bind only, 1: Self-SMS, 2: 2+ Peers Vouched
  phone?: string; // Real mobile number (Level 1 ya Level 2 me display hoga)
  phoneHash?: string; // Search matching ke liye
  verifiedAt?: number;
  vouchedBy?: string[]; // Vouch karne wale peer IDs
};

export type Identity = {
  name: string;
  handle: string;
  hub: string;
  discriminator: string;
  globalId: string;
  bio: string;
  secretPin: string;
  avatarUrl?: string; // Ultra-light 4-8KB compressed thumbnail
  instanceId?: number; // 0 for primary, 1, 2 for linked instances
  revokedInstances?: number[]; // Revoked instance list
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  verification?: VerificationInfo;
};

export type PublicIdentity = Omit<Identity, "privateKey">;

export type Peer = {
  globalId: string;
  name: string;
  via: "nearby" | "tab" | "webrtc";
  at: number;
  verification?: VerificationInfo;
  hasInternetGateway?: boolean;
};

export const DEFAULT_HUB_KEY = "mrt-demo-key";
export const REPORT_HIDE_AT = 3;

export function uidOf(tag: string): string {
  const raw = String(tag || "");
  const i = raw.lastIndexOf("#");
  return (i >= 0 ? raw.slice(i + 1) : raw).trim().toLowerCase();
}

export function isGroupId(tag: string): boolean {
  return tag.startsWith("#group_");
}

export function sameUid(a: string, b: string): boolean {
  return uidOf(a) !== "" && uidOf(a) === uidOf(b);
}

export function tagOk(tag: string): boolean {
  if (!tag || typeof tag !== "string") return false;
  // Format: @handle@hub#id (e.g., @setu@mrt#4364)
  return /^@[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+#[a-zA-Z0-9_-]+$/.test(tag.trim());
}

export function makeId(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${Date.now().toString(36)}${hex}`;
}

export function formatWhen(timestamp: number): string {
  const date = new Date(Number(timestamp) || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { day: "2-digit", month: "short" })} ${time}`;
}

export function formatDuration(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function uniq(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function asReply(value: unknown): Reply | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<Reply>;
  if (typeof r.id !== "string" || typeof r.text !== "string") return null;
  const subs = Array.isArray(r.subReplies) ? r.subReplies : [];
  return {
    id: r.id.slice(0, 40),
    author: String(r.author || "Peer").slice(0, 40),
    authorId: String(r.authorId || ""),
    text: r.text.slice(0, 500),
    time: Number(r.time) || Date.now(),
    likedBy: Array.isArray(r.likedBy) ? r.likedBy.filter((x) => typeof x === "string") : [],
    dislikedBy: Array.isArray(r.dislikedBy) ? r.dislikedBy.filter((x) => typeof x === "string") : [],
    subReplies: subs
      .filter((s) => s && typeof s === "object" && typeof (s as { text?: string }).text === "string")
      .map((s) => ({
        id: String((s as { id?: string }).id || makeId("s")),
        author: String((s as { author?: string }).author || "Peer").slice(0, 40),
        text: String((s as { text: string }).text).slice(0, 500),
        time: Number((s as { time?: number }).time) || Date.now(),
      })),
  };
}

export function mergeReplies(a: Reply[], b: Reply[]): Reply[] {
  const map = new Map<string, Reply>();
  for (const raw of [...a, ...b]) {
    const reply = asReply(raw);
    if (!reply) continue;
    const prev = map.get(reply.id);
    if (!prev) {
      map.set(reply.id, reply);
      continue;
    }
    map.set(reply.id, {
      ...reply,
      text: reply.time >= prev.time ? reply.text : prev.text,
      likedBy: uniq([...prev.likedBy, ...reply.likedBy]),
      dislikedBy: uniq([...prev.dislikedBy, ...reply.dislikedBy]),
      subReplies: mergeSubs(prev.subReplies, reply.subReplies),
    });
  }
  return [...map.values()];
}

function mergeSubs(
  a: Reply["subReplies"],
  b: Reply["subReplies"],
): Reply["subReplies"] {
  const map = new Map<string, Reply["subReplies"][number]>();
  for (const sub of [...a, ...b]) map.set(sub.id, sub);
  return [...map.values()];
}

export function mergePosts(a: Post, b: Post): Post {
  const newer = (a.rev || 0) >= (b.rev || 0) ? a : b;
  const older = newer === a ? b : a;
  return {
    ...older,
    ...newer,
    content: (newer.content || older.content || "").slice(0, 2000),
    deleted: Boolean(newer.deleted || (older.deleted && older.rev === newer.rev)),
    likes: uniq([...(a.likes || []), ...(b.likes || [])]),
    reposts: uniq([...(a.reposts || []), ...(b.reposts || [])]),
    reports: uniq([...(a.reports || []), ...(b.reports || [])]),
    replies: mergeReplies(a.replies || [], b.replies || []),
    mediaKey: newer.mediaKey || older.mediaKey,
    mediaMime: newer.mediaMime || older.mediaMime,
    mediaName: newer.mediaName || older.mediaName,
    localOnly: false,
    rev: Math.max(a.rev || 0, b.rev || 0),
  };
}

export function safeMediaSrc(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("blob:")) return url;
  if (url.startsWith("data:image/")) return url;
  if (url.startsWith("data:audio/")) return url;
  if (url.startsWith("data:video/")) return url;
  return null;
}

export function initial(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length > 10 && !phone.startsWith("+")) return `+${digits}`;
  return phone.startsWith("+") ? phone : `+${digits}`;
}

export function hashPhoneSimple(phone: string): string {
  const clean = normalizePhone(phone);
  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = (hash << 5) - hash + clean.charCodeAt(i);
    hash |= 0;
  }
  return "p_" + Math.abs(hash).toString(36);
}

export interface GatewayConfig {
  isGateway: boolean;
  allowSharedData: boolean;
  dailyCapMB: number;
  usedBytesToday: number;
  syncMediaOnlyOnWifi: boolean;
  minCellularFloorMB: number; // Hard Minimum Floor Cap (e.g. 35MB)
}

export type QueuePriority = "high" | "low"; // high = text/auth, low = media/blobs

export type FileChunk = {
  fileId: string;
  index: number;
  total: number;
  data: string; // Base64 chunk
  mime: string;
  name: string;
};