import { mergeReplies, type Msg, type Post } from "@/lib/mesh/model";
import type { Env } from "./types";

export function canon(env: Env): string {
  return `${env.id}|${env.kind}|${env.from}|${env.to ?? ""}|${JSON.stringify(env.payload)}`;
}

export function hex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function rank(status: Msg["status"]): number {
  if (status === "read") return 3;
  if (status === "delivered") return 2;
  if (status === "sent") return 1;
  return 0;
}

export function tidyPost(raw: Post): Post {
  return {
    ...raw,
    id: String(raw.id || "").slice(0, 40),
    author: String(raw.author || "Peer").slice(0, 40),
    globalId: String(raw.globalId || ""),
    content: String(raw.content || "").slice(0, 2000),
    category: raw.category === "friends" || raw.category === "groups" ? raw.category : "all",
    likes: Array.isArray(raw.likes) ? raw.likes.filter((x) => typeof x === "string") : [],
    reposts: Array.isArray(raw.reposts) ? raw.reposts.filter((x) => typeof x === "string") : [],
    reports: Array.isArray(raw.reports) ? raw.reports.filter((x) => typeof x === "string") : [],
    replies: mergeReplies(Array.isArray(raw.replies) ? raw.replies : [], []),
    timestamp: Number(raw.timestamp) || Date.now(),
    rev: Number(raw.rev) || 1,
  };
}

export function loadDeletedForMeSafe(): Set<string> {
  if (typeof localStorage === "undefined") return new Set<string>();
  try {
    const raw = localStorage.getItem("gvnd_deleted_for_me_v1");
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set<string>(parsed.filter((x): x is string => typeof x === "string"));
  } catch (err) {
    console.warn("[mesh/storage] Corrupted gvnd_deleted_for_me_v1 reset:", err);
    return new Set<string>();
  }
}

export async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("meshnet-media-v1", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("blobs")) req.result.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb"));
  });
}
