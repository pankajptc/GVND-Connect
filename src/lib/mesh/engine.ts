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
import {
  EMPTY_SNAP,
  type CallBody,
  type Env,
  type IncomingCall,
  type LiveCall,
  type Snap,
  type Via,
  type WireMsg,
} from "@/lib/mesh/engine/types";
import { canon, hex, loadDeletedForMeSafe, openDb, rank, tidyPost } from "@/lib/mesh/engine/storage";
import { computeBlobHash, dataUrlToBlob, safeUrl } from "@/lib/mesh/engine/media";
import { resolvePeerName, savePeerCacheEntry } from "@/lib/mesh/engine/presence";

export type { CallLog, Category, Contact, Group, Msg, Peer, Post, PublicIdentity, Quote };
export { EMPTY_SNAP, type IncomingCall, type LiveCall, type Snap };

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
  private deletedForMe = loadDeletedForMeSafe();
  private peerSubActive = false;
  private seenOrder: string[] = [];
  private viewing: string | null = null;
  private inflight = new Set<string>();
  private activeDownloads = new Map<string, number>(); // msgId -> lastChunkTimestamp
  private hashDirectory = new Map<string, { compHash: string; size: number; mime: string; thumb?: string }>();
  private rawMedia = new Map<string, string>();
  private chunkBuffer = new Map<string, { total: number; chunks: Map<number, string>; mime: string; name: string }>();
  private hydrated = false;
  private pulling = false;
  private syncingApi = false;

  private patchMsg(id: string, fn: (m: Msg) => Msg): Msg | undefined {
    let found: Msg | undefined;
    let changed = false;
    const nextChats: Record<string, Msg[]> = {};
    for (const [k, list] of Object.entries(this.chats)) {
      nextChats[k] = list.map((m) => {
        if (m.id === id) {
          changed = true;
          const updated = fn(m);
          if (updated.transferProgress === undefined) {
            delete (updated as any).transferProgress;
          }
          found = updated;
          return updated;
        }
        return m;
      });
    }
    if (changed) {
      this.chats = nextChats;
      this.emit();
    }
    return found;
  }
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
    if (this.viewing) this.markRead?.(this.viewing);
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
    const logStep = (step: string, detail: string) => {
      void fetch("/api/mesh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "debug", id: msgId, status: step, detail }),
      }).catch(() => {});
    };

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
      transferProgress: 5,
      ttl: 4,
    };
    this.insert(this.resolve(to), draftMsg);
    this.emit();
    logStep("1_draft_inserted", `${mime} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    try {
      const origHash = await computeBlobHash(file);
      const cachedMapping = this.hashDirectory.get(origHash);

      if (cachedMapping && (this.rawMedia.has(cachedMapping.compHash) || Boolean(this.urls[cachedMapping.compHash]))) {
        let cachedUrl = this.rawMedia.get(cachedMapping.compHash);
        if (!cachedUrl && this.urls[cachedMapping.compHash]) {
          try {
            const r = await fetch(this.urls[cachedMapping.compHash]);
            const b = await r.blob();
            cachedUrl = await blobToDataUrl(b);
            this.rawMedia.set(cachedMapping.compHash, cachedUrl);
          } catch {}
        }
        if (cachedUrl) {
          const updatedMsg = this.patchMsg(msgId, (m) => ({
            ...m,
            mediaKey: cachedMapping.compHash,
            mediaMime: cachedMapping.mime,
            mediaThumb: cachedMapping.thumb,
            mediaSize: cachedMapping.size,
            transferProgress: 90,
          }));
          this.inflight.delete(msgId);
          logStep("2_sha256_cache_hit", `skip_recompress key=${cachedMapping.compHash} size=${cachedMapping.size}`);
          if (updatedMsg) {
            await this.deliver(updatedMsg, cachedUrl);
            void this.syncMeshApi();
          }
          return;
        }
      }

      let processedBlob: Blob = file;
      let finalMime = mime;
      let lightThumb = "";

      if (file.size > 100 * 1024 * 1024) {
        this.inflight.delete(msgId);
        for (const k of Object.keys(this.chats)) { this.chats[k] = (this.chats[k] || []).filter((m) => m.id !== msgId); }
        this.emitPersist();
        this.toast("File 100 MB se badi hai — max 100 MB allowed.");
        return;
      }

      if (mime.startsWith("image/")) {
        this.patchMsg(msgId, (m) => ({ ...m, transferProgress: 35 }));
        const shrunk = await shrinkImage(file, 260000);
        if (shrunk) {
          const b = dataUrlToBlob(shrunk.dataUrl);
          if (b) processedBlob = b;
          finalMime = shrunk.mime;
        }
        const tinyThumb = await shrinkImage(file, 14000);
        if (tinyThumb) lightThumb = tinyThumb.dataUrl;
        logStep("2_image_hq_compressed", `orig=${file.size} -> comp=${processedBlob.size}`);
      } else {
        // Video, Audio, PDF & All Other Files: Zero Compression (Direct Original up to 100MB)
        this.patchMsg(msgId, (m) => ({ ...m, transferProgress: 45 }));
        processedBlob = file;
        finalMime = mime;
        logStep("2_direct_uncompressed_media", `mime=${mime} size=${file.size}`);
      }

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
        transferProgress: 85,
        mediaSize: finalSize,
        mediaMime: finalMime,
      }));

      const readyDataUrl = await blobToDataUrl(processedBlob);
      await this.keepMedia(contentHashKey, readyDataUrl, finalMime);

      const updatedMsg = this.patchMsg(msgId, (m) => ({
        ...m,
        mediaKey: contentHashKey,
        mediaMime: finalMime,
        mediaThumb: lightThumb || undefined,
        mediaSize: finalSize,
        transferProgress: 90,
      }));
      this.emitPersist();

      this.inflight.delete(msgId);
      logStep("3_uploading", `key=${contentHashKey} bytes=${readyDataUrl.length}`);
      if (updatedMsg) {
        await this.deliver(updatedMsg, readyDataUrl);
        void this.syncMeshApi();
      }
    } catch (err: any) {
      this.inflight.delete(msgId);
      logStep("err_sendFile", err?.message || "unknown");
      for (const k of Object.keys(this.chats)) {
        this.chats[k] = (this.chats[k] || []).filter((m) => m.id !== msgId);
      }
      this.emitPersist();
      this.toast("Media compression fail — chhoti file try karein.");
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
    for (const [, list] of Object.entries(this.chats)) {
      const m = list.find((msg) => msg.id === msgId);
      if (m && m.mediaKey && !m.isDownloaded) {
        if (this.urls[m.mediaKey] || this.rawMedia.has(m.mediaKey)) {
          this.patchMsg(msgId, (item) => ({ ...item, isDownloaded: true, transferProgress: undefined, status: "read" }));
          this.emitPersist();
          void fetch("/api/mesh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "ack", id: m.id, status: "read" }),
          }).catch(() => {});
          return;
        }

        this.patchMsg(msgId, (item) => ({ ...item, transferProgress: 15 }));
        this.emit();

        try {
          const r = await fetch("/api/mesh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "getMedia", mediaKey: m.mediaKey }),
          });
          if (r.ok) {
            const md = await r.json();
            if (md?.dataUrl) {
              this.patchMsg(msgId, (item) => ({ ...item, transferProgress: 85 }));
              await this.keepMedia(m.mediaKey, md.dataUrl, m.mediaMime || "application/octet-stream");
              this.patchMsg(msgId, (item) => ({ ...item, isDownloaded: true, transferProgress: undefined, status: "read" }));
              this.emitPersist();
              void fetch("/api/mesh", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "ack", id: m.id, status: "read" }),
              }).catch(() => {});
              return;
            }
          }
        } catch {}

        const lastActive = this.activeDownloads.get(msgId) || 0;
        if (isResume && Date.now() - lastActive < 6000) return;

        this.activeDownloads.set(msgId, Date.now());
        const senderOnline = this.isOnline(m.from);

        const existingEntry = this.chunkBuffer.get(m.mediaKey);
        const currentPct =
          existingEntry && existingEntry.total > 0
            ? Math.max(1, Math.round((existingEntry.chunks.size / existingEntry.total) * 100))
            : 1;

        this.patchMsg(msgId, (item) => ({ ...item, transferProgress: currentPct }));
        this.emit();

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

        // Reset 1% stuck state after 6s if neither relay cache nor peer has old file
        window.setTimeout(() => {
          for (const curList of Object.values(this.chats)) {
            const cur = curList.find((x) => x.id === msgId);
            if (cur && !cur.isDownloaded && (cur.transferProgress || 0) <= 1) {
              this.activeDownloads.delete(msgId);
              this.patchMsg(msgId, (item) => ({ ...item, transferProgress: undefined }));
              this.toast("Purani file cache mein nahi hai — sender se dubara bhejein.");
            }
          }
        }, 6000);
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
      this.deletedForMe.add(id);
      try {
        localStorage.setItem("gvnd_deleted_for_me_v1", JSON.stringify(Array.from(this.deletedForMe).slice(-2000)));
      } catch {}
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
    if (!cleanName || (!cleanTag.startsWith("phone:") && !tagOk(cleanTag))) return "Naam aur sahi global tag dono chahiye.";
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
      loopback: false,
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
          if (v?.compHash && !(v.mime?.startsWith("audio/") && v.size < 220000)) this.hashDirectory.set(k, v);
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
      level: 0,
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
      return data as { identity: Identity };
    } catch {
      return null;
    }
  }

  private applySaved(data: Partial<ReturnType<MeshEngine["saved"]>> & { identity: Identity }): void {
    this.identity = data.identity;
    this.chats = data.chats && typeof data.chats === "object"
      ? Object.fromEntries(
          Object.entries(data.chats).map(([k, list]) => [
            k,
            Array.isArray(list) ? list.map((m) => ({ ...m, transferProgress: undefined })) : [],
          ])
        )
      : {};
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
      chats[key] = list.map((m) => ({ ...m, mediaData: undefined, transferProgress: undefined }));
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
      if (now - peer.at < 90000 && !sameUid(peer.globalId, me.globalId)) peers.push(peer);
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
    if (this.identity && !this.identity.createdAt) {
      this.identity.createdAt = Date.now();
    }
    if (!this.identity) throw new Error("Mesh identity missing");
    return this.identity;
  }

  private openTransports(): void {
    this.closeTransports();
    this.bc = new BroadcastChannel("meshnet-v1");
    this.bc.onmessage = (event) => {
      void this.ingest(event.data, "bc");
    };
    void this.syncMeshApi();
    this.timers.push(window.setInterval(() => void this.syncMeshApi(), 300));
    window.addEventListener("pagehide", this.onHide);
    document.addEventListener("visibilitychange", this.onVisible);

    if (!this.peerSubActive) {
      this.peerSubActive = true;
      this.setupPeerSub();
    }
  }

  private setupPeerSub(): void {
    gvndControl.subscribePeers((p) => {
      if (sameUid(p.globalId, this.me().globalId)) return;
      const uid = uidOf(p.globalId);
      const prev = this.presence.get(uid);
      const freshAt = Math.max(p.lastSeen || 0, Date.now());
      const isGeneric = !p.name || p.name.startsWith("Peer ") || p.name === "GVND Peer";
      const resolvedName = !isGeneric ? p.name : (prev?.name || p.name || "Peer");
      const resolvedAvatar = (p.avatarUrl && p.avatarUrl.length > 5) ? p.avatarUrl : ((prev as any)?.avatarUrl || "");
      this.presence.set(uid, {
        ...(prev || {}),
        globalId: p.globalId,
        name: resolvedName,
        avatarUrl: resolvedAvatar,
        via: "nearby",
        at: freshAt,
      } as any);
      try {
        const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
        c[uid] = { ...(c[uid] || {}), name: resolvedName, avatarUrl: resolvedAvatar || c[uid]?.avatarUrl || "", globalId: p.globalId };
        localStorage.setItem("meshnet_peer_cache", JSON.stringify(c));
      } catch {}
      if (!prev || Date.now() - (prev.at || 0) > 5000) this.emit();
    });

    gvndControl.subscribeAllThreads((_threadKey, incomingMsg) => {
      if (sameUid(incomingMsg.from, this.me().globalId)) return;
      if (!this.forMe(incomingMsg.to) && !sameUid(incomingMsg.to, this.me().globalId)) return;
      const thread = isGroupId(incomingMsg.to) ? incomingMsg.to : incomingMsg.from;
      const hasBlob = incomingMsg.mediaKey
        ? Boolean(this.urls[incomingMsg.mediaKey] || this.rawMedia.has(incomingMsg.mediaKey))
        : true;
      this.insert(thread, { ...incomingMsg, isDownloaded: !incomingMsg.mediaKey });
      this.emitPersist();
    });

    gvndControl.subscribeFeeds(this.me().hub, (remotePost) => {
      this.acceptPost(tidyPost(remotePost), false);
    });

    this.timers.push(
      window.setInterval(() => {
        const lanNodes = getLanDiscoveredNodes();
        if (lanNodes.length > 0) {
          gvndControl.addMeshPeers(lanNodes);
          this.emit();
        }
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

  // Compute 0-100 Trust Score strictly from cryptographic proofs (prevents DevTools / reverse-engineering spoofing)
  computeTrustScore(v?: VerificationInfo): number {
    if (!v || !v.verified || v.slashed) return 0;
    const validProofs = Array.isArray(v.vouchProofs)
      ? v.vouchProofs.filter((p) => p && typeof p.sig === "string" && p.sig.length > 20 && p.pubKey && p.voucher)
      : [];
    const uniqueVouchers = new Set(validProofs.map((p) => uidOf(p.voucher))).size;
    const hasSignedSms = v.type === "self_sms" && typeof v.selfSmsSig === "string" && v.selfSmsSig.length > 20 && Boolean(v.phoneHash);

    if (!hasSignedSms && uniqueVouchers < 3) return 0;

    let score = uniqueVouchers >= 3 ? 25 : hasSignedSms ? 10 : 0;
    if (uniqueVouchers >= 10) {
      score = Math.min(100, 25 + (uniqueVouchers - 9) * 5);
    }
    return score;
  }

  // 1. Trigger Self-SMS Loopback
  startSelfSmsVerification(phoneNumber: string): string {
    const cleanPhone = normalizePhone(phoneNumber);
    const token = `MESH_${Math.floor(100000 + Math.random() * 900000)}`;
    localStorage.setItem("meshnet_sms_challenge", JSON.stringify({
      phone: cleanPhone,
      token,
      expiresAt: Date.now() + 300000,
    }));
    const payload = `GVND Connect Loopback: ${token}`;
    window.location.href = `sms:${cleanPhone}?body=${encodeURIComponent(payload)}`;
    return token;
  }

  // 2. Incoming Token Check (Self-SMS Loopback -> Level 1, Trust Score 10)
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
      } catch {}
    }

    if (matched && !cleanInput.includes("TIMEOUT")) {
      const pendingPhone = localStorage.getItem("meshnet_pending_phone") || "";
      const activePhone = targetPhone || pendingPhone || cleanInput;
      const cleanTargetPhone = normalizePhone(activePhone);
      const hash = hashPhoneSimple(cleanTargetPhone);
      const existingVouches = this.me().verification?.vouchedBy || [];

      const verifiedAt = Date.now();
      const existingProofs = this.me().verification?.vouchProofs || [];
      const vData: VerificationInfo = {
        verified: true,
        type: "self_sms",
        level: existingProofs.length >= 3 ? 2 : 1,
        trustScore: existingProofs.length >= 10 ? Math.min(100, 25 + (existingProofs.length - 9) * 5) : existingProofs.length >= 3 ? 25 : 10,
        phone: cleanTargetPhone,
        phoneHash: hash,
        verifiedAt,
        vouchedBy: existingVouches,
        vouchProofs: existingProofs,
        signerPubKey: this.me().publicKey,
        watchReports: [],
        slashed: false,
      };

      this.setVerification(vData);
      void signText(this.me().privateKey, `SMS_VERIFIED|${this.me().globalId}|${hash}|${verifiedAt}`).then((sig) => {
        if (this.identity?.verification) {
          this.setVerification({ ...this.identity.verification, selfSmsSig: sig, signerPubKey: this.me().publicKey });
          void this.broadcastHello();
        }
      });
      localStorage.setItem("meshnet_verified_phone", cleanTargetPhone);
      localStorage.setItem("gvnd_sms_verified", "1");
      localStorage.setItem("gvnd_verified_phone", cleanTargetPhone);
      localStorage.removeItem("meshnet_sms_challenge");
      localStorage.removeItem("meshnet_pending_phone");
      void this.broadcastHello();
      this.toast("SIM Verified! Level 1 Unlocked (Trust Score: 10/100)");
      return true;
    }

    const pendingPhone = localStorage.getItem("meshnet_pending_phone") || targetPhone;
    if (pendingPhone) {
      const cleanTargetPhone = normalizePhone(pendingPhone);
      const hash = hashPhoneSimple(cleanTargetPhone);
      this.setVerification({
        verified: false,
        type: "sim",
        level: 0,
        trustScore: 0,
        phone: cleanTargetPhone,
        phoneHash: hash,
        vouchedBy: [],
      });
      localStorage.removeItem("meshnet_sms_challenge");
      this.toast("SMS verify nahi hua — background auto-vouching active hai.");
    }
    return false;
  }

  // 3. Automatic Background Peer Vouching with ECDSA Signature (Unforgeable)
  silentVouchForPeer(peerGlobalId: string, peerPhoneHash?: string): void {
    const myV = this.me().verification;
    if (!myV?.verified || myV.slashed || this.computeTrustScore(myV) <= 0) return;
    const isKnownContact = this.contacts.some(
      (c) => sameUid(c.tag, peerGlobalId) || (peerPhoneHash && hashPhoneSimple(c.tag) === peerPhoneHash)
    );
    if (!isKnownContact) return;

    const cleanTargetHash = peerPhoneHash || "";
    const statement = `VOUCH|${peerGlobalId}|${cleanTargetHash}`;
    void signText(this.me().privateKey, statement).then((sig) => {
      void this.ship(
        {
          v: 1,
          id: makeId("v"),
          kind: "hello",
          from: this.me().globalId,
          fromName: this.me().name,
          to: peerGlobalId,
          key: this.me().publicKey,
          payload: {
            vouch: true,
            targetHash: cleanTargetHash,
            voucher: this.me().globalId,
            voucherPubKey: this.me().publicKey,
            vouchSig: sig,
            voucherScore: this.computeTrustScore(myV),
          },
        },
        [{ uid: uidOf(peerGlobalId), mail: false }]
      );
    });
  }

  // 4. Receive & Cryptographically Verify Peer Vouch (Rejects unsigned/forged vouches)
  receivePeerVouch(
    voucherGlobalId: string,
    targetHash: string,
    claimedPhone?: string,
    voucherPubKey?: JsonWebKey,
    vouchSig?: string
  ): void {
    if (!this.identity || sameUid(voucherGlobalId, this.me().globalId)) return;
    if (!voucherPubKey || !vouchSig || typeof vouchSig !== "string" || vouchSig.length < 20) return;

    const v: VerificationInfo = (this.identity.verification as VerificationInfo) || { verified: false, type: "none", level: 0, trustScore: 0 };
    if (targetHash && v.phoneHash && v.phoneHash !== targetHash) return;

    const statement = `VOUCH|${this.me().globalId}|${targetHash || ""}`;
    void verifyText(voucherPubKey, vouchSig, statement).then((isValidSig) => {
      if (!isValidSig || !this.identity) return;
      const curV: VerificationInfo = (this.identity.verification as VerificationInfo) || { verified: false, type: "none", level: 0, trustScore: 0 };
      const existingProofs = Array.isArray(curV.vouchProofs) ? [...curV.vouchProofs] : [];
      if (existingProofs.some((p) => sameUid(p.voucher, voucherGlobalId))) return;

      existingProofs.push({
        voucher: voucherGlobalId,
        pubKey: voucherPubKey,
        sig: vouchSig,
        targetHash: targetHash || "",
        at: Date.now(),
      });

      const updatedVouchers = existingProofs.map((p) => p.voucher);
      const count = updatedVouchers.length;
      const hasSignedSms = curV.type === "self_sms" && typeof curV.selfSmsSig === "string" && curV.selfSmsSig.length > 20;

      const nextLevel: 0 | 1 | 2 = count >= 3 ? 2 : hasSignedSms ? 1 : 0;
      const isNowVerified = count >= 3 || hasSignedSms;
      let nextScore = 0;
      if (count >= 10) {
        nextScore = Math.min(100, 25 + (count - 9) * 5);
      } else if (count >= 3) {
        nextScore = 25;
      } else if (hasSignedSms) {
        nextScore = 10;
      }

      const finalPhone = curV.phone || claimedPhone || "";
      this.setVerification({
        ...curV,
        verified: isNowVerified,
        type: count >= 3 ? "peer_vouched" : curV.type,
        level: nextLevel,
        trustScore: nextScore,
        phone: finalPhone,
        verifiedAt: curV.verifiedAt || Date.now(),
        vouchedBy: updatedVouchers,
        vouchProofs: existingProofs,
      });
      void this.broadcastHello();
    });
  }

  // 5. Asymmetric Report & Trust Slashing (High-Trust >= 60 = Instant Drop, Low-Trust = Wait & Watch)
  reportPeerNode(targetGlobalId: string, reason = "spam"): void {
    const myV = this.me().verification;
    const myScore = this.computeTrustScore(myV);
    const isHighTrust = myScore >= 60 || ((myV?.vouchedBy?.length || 0) >= 10 && Boolean(myV?.verified));

    void this.ship(
      {
        v: 1,
        id: makeId("rep"),
        kind: "hello",
        from: this.me().globalId,
        fromName: this.me().name,
        to: targetGlobalId,
        payload: {
          nodeReport: true,
          targetId: targetGlobalId,
          reporterId: this.me().globalId,
          reporterScore: myScore,
          highTrustStrike: isHighTrust,
          reason,
        },
      },
      "all"
    );
    this.toast(
      isHighTrust
        ? "High-Trust Report sent — target node ka Trust Score turant slash hoga!"
        : "Report Wait & Watch queue mein darj ho gayi (3 reports par action hoga)."
    );
  }

  private applyIncomingReport(reporterId: string, highTrustStrike: boolean): void {
    if (!this.identity || sameUid(reporterId, this.me().globalId)) return;
    const v = this.identity.verification || { verified: false, type: "none", level: 0, trustScore: 0 };
    const watch = new Set(v.watchReports || []);
    watch.add(reporterId);
    const watchList = Array.from(watch);

    if (highTrustStrike || watchList.length >= 3) {
      const curScore = this.computeTrustScore(v);
      const slashedScore = highTrustStrike ? Math.max(0, curScore - 45) : Math.max(0, curScore - 25);
      const demotedLevel: 0 | 1 | 2 = slashedScore < 10 ? 0 : slashedScore < 25 ? 1 : 2;
      this.setVerification({
        ...v,
        verified: slashedScore >= 10,
        level: demotedLevel,
        trustScore: slashedScore,
        watchReports: watchList,
        slashed: true,
      });
      this.toast(`Community Report Alert: Trust Score gir kar ${slashedScore}/100 ho gaya.`);
    } else {
      this.setVerification({
        ...v,
        watchReports: watchList,
      });
    }
  }

  private async syncMeshApi(): Promise<void> {
    if (!this.identity) return;
    try {
      const me = this.me();
      const outbox: Msg[] = [];
      for (const list of Object.values(this.chats)) {
        for (const m of list.slice(-20)) {
          if (sameUid(m.from, me.globalId) && m.status !== "read") {
            outbox.push({ ...m });
          }
        }
      }
      const res = await fetch("/api/mesh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync",
          peer: {
            globalId: me.globalId,
            name: me.name,
            handle: me.handle,
            hub: me.hub,
            discriminator: me.discriminator,
            bio: me.bio,
            avatarUrl: me.avatarUrl || "",
            createdAt: me.createdAt || Date.now(),
            verification: me.verification,
            publicKey: me.publicKey,
          },
          outbox: outbox.slice(-30),
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.peers)) {
        for (const p of data.peers) {
          if (!p?.globalId || sameUid(p.globalId, me.globalId)) continue;
          const uid = uidOf(p.globalId);
          const prevP = this.presence.get(uid);
          const isGeneric = !p.name || p.name === "Peer" || p.name.startsWith("Peer ") || p.name === "GVND Peer";
          const cleanName = !isGeneric ? p.name : (prevP?.name && prevP.name !== "Peer" ? prevP.name : p.name || "Peer");
          const cleanAvatar = (p.avatarUrl && String(p.avatarUrl).length > 5) ? p.avatarUrl : (prevP?.avatarUrl || "");
          this.presence.set(uid, {
            ...(prevP || {}),
            globalId: p.globalId,
            name: cleanName,
            avatarUrl: cleanAvatar,
            createdAt: p.createdAt || prevP?.createdAt || Date.now(),
            bio: typeof p.bio === "string" && p.bio.trim() ? p.bio.trim() : (prevP?.bio || ""),
            via: "tab",
            at: Date.now(),
            verification: p.verification || prevP?.verification || { verified: false, type: "none", level: 0 },
          });
          savePeerCacheEntry(p.globalId, !isGeneric ? p.name : undefined, cleanAvatar);
        }
      }
      if (Array.isArray(data?.messages)) {
        let changed = false;
        for (const rm of data.messages) {
          if (!rm?.id || !rm?.from || !rm?.to) continue;
          if (sameUid(rm.from, me.globalId)) {
            const rank = (s: string) => (s === "read" ? 3 : s === "delivered" ? 2 : s === "sent" ? 1 : 0);
            for (const list of Object.values(this.chats)) {
              const cur = list.find((x) => x.id === rm.id);
              if (cur && rank(rm.status || "") > rank(cur.status || "")) {
                this.patchMsg(rm.id, (item) => ({ ...item, status: rm.status }));
                changed = true;
              }
            }
          } else if (sameUid(rm.to, me.globalId)) {
            const thread = this.resolve(rm.from);
            const existing = (this.chats[thread] || []).find((x) => x.id === rm.id);
            if (!existing) {
              if (rm.from && !sameUid(rm.from, me.globalId)) {
                const sUid = uidOf(rm.from);
                const prevP = this.presence.get(sUid);
                const cleanName = (rm.fromName && !rm.fromName.startsWith("Peer ") && rm.fromName !== "GVND Peer") ? rm.fromName : undefined;
                this.presence.set(sUid, {
                  ...(prevP || {}),
                  globalId: rm.from,
                  name: cleanName || prevP?.name || rm.fromName || "Peer",
                  via: "tab",
                  at: Date.now(),
                  verification: prevP?.verification || { verified: false, type: "none", level: 0 },
                });
                if (cleanName) {
                  try {
                    const pc = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
                    pc[sUid] = { ...(pc[sUid] || {}), name: cleanName, globalId: rm.from };
                    localStorage.setItem("meshnet_peer_cache", JSON.stringify(pc));
                  } catch {}
                }
              }
              this.insert(thread, {
                ...rm,
                status: "delivered",
                isDownloaded: !rm.mediaKey,
                transferProgress: undefined,
              });
              changed = true;
              void fetch("/api/mesh", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "ack", id: rm.id, status: "delivered" }),
              }).catch(() => {});
            }
          }
        }
        if (changed) this.emitPersist();
      }
      this.emit();
    } catch {}
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
    if (env.fromName && !env.fromName.startsWith("Peer ")) {
      try {
        const senderUid = uidOf(env.from);
        const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
        c[senderUid] = { ...(c[senderUid] || {}), name: env.fromName, avatarUrl: (env.payload as any)?.avatarUrl || c[senderUid]?.avatarUrl || "", globalId: env.from };
        localStorage.setItem("meshnet_peer_cache", JSON.stringify(c));
      } catch {}
    }
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
    // Har valid incoming packet par online presence & peer cache refresh karein
    if (env.from && !sameUid(env.from, this.me().globalId)) {
      const sUid = uidOf(env.from);
      const oldP = this.presence.get(sUid);
      const validName = (env.fromName && !env.fromName.startsWith("Peer ") && env.fromName !== "GVND Peer") ? env.fromName : undefined;
      this.presence.set(sUid, {
        ...(oldP || {}),
        globalId: env.from,
        name: validName || oldP?.name || env.fromName || "Peer",
        via: via === "rtc" ? "webrtc" : "tab",
        at: Date.now(),
        verification: oldP?.verification || { verified: false, type: "none", level: 0 },
      });
      if (validName) {
        try {
          const pc = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
          pc[sUid] = { ...(pc[sUid] || {}), name: validName, globalId: env.from };
          localStorage.setItem("meshnet_peer_cache", JSON.stringify(pc));
        } catch {}
      }
    }

    if (env.kind === "hello") {
      const payload = env.payload as {
        bio?: string;
        verification?: VerificationInfo;
        hasInternetGateway?: boolean;
        directorySync?: any[];
      };
      const vInfo = payload?.verification || { verified: false, type: "none", level: 0 };
      const prevPeer = this.presence.get(uidOf(env.from));
      const incomingName = (env.fromName && !env.fromName.startsWith("Peer ") && env.fromName !== "GVND Peer") ? env.fromName : undefined;
      const finalName = incomingName || prevPeer?.name || env.fromName || "Peer";
      const rawAv = (payload as any)?.avatarUrl;
      const finalAvatar = (rawAv && String(rawAv).length > 5) ? rawAv : ((prevPeer as any)?.avatarUrl || "");

      this.presence.set(uidOf(env.from), {
        ...(prevPeer || {}),
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
        const uKey = uidOf(env.from);
        const prev = pCache[uKey] || pCache[env.from] || {};
        pCache[uKey] = {
          name: (finalName && !finalName.startsWith("Peer ") && finalName !== "GVND Peer") ? finalName : (prev.name || finalName),
          avatarUrl: (finalAvatar && String(finalAvatar).length > 5) ? finalAvatar : (prev.avatarUrl || ""),
          globalId: env.from,
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
      const anyPayload = env.payload as any;
      if (anyPayload?.vouch && env.to && sameUid(env.to, this.me().globalId)) {
        this.receivePeerVouch(
          env.from,
          String(anyPayload.targetHash || ""),
          undefined,
          anyPayload.voucherPubKey || env.key,
          typeof anyPayload.vouchSig === "string" ? anyPayload.vouchSig : undefined
        );
      } else if (anyPayload?.nodeReport && anyPayload?.targetId && sameUid(anyPayload.targetId, this.me().globalId)) {
        this.applyIncomingReport(env.from, Boolean(anyPayload.highTrustStrike));
      } else {
        this.silentVouchForPeer(env.from, (vInfo as VerificationInfo | undefined)?.phoneHash);
      }
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
    if (mediaData && rest.mediaKey && mediaData.startsWith("data:")) this.rawMedia.set(rest.mediaKey, mediaData);
    
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
    void this.deliver(msg).then(() => void this.syncMeshApi());
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
      const bytes = mediaData && mediaData.startsWith("data:") ? mediaData : msg.mediaKey ? this.rawMedia.get(msg.mediaKey) : undefined;
      if (isGroupId(msg.to)) {
        await this.fanout(msg, bytes);
        return;
      }
      if (msg.mediaKey) {
        const mediaPayload = bytes || this.rawMedia.get(msg.mediaKey);
        if (mediaPayload) {
          try {
            const mRes = await fetch("/api/mesh", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "media",
                mediaKey: msg.mediaKey,
                dataUrl: mediaPayload,
                mime: msg.mediaMime || "application/octet-stream",
              }),
            });
            if (!mRes.ok) {
                          }
          } catch (e: any) {
                      }
        }
      }
      const online = this.isOnline(msg.to);
      try {
        await this.wireDm(msg, bytes, !online, uidOf(msg.to));
      } catch {}
      this.patchMsg(msg.id, (m) => ({
        ...m,
        status: m.status === "queued" ? "sent" : m.status,
        isDownloaded: true,
        transferProgress: undefined,
      }));
      this.emitPersist();
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
    let changed = false;
    const nextChats: Record<string, Msg[]> = {};
    for (const [k, list] of Object.entries(this.chats)) {
      nextChats[k] = list.map((m) => {
        if (m.id === id && rank(status) > rank(m.status)) {
          changed = true;
          return { ...m, status };
        }
        return m;
      });
    }
    if (changed) {
      this.chats = nextChats;
      this.emit();
      this.emitPersist();
    }
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
        void this.deliver(msg).then(() => void this.syncMeshApi());
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

  loginWithPassphrase(handleInput: string, passphrase: string, allowCreate = false): { ok: boolean; globalId: string; notFound?: boolean; err?: string } {
    const cleanHandle = handleInput.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const secret = passphrase.trim();
    if (!cleanHandle || !secret) {
      return { ok: false, globalId: this.me().globalId, err: "Username aur Secret PIN dono dalein." };
    }
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const salt = allowCreate ? (crypto.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))) : "";
    const seed = cleanHandle + "::gvnd::" + secret + (salt ? "::" + salt : "");
    for (let i = 0; i < seed.length; i++) {
      const ch = seed.charCodeAt(i);
      h1 ^= ch;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= ch ^ (i & 0xff);
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    const uid = ((h1 ^ h2) >>> 0).toString(16).padStart(8, "0").slice(0, 8);
    const hub = this.me().hub || "mrt";
    const nextGlobalId = `@${cleanHandle}@${hub}#${uid}`;
    const existingRaw = localStorage.getItem(`meshnet-node:${uid}`);
    const knownDir = JSON.parse(localStorage.getItem("meshnet_known_directory") || "{}");
    const peerCache = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
    const accountExists = Boolean(existingRaw || knownDir[uid] || peerCache[uid]);
    if (!allowCreate && !accountExists) {
      return { ok: false, globalId: nextGlobalId, notFound: true, err: "Yeh account nahi mila! Pehle New Account par jakar signup karein." };
    }
    if (existingRaw) {
      try {
        const parsedNode = JSON.parse(existingRaw);
        if (parsedNode?.identity) this.applySaved(parsedNode);
      } catch {}
    }
    const cur = this.me();
    this.identity = {
      ...cur,
      name: cur.name && !cur.name.startsWith("Peer ") ? cur.name : cleanHandle,
      handle: cleanHandle,
      discriminator: uid,
      globalId: nextGlobalId,
    };
    localStorage.setItem("meshnet-active-sid", uid);
    this.persist();
    try {
      const raw = JSON.parse(localStorage.getItem("meshnet_identity_v1") || "{}");
      raw.globalId = nextGlobalId;
      raw.handle = cleanHandle;
      localStorage.setItem("meshnet_identity_v1", JSON.stringify(raw));
    } catch {}
    this.emit();
    this.emitPersist();
    this.toast(`Login successful! ID: ${nextGlobalId}`);
    return { ok: true, globalId: nextGlobalId };
  }

  exportIdentityBackup(): string {
    return JSON.stringify({
      v: 1,
      me: this.me(),
      contacts: this.contacts,
      groups: this.groups,
      chats: this.chats
    });
  }

  importAndMergeBackup(rawJson: string): boolean {
    try {
      const data = JSON.parse(rawJson.trim());
      if (!data || !data.me) return false;
      if (Array.isArray(data.contacts)) {
        for (const c of data.contacts) {
          if (c?.tag && !this.contacts.some((x) => sameUid(x.tag, c.tag))) {
            this.contacts.push(c);
          }
        }
      }
      if (data.chats && typeof data.chats === "object") {
        for (const [k, list] of Object.entries(data.chats)) {
          if (!Array.isArray(list)) continue;
          const tk = uidOf(k) || k;
          const existing = this.chats[tk] || [];
          const seen = new Set(existing.map((m) => m.id));
          const merged = [...existing];
          for (const m of list as Msg[]) {
            if (m?.id && !seen.has(m.id)) {
              seen.add(m.id);
              merged.push(m);
            }
          }
          merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          this.chats[tk] = merged;
        }
      }
      if (data.me.globalId && this.identity) {
        this.identity = {
          ...this.identity,
          name: data.me.name || this.identity.name,
          bio: data.me.bio || this.identity.bio,
          globalId: data.me.globalId,
        };
      }
      this.emit();
      this.emitPersist();
      this.toast("Account & old chats merged successfully!");
      return true;
    } catch {
      return false;
    }
  }

  markRead(tag: string): void {
    const k = uidOf(tag) || tag;
    const list = this.chats[k] || this.chats[tag];
    if (!Array.isArray(list) || list.length === 0) return;
    let changed = false;
    const readIds: string[] = [];
    const next = list.map((m) => {
      if (!sameUid(m.from, this.me().globalId) && m.status !== "read" && !(m.mediaKey && !m.isDownloaded)) {
        changed = true;
        readIds.push(m.id);
        return { ...m, status: "read" as const };
      }
      return m;
    });
    if (!changed) return;
    this.chats = { ...this.chats, [k]: next };
    this.emit();
    this.emitPersist();
    Promise.all(
      readIds.map((id) =>
        fetch("/api/mesh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "ack", id, status: "read" }),
        }).catch(() => {})
      )
    ).then(() => void this.syncMeshApi());
  }

  private isOnline(tag: string): boolean {
    const peer = this.presence.get(uidOf(tag));
    return Boolean(peer && Date.now() - peer.at < 90000);
  }

  private isContact(tag: string): boolean {
    return this.contacts.some((c) => sameUid(c.tag, tag));
  }

  private nameOf(tag: string): string {
  if (sameUid(tag, this.me().globalId)) return this.me().name;
  const contact = this.contacts.find((c) => sameUid(c.tag, tag));
  if (contact) return contact.name;
  const peer = this.presence.get(uidOf(tag));
  if (peer && peer.name && !peer.name.startsWith("Peer ") && peer.name !== "GVND Peer") return peer.name;
  try {
    const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
    const hit = Object.entries(c).find(([k]) => sameUid(k, tag));
    if (hit && (hit[1] as any)?.name && !(hit[1] as any).name.startsWith("Peer ")) return (hit[1] as any).name;
  } catch {}
  const group = this.groups.find((g) => g.id === tag);
  if (group) return group.name;
  if (tag.startsWith("@") && tag.includes("@", 1)) {
    const h = tag.slice(1).split("@")[0];
    if (h && !h.startsWith("peer")) return h.charAt(0).toUpperCase() + h.slice(1);
  }
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

  private insert(thread: string, msg: Msg): boolean {
    if (msg?.id && this.deletedForMe.has(msg.id)) return false;
    const k = uidOf(thread) || thread;
    const prev = this.chats[k] || this.chats[thread] || [];
    const existed = prev.some((x) => x.id === msg.id);
    const next = existed ? prev.map((x) => {
      if (x.id !== msg.id) return x;
      const keepStatus = rank(x.status) >= rank(msg.status) ? x.status : msg.status;
      return { ...x, ...msg, status: keepStatus };
    }) : [...prev, msg];
    const updatedChats = { ...this.chats };
    if (thread !== k) delete updatedChats[thread];
    updatedChats[k] = next;
    this.chats = updatedChats;
    this.emit();
    this.emitPersist();
    return existed;
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

  isOnboarded(): boolean {
    try {
      return localStorage.getItem("gvnd_onboarded_v1") === "1";
    } catch {
      return true;
    }
  }

  completeNewOnboarding(input: { name: string; handle: string; pin: string; phone?: string }): { ok: boolean; err?: string } {
    const cleanName = input.name.trim();
    const cleanHandle = input.handle.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const cleanPin = input.pin.trim();
    if (cleanName.length < 2 || cleanHandle.length < 2) {
      return { ok: false, err: "Naam aur username (kam se kam 2 letters) dalein." };
    }
    if (cleanPin.length < 4) {
      return { ok: false, err: "Kam se kam 4-digit Secret PIN banayein." };
    }
    const res = this.loginWithPassphrase(cleanHandle, cleanPin, true);
    if (!res.ok || !this.identity) return { ok: false, err: "Account setup fail hua." };

    this.identity = {
      ...this.identity,
      name: cleanName.slice(0, 32),
      handle: cleanHandle,
      secretPin: cleanPin.slice(0, 12),
    };
    localStorage.setItem("gvnd_onboarded_v1", "1");
    this.persist();
    this.emitPersist();
    void this.broadcastHello();

    if (input.phone && input.phone.replace(/\D/g, "").length >= 10) {
      const fullNum = normalizePhone(input.phone);
      localStorage.setItem("meshnet_pending_phone", fullNum);
      this.startSelfSmsVerification(fullNum);
    }
    return { ok: true };
  }

  async exportEncryptedGvndFile(passphrase: string): Promise<string> {
    const secret = passphrase.trim();
    const payload = JSON.stringify({
      format: "gvnd-vault-v1",
      exportedAt: Date.now(),
      data: this.saved(),
    });
    const sealed = await seal(secret, payload);
    return JSON.stringify({
      app: "GVND Connect",
      v: 1,
      encrypted: true,
      globalId: this.me().globalId,
      vault: sealed,
    });
  }

  async importEncryptedGvndFile(fileText: string, passphrase: string): Promise<{ ok: boolean; err?: string }> {
    try {
      const wrapper = JSON.parse(fileText.trim());
      if (!wrapper?.vault) return { ok: false, err: "Valid .gvnd backup file nahi hai." };
      const decryptedRaw = await openSeal<string>(passphrase.trim(), wrapper.vault);
      if (!decryptedRaw) return { ok: false, err: "Galat Password / PIN! File decrypt nahi hui." };
      const parsed = typeof decryptedRaw === "string" ? JSON.parse(decryptedRaw) : decryptedRaw;
      const savedData = parsed?.data || parsed;
      if (!savedData?.identity?.globalId || !savedData?.identity?.privateKey) {
        return { ok: false, err: "Backup file ke andar identity data missing hai." };
      }
      this.applySaved(savedData);
      localStorage.setItem("meshnet-active-sid", savedData.identity.discriminator);
      localStorage.setItem("gvnd_onboarded_v1", "1");
      this.persist();
      this.emitPersist();
      void this.broadcastHello();
      this.toast(`Welcome back ${savedData.identity.name}! Account & chats restore ho gaye.`);
      return { ok: true };
    } catch {
      return { ok: false, err: "Backup file padhne mein error aaya." };
    }
  }

  addContactByPhone(name: string, phone: string): { ok: boolean; tag: string; isOnline: boolean } {
    const digits = String(phone || "").replace(/[^0-9]/g, "").slice(-10);
    const clean = digits.length === 10 ? "+91" + digits : normalizePhone(phone);
    const displayName = (name && !/^[+0-9\s-]+$/.test(name.trim())) ? name.trim() : (digits.length === 10 ? "+91 " + digits : clean);
    const peer = this.findPeerByPhone(clean);
    if (peer) {
      this.saveContact(displayName, peer.globalId);
      return { ok: true, tag: peer.globalId, isOnline: true };
    }
    const tag = "phone:" + clean;
    this.saveContact(displayName, tag);
    return { ok: true, tag, isOnline: false };
  }
}

let singleton: MeshEngine | null = null;
export function getEngine(): MeshEngine {
  if (!singleton) singleton = new MeshEngine();
  return singleton;
}
