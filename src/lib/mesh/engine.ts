import { P2PRoom } from "@/lib/multiplayer";
import { gvndControl } from "@/lib/mesh/gunControlPlane";
import { getLanDiscoveredNodes } from "@/lib/mesh/nativeBridge";
import {
  blobToDataUrl,
  clearHubKeyCache,
  generateIdentityKeys,
  openSeal,
  sameKey,
  seal,
  shrinkImage,
  signText,
  verifyText,
  sealDirect,
  openDirectSeal,
  sliceDataUrl,
} from "@/lib/mesh/crypto";
import {
  DEFAULT_HUB_KEY,
  REPORT_HIDE_AT,
  type CallLog,
  type Category,
  type Contact,
  type Group,
  type Identity,
  type Msg,
  type Peer,
  type Post,
  type PublicIdentity,
  type Quote,
  type Reply,
  type VerificationInfo,
  type FileChunk,
  formatDuration,
  isGroupId,
  makeId,
  mergePosts,
  mergeReplies,
  sameUid,
  tagOk,
  uidOf,
  hashPhoneSimple,
  normalizePhone,
} from "@/lib/mesh/model";

export type { CallLog, Category, Contact, Group, Msg, Peer, Post, PublicIdentity, Quote };

type Via = "mail" | "bc" | "rtc";

type Env = {
  v: 1;
  id: string;
  kind: "hello" | "dm" | "receipt" | "typing" | "edit" | "delete" | "feed" | "call" | "chunk";
  from: string;
  fromName: string;
  to?: string;
  key?: JsonWebKey;
  sig?: string;
  payload: unknown;
  ttl?: number;       // Max hops allowed
  hopPath?: string[]; // Routing trace
};

type CallBody = {
  action: "offer" | "answer" | "ice" | "hangup" | "reject";
  callId: string;
  mode?: "voice" | "video";
  pin?: string;
  trusted?: boolean;
  reason?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type WireMsg = Msg & { mediaData?: string };

export type IncomingCall = {
  callId: string;
  from: string;
  name: string;
  mode: "voice" | "video";
  sdp: RTCSessionDescriptionInit;
};

export type LiveCall = {
  callId: string;
  tag: string;
  name: string;
  mode: "voice" | "video";
  direction: "in" | "out";
  phase: "ringing" | "connected";
  seconds: number;
  mic: boolean;
  cam: boolean;
  volume: number;
  loopback: boolean;
};

export type Snap = {
  me: PublicIdentity;
  chats: Record<string, Msg[]>;
  contacts: Contact[];
  groups: Group[];
  posts: Post[];
  hidden: string[];
  blocked: string[];
  muted: string[];
  starred: string[];
  callLogs: CallLog[];
  peers: Peer[];
  pins: { uid: string; label: string }[];
  typing: { thread: string; name: string; until: number } | null;
  toast: string | null;
  incoming: IncomingCall | null;
  call: LiveCall | null;
  rtcPeers: number;
  outbox: number;
  urls: Record<string, string>;
  mediaTick: number;
  hubKey: string;
};

const EMPTY_ME: PublicIdentity = {
  name: "GVND Connect",
  handle: "gvnd",
  hub: "mrt",
  discriminator: "00000000",
  globalId: "@gvnd@mrt#00000000",
  bio: "",
  secretPin: "0000",
  publicKey: {},
  verification: {
    verified: false,
    type: "none",
    level: 0,
  },
};

export const EMPTY_SNAP: Snap = {
  me: EMPTY_ME,
  chats: {},
  contacts: [],
  groups: [],
  posts: [],
  hidden: [],
  blocked: [],
  muted: [],
  starred: [],
  callLogs: [],
  peers: [],
  pins: [],
  typing: null,
  toast: null,
  incoming: null,
  call: null,
  rtcPeers: 0,
  outbox: 0,
  urls: {},
  mediaTick: 0,
  hubKey: DEFAULT_HUB_KEY,
};

function canon(env: Env): string {
  return `${env.id}|${env.kind}|${env.from}|${env.to ?? ""}|${JSON.stringify(env.payload)}`;
}

function hex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function rank(status: Msg["status"]): number {
  if (status === "read") return 3;
  if (status === "delivered") return 2;
  if (status === "sent") return 1;
  return 0;
}

function tidyPost(raw: Post): Post {
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

function dataUrlToBlob(dataUrl: string): Blob | null {
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

async function computeBlobHash(blob: Blob): Promise<string> {
  try {
    const buf = await blob.arrayBuffer();
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const hashBuf = await crypto.subtle.digest("SHA-256", buf);
      const hexStr = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `sha_${hexStr.slice(0, 24)}`;
    }
  } catch {}
  return `sz_${blob.size}_${blob.type.replace(/[^a-z0-9]/gi, "")}`;
}

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("meshnet-media-v1", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("blobs")) req.result.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb"));
  });
}

export class MeshEngine {
  localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null;

  private identity: Identity | null = null;
  private chats: Record<string, Msg[]> = {};
  private contacts: Contact[] = [];
  private groups: Group[] = [];
  private posts: Post[] = [];
  private hidden: string[] = [];
  private blocked: string[] = [];
  private muted: string[] = [];
  private starred: string[] = [];
  private callLogs: CallLog[] = [];
  private passphrase = DEFAULT_HUB_KEY;
  private pins: Record<string, JsonWebKey> = {};
  private urls: Record<string, string> = {};
  private presence = new Map<string, Peer>();
  private p2pByUid = new Map<string, string>();
  private listeners = new Set<() => void>();
  private snap: Snap = EMPTY_SNAP;
  private refs = 0;
  private bc: BroadcastChannel | null = null;
  private room: P2PRoom | null = null;
  private timers: number[] = [];
  private persistTimer = 0;
  private toastTimer = 0;
  private toastText: string | null = null;

  private toast(text: string): void {
    this.toastText = text;
    this.emit();
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastText = null;
      this.emit();
    }, 3200);
  }
  private typing: Snap["typing"] = null;
  private rtcPeers = 0;
  private mediaTick = 0;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private viewing: string | null = null;
  private inflight = new Set<string>();
  private activeDownloads = new Map<string, number>(); // msgId -> lastChunkTimestamp
  private hashDirectory = new Map<string, { compHash: string; size: number; mime: string; thumb?: string }>();
  private rawMedia = new Map<string, string>();
  private chunkBuffer = new Map<string, { total: number; chunks: Map<number, string>; mime: string; name: string }>();
  private hydrated = false;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private incoming: IncomingCall | null = null;
  private live: LiveCall | null = null;
  private callClock = 0;
  private ringTimer = 0;
  private badKeyToasted = false;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): Snap {
    return this.snap;
  }

  async start(): Promise<void> {
    this.refs += 1;
    if (this.refs > 1) return;
    if (!this.hydrated) await this.hydrate();
    this.openTransports();
  }

  stop(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    this.closeTransports();
  }

  setViewing(tag: string | null): void {
    this.viewing = tag ? this.resolve(tag) : null;
    if (this.viewing) this.markRead(this.viewing);
  }

  sendText(to: string, text: string, reply?: Quote | null): void {
    const clean = text.trim();
    if (!clean || !to) return;
    this.queueOut({
      id: makeId("m"),
      from: this.me().globalId,
      to,
      content: clean.slice(0, 2000),
      timestamp: Date.now(),
      status: "queued",
      replyTo: reply || undefined,
    });
  }

  sendLocation(to: string, lat: number, lng: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    this.queueOut({
      id: makeId("m"),
      from: this.me().globalId,
      to,
      content: "",
      timestamp: Date.now(),
      status: "queued",
      location: { lat, lng },
    });
  }

  sendContactCard(to: string, contact: Contact): void {
    this.queueOut({
      id: makeId("m"),
      from: this.me().globalId,
      to,
      content: "",
      timestamp: Date.now(),
      status: "queued",
      contactCard: { name: contact.name.slice(0, 40), tag: contact.tag },
    });
  }

  async sendFile(to: string, file: File): Promise<void> {
    if (file.size > 104857600) {
      this.toast("File 100MB se badi hai. Max 100MB allow hai.");
      return;
    }

    const mime = file.type || "application/octet-stream";
    const msgId = makeId("m");
    const tempKey = makeId("f");

    // 1. Lock message while processing so flush() never sends uncompressed file
    this.inflight.add(msgId);

    const draftMsg: Msg = {
      id: msgId,
      from: this.me().globalId,
      to,
      content: "",
      timestamp: Date.now(),
      status: "queued",
      mediaKey: tempKey,
      mediaName: (file.name || "file").slice(0, 80),
      mediaMime: mime,
      mediaSize: file.size,
      isDownloaded: true,
      transferProgress: 1,
      ttl: 4,
    };
    this.insert(this.resolve(to), draftMsg);
    this.emit();

    // 2. Original File SHA-256 Check (Delhi/Mumbai Global Deduplication)
    const origHash = await computeBlobHash(file);
    const cachedMapping = this.hashDirectory.get(origHash);

    // Agar wahi original file pehle se compressed & cached hai to dubara compress na karein
    if (cachedMapping && (this.urls[cachedMapping.compHash] || this.rawMedia.has(cachedMapping.compHash))) {
      const updatedMsg = this.patchMsg(msgId, (m) => ({
        ...m,
        mediaKey: cachedMapping.compHash,
        mediaMime: cachedMapping.mime,
        mediaThumb: cachedMapping.thumb,
        mediaSize: cachedMapping.size,
        transferProgress: undefined,
      }));
      this.emitPersist();
      this.inflight.delete(msgId);
      if (updatedMsg) {
        await this.deliver({ ...updatedMsg, mediaKey: cachedMapping.compHash, mediaSize: cachedMapping.size, mediaMime: cachedMapping.mime }, undefined);
      }
      return;
    }

    let processedBlob: Blob = file;
    let finalMime = mime;
    let lightThumb = "";

    // 3A. Dynamic Video Compression (Waits until conversion completes 100%)
    if (mime.startsWith("video/")) {
      try {
        processedBlob = await new Promise<Blob>((resolve) => {
          const video = document.createElement("video");
          const fileUrl = URL.createObjectURL(file);
          video.src = fileUrl;
          video.preload = "auto";
          video.playsInline = true;
          video.muted = true;

          let finished = false;
          const finishWith = (resultBlob: Blob) => {
            if (finished) return;
            finished = true;
            URL.revokeObjectURL(fileUrl);
            resolve(resultBlob);
          };

          video.onloadedmetadata = async () => {
            try {
              const targetH = 360;
              const aspect = (video.videoWidth || 640) / (video.videoHeight || 360);
              const targetW = Math.max(2, Math.round((targetH * aspect) / 2) * 2);

              const canvas = document.createElement("canvas");
              canvas.width = targetW;
              canvas.height = targetH;
              const ctx = canvas.getContext("2d", { alpha: false });
              if (!ctx) throw new Error("no ctx");

              const videoStream = canvas.captureStream(24);
              let combinedStream: MediaStream = videoStream;
              let audioCtx: AudioContext | null = null;

              try {
                const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                audioCtx = new AC();
                if (audioCtx.state === "suspended") await audioCtx.resume();
                const src = audioCtx.createMediaElementSource(video);
                const dest = audioCtx.createMediaStreamDestination();
                src.connect(dest);
                video.muted = false;
                const aTracks = dest.stream.getAudioTracks();
                if (aTracks.length > 0) {
                  combinedStream = new MediaStream([videoStream.getVideoTracks()[0], aTracks[0]]);
                }
              } catch {}

              let recMime = "video/webm;codecs=vp8,opus";
              if (!MediaRecorder.isTypeSupported(recMime)) recMime = "video/webm";

              const recorder = new MediaRecorder(combinedStream, {
                mimeType: recMime,
                videoBitsPerSecond: 700000,
                audioBitsPerSecond: 64000,
              });

              const chunks: Blob[] = [];
              recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) chunks.push(e.data);
              };

              recorder.onstop = () => {
                if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
                const out = new Blob(chunks, { type: "video/webm" });
                if (out.size > 0 && out.size < file.size) {
                  finalMime = "video/webm";
                  finishWith(out);
                } else {
                  finishWith(file);
                }
              };

              recorder.onerror = () => finishWith(file);

              await video.play().catch(async () => {
                video.muted = true;
                await video.play();
              });
              recorder.start(400);

              let thumbCaptured = false;
              const drawFrame = () => {
                if (finished) return;
                if (!video.paused && !video.ended) {
                  ctx.drawImage(video, 0, 0, targetW, targetH);
                  if (!thumbCaptured && video.currentTime > 0.1) {
                    thumbCaptured = true;
                    try {
                      const tc = document.createElement("canvas");
                      tc.width = 48;
                      tc.height = 48;
                      tc.getContext("2d")?.drawImage(video, 0, 0, 48, 48);
                      lightThumb = tc.toDataURL("image/jpeg", 0.35);
                    } catch {}
                  }
                  if (video.duration) {
                    const pct = Math.min(85, Math.max(5, Math.round((video.currentTime / video.duration) * 85)));
                    this.patchMsg(msgId, (m) => ({ ...m, transferProgress: pct }));
                    this.emit();
                  }
                  requestAnimationFrame(drawFrame);
                } else if (video.ended) {
                  if (recorder.state === "recording") recorder.stop();
                } else {
                  void video.play().catch(() => {});
                  requestAnimationFrame(drawFrame);
                }
              };
              requestAnimationFrame(drawFrame);
            } catch {
              finishWith(file);
            }
          };

          video.onerror = () => finishWith(file);
        });
      } catch {
        processedBlob = file;
      }
    } else if (mime.startsWith("image/")) {
      this.patchMsg(msgId, (m) => ({ ...m, transferProgress: 30 }));
      this.emit();
      const shrunk = await shrinkImage(file, 45000);
      if (shrunk) {
        const b = dataUrlToBlob(shrunk.dataUrl);
        if (b) processedBlob = b;
        finalMime = shrunk.mime;
      }
      try {
        const bmp = await createImageBitmap(processedBlob);
        const c = document.createElement("canvas");
        c.width = 48;
        c.height = 48;
        c.getContext("2d")?.drawImage(bmp, 0, 0, 48, 48);
        lightThumb = c.toDataURL("image/jpeg", 0.35);
        bmp.close();
      } catch {}
    } else if (mime.startsWith("audio/")) {
      // 3C. Uploaded Audio Compression (64kbps Opus)
      try {
        processedBlob = await new Promise<Blob>((resolve) => {
          const audioEl = document.createElement("audio");
          const fileUrl = URL.createObjectURL(file);
          audioEl.src = fileUrl;
          audioEl.preload = "auto";

          let finished = false;
          const finishAudio = (res: Blob) => {
            if (finished) return;
            finished = true;
            URL.revokeObjectURL(fileUrl);
            resolve(res);
          };

          audioEl.onloadedmetadata = async () => {
            try {
              const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
              const audioCtx = new AC();
              if (audioCtx.state === "suspended") await audioCtx.resume();
              const src = audioCtx.createMediaElementSource(audioEl);
              const dest = audioCtx.createMediaStreamDestination();
              src.connect(dest);

              const recMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/webm";
              const recorder = new MediaRecorder(dest.stream, {
                mimeType: recMime,
                audioBitsPerSecond: 64000, // 64kbps Opus
              });

              const chunks: Blob[] = [];
              recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) chunks.push(e.data);
              };

              recorder.onstop = () => {
                if (audioCtx.state !== "closed") void audioCtx.close();
                const out = new Blob(chunks, { type: "audio/webm" });
                if (out.size > 0 && out.size < file.size) {
                  finalMime = "audio/webm";
                  finishAudio(out);
                } else {
                  finishAudio(file);
                }
              };

              recorder.onerror = () => finishAudio(file);

              audioEl.ontimeupdate = () => {
                if (audioEl.duration) {
                  const pct = Math.min(85, Math.max(5, Math.round((audioEl.currentTime / audioEl.duration) * 85)));
                  this.patchMsg(msgId, (m) => ({ ...m, transferProgress: pct }));
                  this.emit();
                }
              };

              audioEl.onended = () => {
                if (recorder.state === "recording") recorder.stop();
              };

              await audioEl.play();
              recorder.start(400);
            } catch {
              finishAudio(file);
            }
          };

          audioEl.onerror = () => finishAudio(file);
        });
      } catch {
        processedBlob = file;
      }
    }

    // 4. Content-Addressable SHA-256 Key + Save Mapping (origHash -> compHash)
    const contentHashKey = await computeBlobHash(processedBlob);
    const finalSize = processedBlob.size;

    this.hashDirectory.set(origHash, {
      compHash: contentHashKey,
      size: finalSize,
      mime: finalMime,
      thumb: lightThumb || undefined,
    });
    try {
      localStorage.setItem("meshnet_hash_directory", JSON.stringify(Object.fromEntries(this.hashDirectory)));
    } catch {}

    this.patchMsg(msgId, (m) => ({
      ...m,
      mediaKey: contentHashKey,
      transferProgress: 90,
      mediaSize: finalSize,
      mediaMime: finalMime,
    }));
    this.emit();

    if (!this.urls[contentHashKey]) {
      const dataUrl = await blobToDataUrl(processedBlob);
      await this.keepMedia(contentHashKey, dataUrl, finalMime);
    }

    // 5. Send Metadata + SHA-256 Hash + Thumbnail
    const updatedMsg = this.patchMsg(msgId, (m) => ({
      ...m,
      mediaKey: contentHashKey,
      mediaMime: finalMime,
      mediaThumb: lightThumb || undefined,
      mediaSize: finalSize,
      transferProgress: undefined,
    }));
    this.emitPersist();

    this.inflight.delete(msgId);
    if (updatedMsg) {
      await this.deliver({ ...updatedMsg, mediaKey: contentHashKey, mediaSize: finalSize, mediaMime: finalMime }, undefined);
    }
  }

  private async attachAndSend(to: string, name: string, mime: string, dataUrl: string, thumb?: string, rawSize?: number): Promise<void> {
    const blob = dataUrlToBlob(dataUrl);
    const mediaKey = blob ? await computeBlobHash(blob) : makeId("f");
    const msgId = makeId("m");
    const msg: Msg = {
      id: msgId,
      from: this.me().globalId,
      to,
      content: "",
      timestamp: Date.now(),
      status: "queued",
      mediaKey,
      mediaName: name.slice(0, 80),
      mediaMime: mime,
      mediaThumb: thumb,
      mediaSize: rawSize || dataUrl.length,
      isDownloaded: true,
      transferProgress: 35,
      ttl: 4,
    };
    this.insert(this.resolve(to), msg);
    this.emit();

    if (!this.urls[mediaKey]) {
      await this.keepMedia(mediaKey, dataUrl, mime);
    }

    this.patchMsg(msgId, (m) => ({ ...m, transferProgress: undefined }));
    this.emitPersist();

    const finalMsg = this.chats[this.resolve(to)]?.find((m) => m.id === msgId);
    if (finalMsg) await this.deliver(finalMsg, undefined);
  }

  async sendVoice(to: string, blob: Blob): Promise<void> {
    if (blob.size > 15000000) {
      this.toast("Voice note bahut lamba hai (Max 15MB).");
      return;
    }
    const dataUrl = await blobToDataUrl(blob);
    await this.attachAndSend(to, "voice-note.webm", blob.type || "audio/webm", dataUrl, "", blob.size);
  }

  // Receiver Download: Pehle local SHA-256 cache check karega -> Nahi mila to Sender + Mesh Swarm se fetch karega
  async requestMediaDownload(msgId: string, isResume = false): Promise<void> {
    for (const [t, list] of Object.entries(this.chats)) {
      const m = list.find((msg) => msg.id === msgId);
      if (m && m.mediaKey && !m.isDownloaded) {
        // 1. WhatsApp Deduplication: Agar wahi file kisi aur chat me pehle se downloaded hai to 0KB me turant open karein!
        if (this.urls[m.mediaKey] || this.rawMedia.has(m.mediaKey)) {
          this.patchMsg(msgId, (item) => ({ ...item, isDownloaded: true, transferProgress: undefined }));
          this.emitPersist();
          return;
        }

        const lastActive = this.activeDownloads.get(msgId) || 0;
        if (isResume && Date.now() - lastActive < 6000) return;

        this.activeDownloads.set(msgId, Date.now());
        const senderOnline = this.isOnline(m.from);

        const existingEntry = this.chunkBuffer.get(m.mediaKey);
        const currentPct = existingEntry && existingEntry.total > 0
          ? Math.max(1, Math.round((existingEntry.chunks.size / existingEntry.total) * 100))
          : (m.transferProgress && m.transferProgress > 1 ? m.transferProgress : 1);

        this.patchMsg(msgId, (item) => ({ ...item, transferProgress: currentPct }));
        this.emit();

        if (!senderOnline && !isResume) {
          this.toast("Sender offline hai — Mesh Swarm aur Relay queue se file dhoondi ja rahi hai...");
        }

        // 2. Direct Sender + Offline Mail Queue
        await this.ship(
          {
            v: 1,
            id: makeId("req"),
            kind: "chunk",
            from: this.me().globalId,
            fromName: this.me().name,
            to: m.from,
            payload: { fileId: m.mediaKey, index: -1, total: 0, data: "FETCH", mime: m.mediaMime || "", name: m.mediaName || "" },
            ttl: 4,
          },
          [{ uid: uidOf(m.from), mail: !senderOnline }]
        );

        // 3. Swarm Fallback: Agar sender offline hai aur mesh par koi aur peer online hai jiske paas ye hash hai, to usse bhi maangein
        if (!senderOnline && this.snap.peers.length > 0) {
          await this.ship(
            {
              v: 1,
              id: makeId("swm"),
              kind: "chunk",
              from: this.me().globalId,
              fromName: this.me().name,
              payload: { fileId: m.mediaKey, index: -1, total: 0, data: "FETCH_SWARM", mime: m.mediaMime || "", name: m.mediaName || "" },
              ttl: 3,
            },
            "all"
          );
        }
        break;
      }
    }
  }

  editMessage(thread: string, id: string, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const msg = this.patchMsg(id, (m) => {
      if (!sameUid(m.from, this.me().globalId) || m.isDeleted || m.system) return m;
      return { ...m, content: clean.slice(0, 2000), editedAt: Date.now() };
    });
    if (!msg?.editedAt) return;
    this.emitPersist();
    void this.shipEdit(this.resolve(thread), msg);
  }

  deleteMessage(thread: string, id: string, mode: "everyone" | "me" = "everyone"): void {
    const key = this.resolve(thread);
    if (mode === "me") {
      const list = this.chats[key] || [];
      this.chats = { ...this.chats, [key]: list.filter((m) => m.id !== id) };
      this.emitPersist();
      return;
    }

    const msg = this.patchMsg(id, (m) => {
      if (!sameUid(m.from, this.me().globalId) || m.system) return m;
      return { ...m, isDeleted: true, content: "", mediaKey: undefined, location: undefined };
    });
    if (!msg?.isDeleted) return;
    this.emitPersist();
    void this.ship({
      v: 1,
      id: makeId("d"),
      kind: "delete",
      from: this.me().globalId,
      fromName: this.me().name,
      to: msg.to,
      payload: { msgId: id, thread: msg.to },
    }, this.targetsFor(msg.to));
  }

  deleteMessagesBulk(thread: string, ids: string[], mode: "everyone" | "me"): void {
    for (const id of ids) {
      this.deleteMessage(thread, id, mode);
    }
    this.toast(mode === "everyone" ? "Deleted for everyone" : "Deleted for me");
  }

  forwardMessages(targetTags: string[], msgs: Msg[]): void {
    for (const to of targetTags) {
      for (const m of msgs) {
        if (m.isDeleted || m.system) continue;
        const out: Msg = {
          id: makeId("m"),
          from: this.me().globalId,
          to,
          content: m.content || "",
          timestamp: Date.now(),
          status: "queued",
          location: m.location,
          contactCard: m.contactCard,
          mediaKey: m.mediaKey,
          mediaName: m.mediaName,
          mediaMime: m.mediaMime,
          mediaThumb: m.mediaThumb,
          mediaSize: m.mediaSize,
          isDownloaded: Boolean(m.mediaKey ? (this.urls[m.mediaKey] || this.rawMedia.has(m.mediaKey)) : true),
          ttl: 4,
        };
        this.insert(this.resolve(to), out);
        void this.deliver(out, undefined);
      }
    }
    this.emitPersist();
    this.toast(`Forwarded to ${targetTags.length} chat(s)`);
  }

  toggleStar(id: string): void {
    this.starred = this.starred.includes(id) ? this.starred.filter((x) => x !== id) : [...this.starred, id];
    this.emitPersist();
  }

  clearThread(thread: string): void {
    const key = this.resolve(thread);
    const next = { ...this.chats };
    delete next[key];
    this.chats = next;
    this.emitPersist();
  }

  setTyping(to: string, on: boolean): void {
    if (!to) return;
    void this.ship(
      {
        v: 1,
        id: makeId("t"),
        kind: "typing",
        from: this.me().globalId,
        fromName: this.me().name,
        to,
        payload: { on, thread: to },
      },
      this.targetsFor(to).map((t) => ({ ...t, mail: false })),
    );
  }

  saveContact(name: string, tag: string): string | null {
    const cleanTag = tag.trim();
    const cleanName = name.trim();
    if (!cleanName || !tagOk(cleanTag)) return "Naam aur sahi global tag dono chahiye.";
    const rest = this.contacts.filter((c) => !sameUid(c.tag, cleanTag));
    this.contacts = [...rest, { name: cleanName.slice(0, 40), tag: cleanTag }];
    this.emitPersist();
    this.toast("Contact save ho gaya.");
    return null;
  }

  removeContact(tag: string): void {
    this.contacts = this.contacts.filter((c) => !sameUid(c.tag, tag));
    this.emitPersist();
  }

  toggleMute(tag: string): void {
    const key = isGroupId(tag) ? tag : uidOf(tag);
    this.muted = this.muted.includes(key) ? this.muted.filter((x) => x !== key) : [...this.muted, key];
    this.emitPersist();
  }

  toggleBlock(tag: string): void {
    const key = uidOf(tag);
    if (!key) return;
    if (this.blocked.some((b) => uidOf(b) === key)) {
      this.blocked = this.blocked.filter((b) => uidOf(b) !== key);
      this.toast("Unblock ho gaya.");
    } else {
      this.blocked = [...this.blocked, tag];
      this.toast("Block ho gaya. Unke messages aur posts yahan nahi dikhenge.");
    }
    this.emitPersist();
  }

  forgetPin(uid: string): void {
    const next = { ...this.pins };
    delete next[uid];
    this.pins = next;
    this.toast("Pinned key hata di. Agli hello par naya key save hoga.");
    this.emitPersist();
  }

  createGroup(name: string, members: string[]): string | null {
    if (!this.me().verification?.verified) {
      this.toast("Naya group banane ke liye verified account chahiye.");
      return null;
    }
    const clean = name.trim();
    if (clean.length < 2) {
      this.toast("Group ka naam chahiye.");
      return null;
    }
    const unique = [this.me().globalId];
    for (const member of members) {
      if (!tagOk(member) || sameUid(member, this.me().globalId)) continue;
      if (!unique.some((m) => sameUid(m, member))) unique.push(member.trim());
    }
    if (unique.length < 2) {
      this.toast("Kam se kam ek member chahiye.");
      return null;
    }
    const group: Group = { id: `#group_${hex(4)}`, name: clean.slice(0, 32), members: unique };
    this.groups = [...this.groups, group];
    const msg: Msg = {
      id: makeId("m"),
      from: this.me().globalId,
      to: group.id,
      content: `${this.me().name} ne group banaya`,
      timestamp: Date.now(),
      status: "sent",
      system: true,
      groupMeta: group,
    };
    this.insert(group.id, msg);
    this.emitPersist();
    void this.fanout(msg);
    return group.id;
  }

  leaveGroup(id: string): void {
    this.groups = this.groups.filter((g) => g.id !== id);
    this.insert(id, {
      id: makeId("m"),
      from: this.me().globalId,
      to: id,
      content: "Aap group se nikal gaye",
      timestamp: Date.now(),
      status: "sent",
      system: true,
    });
    this.emitPersist();
  }

  async publishPost(input: {
    text: string;
    category: Category;
    groupId?: string;
    file?: File | null;
  }): Promise<string | null> {
    const text = input.text.trim();
    if (!text && !input.file) return "Kuch likho ya photo lagao.";
    if (input.category === "groups" && !input.groupId) return "Group choose karo.";
    let mediaKey: string | undefined;
    let mediaMime: string | undefined;
    let mediaName: string | undefined;
    if (input.file) {
      if (!this.me().verification?.verified) {
        return "Feed par photo post karne ke liye account verify karein.";
      }
      if (!input.file.type.startsWith("image/")) return "Feed par abhi photo supported hai.";
      const shrunk = await shrinkImage(input.file);
      if (!shrunk) return "Photo compress nahi ho payi.";
      mediaKey = makeId("i");
      mediaMime = shrunk.mime;
      mediaName = input.file.name || "photo.jpg";
      await this.keepMedia(mediaKey, shrunk.dataUrl, mediaMime);
    }
    const post: Post = {
      id: makeId("p"),
      author: this.me().name,
      globalId: this.me().globalId,
      content: text.slice(0, 2000),
      category: input.category,
      groupId: input.category === "groups" ? input.groupId : undefined,
      mediaKey,
      mediaMime,
      mediaName,
      likes: [],
      reposts: [],
      reports: [],
      replies: [],
      timestamp: Date.now(),
      rev: 1,
    };
    this.posts = [post, ...this.posts].slice(0, 120);
    this.emitPersist();
    void this.pushFeed(post);
    return null;
  }

  toggleLike(id: string): void {
    this.touchPost(id, (post) => {
      const mine = this.me().globalId;
      const has = post.likes.some((x) => sameUid(x, mine));
      post.likes = has ? post.likes.filter((x) => !sameUid(x, mine)) : [...post.likes, mine];
    });
  }

  toggleRepost(id: string): void {
    const post = this.posts.find((p) => p.id === id);
    if (!post) return;
    if (post.reposts.some((x) => sameUid(x, this.me().globalId))) {
      this.toast("Aap is post ko pehle hi repost kar chuke ho.");
      return;
    }
    this.touchPost(id, (p) => {
      p.reposts = [...p.reposts, this.me().globalId];
    });
  }

  addComment(postId: string, text: string, parentId?: string | null): void {
    const clean = text.trim();
    if (!clean) return;
    this.touchPost(postId, (post) => {
      if (parentId) {
        post.replies = post.replies.map((reply) => {
          if (reply.id !== parentId) return reply;
          return {
            ...reply,
            subReplies: [
              ...reply.subReplies,
              { id: makeId("s"), author: this.me().name, text: clean.slice(0, 500), time: Date.now() },
            ],
          };
        });
        return;
      }
      const reply: Reply = {
        id: makeId("c"),
        author: this.me().name,
        authorId: this.me().globalId,
        text: clean.slice(0, 500),
        time: Date.now(),
        likedBy: [],
        dislikedBy: [],
        subReplies: [],
      };
      post.replies = [...post.replies, reply];
    });
  }

  reactComment(postId: string, commentId: string, reaction: "like" | "dislike"): void {
    const mine = this.me().globalId;
    this.touchPost(postId, (post) => {
      post.replies = post.replies.map((reply) => {
        if (reply.id !== commentId) return reply;
        let liked = reply.likedBy.filter((id) => !sameUid(id, mine));
        let disliked = reply.dislikedBy.filter((id) => !sameUid(id, mine));
        if (reaction === "like") {
          if (!reply.likedBy.some((id) => sameUid(id, mine))) liked = [...liked, mine];
        } else if (!reply.dislikedBy.some((id) => sameUid(id, mine))) {
          disliked = [...disliked, mine];
        }
        return { ...reply, likedBy: liked, dislikedBy: disliked };
      });
    });
  }

  reportPost(id: string): void {
    const post = this.posts.find((p) => p.id === id);
    if (!post) return;
    if (sameUid(post.globalId, this.me().globalId)) {
      this.toast("Apni post report nahi hoti. Delete karo.");
      return;
    }
    if (post.reports.some((x) => sameUid(x, this.me().globalId))) {
      this.toast("Report pehle hi ja chuki hai.");
      return;
    }
    this.touchPost(id, (p) => {
      p.reports = [...p.reports, this.me().globalId];
    });
    const next = this.posts.find((p) => p.id === id);
    const n = next?.reports.length ?? 1;
    this.toast(n >= REPORT_HIDE_AT ? "Post hide ho gayi. Kaafi reports aa gayi." : `Report ${n}/${REPORT_HIDE_AT}`);
  }

  hidePost(id: string): void {
    if (!this.hidden.includes(id)) this.hidden = [...this.hidden, id];
    this.emitPersist();
  }

  deletePost(id: string): void {
    const post = this.posts.find((p) => p.id === id);
    if (!post || !sameUid(post.globalId, this.me().globalId)) return;
    this.touchPost(id, (p) => {
      p.deleted = true;
      p.content = "";
    });
  }

  saveProfile(input: { name: string; handle: string; hub: string; bio: string }): string | null {
    const name = input.name.trim();
    const handle = input.handle.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const hub = input.hub.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
    if (name.length < 2 || handle.length < 2) return "Naam aur username dono chahiye.";
    if (!/^[a-z0-9]{2,6}$/.test(hub)) return "Hub code 2–6 letters.";
    if (["admin", "system"].includes(handle)) return "Ye username reserved hai.";
    const old = this.me().globalId;
    const next: Identity = {
      ...this.me(),
      name: name.slice(0, 32),
      handle,
      hub,
      bio: input.bio.trim().slice(0, 160),
      globalId: `@${handle}@${hub}#${this.me().discriminator}`,
    };
    this.identity = next;
    if (old !== next.globalId) {
      for (const [thread, list] of Object.entries(this.chats)) {
        this.chats[thread] = list.map((m) => (m.from === old ? { ...m, from: next.globalId } : m));
      }
      this.posts = this.posts.map((p) =>
        p.globalId === old ? { ...p, globalId: next.globalId, author: next.name, rev: p.rev + 1 } : p,
      );
    }
    this.emitPersist();
    this.rejoin();
    this.toast("Profile save ho gaya.");
    return null;
  }

  regenPin(): void {
    const pin = String(1000 + Math.floor(Math.random() * 9000));
    this.identity = { ...this.me(), secretPin: pin };
    this.emitPersist();
    this.toast(`Naya PIN ${pin}`);
  }

  setPassphrase(next: string): string | null {
    const clean = next.trim();
    if (clean.length < 8) return "Hub key kam se kam 8 characters.";
    this.passphrase = clean.slice(0, 80);
    clearHubKeyCache();
    this.emitPersist();
    this.toast("Hub key badal gayi. Doosre nodes par bhi yahi key daalo.");
    return null;
  }

  async startCall(tag: string, mode: "voice" | "video", opts: { pin?: string; dialer: boolean }): Promise<string | null> {
    const target = tag.trim();
    if (this.live || this.incoming) return "Pehle wali call khatam karo.";
    if (sameUid(target, this.me().globalId)) return "Khud ko call nahi kar sakte.";
    if (!tagOk(target)) return "Global tag sahi format mein nahi hai.";
    if (opts.dialer) {
      if (!opts.pin || opts.pin.trim().length < 4) return "4 digit calling PIN chahiye.";
    } else if (!this.isContact(target)) {
      return "Ye saved contact nahi hai. Calls tab se PIN ke saath dial karo.";
    }
    if (!this.isOnline(target)) return "Peer filhal offline hai.";
    const targetPeer = this.presence.get(uidOf(target));
    if (!targetPeer?.verification?.verified && !this.isContact(target)) {
      return "Unverified peer ko call sirf unke saved contact hone par ja sakti hai.";
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === "video" });
    } catch {
      this.localStream = null;
      return "Mic ya camera ki permission nahi mili.";
    }
    const callId = makeId("c");
    this.live = {
      callId,
      tag: target,
      name: this.nameOf(target),
      mode,
      direction: "out",
      phase: "ringing",
      seconds: 0,
      mic: true,
      cam: mode === "video",
      volume: 1,
    };
    this.bumpMedia();
    try {
      this.pc = this.makePc(target, callId);
      for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream as MediaStream);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this.wireCall(target, {
        action: "offer",
        callId,
        mode,
        sdp: offer,
        pin: opts.pin?.trim() || "",
        trusted: !opts.dialer && this.isContact(target),
      });
    } catch {
      this.finishCall("failed");
      return "Call setup fail ho gaya.";
    }
    this.ringTimer = window.setTimeout(() => {
      if (this.live?.callId === callId && this.live.phase === "ringing") {
        this.toast("Koi jawab nahi.");
        this.finishCall("missed");
      }
    }, 30000);
    return null;
  }

  async acceptCall(): Promise<void> {
    const inc = this.incoming;
    if (!inc) return;
    window.clearTimeout(this.ringTimer);
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: inc.mode === "video",
      });
    } catch {
      this.toast("Mic ya camera ki permission nahi mili.");
      this.declineCall();
      return;
    }
    try {
      this.pc = this.makePc(inc.from, inc.callId);
      for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream as MediaStream);
      await this.pc.setRemoteDescription(inc.sdp);
      await this.flushIce();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.wireCall(inc.from, { action: "answer", callId: inc.callId, sdp: answer });
      this.incoming = null;
      this.live = {
        callId: inc.callId,
        tag: inc.from,
        name: inc.name,
        mode: inc.mode,
        direction: "in",
        phase: "ringing",
        seconds: 0,
        mic: true,
        cam: inc.mode === "video",
        volume: 1,
        loopback: false,
      };
      this.bumpMedia();
    } catch {
      this.toast("Call accept nahi ho payi.");
      this.finishCall("failed");
    }
  }

  declineCall(): void {
    const inc = this.incoming;
    if (!inc) {
      if (this.live) void this.hangup();
      return;
    }
    window.clearTimeout(this.ringTimer);
    void this.wireCall(inc.from, { action: "reject", callId: inc.callId, reason: "declined" });
    this.logCall({
      tag: inc.from,
      name: inc.name,
      mode: inc.mode,
      direction: "in",
      result: "declined",
      duration: 0,
    });
    this.incoming = null;
    this.emitPersist();
  }

  hangup(): void {
    const live = this.live;
    if (live) void this.wireCall(live.tag, { action: "hangup", callId: live.callId });
    this.finishCall(live?.phase === "connected" ? "done" : "declined");
  }

  setMic(on: boolean): void {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = on;
    });
    if (this.live) this.live = { ...this.live, mic: on };
    this.emit();
  }

  setCam(on: boolean): void {
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = on;
    });
    if (this.live) this.live = { ...this.live, cam: on };
    this.emit();
  }

  setVolume(v: number): void {
    const volume = Math.min(1, Math.max(0, v));
    if (this.live) this.live = { ...this.live, volume };
    this.emit();
  }

  note(text: string): void {
    this.toast(text);
  }

  dismissToast(): void {
    this.toastText = null;
    this.emit();
  }

  async setAvatarFile(file: File): Promise<string | null> {
    try {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return "Canvas error";

      // Square crop and resize to 128x128 (~4KB)
      const size = 128;
      canvas.width = size;
      canvas.height = size;

      const minEdge = Math.min(bmp.width, bmp.height);
      const sx = (bmp.width - minEdge) / 2;
      const sy = (bmp.height - minEdge) / 2;

      ctx.drawImage(bmp, sx, sy, minEdge, minEdge, 0, 0, size, size);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.65);
      bmp.close();

      if (this.identity) {
        this.identity.avatarUrl = dataUrl;
        this.persist();
        this.emitPersist();
        void this.broadcastHello();
        this.toast("Profile picture update ho gayi!");
      }
      return null;
    } catch {
      return "Avatar processing failed";
    }
  }

  async exportEncryptedBackup(pass: string): Promise<string> {
    const raw = JSON.stringify(this.saved());
    if (!pass) return raw;
    return await seal(pass, raw);
  }

  async importEncryptedBackup(packed: string, pass: string): Promise<string | null> {
    try {
      let raw = packed;
      if (pass) {
        const decrypted = await openSeal<string>(pass, packed);
        if (!decrypted) return "Galat Password ya PIN!";
        raw = typeof decrypted === "string" ? decrypted : JSON.stringify(decrypted);
      }
      const data = JSON.parse(raw) as { identity?: Identity };
      const id = data.identity;
      if (!id?.globalId || !id.privateKey || !id.publicKey || !id.discriminator) return "Backup file valid nahi hai.";

      // Restored device gets an incremented instance slot
      const existingInstance = Number(id.instanceId || 0);
      id.instanceId = existingInstance === 0 ? 1 : existingInstance + 1;

      localStorage.setItem("meshnet-active-sid", id.discriminator);
      sessionStorage.setItem("meshnet-sid", id.discriminator);
      localStorage.setItem(`meshnet-node:${id.discriminator}`, JSON.stringify(data));
      return null;
    } catch {
      return "Backup file decrypt nahi ho payi.";
    }
  }

  revokeSubInstance(instanceNum: number): void {
    if (!this.identity) return;
    const revoked = new Set(this.identity.revokedInstances || []);
    revoked.add(instanceNum);
    this.identity.revokedInstances = Array.from(revoked);
    this.persist();
    this.emitPersist();

    // Broadcast revocation signal across mesh
    void this.ship(
      {
        v: 1,
        id: makeId("rv"),
        kind: "hello",
        from: this.me().globalId,
        fromName: this.me().name,
        payload: {
          revokeInstance: instanceNum,
          masterId: this.me().globalId,
        },
      },
      "all"
    );
    this.toast(`Instance /${instanceNum} revoke kar diya gaya.`);
  }

  exportBackup(): string {
    return JSON.stringify(this.saved());
  }

  importBackup(raw: string): string | null {
    return "Use importEncryptedBackup";
  }

  private async hydrate(): Promise<void> {
    // SessionStorage ke bajaye permanent localStorage se active ID load karein
    let sid = localStorage.getItem("meshnet-active-sid");
    if (!sid) {
      // Fallback check agar kisi purane key se saved ho
      sid = sessionStorage.getItem("meshnet-sid");
    }

    const saved = sid ? this.readNode(sid) : null;
    if (saved?.identity) {
      this.applySaved(saved);
      localStorage.setItem("meshnet-active-sid", saved.identity.discriminator);
    } else {
      const identity = await this.freshIdentity();
      localStorage.setItem("meshnet-active-sid", identity.discriminator);
      sessionStorage.setItem("meshnet-sid", identity.discriminator);
      this.identity = identity;
      this.seed();
    }
    try {
      const rawHashes = localStorage.getItem("meshnet_hash_directory");
      if (rawHashes) {
        const parsed = JSON.parse(rawHashes) as Record<string, { compHash: string; size: number; mime: string; thumb?: string }>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v?.compHash) this.hashDirectory.set(k, v);
        }
      }
    } catch {}

    this.hydrated = true;
    await this.restoreMedia();
    this.emit();
  }

private async freshIdentity(): Promise<Identity> {
  const discriminator = hex(4);
  const keys = await generateIdentityKeys();
  const handle = `peer${discriminator.slice(0, 4)}`;
  return {
    name: `Peer ${discriminator.slice(0, 4).toUpperCase()}`,
    handle,
    hub: "mrt",
    discriminator,
    globalId: `@${handle}@mrt#${discriminator}`,
    bio: "Mesh pe available.",
    secretPin: String(1000 + Math.floor(Math.random() * 9000)),
    verification: {
      verified: false,
      type: "none",
    },
    ...keys,
  };
}

  private seed(): void {
    this.passphrase = DEFAULT_HUB_KEY;
    this.contacts = [];
    this.groups = [];
    this.chats = {};
    this.posts = [];
    this.callLogs = [];
    this.persist();
  }

  private readNode(disc: string): { identity: Identity } | null {
    try {
      const raw = localStorage.getItem(`meshnet-node:${disc}`);
      if (!raw) return null;
      const data = JSON.parse(raw) as { identity?: Identity };
      if (!data.identity?.globalId || !data.identity.privateKey) return null;
      return data;
    } catch {
      return null;
    }
  }

  private applySaved(data: Partial<ReturnType<MeshEngine["saved"]>> & { identity: Identity }): void {
    this.identity = data.identity;
    this.chats = data.chats && typeof data.chats === "object" ? data.chats : {};
    this.contacts = Array.isArray(data.contacts) ? data.contacts : [];
    this.groups = Array.isArray(data.groups) ? data.groups : [];
    this.posts = Array.isArray(data.posts) ? data.posts.map((p) => tidyPost(p)) : [];
    this.hidden = Array.isArray(data.hidden) ? data.hidden : [];
    this.blocked = Array.isArray(data.blocked) ? data.blocked : [];
    this.muted = Array.isArray(data.muted) ? data.muted : [];
    this.starred = Array.isArray(data.starred) ? data.starred : [];
    this.callLogs = Array.isArray(data.callLogs) ? data.callLogs : [];
    this.passphrase = typeof data.passphrase === "string" && data.passphrase ? data.passphrase : DEFAULT_HUB_KEY;
    this.pins = data.pins && typeof data.pins === "object" ? data.pins : {};
  }

  private saved() {
    const chats: Record<string, Msg[]> = {};
    for (const [key, list] of Object.entries(this.chats)) {
      chats[key] = list.map((m) => ({ ...m, mediaData: undefined }));
    }
    return {
      identity: this.me(),
      chats,
      contacts: this.contacts,
      groups: this.groups,
      posts: this.posts.map((p) => ({ ...p, localOnly: p.localOnly || undefined })),
      hidden: this.hidden,
      blocked: this.blocked,
      muted: this.muted,
      starred: this.starred,
      callLogs: this.callLogs.slice(0, 40),
      passphrase: this.passphrase,
      pins: this.pins,
    };
  }

  private persist(): void {
    try {
      const me = this.me();
      localStorage.setItem(`meshnet-node:${me.discriminator}`, JSON.stringify(this.saved()));
    } catch {
      this.toastText = "Device storage full hai. Purani media hatao.";
    }
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = 0;
      this.persist();
    }, 180);
  }

  private emit(): void {
    this.snap = this.compute();
    for (const fn of this.listeners) fn();
  }

  private emitPersist(): void {
    this.persistSoon();
    this.emit();
  }

  private compute(): Snap {
    const me = this.me();
    const now = Date.now();
    const peers: Peer[] = [];
    // Dummy peer presence removed - sirf real peers dikhenge
    for (const peer of this.presence.values()) {
      if (now - peer.at < 60000 && !sameUid(peer.globalId, me.globalId)) peers.push(peer);
    }
    let outbox = 0;
    for (const list of Object.values(this.chats)) {
      for (const msg of list) {
        if (msg.status === "queued" && sameUid(msg.from, me.globalId)) outbox += 1;
      }
    }
    const pins = Object.keys(this.pins).map((uid) => {
      const contact = this.contacts.find((c) => uidOf(c.tag) === uid);
      const peer = peers.find((p) => uidOf(p.globalId) === uid);
      return { uid, label: contact?.name || peer?.name || uid };
    });
    const { privateKey: _private, ...pub } = me;
    return {
      me: pub,
      chats: this.chats,
      contacts: this.contacts,
      groups: this.groups,
      posts: [...this.posts].sort((a, b) => b.timestamp - a.timestamp),
      hidden: this.hidden,
      blocked: this.blocked,
      muted: this.muted,
      starred: this.starred,
      callLogs: this.callLogs,
      peers,
      pins,
      typing: this.typing && this.typing.until > now ? this.typing : null,
      toast: this.toastText,
      incoming: this.incoming,
      call: this.live,
      rtcPeers: this.rtcPeers,
      outbox,
      urls: this.urls,
      mediaTick: this.mediaTick,
      hubKey: this.passphrase,
    };
  }

  private me(): Identity {
    if (!this.identity) throw new Error("Mesh identity missing");
    return this.identity;
  }

  private openTransports(): void {
    this.closeTransports();
    this.bc = new BroadcastChannel("meshnet-v1");
    this.bc.onmessage = (event) => {
      void this.ingest(event.data, "bc");
    };
    window.addEventListener("pagehide", this.onHide);
    document.addEventListener("visibilitychange", this.onVisible);

    gvndControl.subscribePeers((p) => {
      if (sameUid(p.globalId, this.me().globalId)) return;
      if (!this.presence.has(uidOf(p.globalId))) {
        this.presence.set(uidOf(p.globalId), {
          globalId: p.globalId,
          name: p.name,
          via: "nearby",
          at: p.lastSeen || Date.now(),
        });
        this.emit();
      }
    });

    gvndControl.subscribeAllThreads((_threadKey, incomingMsg) => {
      if (sameUid(incomingMsg.from, this.me().globalId)) return;
      if (!this.forMe(incomingMsg.to) && !sameUid(incomingMsg.to, this.me().globalId)) return;
      const thread = isGroupId(incomingMsg.to) ? incomingMsg.to : incomingMsg.from;
      const hasBlob = incomingMsg.mediaKey
        ? Boolean(this.urls[incomingMsg.mediaKey] || this.rawMedia.has(incomingMsg.mediaKey))
        : true;
      this.insert(thread, { ...incomingMsg, isDownloaded: hasBlob });
      this.emitPersist();
    });

    gvndControl.subscribeFeeds(this.me().hub, (remotePost) => {
      this.acceptPost(tidyPost(remotePost), false);
    });

    this.timers.push(
      window.setInterval(() => {
        const lanNodes = getLanDiscoveredNodes();
        if (lanNodes.length > 0) gvndControl.addMeshPeers(lanNodes);
      }, 4000)
    );

    // GunDB Control Plane (Peers, Chats & Feeds CRDT Sync)
    gvndControl.subscribePeers((p) => {
      if (sameUid(p.globalId, this.me().globalId)) return;
      if (!this.presence.has(uidOf(p.globalId))) {
        this.presence.set(uidOf(p.globalId), {
          globalId: p.globalId,
          name: p.name,
          via: "nearby",
          at: p.lastSeen || Date.now(),
        });
        this.emit();
      }
    });

    gvndControl.subscribeAllThreads((_threadKey, incomingMsg) => {
      if (sameUid(incomingMsg.from, this.me().globalId)) return;
      if (!this.forMe(incomingMsg.to) && !sameUid(incomingMsg.to, this.me().globalId)) return;
      const thread = isGroupId(incomingMsg.to) ? incomingMsg.to : incomingMsg.from;
      const hasBlob = incomingMsg.mediaKey
        ? Boolean(this.urls[incomingMsg.mediaKey] || this.rawMedia.has(incomingMsg.mediaKey))
        : true;
      this.insert(thread, { ...incomingMsg, isDownloaded: hasBlob });
      this.emitPersist();
    });

    gvndControl.subscribeFeeds(this.me().hub, (remotePost) => {
      this.acceptPost(tidyPost(remotePost), false);
    });

    // APK UDP LAN Auto-Discovery Sync
    this.timers.push(
      window.setInterval(() => {
        const lanNodes = getLanDiscoveredNodes();
        if (lanNodes.length > 0) gvndControl.addMeshPeers(lanNodes);
      }, 4000)
    );

    this.timers.push(window.setInterval(() => void this.broadcastHello(), 3500));
    this.timers.push(window.setInterval(() => void this.pullAll(), 4500));
    this.timers.push(window.setInterval(() => this.flush(), 1500));
    void this.broadcastHello();
    void this.pullAll();
    this.openRoom();
  }

  private onHide = (): void => {
    this.persist();
  };

  private onVisible = (): void => {
    if (document.visibilityState === "visible") {
      void this.broadcastHello();
      void this.pullAll();
      this.flush();
    }
  };

  private closeTransports(): void {
    window.removeEventListener("pagehide", this.onHide);
    document.removeEventListener("visibilitychange", this.onVisible);
    for (const timer of this.timers) window.clearInterval(timer);
    this.timers = [];
    this.bc?.close();
    this.bc = null;
    this.room?.close();
    this.room = null;
    this.presence.clear();
    this.p2pByUid.clear();
    this.rtcPeers = 0;
  }

  private openRoom(): void {
    const me = this.me();
    const room = `hub-${me.hub}`.replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(me.discriminator) || !/^[a-zA-Z0-9_-]{1,64}$/.test(room)) return;
    this.room = new P2PRoom({
      room,
      selfId: me.discriminator,
      name: me.name.slice(0, 64),
      onMessage: (_from, data) => {
        void this.ingest(data, "rtc", _from);
      },
      onPeersChanged: (peers) => {
        this.rtcPeers = peers.filter((p) => p.connectionState === "connected").length;
        this.emit();
        void this.broadcastHello();
      },
    });
    void this.room.join();
  }

  private rejoin(): void {
    if (this.refs < 1) return;
    this.room?.close();
    this.room = null;
    this.p2pByUid.clear();
    this.openRoom();
    void this.broadcastHello();
  }

  private async broadcastHello(): Promise<void> {
    const isOnline = typeof navigator !== "undefined" && navigator.onLine;

    // Self verified phone ensure karein
    const myPhone =
      this.me().verification?.phone ||
      localStorage.getItem("meshnet_verified_phone") ||
      undefined;

    const myVerification: VerificationInfo = {
      ...(this.me().verification || { verified: false, type: "none", level: 0 }),
      phone: myPhone,
    };

    // Apni local directory se verified nodes list nikalein
    let directoryExport: any[] = [];
    try {
      const rawDir = localStorage.getItem("meshnet_known_directory") || "{}";
      const dir = JSON.parse(rawDir);
      directoryExport = Object.values(dir).slice(0, 50);
    } catch {
      /* ignore */
    }

    // Recent SHA-256 original->compressed hash mappings export karein (Max 30 entries)
    const hashSyncExport = Array.from(this.hashDirectory.entries()).slice(-30);
    gvndControl.announcePeer({
      globalId: this.me().globalId,
      name: this.me().name,
      bio: this.me().bio,
      avatarUrl: this.me().avatarUrl,
    });

    gvndControl.announcePeer({
      globalId: this.me().globalId,
      name: this.me().name,
      bio: this.me().bio,
      avatarUrl: this.me().avatarUrl,
    });

    await this.ship(
      {
        v: 1,
        id: makeId("h"),
        kind: "hello",
        from: this.me().globalId,
        fromName: this.me().name,
        payload: { 
          bio: this.me().bio, 
          hub: this.me().hub,
          avatarUrl: (this.me() as any).avatarUrl,
          instanceId: (this.me() as any).instanceId ?? 0,
          verification: myVerification,
          hasInternetGateway: isOnline,
          directorySync: directoryExport,
          hashSync: hashSyncExport,
        },
      },
      "all",
    );
    this.emit();
  }

  // 1. Trigger Self-SMS Loopback
  startSelfSmsVerification(phoneNumber: string): string {
    const cleanPhone = normalizePhone(phoneNumber);
    const token = `MESH_${Math.floor(100000 + Math.random() * 900000)}`;
    
    // Local storage me pending challenge save karein (5 minute expiry)
    localStorage.setItem("meshnet_sms_challenge", JSON.stringify({
      phone: cleanPhone,
      token,
      expiresAt: Date.now() + 300000
    }));

    // Recipient me wahi same number daal kar SMS intent trigger karein
    const payload = `MeshNet Loopback Challenge: ${token}`;
    window.location.href = `sms:${cleanPhone}?body=${encodeURIComponent(payload)}`;

    return token;
  }

  // 2. Incoming Token Check (Self-SMS Loopback Hybrid)
  confirmSelfSmsToken(incomingText: string): boolean {
    const saved = localStorage.getItem("meshnet_sms_challenge");
    const cleanInput = incomingText.trim().toUpperCase();
    const inputDigits = cleanInput.replace(/\D/g, "");

    let targetPhone = "";
    let matched = false;

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        targetPhone = parsed.phone || "";
        const expectedDigits = String(parsed.token || "").replace(/\D/g, "");
        if (
          cleanInput.includes(String(parsed.token).toUpperCase()) ||
          (inputDigits.length >= 5 && expectedDigits.includes(inputDigits)) ||
          inputDigits === expectedDigits
        ) {
          matched = true;
        }
      } catch (e) {
        console.error(e);
      }
    }

    // CASE 1: Genuine Loopback Match Only (No Auto Fake Verification)
    if (matched && !cleanInput.includes("TIMEOUT")) {
      const pendingPhone = localStorage.getItem("meshnet_pending_phone") || "";
      const activePhone = targetPhone || pendingPhone || cleanInput;
      const cleanTargetPhone = normalizePhone(activePhone);
      const hash = hashPhoneSimple(cleanTargetPhone);
      
      const vData: VerificationInfo = {
        verified: true,
        type: "self_sms",
        level: 1,
        phone: cleanTargetPhone,
        phoneHash: hash,
        verifiedAt: Date.now(),
        vouchedBy: []
      };

      this.setVerification(vData);

      localStorage.setItem("meshnet_verified_phone", cleanTargetPhone);
      localStorage.removeItem("meshnet_sms_challenge");
      localStorage.removeItem("meshnet_pending_phone");

      try {
        const rawDir = localStorage.getItem("meshnet_known_directory") || "{}";
        const dir = JSON.parse(rawDir);
        dir[this.me().globalId] = {
          globalId: this.me().globalId,
          name: this.me().name,
          verification: vData,
          lastSeen: Date.now(),
        };
        localStorage.setItem("meshnet_known_directory", JSON.stringify(dir));
      } catch (e) {
        console.error(e);
      }

      void this.broadcastHello();
      this.toast("SIM Loopback Confirmed! Level 1 Verified.");
      return true;
    }

    // CASE 2: SMS LOOPBACK FAIL / TIMEOUT -> SET TO PENDING (UNVERIFIED)
    const pendingPhone = localStorage.getItem("meshnet_pending_phone") || targetPhone;
    if (pendingPhone) {
      const cleanTargetPhone = normalizePhone(pendingPhone);
      const hash = hashPhoneSimple(cleanTargetPhone);
      const pendingData: VerificationInfo = {
        verified: false, // NOT VERIFIED YET
        type: "sim",
        level: 0,        // Level 0: 3 Peers Vouch Requirement
        phone: cleanTargetPhone,
        phoneHash: hash,
        vouchedBy: []
      };

      this.setVerification(pendingData);
      localStorage.removeItem("meshnet_sms_challenge");
      this.toast("SMS verify nahi hua! Status: Pending (3 Peers Vouch Jaruri)");
    }
    return false;
  }

  // 3. Background Silent Peer Vouching
  silentVouchForPeer(peerGlobalId: string, peerPhoneHash?: string): void {
    if (!peerPhoneHash) return;
    const match = this.contacts.find(
      (c) => hashPhoneSimple(c.tag) === peerPhoneHash || c.tag === peerGlobalId
    );
    if (match) {
      void this.ship(
        {
          v: 1,
          id: makeId("v"),
          kind: "hello",
          from: this.me().globalId,
          fromName: this.me().name,
          to: peerGlobalId,
          payload: {
            vouch: true,
            targetHash: peerPhoneHash,
            voucher: this.me().globalId,
          },
        },
        [{ uid: uidOf(peerGlobalId), mail: false }]
      );
    }
  }

  // 4. Receive Peer Vouch (Strict 3 Vouchers Rule for Level 2)
  receivePeerVouch(voucherGlobalId: string, targetHash: string, claimedPhone?: string): void {
    if (!this.identity) return;
    const v = this.identity.verification;
    if (!v || v.phoneHash !== targetHash) return;

    const vouchers = new Set(v.vouchedBy || []);
    vouchers.add(voucherGlobalId);
    const updatedVouchers = Array.from(vouchers);

    // Rule: Kam se kam 3 peers ka vouch chahiye agar loopback nahi hua
    if (updatedVouchers.length >= 3) {
      const finalPhone = v.phone || claimedPhone || "";
      const vData: VerificationInfo = {
        verified: true,
        type: "peer_vouched",
        level: 2,
        phone: finalPhone,
        phoneHash: targetHash,
        verifiedAt: Date.now(),
        vouchedBy: updatedVouchers,
      };

      this.setVerification(vData);
      if (finalPhone) {
        localStorage.setItem("meshnet_verified_phone", finalPhone);
      }
      this.toast("Level 2 Verified! 3 Peers ne aapka number vouch kar diya.");
      void this.broadcastHello();
    } else {
      // 3 se kam hone par UNVERIFIED rahega
      this.setVerification({
        ...v,
        verified: false,
        level: 0,
        vouchedBy: updatedVouchers,
      });
      this.toast(`Peer ne vouch kiya (${updatedVouchers.length}/3 Vouchers mile).`);
    }
  }

  private async pullAll(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    try {
      const uid = this.me().discriminator;
      const mailRes = await fetch(`/api/mesh?op=mail&uid=${uid}`);
      if (mailRes.ok) {
        const body = (await mailRes.json()) as { items?: { id: string; payload: string }[] };
        const acks: string[] = [];
        for (const item of body.items || []) {
          acks.push(item.id);
          try {
            await this.ingest(JSON.parse(item.payload), "mail");
          } catch {
            /* drop poison */
          }
        }
        if (acks.length) {
          await fetch("/api/mesh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "ack", toUid: uid, ids: acks }),
          });
        }
      }
      const feedRes = await fetch(`/api/mesh?op=feed&hub=${this.me().hub}`);
      if (feedRes.ok) {
        const body = (await feedRes.json()) as { items?: { payload: string }[] };
        for (const item of body.items || []) {
          const post = await openSeal<Post>(this.passphrase, item.payload);
          if (post && typeof post.id === "string") this.acceptPost(tidyPost(post), true);
        }
      }
    } catch {
      /* relay optional while offline */
    } finally {
      this.pulling = false;
    }
  }

  private async ingest(raw: unknown, via: Via, rtcPeerId?: string): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const env = raw as Env;
    if (env.v !== 1 || typeof env.id !== "string" || typeof env.from !== "string" || typeof env.kind !== "string") return;

    // Check if this incoming hello contains instance revocation command for us
    const payloadRevoke = (env.payload as any)?.revokeInstance;
    if (payloadRevoke !== undefined && this.identity?.instanceId === payloadRevoke) {
      this.toast("Yeh instance master phone dwara revoke kar diya gaya hai!");
      sessionStorage.clear();
      localStorage.removeItem("meshnet-active-sid");
      window.setTimeout(() => window.location.reload(), 1500);
      return;
    }

    if (sameUid(env.from, this.me().globalId) && (env.payload as any)?.instanceId === this.identity?.instanceId) return;
    if (this.blocked.some((b) => sameUid(b, env.from))) return;
    if (!env.key || !env.sig) return;
    const ok = await verifyText(env.key, canon(env), env.sig);
    if (!ok) return;
    const pinned = this.pins[uidOf(env.from)];
    if (pinned && !sameKey(pinned, env.key)) {
      this.toast(`${env.fromName || "Peer"} ki identity key badal gayi. Profile se pin hatao agar ye wahi hain.`);
      return;
    }
    if (!pinned) this.pins = { ...this.pins, [uidOf(env.from)]: env.key };
    if (this.seen.has(env.id)) return;
    this.seen.add(env.id);
    this.seenOrder.push(env.id);
    const isMine = env.to ? this.forMe(env.to) : true;
    
    // --- MULTI-HOP RELAY FORWARDER ---
    if (!isMine && env.to && (env.ttl ?? 0) > 1) {
      const myUid = uidOf(this.me().globalId);
      const visited = env.hopPath || [];

      // Agar hum pehle hi is path me hain to loop drop karein
      if (!visited.includes(myUid)) {
        const forwardedEnv: Env = {
          ...env,
          ttl: (env.ttl || 4) - 1,
          hopPath: [...visited, myUid],
        };

        // Local connected peers ko forward karein (excluding where it came from)
        if (this.room) {
          this.room.send(forwardedEnv);
        }
        this.bc?.postMessage(forwardedEnv);
      }
      return; // Apna task khatam, packet aage pass ho gaya
    }
    if (this.seenOrder.length > 2000) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
    if (env.kind === "hello") {
      const payload = env.payload as {
        bio?: string;
        verification?: VerificationInfo;
        hasInternetGateway?: boolean;
        directorySync?: any[];
      };
      const vInfo = payload?.verification || { verified: false, type: "none" };

      const incomingName = (env.fromName && !env.fromName.startsWith("Peer ")) ? env.fromName : undefined;
      const finalName = incomingName || env.fromName || "Peer";
      const finalAvatar = (payload as any)?.avatarUrl;

      this.presence.set(uidOf(env.from), {
        globalId: env.from,
        name: finalName,
        via: via === "rtc" ? "webrtc" : "tab",
        at: Date.now(),
        verification: vInfo,
        hasInternetGateway: Boolean(payload?.hasInternetGateway),
        avatarUrl: finalAvatar,
        instanceId: (payload as any)?.instanceId,
      } as any);

      // Permanent Offline Peer Cache (Name aur Avatar hamesha ke liye lock)
      try {
        const rawCache = localStorage.getItem("meshnet_peer_cache") || "{}";
        const pCache = JSON.parse(rawCache);
        const prev = pCache[env.from] || {};
        pCache[env.from] = {
          name: finalName !== "Peer" ? finalName : (prev.name || finalName),
          avatarUrl: finalAvatar || prev.avatarUrl || "",
        };
        localStorage.setItem("meshnet_peer_cache", JSON.stringify(pCache));
      } catch {
        /* ignore */
      }

      // 1. Peer ka apna verified info save karein
      try {
        const rawDir = localStorage.getItem("meshnet_known_directory") || "{}";
        const dir = JSON.parse(rawDir);

        dir[env.from] = {
          globalId: env.from,
          name: env.fromName || "Peer",
          verification: vInfo,
          lastSeen: Date.now(),
        };

        // 2. Peer dwara share ki gayi directory sync karein (Gossip propagation)
        if (Array.isArray(payload?.directorySync)) {
          for (const item of payload.directorySync) {
            if (item && item.globalId && item.verification?.verified) {
              if (!dir[item.globalId] || (item.lastSeen || 0) > (dir[item.globalId]?.lastSeen || 0)) {
                dir[item.globalId] = item;
              }
            }
          }
        }

        localStorage.setItem("meshnet_known_directory", JSON.stringify(dir));

        // 3. Peer ki SHA-256 hash mappings merge karein (Global Deduplication Sync)
        const incomingHashes = (payload as any)?.hashSync;
        if (Array.isArray(incomingHashes) && incomingHashes.length > 0) {
          let hashUpdated = false;
          for (const entry of incomingHashes) {
            if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[1]?.compHash) {
              if (!this.hashDirectory.has(entry[0])) {
                this.hashDirectory.set(entry[0], entry[1]);
                hashUpdated = true;
              }
            }
          }
          if (hashUpdated) {
            localStorage.setItem("meshnet_hash_directory", JSON.stringify(Object.fromEntries(this.hashDirectory)));
          }
        }
      } catch (e) {
        console.error(e);
      }

      if (via === "rtc" && rtcPeerId) this.p2pByUid.set(uidOf(env.from), rtcPeerId);
      this.retarget(env.from, env.fromName);
      this.flush();

      // Agar peer background se wapas online aaya hai aur transfer 6s se ruka hua tha to resume karein
      for (const list of Object.values(this.chats)) {
        for (const m of list) {
          if (sameUid(m.from, env.from) && m.mediaKey && !m.isDownloaded && m.transferProgress !== undefined) {
            void this.requestMediaDownload(m.id, true);
          }
        }
      }

      this.emitPersist();
      return;
    }
    if (env.to && !this.forMe(env.to)) return;
    if (env.kind === "typing") {
      const payload = env.payload as { on?: boolean; thread?: string };
      const thread = payload.thread && isGroupId(payload.thread) ? payload.thread : env.from;
      this.typing = payload.on ? { thread, name: env.fromName || "Peer", until: Date.now() + 2500 } : null;
      this.emit();
      return;
    }
    if (env.kind === "receipt") {
      const payload = env.payload as { msgId?: string; status?: Msg["status"] };
      if (!payload.msgId || (payload.status !== "delivered" && payload.status !== "read")) return;
      this.patchMsg(payload.msgId, (m) => (rank(payload.status as Msg["status"]) > rank(m.status) ? { ...m, status: payload.status as Msg["status"] } : m));
      this.emitPersist();
      return;
    }
    if (env.kind === "delete") {
      const payload = env.payload as { msgId?: string };
      if (!payload.msgId) return;
      this.patchMsg(payload.msgId, (m) =>
        sameUid(m.from, env.from) ? { ...m, isDeleted: true, content: "", mediaKey: undefined } : m,
      );
      this.emitPersist();
      return;
    }
    if (env.kind === "chunk") {
      const chunk = env.payload as FileChunk;
      if (!chunk?.fileId || chunk.index === undefined) return;

      // Jab receiver download button dabakar request karta hai (Direct Sender ya Mesh Swarm peer se)
      if (chunk.index === -1 && (chunk.data === "FETCH" || chunk.data === "FETCH_SWARM")) {
        const sendFromMemoryOrDb = async () => {
          let fullData = this.rawMedia.get(chunk.fileId);
          if (fullData) {
            void this.deliverChunked(env.from, chunk.fileId, chunk.name, chunk.mime, fullData);
            return;
          }
          if (typeof indexedDB !== "undefined") {
            try {
              const db = await openDb();
              const tx = db.transaction("blobs", "readonly");
              const req = tx.objectStore("blobs").get(chunk.fileId);
              req.onsuccess = async () => {
                const b = req.result as Blob;
                if (b) {
                  const dataUrl = await blobToDataUrl(b);
                  this.rawMedia.set(chunk.fileId, dataUrl);
                  void this.deliverChunked(env.from, chunk.fileId, chunk.name, chunk.mime, dataUrl);
                }
              };
            } catch {}
          }
        };
        void sendFromMemoryOrDb();
        return;
      }

      let entry = this.chunkBuffer.get(chunk.fileId);
      if (!entry) {
        entry = { total: chunk.total, chunks: new Map(), mime: chunk.mime, name: chunk.name };
        this.chunkBuffer.set(chunk.fileId, entry);
      }

      entry.chunks.set(chunk.index, chunk.data);

      const progressPercent = Math.round((entry.chunks.size / entry.total) * 100);
      for (const list of Object.values(this.chats)) {
        const m = list.find((msg) => msg.mediaKey === chunk.fileId);
        if (m) {
          if (progressPercent >= 100) {
            this.activeDownloads.delete(m.id);
          } else {
            this.activeDownloads.set(m.id, Date.now());
          }
          this.patchMsg(m.id, (msg) => ({
            ...msg,
            transferProgress: progressPercent >= 100 ? undefined : progressPercent,
            isDownloaded: progressPercent >= 100 ? true : false,
          }));
          break;
        }
      }

      if (entry.chunks.size === entry.total) {
        let fullDataUrl = "";
        for (let i = 0; i < entry.total; i++) {
          fullDataUrl += entry.chunks.get(i) || "";
        }
        this.chunkBuffer.delete(chunk.fileId);
        await this.keepMedia(chunk.fileId, fullDataUrl, entry.mime);

        // Download complete hote hi Sender ko Read Receipt (Blue Double Tick) bhejein
        for (const [thread, list] of Object.entries(this.chats)) {
          const m = list.find((msg) => msg.mediaKey === chunk.fileId);
          if (m && !sameUid(m.from, this.me().globalId)) {
            const isViewingChat = this.viewing === thread || sameUid(this.viewing || "", thread);
            const receiptStatus: Msg["status"] = isViewingChat ? "read" : "delivered";
            this.patchMsg(m.id, (item) => ({ ...item, status: receiptStatus, isDownloaded: true, transferProgress: undefined }));
            void this.ship(
              {
                v: 1,
                id: makeId("r"),
                kind: "receipt",
                from: this.me().globalId,
                fromName: this.me().name,
                to: m.from,
                payload: { msgId: m.id, status: receiptStatus },
              },
              [{ uid: uidOf(m.from), mail: !this.isOnline(m.from) }]
            );
            break;
          }
        }

        this.emitPersist();
      }
      return;
    }
    if (env.kind === "dm" || env.kind === "edit" || env.kind === "feed" || env.kind === "call") {
      const box = (env.payload as { box?: string })?.box;
      if (!box) return;
      if (env.kind === "dm") {
        let msg: WireMsg | null = null;
        // Pehle direct Pairwise E2EE se kholne ki koshish karein
        if (env.key) {
          msg = await openDirectSeal<WireMsg>(this.me().privateKey, env.key, box);
        }
        // Agar E2EE se na khule (jaise group message ya fallback), to hub passphrase se kholein
        if (!msg) {
          msg = await openSeal<WireMsg>(this.passphrase, box);
        }
        if (!msg) return this.keyMiss();
        await this.acceptDm(msg, env.from);
        return;
      }
      if (env.kind === "edit") {
        const body = await openSeal<{ msgId: string; content: string; editedAt: number }>(this.passphrase, box);
        if (!body) return this.keyMiss();
        this.patchMsg(body.msgId, (m) =>
          sameUid(m.from, env.from) ? { ...m, content: String(body.content || "").slice(0, 2000), editedAt: body.editedAt } : m,
        );
        this.emitPersist();
        return;
      }
      if (env.kind === "feed") {
        const post = await openSeal<Post>(this.passphrase, box);
        if (!post) return this.keyMiss();
        this.acceptPost(tidyPost(post), true);
        return;
      }
      const call = await openSeal<CallBody>(this.passphrase, box);
      if (!call) return this.keyMiss();
      await this.acceptCallSignal(env.from, env.fromName || "Peer", call);
    }
  }

  private keyMiss(): void {
    if (this.badKeyToasted) return;
    this.badKeyToasted = true;
    this.toast("Kuch packets is hub key se nahi khule.");
  }

  private forMe(to: string): boolean {
    if (sameUid(to, this.me().globalId)) return true;
    if (!isGroupId(to)) return false;
    const group = this.groups.find((g) => g.id === to);
    return Boolean(group?.members.some((m) => sameUid(m, this.me().globalId)));
  }

  private async acceptDm(msg: WireMsg, claimedFrom: string): Promise<void> {
    if (!msg.id || !sameUid(msg.from, claimedFrom)) return;
    if (msg.groupMeta && isGroupId(msg.to)) {
      const members = msg.groupMeta.members || [];
      if (members.some((m) => sameUid(m, this.me().globalId))) {
        const idx = this.groups.findIndex((g) => g.id === msg.groupMeta?.id);
        if (idx < 0) this.groups = [...this.groups, msg.groupMeta];
      }
    }
    if (isGroupId(msg.to)) {
      if (!this.forMe(msg.to)) return;
    } else {
      this.retarget(msg.from, "");
    }
    const thread = isGroupId(msg.to) ? msg.to : msg.from;
    const viewing = this.viewing === thread || sameUid(this.viewing || "", thread);
    const status: Msg["status"] = msg.system ? "read" : viewing ? "read" : "delivered";
    const { mediaData, ...rest } = msg;
    if (mediaData && rest.mediaKey) await this.keepMedia(rest.mediaKey, mediaData, rest.mediaMime || "application/octet-stream");
    
    // Receiver ke pass media kabhi bhi auto-download nahi hoga (isDownloaded: false)
    const stored: Msg = { 
      ...rest, 
      status, 
      isDownloaded: !rest.mediaKey, // Sirf non-media messages downloaded manenge
      transferProgress: undefined 
    };
    const existed = Object.values(this.chats).some((list) => list.some((m) => m.id === stored.id));
    this.insert(thread, stored);
    if (!existed && !stored.system && !isGroupId(stored.to)) {
      void this.ship(
        {
          v: 1,
          id: makeId("r"), // Unique ID taaki receiver ke seen set me drop na ho
          kind: "receipt",
          from: this.me().globalId,
          fromName: this.me().name,
          to: stored.from,
          payload: { msgId: stored.id, status },
        },
        [{ uid: uidOf(stored.from), mail: !this.isOnline(stored.from) }],
      );
    }
    this.emitPersist();
  }

  private acceptPost(remote: Post, fromNet: boolean): void {
    if (!remote.id) return;
    if (this.blocked.some((b) => sameUid(b, remote.globalId))) return;
    const idx = this.posts.findIndex((p) => p.id === remote.id);
    if (idx < 0) {
      if (remote.deleted) return;
      this.posts = [{ ...remote, localOnly: false }, ...this.posts].slice(0, 120);
      this.emitPersist();
      return;
    }
    const merged = mergePosts(this.posts[idx], remote);
    const grew =
      merged.likes.length > remote.likes.length ||
      merged.reposts.length > remote.reposts.length ||
      merged.reports.length > remote.reports.length ||
      merged.replies.length > remote.replies.length;
    if (grew && merged.rev <= remote.rev) merged.rev = remote.rev + 1;
    const changed = JSON.stringify(merged) !== JSON.stringify(this.posts[idx]);
    if (!changed) return;
    this.posts = this.posts.map((p) => (p.id === merged.id ? merged : p)).filter((p) => !p.deleted);
    this.emitPersist();
    if (fromNet && merged.rev > remote.rev) void this.pushFeed(merged);
  }

  private touchPost(id: string, mutate: (post: Post) => void): void {
    const post = this.posts.find((p) => p.id === id);
    if (!post || post.deleted) return;
    const next: Post = {
      ...post,
      likes: [...post.likes],
      reposts: [...post.reposts],
      reports: [...post.reports],
      replies: post.replies.map((r) => ({ ...r, likedBy: [...r.likedBy], dislikedBy: [...r.dislikedBy], subReplies: [...r.subReplies] })),
      localOnly: false,
      rev: post.rev + 1,
    };
    mutate(next);
    this.posts = this.posts.map((p) => (p.id === id ? next : p)).filter((p) => !p.deleted);
    this.emitPersist();
    void this.pushFeed(next);
  }

  private async pushFeed(post: Post): Promise<void> {
    if (post.localOnly) return;
    try {
      gvndControl.putFeedPost(this.me().hub, post);
      gvndControl.putFeedPost(this.me().hub, post);
      const payload = await seal(this.passphrase, post);
      if (payload.length > 58000) return;
      await fetch("/api/mesh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "feed", hub: this.me().hub, id: post.id, payload }),
      });
      await this.ship(
        {
          v: 1,
          id: `f${post.id}x${post.rev}`,
          kind: "feed",
          from: this.me().globalId,
          fromName: this.me().name,
          payload: { box: payload },
        },
        "all",
      );
    } catch {
      /* live peers may still have the local copy */
    }
  }

  private queueOut(msg: Msg): void {
    const thread = msg.to;
    const resolved = this.resolve(thread);
    this.insert(resolved, msg);
    gvndControl.putChatMessage(resolved, msg);
    this.emitPersist();
    void this.deliver(msg);
  }

  private async deliverChunked(to: string, fileId: string, name: string, mime: string, dataUrl: string, msgId?: string): Promise<void> {
    // 32KB Optimal WebRTC Chunk Size (JSON + Signature + JWK key milkar ~34KB rehta hai, jo WebRTC ke 64KB SCTP limit se kabhi drop nahi hota)
    const CHUNK_SIZE = 32768;
    const chunks = sliceDataUrl(dataUrl, CHUNK_SIZE);
    const total = chunks.length;

    const targetMsgId = msgId || (() => {
      for (const list of Object.values(this.chats)) {
        const found = list.find((m) => m.mediaKey === fileId);
        if (found) return found.id;
      }
      return undefined;
    })();

    for (let i = 0; i < total; i++) {
      const chunkPayload: FileChunk = {
        fileId,
        index: i,
        total,
        data: chunks[i],
        mime,
        name,
      };

      const env: Env = {
        v: 1,
        id: makeId("c"),
        kind: "chunk",
        from: this.me().globalId,
        fromName: this.me().name,
        to,
        payload: chunkPayload,
        ttl: 4,
      };

      await this.ship(env, [{ uid: uidOf(to), mail: false }]);

      if (targetMsgId && (i % 2 === 0 || i === total - 1)) {
        const percent = Math.round(((i + 1) / total) * 100);
        this.patchMsg(targetMsgId, (m) => ({ ...m, transferProgress: percent >= 100 ? undefined : percent }));
        this.emit();
      }

      // Har 3 chunks par 5ms yield taaki WebRTC send buffer overflow na ho
      if (i % 3 === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    for (const list of Object.values(this.chats)) {
      const m = list.find((item) => item.mediaKey === fileId);
      if (m && sameUid(m.from, this.me().globalId)) {
        this.patchMsg(m.id, (item) => ({ ...item, status: "sent", transferProgress: undefined }));
        this.emitPersist();
        break;
      }
    }
  }

  private async deliver(msg: Msg, mediaData?: string): Promise<void> {
    if (this.inflight.has(msg.id)) return;
    this.inflight.add(msg.id);
    try {
      gvndControl.putChatMessage(this.resolve(msg.to), msg);
      gvndControl.putChatMessage(this.resolve(msg.to), msg);
      const bytes = mediaData && mediaData.startsWith("data:") ? mediaData : msg.mediaKey ? this.rawMedia.get(msg.mediaKey) : undefined;
      if (isGroupId(msg.to)) {
        await this.fanout(msg, bytes);
        return;
      }
      const online = this.isOnline(msg.to);
      const ok = await this.wireDm(msg, bytes, !online, uidOf(msg.to));
      if (ok) {
        this.patchMsg(msg.id, (m) => (m.status === "queued" ? { ...m, status: "sent" } : m));
        this.emitPersist();
      }
    } finally {
      this.inflight.delete(msg.id);
    }
  }

  private async fanout(msg: Msg, mediaData?: string): Promise<void> {
    const group = this.groups.find((g) => g.id === msg.to);
    if (!group) return;
    let any = false;
    for (const member of group.members) {
      if (sameUid(member, this.me().globalId)) continue;
      const online = this.isOnline(member);
      const ok = await this.wireDm(msg, mediaData, !online, uidOf(member));
      if (ok) any = true;
    }
    this.patchMsg(msg.id, (m) => ({ ...m, status: any ? (m.status === "queued" ? "sent" : m.status) : "queued" }));
    this.emitPersist();
  }

  private bumpStatus(id: string, status: Msg["status"]): void {
    this.patchMsg(id, (m) => (rank(status) > rank(m.status) ? { ...m, status } : m));
    this.emit();
  }

  private async wireDm(msg: Msg, mediaData: string | undefined, mail: boolean, routeUid: string): Promise<boolean> {
    const wire: WireMsg = { ...msg };
    // Strict safety: Files/Media me mediaData inline kabhi na jaye, sirf pure metadata jaye
    if (msg.mediaKey) {
      wire.mediaData = undefined;
    } else if (mediaData && mediaData.startsWith("data:") && mediaData.length < 25000) {
      wire.mediaData = mediaData;
    }

    let box: string;
    const peerKey = this.pins[routeUid];

    // Agar direct peer ki pinned public key maujood hai, to direct E2EE seal karein
    if (peerKey && !isGroupId(msg.to)) {
      box = await sealDirect(this.me().privateKey, peerKey, wire);
    } else {
      // Group message ya key na hone par fallback to hub passphrase
      box = await seal(this.passphrase, wire);
    }

    const env: Env = {
      v: 1,
      id: msg.id,
      kind: "dm",
      from: this.me().globalId,
      fromName: this.me().name,
      to: msg.to,
      payload: { box },
    };
    if (JSON.stringify(env).length > 58000) {
      this.toast("Message relay ke liye bada hai.");
      return false;
    }
    await this.ship(env, [{ uid: routeUid, mail: false }]);
    if (!mail) return true;
    return this.postMail(routeUid, env);
  }

  private flush(): void {
    for (const list of Object.values(this.chats)) {
      for (const msg of list) {
        if (msg.status !== "queued" || !sameUid(msg.from, this.me().globalId)) continue;
        // Agar delivery 45 second se pending ho aur peer offline ho to loop na phasayein
        if (Date.now() - msg.timestamp > 45000 && !this.isOnline(msg.to)) continue;
        void this.deliver(msg);
      }
    }
  }

  private async shipEdit(thread: string, msg: Msg): Promise<void> {
    const box = await seal(this.passphrase, { msgId: msg.id, content: msg.content, editedAt: msg.editedAt });
    await this.ship(
      {
        v: 1,
        id: makeId("e"),
        kind: "edit",
        from: this.me().globalId,
        fromName: this.me().name,
        to: msg.to,
        payload: { box },
      },
      this.targetsFor(isGroupId(thread) ? thread : msg.to),
    );
  }

  private targetsFor(to: string): { uid: string; mail: boolean }[] {
    if (isGroupId(to)) {
      const group = this.groups.find((g) => g.id === to);
      if (!group) return [];
      return group.members
        .filter((m) => !sameUid(m, this.me().globalId))
        .map((m) => ({ uid: uidOf(m), mail: !this.isOnline(m) }));
    }
    return [{ uid: uidOf(to), mail: !this.isOnline(to) }];
  }

  private async ship(env: Env, targets: { uid: string; mail: boolean }[] | "all"): Promise<void> {
    try {
      env.key = this.me().publicKey;
      env.sig = await signText(this.me().privateKey, canon(env));
      
      // Default TTL agar set nahi hai
      if (env.ttl === undefined) env.ttl = 4;
      if (!env.hopPath) env.hopPath = [uidOf(this.me().globalId)];

      this.bc?.postMessage(env);
      if (!this.room) {
        if (targets !== "all") {
          for (const target of targets) if (target.mail) await this.postMail(target.uid, env);
        }
        return;
      }
      const raw = JSON.stringify(env);
      if (env.kind !== "chunk" && raw.length > 50000) return;
      if (targets === "all") {
        this.room.send(env);
        return;
      }
      for (const target of targets) {
        const pid = this.p2pByUid.get(target.uid);
        if (pid) this.room.send(env, pid);
        if (target.mail) await this.postMail(target.uid, env);
      }
    } catch {
      /* signing or socket failure stays queued */
    }
  }
  
  private async postMail(uid: string, env: Env): Promise<boolean> {
    if (!/^[a-z0-9]{4,16}$/.test(uid)) return false;
    const id = `${env.id}${uid}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    if (id.length < 6) return false;
    try {
      const res = await fetch("/api/mesh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "mail", toUid: uid, id, payload: JSON.stringify(env) }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async wireCall(to: string, body: CallBody): Promise<void> {
    const box = await seal(this.passphrase, body);
    await this.ship(
      {
        v: 1,
        id: makeId("k"),
        kind: "call",
        from: this.me().globalId,
        fromName: this.me().name,
        to,
        payload: { box },
      },
      [{ uid: uidOf(to), mail: false }],
    );
  }

  private async acceptCallSignal(from: string, name: string, body: CallBody): Promise<void> {
    if (body.action === "offer") {
      if (this.live || this.incoming) {
        await this.wireCall(from, { action: "reject", callId: body.callId, reason: "busy" });
        return;
      }
      const trusted = Boolean(body.trusted) && this.isContact(from);
      const pinOk = Boolean(body.pin) && body.pin === this.me().secretPin;
      if (!trusted && !pinOk) {
        await this.wireCall(from, { action: "reject", callId: body.callId, reason: "pin" });
        return;
      }
      if (!body.sdp) return;
      this.incoming = { callId: body.callId, from, name: name || this.nameOf(from), mode: body.mode || "voice", sdp: body.sdp };
      this.emit();
      window.clearTimeout(this.ringTimer);
      this.ringTimer = window.setTimeout(() => {
        if (this.incoming?.callId !== body.callId) return;
        this.logCall({ tag: from, name: this.incoming.name, mode: this.incoming.mode, direction: "in", result: "missed", duration: 0 });
        this.incoming = null;
        this.emitPersist();
      }, 30000);
      return;
    }
    if (!this.live || this.live.callId !== body.callId) return;
    if (body.action === "answer" && body.sdp && this.pc) {
      await this.pc.setRemoteDescription(body.sdp);
      await this.flushIce();
      this.markConnected();
      return;
    }
    if (body.action === "ice" && body.candidate) {
      if (!this.pc || !this.pc.remoteDescription) this.pendingIce.push(body.candidate);
      else await this.pc.addIceCandidate(body.candidate).catch(() => undefined);
      return;
    }
    if (body.action === "reject") {
      this.toast(body.reason === "pin" ? "Unhone PIN reject kar diya." : body.reason === "busy" ? "Peer busy hai." : "Call decline ho gayi.");
      this.finishCall(body.reason === "busy" ? "failed" : "declined");
      return;
    }
    if (body.action === "hangup") this.finishCall(this.live.phase === "connected" ? "done" : "missed");
  }

  private makePc(peer: string, callId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void this.wireCall(peer, { action: "ice", callId, candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      this.remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      this.markConnected();
    };
    return pc;
  }

  private async flushIce(): Promise<void> {
    if (!this.pc) return;
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const candidate of queued) {
      await this.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private markConnected(): void {
    if (!this.live || this.live.phase === "connected") {
      this.bumpMedia();
      return;
    }
    window.clearTimeout(this.ringTimer);
    this.live = { ...this.live, phase: "connected", seconds: 0 };
    window.clearInterval(this.callClock);
    this.callClock = window.setInterval(() => {
      if (!this.live || this.live.phase !== "connected") return;
      this.live = { ...this.live, seconds: this.live.seconds + 1 };
      this.emit();
    }, 1000);
    this.bumpMedia();
  }

  private finishCall(result: CallLog["result"]): void {
    window.clearTimeout(this.ringTimer);
    window.clearInterval(this.callClock);
    const live = this.live;
    if (live) {
      this.logCall({
        tag: live.tag,
        name: live.name,
        mode: live.mode,
        direction: live.direction,
        result,
        duration: live.phase === "connected" ? live.seconds : 0,
      });
    }
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.remoteStream = null;
    this.pendingIce = [];
    this.live = null;
    this.incoming = null;
    this.bumpMedia();
  }

  private logCall(entry: Omit<CallLog, "id" | "at">): void {
    this.callLogs = [{ ...entry, id: makeId("l"), at: Date.now() }, ...this.callLogs].slice(0, 40);
  }

  private bumpMedia(): void {
    this.mediaTick += 1;
    this.emitPersist();
  }

  private isOnline(tag: string): boolean {
    const peer = this.presence.get(uidOf(tag));
    return Boolean(peer && Date.now() - peer.at < 45000);
  }

  private isContact(tag: string): boolean {
    return this.contacts.some((c) => sameUid(c.tag, tag));
  }

  private nameOf(tag: string): string {
  if (sameUid(tag, this.me().globalId)) return this.me().name;
  const contact = this.contacts.find((c) => sameUid(c.tag, tag));
  if (contact) return contact.name;
  const peer = this.presence.get(uidOf(tag));
  if (peer) return peer.name;
  const group = this.groups.find((g) => g.id === tag);
  if (group) return group.name;
  return tag;
}

  private resolve(tag: string): string {
    if (this.chats[tag] || isGroupId(tag)) return tag;
    const hit = Object.keys(this.chats).find((key) => !isGroupId(key) && sameUid(key, tag));
    return hit || tag;
  }

  private retarget(tag: string, name: string): void {
    for (const key of Object.keys(this.chats)) {
      if (isGroupId(key) || key === tag || !sameUid(key, tag)) continue;
      const merged = [...(this.chats[tag] || []), ...this.chats[key]];
      const map = new Map<string, Msg>();
      for (const msg of merged) {
        map.set(msg.id, {
          ...msg,
          from: sameUid(msg.from, tag) ? tag : msg.from,
          to: !isGroupId(msg.to) && sameUid(msg.to, tag) ? tag : msg.to,
        });
      }
      const next = { ...this.chats, [tag]: [...map.values()] };
      delete next[key];
      this.chats = next;
    }
    this.contacts = this.contacts.map((c) => (sameUid(c.tag, tag) ? { ...c, tag, name: name || c.name } : c));
    if (this.viewing && sameUid(this.viewing, tag)) this.viewing = tag;
  }

  private insert(thread: string, msg: Msg): void {
    const list = this.chats[thread] || [];
    if (list.some((m) => m.id === msg.id)) return;
    this.chats = { ...this.chats, [thread]: [...list, msg].slice(-300) };
  }

  private patchMsg(id: string, fn: (m: Msg) => Msg): Msg | null {
    for (const [thread, list] of Object.entries(this.chats)) {
      const idx = list.findIndex((m) => m.id === id);
      if (idx < 0) continue;
      const next = fn(list[idx]);
      const copy = list.slice();
      copy[idx] = next;
      this.chats = { ...this.chats, [thread]: copy };
      return next;
    }
    return null;
  }

  private markRead(thread: string): void {
    const key = this.resolve(thread);
    const list = this.chats[key];
    if (!list) return;
    let changed = false;
    const next = list.map((m) => {
      if (sameUid(m.from, this.me().globalId) || m.status === "read" || m.system) return m;
      changed = true;
      if (!isGroupId(key)) {
        void this.ship(
          {
            v: 1,
            id: `r${m.id}read`,
            kind: "receipt",
            from: this.me().globalId,
            fromName: this.me().name,
            to: m.from,
            payload: { msgId: m.id, status: "read" },
          },
          [{ uid: uidOf(m.from), mail: !this.isOnline(m.from) }],
        );
      }
      return { ...m, status: "read" as const };
    });
    if (!changed) return;
    this.chats = { ...this.chats, [key]: next };
    this.emitPersist();
  }

  private async keepMedia(key: string, dataUrl: string, mime: string): Promise<void> {
    const blob = dataUrlToBlob(dataUrl);
    // 40000 length ka barrier hatayein taaki badi audio/video/document file memory me ready rahe
    if (dataUrl.startsWith("data:")) this.rawMedia.set(key, dataUrl);
    if (blob) {
      try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("blobs", "readwrite");
          tx.objectStore("blobs").put(blob, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      } catch {
        /* memory url still works */
      }
    }
    const url = blob ? URL.createObjectURL(blob) : dataUrl;
    this.urls = { ...this.urls, [key]: safeUrl(url, mime) };
  }

  private async restoreMedia(): Promise<void> {
    const keys = new Set<string>();
    for (const list of Object.values(this.chats)) {
      for (const msg of list) if (msg.mediaKey) keys.add(msg.mediaKey);
    }
    for (const post of this.posts) if (post.mediaKey) keys.add(post.mediaKey);
    if (keys.size === 0) return;
    try {
      const db = await openDb();
      const next = { ...this.urls };
      for (const key of keys) {
        const blob = await new Promise<Blob | null>((resolve, reject) => {
          const tx = db.transaction("blobs", "readonly");
          const req = tx.objectStore("blobs").get(key);
          req.onsuccess = () => resolve((req.result as Blob) || null);
          req.onerror = () => reject(tx.error);
        });
        if (blob) next[key] = URL.createObjectURL(blob);
      }
      db.close();
      this.urls = next;
    } catch {
      /* empty cache */
    }
  }

  setVerification(info: VerificationInfo): void {
    if (!this.identity) return;
    this.identity.verification = info;
    
    // Save to persistent localStorage immediately
    this.persist();
    this.emitPersist();
    this.flush();
    void this.broadcastHello();

    this.toast(
      info.verified
        ? `Node Verified (${info.type.toUpperCase()})!`
        : "Verification status reset."
    );
  }
  
  // Dynamic Self-Adjusting Reel & Shard Quota (Zero Manual Maintenance)
  getDynamicReelQuotaMB(): number {
    const isOnline = typeof navigator !== "undefined" && navigator.onLine;
    if (!isOnline) return 150;

    const nav: any = typeof navigator !== "undefined" ? navigator : null;
    const conn = nav?.connection;
    const isWifi = conn ? (conn.type === "wifi" || !conn.saveData) : true;

    // 1. Wi-Fi: High-throughput Seeder Quota (450 MB)
    if (isWifi) return 450;

    // 2. Cellular Scale: Peer count ke hisaab se dynamically calculate hoga
    const peerCount = this.snap.peers.length;
    const MIN_FLOOR_MB = 35;  // Strict Minimum Cap (Kabhi iske niche nahi jayega)
    const MAX_BOOT_MB = 150;  // Initial Phase Cap

    if (peerCount <= 5) {
      return MAX_BOOT_MB; // Shuruati 150MB
    }

    // Dynamic Decay Formula: Jaise peers badhenge, quota ghatega but MIN_FLOOR par lock rahega
    // Har 5 peers judne par 15MB drop hoga jab tak floor na aa jaye
    const dynamicMB = Math.round(MAX_BOOT_MB - (peerCount - 5) * 3);
    return Math.max(MIN_FLOOR_MB, dynamicMB);
  }

  // Automatic LRU Cleaner jab storage quota cross ho jaye
  async pruneReelCacheIfNeeded(): Promise<void> {
    try {
      const quotaBytes = this.getDynamicReelQuotaMB() * 1024 * 1024;
      const db = await openDb();
      const tx = db.transaction("blobs", "readwrite");
      const store = tx.objectStore("blobs");
      const req = store.getAllKeys();

      req.onsuccess = () => {
        const keys = req.result as string[];
        // Agar total stored chunks quota se jyada hone lagein to oldest chunks delete karein
        if (keys.length > 0 && keys.length * 65536 > quotaBytes) {
          const excessCount = Math.ceil((keys.length * 65536 - quotaBytes) / 65536);
          // Oldest chunks pehle remove honge (FIFO / LRU basis)
          for (let i = 0; i < Math.min(excessCount, keys.length); i++) {
            if (keys[i].startsWith("r_")) { // Reels chunk prefix
              store.delete(keys[i]);
            }
          }
        }
      };
    } catch {
      /* ignore background storage cleanup */
    }
  }

  canRelayPayload(byteSize: number, priority: string): boolean {
    const isOnline = typeof navigator !== "undefined" && navigator.onLine;
    if (!isOnline) return false;

    if (priority === "high") return true;

    const nav: any = typeof navigator !== "undefined" ? navigator : null;
    const connection = nav?.connection;
    const isMetered = connection ? connection.saveData || connection.type === "cellular" : false;

    if (isMetered) {
      // Cellular par Dynamic Quota check karein
      const currentQuota = this.getDynamicReelQuotaMB();
      if (currentQuota <= 35 && byteSize > 65536) {
        return false; // Low cellular floor par heavy background relays pause
      }
    }

    return true;
  }

  async relayOutboxPackets(): Promise<void> {
    if (!this.canRelayPayload(1024, "high")) return;

    let queuedCount = 0;
    for (const list of Object.values(this.chats)) {
      for (const m of list) {
        if (m.status === "queued" && sameUid(m.from, this.me().globalId)) {
          queuedCount++;
          void this.deliver(m);
        }
      }
    }
    if (queuedCount > 0) {
      this.toast(`Relaying ${queuedCount} packets...`);
    }
  }

  findPeerByPhone(phone: string): (Peer & { isOnline?: boolean }) | undefined {
    const cleanPhone = normalizePhone(phone);
    const targetHash = hashPhoneSimple(cleanPhone);
    const rawHash = hashPhoneSimple(phone.replace(/\D/g, ""));

    // 1. Check if peer is currently live online
    const online = this.snap.peers.find(
      (p) => p.verification?.phoneHash === targetHash || p.verification?.phoneHash === rawHash
    );
    if (online) return { ...online, isOnline: true };

    // 2. Check in Persistent Known Directory (Offline Cache)
    try {
      const rawDir = localStorage.getItem("meshnet_known_directory") || "{}";
      const dir = JSON.parse(rawDir);
      for (const item of Object.values(dir) as any[]) {
        const v = item.verification;
        if (v && (v.phoneHash === targetHash || v.phoneHash === rawHash || v.phone === cleanPhone)) {
          return {
            globalId: item.globalId,
            name: item.name,
            via: "nearby",
            at: item.lastSeen || 0,
            verification: v,
            isOnline: false,
          };
        }
      }
    } catch {
      /* ignore storage errors */
    }

    return undefined;
  }

  addContactByPhone(name: string, phone: string): { ok: boolean; tag: string; isOnline: boolean } {
    const clean = normalizePhone(phone);
    const peer = this.findPeerByPhone(clean);

    let tag: string;
    const cleanName = (name.trim() || `User_${clean.slice(-4)}`).replace(/[^a-zA-Z0-9]/g, "_");

    if (peer) {
      tag = peer.globalId;
      this.saveContact(name.trim() || peer.name, tag);
      this.toast(`${peer.name} mesh par mil gaye!`);
      return { ok: true, tag, isOnline: true };
    } else {
      const hub = this.identity?.hub || "mesh";
      const id = clean.slice(-4);
      tag = `@${cleanName.toLowerCase()}@${hub}#${id}`;
      
      const err = this.saveContact(name.trim() || cleanName, tag);
      if (err) {
        this.toast(`Contact error: ${err}`);
      } else {
        this.toast(`${cleanName} contact list mein jud gaya!`);
      }
      return { ok: !err, tag, isOnline: false };
    }
  }
}

function safeUrl(url: string, mime: string): string {
  if (url.startsWith("blob:")) return url;
  if (mime.startsWith("image/") && url.startsWith("data:image/")) return url;
  if (mime.startsWith("audio/") && url.startsWith("data:audio/")) return url;
  if (mime.startsWith("video/") && url.startsWith("data:video/")) return url;
  return url.startsWith("blob:") ? url : "";
}

let singleton: MeshEngine | null = null;

export function getEngine(): MeshEngine {
  if (!singleton) singleton = new MeshEngine();
  return singleton;
}

export { formatDuration };
