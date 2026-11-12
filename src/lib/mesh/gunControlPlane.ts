const Gun = (typeof window !== "undefined" ? (window as any).Gun : null);
import type { Msg, Post } from "@/lib/mesh/model";

const NAMESPACE = "gvnd-connect-v1";

class GvndControlPlane {
  private gun: any;
  private peers = new Set<string>();

  constructor() {
    if (typeof window !== "undefined") {
      if (
        window.location.protocol.startsWith("http") &&
        window.location.hostname !== "appassets.androidplatform.net"
      ) {
        this.peers.add(`${window.location.origin}/gun`);
      }
      this.peers.add("http://127.0.0.1:18081/gun");
    }

    this.gun = Gun({
      peers: Array.from(this.peers),
      localStorage: false,
      radisk: true,
    });
  }

  public addMeshPeers(nodeUrls: string[]) {
    let added = false;
    for (const baseUrl of nodeUrls) {
      const gunUrl = `${baseUrl.replace(/\/$/, "")}/gun`;
      if (!this.peers.has(gunUrl)) {
        this.peers.add(gunUrl);
        added = true;
      }
    }
    if (added && this.gun) {
      this.gun.opt({ peers: Array.from(this.peers) });
    }
  }

  public announcePeer(peer: { globalId: string; name: string; bio?: string; avatarUrl?: string }) {
    this.gun.get(NAMESPACE).get("peers").get(peer.globalId).put({
      globalId: peer.globalId,
      name: peer.name,
      bio: peer.bio || "",
      avatarUrl: peer.avatarUrl || "",
      lastSeen: Date.now(),
    });
  }

  public subscribePeers(
    onPeer: (peer: { globalId: string; name: string; bio: string; avatarUrl: string; lastSeen: number }) => void
  ) {
    this.gun.get(NAMESPACE).get("peers").map().on((data: any) => {
      if (!data || !data.globalId) return;
      onPeer({
        globalId: String(data.globalId),
        name: String(data.name || "GVND Peer"),
        bio: String(data.bio || ""),
        avatarUrl: String(data.avatarUrl || ""),
        lastSeen: Number(data.lastSeen || 0),
      });
    });
  }

  public putChatMessage(threadKey: string, msg: Msg) {
    this.gun.get(NAMESPACE).get("threads").get(threadKey).get(msg.id).put({
      id: msg.id,
      from: msg.from,
      to: msg.to,
      content: msg.content || "",
      timestamp: msg.timestamp,
      status: msg.status,
      editedAt: msg.editedAt || 0,
      isDeleted: Boolean(msg.isDeleted),
      system: Boolean(msg.system),
      mediaKey: msg.mediaKey || "",
      mediaName: msg.mediaName || "",
      mediaMime: msg.mediaMime || "",
      mediaThumb: msg.mediaThumb || "",
      mediaSize: msg.mediaSize || 0,
      metaJson: JSON.stringify({
        replyTo: msg.replyTo || null,
        location: msg.location || null,
        contactCard: msg.contactCard || null,
        groupMeta: msg.groupMeta || null,
      }),
    });
  }

  public subscribeAllThreads(onMsg: (threadKey: string, msg: Msg) => void) {
    this.gun.get(NAMESPACE).get("threads").map().on((_node: any, threadKey: string) => {
      if (!threadKey || threadKey === "_") return;
      this.gun.get(NAMESPACE).get("threads").get(threadKey).map().on((data: any) => {
        if (!data || !data.id || !data.from) return;
        let extra: any = {};
        try { if (data.metaJson) extra = JSON.parse(String(data.metaJson)); } catch {}
        onMsg(threadKey, {
          id: String(data.id),
          from: String(data.from),
          to: String(data.to || threadKey),
          content: String(data.content || ""),
          timestamp: Number(data.timestamp || Date.now()),
          status: (data.status as Msg["status"]) || "delivered",
          editedAt: data.editedAt ? Number(data.editedAt) : undefined,
          isDeleted: Boolean(data.isDeleted),
          system: Boolean(data.system),
          mediaKey: data.mediaKey ? String(data.mediaKey) : undefined,
          mediaName: data.mediaName ? String(data.mediaName) : undefined,
          mediaMime: data.mediaMime ? String(data.mediaMime) : undefined,
          mediaThumb: data.mediaThumb ? String(data.mediaThumb) : undefined,
          mediaSize: data.mediaSize ? Number(data.mediaSize) : undefined,
          replyTo: extra.replyTo || undefined,
          location: extra.location || undefined,
          contactCard: extra.contactCard || undefined,
          groupMeta: extra.groupMeta || undefined,
        });
      });
    });
  }

  public putFeedPost(hub: string, post: Post) {
    this.gun.get(NAMESPACE).get("feeds").get(hub).get(post.id).put({
      id: post.id,
      author: post.author,
      globalId: post.globalId,
      content: post.content,
      category: post.category,
      groupId: post.groupId || "",
      mediaKey: post.mediaKey || "",
      mediaMime: post.mediaMime || "",
      mediaName: post.mediaName || "",
      timestamp: post.timestamp,
      rev: post.rev,
      deleted: Boolean(post.deleted),
      socialJson: JSON.stringify({
        likes: post.likes || [],
        reposts: post.reposts || [],
        reports: post.reports || [],
        replies: post.replies || [],
      }),
    });
  }

  public subscribeFeeds(hub: string, onPost: (post: Post) => void) {
    this.gun.get(NAMESPACE).get("feeds").get(hub).map().on((data: any) => {
      if (!data || !data.id) return;
      let social: any = {};
      try { if (data.socialJson) social = JSON.parse(String(data.socialJson)); } catch {}
      onPost({
        id: String(data.id),
        author: String(data.author || "Peer"),
        globalId: String(data.globalId || ""),
        content: String(data.content || ""),
        category: data.category === "friends" || data.category === "groups" ? data.category : "all",
        groupId: data.groupId ? String(data.groupId) : undefined,
        mediaKey: data.mediaKey ? String(data.mediaKey) : undefined,
        mediaMime: data.mediaMime ? String(data.mediaMime) : undefined,
        mediaName: data.mediaName ? String(data.mediaName) : undefined,
        likes: Array.isArray(social.likes) ? social.likes : [],
        reposts: Array.isArray(social.reposts) ? social.reposts : [],
        reports: Array.isArray(social.reports) ? social.reports : [],
        replies: Array.isArray(social.replies) ? social.replies : [],
        timestamp: Number(data.timestamp || Date.now()),
        rev: Number(data.rev || 1),
        deleted: Boolean(data.deleted),
      });
    });
  }
}

export const gvndControl = new GvndControlPlane();
