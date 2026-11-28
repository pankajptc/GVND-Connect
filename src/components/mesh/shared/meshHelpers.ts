import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Ban, Check, CheckCheck, Clock, Copy, CornerUpRight, Edit3, FileText,
  Reply, Image as ImageIcon, Lock, MapPin, MessageCircle, Mic, MoreVertical,
  Newspaper, Phone, PhoneOff, Plus, Radio, Repeat2, Search, Send, Star, Trash2,
  UserRound, Users, Video, Volume2, X, ShieldCheck, ShieldAlert, QrCode, Wifi, Globe
} from "lucide-react";
import { getLocalHostShareUrl, openFileWithAndroidBridge } from "@/lib/mesh/nativeBridge";
import { QRCodeSVG } from "@/components/mesh/QRCodeSVG";
import {
  EMPTY_SNAP, getEngine, type MeshEngine, type LiveCall, type Msg, type Post, type Snap
} from "@/lib/mesh/engine";
import {
  REPORT_HIDE_AT, type Category, type Contact, formatDuration, formatWhen, initial,
  isGroupId, safeMediaSrc, sameUid, tagOk, uidOf, hashPhoneSimple, type VerificationInfo
} from "@/lib/mesh/model";

export function threadKey(snap: Snap, tag: string): string {
  if (snap.chats[tag]) return tag;
  if (isGroupId(tag)) return tag;
  return Object.keys(snap.chats).find((key) => !isGroupId(key) && sameUid(key, tag)) || tag;
}

export function messagesFor(snap: Snap, tag: string): Msg[] {
  return snap.chats[threadKey(snap, tag)] || [];
}

export function nameOf(snap: Snap, tag: string): string {
  if (sameUid(tag, snap.me.globalId)) return snap.me.name;
  if (isGroupId(tag)) return snap.groups.find((g) => g.id === tag)?.name || "Group";

  const contact = snap.contacts.find((c) => sameUid(c.tag, tag));
  if (contact?.name) return contact.name;

  const peer = snap.peers.find((p) => sameUid(p.globalId, tag));
  if (peer?.name && peer.name !== "Peer" && !peer.name.startsWith("Peer ") && peer.name !== "GVND Peer") {
    try {
      const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
      const u = String(uidOf(tag) || tag).toLowerCase().replace(/^#/, "");
      c[u] = { ...(c[u] || {}), name: peer.name, avatarUrl: (peer as any).avatarUrl || c[u]?.avatarUrl || "", globalId: peer.globalId };
      localStorage.setItem("meshnet_peer_cache", JSON.stringify(c));
    } catch {}
    return peer.name;
  }

  // Offline Permanent Cache se real name padhein
  try {
    const rawCache = localStorage.getItem("meshnet_peer_cache") || "{}";
    const pCache = JSON.parse(rawCache);
    const hit = Object.entries(pCache).find(([k]) => sameUid(k, tag));
    if (hit && (hit[1] as any)?.name && (hit[1] as any).name !== "Peer" && !(hit[1] as any).name.startsWith("Peer ")) {
      return (hit[1] as any).name;
    }
  } catch {
    /* ignore */
  }

  if (peer?.name) return peer.name;

  // Raw hash address ko readable Peer name me convert karein (@peercd26@mrt#cd267ec0 -> Peer CD26)
  if (tag.startsWith("@peer")) {
    const atParts = tag.split("@");
    const peerPart = atParts.find((part) => part.toLowerCase().startsWith("peer"));
    if (peerPart) {
      const code = peerPart.slice(4).toUpperCase();
      return `Peer ${code}`;
    }
  }

  // Handle format fallback (@username@hub#id -> Username)
  if (tag.startsWith("@")) {
    const handle = tag.slice(1).split("@")[0];
    if (handle) {
      return handle.charAt(0).toUpperCase() + handle.slice(1);
    }
  }

  try {
    const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
    const hit = Object.entries(c).find(([k, v]) => sameUid(k, tag) || sameUid((v as any)?.globalId || "", tag));
    const cachedName = (hit?.[1] as any)?.name;
    if (cachedName && !cachedName.startsWith("Peer ") && cachedName !== "GVND Peer") return cachedName;
  } catch {}
  if (tag.startsWith("@") && tag.includes("@", 1)) {
    const handle = tag.slice(1).split("@")[0];
    if (handle && !handle.startsWith("peer")) return handle.charAt(0).toUpperCase() + handle.slice(1);
  }
  return tag.startsWith("@") ? tag : (tag.split("#")[0] || tag);
}

export function unreadCount(snap: Snap, tag: string): number {
  const muteKey = isGroupId(tag) ? tag : uidOf(tag);
  if (snap.muted.includes(muteKey)) return 0;
  return messagesFor(snap, tag).filter(
    (m) => !sameUid(m.from, snap.me.globalId) && m.status !== "read" && !m.isDeleted && !m.system,
  ).length;
}

export function totalUnread(snap: Snap): number {
  return Object.keys(snap.chats).reduce((sum, tag) => sum + unreadCount(snap, tag), 0);
}


export function previewText(msg?: Msg): string {
  if (!msg) return "Tap to chat";
  if (msg.isDeleted) return "This message was deleted";
  if (msg.content) return msg.content;
  if (msg.mediaMime?.startsWith("image/")) return "Photo";
  if (msg.mediaMime?.startsWith("audio/")) return "Voice note";
  if (msg.mediaName) return msg.mediaName;
  if (msg.location) return "Location";
  if (msg.contactCard) return `Contact · ${msg.contactCard.name}`;
  return "Message";
}


export function visiblePosts(snap: Snap, filter: Category): Post[] {
  return snap.posts.filter((post) => {
    if (post.deleted || snap.hidden.includes(post.id) || post.reports.length >= REPORT_HIDE_AT) return false;
    if (snap.blocked.some((b) => sameUid(b, post.globalId))) return false;
    const self = sameUid(post.globalId, snap.me.globalId);
    const friend = self || snap.contacts.some((c) => sameUid(c.tag, post.globalId));
    if (filter === "friends") return friend && post.category !== "groups";
    if (filter === "groups") return post.category === "groups" && snap.groups.some((g) => g.id === post.groupId);
    if (post.category === "groups") return self && snap.groups.some((g) => g.id === post.groupId);
    if (post.category === "friends") return self;
    return true;
  });
}

