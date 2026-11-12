import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Ban,
  Check,
  CheckCheck,
  Clock,
  Copy,
  CornerUpRight,
  Edit3,
  FileText,
  Reply,
  Image as ImageIcon,
  Lock,
  MapPin,
  MessageCircle,
  Mic,
  MoreVertical,
  Newspaper,
  Phone,
  PhoneOff,
  Plus,
  Radio,
  Repeat2,
  Search,
  Send,
  Star,
  Trash2,
  UserRound,
  Users,
  Video,
  Volume2,
  X,
  ShieldCheck,
  ShieldAlert,
  QrCode,
  Wifi,
  Globe
} from "lucide-react";
import { getLocalHostShareUrl, openFileWithAndroidBridge } from "@/lib/mesh/nativeBridge";
import {
  EMPTY_SNAP,
  getEngine,
  type MeshEngine,
  type LiveCall,
  type Msg,
  type Post,
  type Snap,
} from "@/lib/mesh/engine";
import {
  REPORT_HIDE_AT,
  type Category,
  type Contact,
  formatDuration,
  formatWhen,
  initial,
  isGroupId,
  safeMediaSrc,
  sameUid,
  tagOk,
  uidOf,
  hashPhoneSimple,
  type VerificationInfo,
} from "@/lib/mesh/model";

type Tab = "chats" | "feeds" | "calls" | "contacts" | "search" | "profile";

const TABS: { id: Tab; label: string; icon: typeof MessageCircle }[] = [
  { id: "chats", label: "Chats", icon: MessageCircle },
  { id: "feeds", label: "Feeds", icon: Newspaper },
  { id: "calls", label: "Calls", icon: Phone },
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "search", label: "Search", icon: Search },
  { id: "profile", label: "Profile", icon: UserRound },
];

function generateQRMatrix(text: string): boolean[][] {
  const size = 25;
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));

  const addFinder = (r: number, c: number) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const row = r + i;
        const col = c + j;
        if (row >= 0 && row < size && col >= 0 && col < size) {
          if (
            (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
            (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
            (i >= 2 && i <= 4 && j >= 2 && j <= 4)
          ) {
            matrix[row][col] = true;
          } else {
            matrix[row][col] = false;
          }
        }
      }
    }
  };

  addFinder(0, 0);
  addFinder(0, size - 7);
  addFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }
  matrix[size - 8][8] = true;

  const bytes = new TextEncoder().encode(text);
  const bitStream: number[] = [0, 1, 0, 0];
  for (let i = 7; i >= 0; i--) bitStream.push((bytes.length >> i) & 1);
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) bitStream.push((b >> i) & 1);
  }
  while (bitStream.length % 8 !== 0) bitStream.push(0);

  let bitIdx = 0;
  let upwards = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    const rows = upwards
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (const c of [col, col - 1]) {
        if (matrix[row][c] === null) {
          const rawBit = bitIdx < bitStream.length ? bitStream[bitIdx++] : (row + c) % 2 === 0 ? 1 : 0;
          const mask = (row + c) % 2 === 0;
          matrix[row][c] = mask ? rawBit === 0 : rawBit === 1;
        }
      }
    }
    upwards = !upwards;
  }

  return matrix.map((row) => row.map((cell) => cell ?? false));
}

function QRCodeSVG({ value, size = 180 }: { value: string; size?: number }) {
  let matrix: boolean[][];
  try {
    matrix = generateQRMatrix(value);
  } catch {
    matrix = Array.from({ length: 25 }, () => Array(25).fill(false));
  }

  const n = matrix.length;
  const cellSize = 8;
  const viewBoxSize = n * cellSize;

  return (
    <svg
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      width={size}
      height={size}
      className="rounded-lg bg-white p-2 shadow"
      shapeRendering="crispEdges"
    >
      {matrix.map((row, r) =>
        row.map((cell, c) =>
          cell ? (
            <rect
              key={`${r}-${c}`}
              x={c * cellSize}
              y={r * cellSize}
              width={cellSize}
              height={cellSize}
              fill="#000000"
            />
          ) : null
        )
      )}
    </svg>
  );
}

function threadKey(snap: Snap, tag: string): string {
  if (snap.chats[tag]) return tag;
  if (isGroupId(tag)) return tag;
  return Object.keys(snap.chats).find((key) => !isGroupId(key) && sameUid(key, tag)) || tag;
}

function messagesFor(snap: Snap, tag: string): Msg[] {
  return snap.chats[threadKey(snap, tag)] || [];
}

function nameOf(snap: Snap, tag: string): string {
  if (sameUid(tag, snap.me.globalId)) return snap.me.name;
  if (isGroupId(tag)) return snap.groups.find((g) => g.id === tag)?.name || "Group";

  const contact = snap.contacts.find((c) => sameUid(c.tag, tag));
  if (contact?.name) return contact.name;

  const peer = snap.peers.find((p) => sameUid(p.globalId, tag));
  if (peer?.name && !peer.name.startsWith("Peer ")) return peer.name;

  // Offline Permanent Cache se real name padhein
  try {
    const rawCache = localStorage.getItem("meshnet_peer_cache") || "{}";
    const pCache = JSON.parse(rawCache);
    const hit = Object.entries(pCache).find(([k]) => sameUid(k, tag));
    if (hit && (hit[1] as any)?.name && !(hit[1] as any).name.startsWith("Peer ")) {
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

  return tag.split("#")[0] || tag;
}

function unreadCount(snap: Snap, tag: string): number {
  const muteKey = isGroupId(tag) ? tag : uidOf(tag);
  if (snap.muted.includes(muteKey)) return 0;
  return messagesFor(snap, tag).filter(
    (m) => !sameUid(m.from, snap.me.globalId) && m.status !== "read" && !m.isDeleted && !m.system,
  ).length;
}

function totalUnread(snap: Snap): number {
  return Object.keys(snap.chats).reduce((sum, tag) => sum + unreadCount(snap, tag), 0);
}

export function MeshApp() {
  const [snap, setSnap] = useState<Snap | null>(null);
  const engRef = useRef<MeshEngine | null>(null);

  useEffect(() => {
    const eng = getEngine();
    engRef.current = eng;
    const unsub = eng.subscribe(() => setSnap(eng.getSnapshot()));
    void eng.start().then(() => setSnap(eng.getSnapshot()));
    return () => {
      unsub();
      eng.stop();
    };
  }, []);

  if (!snap || snap.me.discriminator === EMPTY_SNAP.me.discriminator || !engRef.current) {
    return (
      <main className="grid h-dvh place-items-center bg-bg px-6 text-center">
        <div>
          <img src="/favicon.svg" alt="GVND Connect" className="mx-auto size-16 rounded-2xl shadow-md" />
          <h1 className="mt-4 text-2xl font-semibold text-balance">GVND Connect</h1>
          <p className="mt-2 text-sm text-muted">Local mesh se link ho raha hai…</p>
        </div>
      </main>
    );
  }

  return <Shell snap={snap} eng={engRef.current} />;
}

function Shell({ snap, eng }: { snap: Snap; eng: MeshEngine }) {
  const [tab, setTab] = useState<Tab>("chats");
  const [chatTag, setChatTag] = useState<string | null>(null);
  const [deckPost, setDeckPost] = useState<string | null>(null);
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; mime: string; name: string } | null>(null);
  const [composer, setComposer] = useState<"chat" | "group" | null>(null);
  const [showHotspotStation, setShowHotspotStation] = useState(false);
  const [isInternetOnline, setIsInternetOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : false
  );

  useEffect(() => {
    const handleStatus = () => setIsInternetOnline(navigator.onLine);
    window.addEventListener("online", handleStatus);
    window.addEventListener("offline", handleStatus);
    return () => {
      window.removeEventListener("online", handleStatus);
      window.removeEventListener("offline", handleStatus);
    };
  }, []);

  // Ek baar me sirf 1 hi Audio/Video play ho — dusra play karte hi pehla auto-pause ho jaye
  useEffect(() => {
    const handleGlobalPlay = (e: Event) => {
      const target = e.target as HTMLMediaElement | null;
      if (!target) return;
      document.querySelectorAll("audio, video").forEach((el) => {
        if (el !== target && !(el as HTMLMediaElement).paused) {
          (el as HTMLMediaElement).pause();
        }
      });
    };
    document.addEventListener("play", handleGlobalPlay, true);
    return () => document.removeEventListener("play", handleGlobalPlay, true);
  }, []);

  // Mobile Hardware Back Button & Browser Back Interception (Website exit se bachane ke liye)
  useEffect(() => {
    window.history.pushState({ meshGuard: true }, "");
    const onPopState = () => {
      if (preview) {
        setPreview(null);
      } else if (commentsFor) {
        setCommentsFor(null);
      } else if (composer) {
        setComposer(null);
      } else if (showHotspotStation) {
        setShowHotspotStation(false);
      } else if (chatTag) {
        setChatTag(null);
      } else if (deckPost) {
        setDeckPost(null);
      } else if (tab !== "chats") {
        setTab("chats");
      }
      window.history.pushState({ meshGuard: true }, "");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [preview, commentsFor, composer, showHotspotStation, chatTag, deckPost, tab]);

  const unread = totalUnread(snap);
  const chatOpen = tab === "chats" && Boolean(chatTag);

  function openChat(tag: string) {
    setTab("chats");
    setChatTag(tag);
    setDeckPost(null);
  }

  function openPost(id: string) {
    if (window.matchMedia("(min-width: 768px)").matches) {
      setTab("feeds");
      setDeckPost(id);
      setChatTag(null);
    } else {
      setCommentsFor(id);
    }
  }

  return (
    <div className="flex h-dvh bg-bg text-fg">
      <aside className="relative flex min-w-0 flex-1 flex-col border-border md:w-96 md:max-w-96 md:flex-none md:border-r">
        <header className="flex flex-col border-b border-border bg-surface px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <img src="/favicon.svg" alt="" className="size-6 shrink-0 rounded-md" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-semibold leading-none">GVND Connect</h1>
                  {unread > 0 && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-fg tabular-nums">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </div>
                <p className="truncate font-mono text-xs text-muted">{snap.me.globalId}</p>
              </div>
            </div>

            {(() => {
              const hasBridge = snap.peers.some((p: any) => p.hasInternetGateway);
              return (
                <button
                  type="button"
                  onClick={() => setShowHotspotStation(true)}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-transform active:scale-95 ${
                    isInternetOnline
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20"
                      : hasBridge
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                      : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
                  }`}
                  title="View Hotspot Station & Network Mesh"
                >
                  {isInternetOnline ? <Globe className="size-3.5" /> : <Wifi className="size-3.5" />}
                  <span>
                    {isInternetOnline
                      ? "Direct Online"
                      : hasBridge
                      ? "Bridged (Peer Gateway)"
                      : "Offline Mesh"}
                  </span>
                  <span className="ml-0.5 font-semibold tabular-nums">
                    ({snap.peers.length} {isInternetOnline ? "online" : "nearby"})
                  </span>
                </button>
              );
            })()}
          </div>
        </header>

        <nav className="flex border-b border-border" aria-label="Sections">
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs ${active ? "text-primary" : "text-muted"}`}
                aria-current={active ? "page" : undefined}
                onClick={() => setTab(item.id)}
              >
                <Icon className="size-5" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "chats" && <ChatList snap={snap} onOpen={openChat} />}
          {tab === "feeds" && (
            <FeedList snap={snap} eng={eng} onOpen={openPost} onChat={openChat} />
          )}
          {tab === "calls" && <CallsPane snap={snap} eng={eng} onOpen={openChat} />}
          {tab === "contacts" && <ContactsPane snap={snap} eng={eng} onOpen={openChat} />}
          {tab === "search" && <SearchPane snap={snap} onOpen={openChat} onPost={openPost} />}
          {tab === "profile" && <ProfilePane snap={snap} eng={eng} onOpen={openChat} />}
        </div>
        {tab === "chats" && (
          <button
            type="button"
            className="absolute right-5 bottom-5 grid size-14 place-items-center rounded-full bg-primary text-primary-fg shadow-lg"
            aria-label="New chat"
            onClick={() => setComposer("chat")}
          >
            <Plus className="size-6" />
          </button>
        )}
      </aside>

      <section
        className={
          chatOpen
            ? "fixed inset-0 z-30 flex min-w-0 flex-1 flex-col bg-bg md:static md:z-auto"
            : "hidden min-w-0 flex-1 flex-col bg-bg md:flex"
        }
      >
        {chatOpen && chatTag ? (
          <ChatPane
            snap={snap}
            eng={eng}
            tag={chatTag}
            onClose={() => setChatTag(null)}
            onPreview={setPreview}
          />
        ) : deckPost && tab === "feeds" ? (
          <PostDeck
            snap={snap}
            eng={eng}
            postId={deckPost}
            onClose={() => setDeckPost(null)}
            onPreview={setPreview}
          />
        ) : (
          <Hub snap={snap} eng={eng} onGroup={() => setComposer("group")} />
        )}
      </section>

      {composer && (
        <Composer
          snap={snap}
          eng={eng}
          mode={composer}
          onClose={() => setComposer(null)}
          onOpen={openChat}
          onMode={setComposer}
        />
      )}
      {commentsFor && (
        <Comments
          snap={snap}
          eng={eng}
          postId={commentsFor}
          onClose={() => setCommentsFor(null)}
        />
      )}
      {showHotspotStation && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setShowHotspotStation(false)}
        >
          <div
            className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-border bg-surface p-2 shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowHotspotStation(false)}
              className="absolute top-4 right-4 z-10 grid size-8 place-items-center rounded-full bg-elevated text-muted hover:text-fg"
            >
              <X className="size-4" />
            </button>
            <Hub
              snap={snap}
              eng={eng}
              onGroup={() => {
                setShowHotspotStation(false);
                setComposer("group");
              }}
            />
          </div>
        </div>
      )}
      {preview && <Preview item={preview} onClose={() => setPreview(null)} />}
      {(snap.incoming || snap.call) && <CallOverlay snap={snap} eng={eng} />}
      {snap.toast && (
        <div
          className="fixed bottom-6 left-1/2 z-50 max-w-sm -translate-x-1/2 rounded-full bg-elevated px-4 py-2 text-sm text-fg shadow-lg"
          role="status"
        >
          {snap.toast}
        </div>
      )}
    </div>
  );
}

function ChatList({ snap, onOpen }: { snap: Snap; onOpen: (tag: string) => void }) {
  const tags = new Set<string>(Object.keys(snap.chats));
  for (const peer of snap.peers) tags.add(peer.globalId);
  const rows = [...tags]
    .map((tag) => {
      const msgs = messagesFor(snap, tag);
      const last = msgs[msgs.length - 1];
      return { tag, last, unread: unreadCount(snap, tag), when: last?.timestamp || 0 };
    })
    .sort((a, b) => b.when - a.when || nameOf(snap, a.tag).localeCompare(nameOf(snap, b.tag)));

  if (rows.length === 0) {
    return <Empty icon={MessageCircle} title="Koi chat nahi" body="Naya chat shuru karo, ya Meera ko message bhejo." />;
  }

  return (
    <ul>
      {rows.map((row) => {
        const online = snap.peers.some((p) => sameUid(p.globalId, row.tag) || p.globalId === row.tag);
        const preview = previewText(row.last);
        return (
          <li key={row.tag}>
            <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-elevated" onClick={() => onOpen(row.tag)}>
              <Avatar
                name={nameOf(snap, row.tag)}
                online={online}
                src={
                  (snap.peers.find((p) => sameUid(p.globalId, row.tag)) as any)?.avatarUrl ||
                  (() => {
                    try {
                      const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
                      const hit = Object.entries(c).find(([k]) => sameUid(k, row.tag));
                      return (hit?.[1] as any)?.avatarUrl || "";
                    } catch {
                      return "";
                    }
                  })()
                }
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold">{nameOf(snap, row.tag)}</span>
                  {row.when > 0 && <span className="shrink-0 text-xs text-muted tabular-nums">{formatWhen(row.when)}</span>}
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2 text-sm text-muted">
                  <span className="truncate">{preview}</span>
                  {row.unread > 0 && (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-fg tabular-nums">
                      {row.unread}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function previewText(msg?: Msg): string {
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

function ChatPane({
  snap,
  eng,
  tag,
  onClose,
  onPreview,
}: {
  snap: Snap;
  eng: MeshEngine;
  tag: string;
  onClose: () => void;
  onPreview: (item: { url: string; mime: string; name: string }) => void;
}) {
  const key = threadKey(snap, tag);
  const msgs = messagesFor(snap, tag);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showForwardModal, setShowForwardModal] = useState(false);
  const [forwardTargets, setForwardTargets] = useState<string[]>([]);
  const longPressTimer = useRef<number | null>(null);
  const didLongPress = useRef(false);
  const [attach, setAttach] = useState(false);

  const selectedMsgs = msgs.filter((m) => selectedIds.includes(m.id));
  const selectionMode = selectedIds.length > 0;
  const allSelectedMine = selectedMsgs.length > 0 && selectedMsgs.every((m) => sameUid(m.from, snap.me.globalId) && !m.isDeleted && !m.system);

  function toggleSelectMsg(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handlePressStart(id: string) {
    didLongPress.current = false;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      didLongPress.current = true;
      longPressTimer.current = null;
      toggleSelectMsg(id);
      if (navigator.vibrate) navigator.vibrate(25);
    }, 400);
  }

  function handlePressEnd() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  // Reliable Copy Function (Works on both HTTP LAN & HTTPS)
  async function copySelectedMessages() {
    const copyText = selectedMsgs
      .map((m) => m.content || m.mediaName || (m.location ? `https://maps.google.com/?q=${m.location.lat},${m.location.lng}` : ""))
      .filter(Boolean)
      .join("\n");
    if (!copyText) {
      eng.note("Copy karne ke liye text nahi hai.");
      setSelectedIds([]);
      return;
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(copyText);
      } else {
        const ta = document.createElement("textarea");
        ta.value = copyText;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      eng.note(`${selectedMsgs.length > 1 ? `${selectedMsgs.length} messages` : "Message"} copy ho gaya!`);
    } catch {
      eng.note("Copy failed.");
    }
    setSelectedIds([]);
  }
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [finding, setFinding] = useState("");
  const [showFind, setShowFind] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const group = snap.groups.find((g) => g.id === key);
  const muted = snap.muted.includes(isGroupId(key) ? key : uidOf(key));
  const blocked = snap.blocked.some((b) => sameUid(b, key));
  const online = snap.peers.some((p) => sameUid(p.globalId, key));

  useEffect(() => {
    eng.setViewing(key);
    return () => {
      eng.setViewing(null);
      // Clean up voice recorder when closing or navigating
      if (recRef.current && recRef.current.state !== "inactive") {
        recRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [eng, key]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [msgs.length, key]);

  const shown = finding.trim()
    ? msgs.filter((m) => (m.content || "").toLowerCase().includes(finding.trim().toLowerCase()))
    : msgs;
  const typing =
    snap.typing &&
    (snap.typing.thread === key || (!isGroupId(key) && sameUid(snap.typing.thread, key)));

  function send() {
    if (editing) {
      if (text.trim()) {
        eng.editMessage(key, editing.id, text.trim());
      }
      setEditing(null);
      setText("");
      eng.setTyping(key, false);
      return;
    }
    if (!text.trim()) return;
    eng.sendText(
      key,
      text.trim(),
      reply ? { id: reply.id, author: nameOf(snap, reply.from), preview: previewText(reply) } : null
    );
    setText("");
    setReply(null);
    eng.setTyping(key, false);
  }

  async function toggleMic() {
    if (recRef.current && recRef.current.state === "recording") {
      recRef.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      streamRef.current = stream;
      const preferredMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, {
        mimeType: preferredMime,
        audioBitsPerSecond: 64000, // 64kbps Opus: Crisp & natural voice quality
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setRecording(false);
        recRef.current = null;
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
      setRecordSecs(0);
      timerRef.current = window.setInterval(() => {
        setRecordSecs((s) => s + 1);
      }, 1000);
    } catch {
      eng.note("Mic permission nahi mili.");
    }
  }

  function sendVoicePreview() {
    if (audioBlob) {
      void eng.sendVoice(key, audioBlob);
      discardVoice();
    }
  }

  function discardVoice() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setRecordSecs(0);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {selectionMode ? (
        <header className="flex items-center justify-between gap-1 border-b border-primary/40 bg-surface px-2 py-2 shadow">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="grid size-10 place-items-center rounded-full hover:bg-elevated"
              aria-label="Clear selection"
              onClick={() => setSelectedIds([])}
            >
              <ArrowLeft className="size-5" />
            </button>
            <span className="text-base font-bold text-primary tabular-nums">{selectedIds.length}</span>
          </div>

          <div className="flex items-center gap-0.5">
            {selectedMsgs.length === 1 && !selectedMsgs[0].isDeleted && (
              <IconBtn
                label="Reply"
                onClick={() => {
                  setReply(selectedMsgs[0]);
                  setSelectedIds([]);
                }}
              >
                <Reply className="size-5" />
              </IconBtn>
            )}
            <IconBtn
              label="Star"
              onClick={() => {
                selectedIds.forEach((id) => eng.toggleStar(id));
                setSelectedIds([]);
              }}
            >
              <Star className="size-5" />
            </IconBtn>
            <IconBtn label="Copy" onClick={() => void copySelectedMessages()}>
              <Copy className="size-5" />
            </IconBtn>
            {selectedMsgs.length === 1 &&
              allSelectedMine &&
              Boolean(selectedMsgs[0].content) && (
                <IconBtn
                  label="Edit"
                  onClick={() => {
                    setEditing(selectedMsgs[0]);
                    setText(selectedMsgs[0].content);
                    setSelectedIds([]);
                  }}
                >
                  <Edit3 className="size-5" />
                </IconBtn>
              )}
            <IconBtn
              label="Delete"
              onClick={() => setShowDeleteModal(true)}
            >
              <Trash2 className="size-5 text-danger" />
            </IconBtn>
            <IconBtn
              label="Forward"
              onClick={() => {
                setForwardTargets([]);
                setShowForwardModal(true);
              }}
            >
              <CornerUpRight className="size-5" />
            </IconBtn>
          </div>
        </header>
      ) : (
        <header className="flex items-center gap-2 border-b border-border px-2 py-2">
          <button
            type="button"
            className="grid size-11 place-items-center"
            aria-label="Back"
            onClick={() => {
              if (selectionMode) setSelectedIds([]);
              else onClose();
            }}
          >
            <ArrowLeft className="size-5" />
          </button>
          <Avatar
            name={nameOf(snap, key)}
            online={online || isGroupId(key)}
            src={
              (snap.peers.find((p) => sameUid(p.globalId, key)) as any)?.avatarUrl ||
              (() => {
                try {
                  const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
                  const hit = Object.entries(c).find(([k]) => sameUid(k, key));
                  return (hit?.[1] as any)?.avatarUrl || "";
                } catch {
                  return "";
                }
              })()
            }
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold">{nameOf(snap, key)}</span>
              <VerificationBadge 
                verified={snap.peers.find((p) => sameUid(p.globalId, key))?.verification?.verified} 
                type={snap.peers.find((p) => sameUid(p.globalId, key))?.verification?.type} 
              />
            </div>
            <div className="truncate font-mono text-xs text-muted">
              {group ? `${group.members.length} members` : online ? "Online" : nameOf(snap, key)}
            </div>
          </div>
          <IconBtn label="Search in chat" onClick={() => setShowFind((v) => !v)}>
            <Search className="size-5" />
          </IconBtn>
          <IconBtn label={muted ? "Unmute" : "Mute"} onClick={() => eng.toggleMute(key)}>
            <Volume2 className={`size-5 ${muted ? "text-primary" : ""}`} />
          </IconBtn>
          {!isGroupId(key) && (
            <>
              <IconBtn label="Voice call" onClick={() => void eng.startCall(key, "voice", { dialer: false }).then((err) => err && eng.note(err))}>
                <Phone className="size-5" />
              </IconBtn>
              <IconBtn label="Video call" onClick={() => void eng.startCall(key, "video", { dialer: false }).then((err) => err && eng.note(err))}>
                <Video className="size-5" />
              </IconBtn>
            </>
          )}
        </header>
      )}
      {showFind && (
        <label className="border-b border-border px-3 py-2">
          <span className="sr-only">Search messages</span>
          <input
            value={finding}
            onChange={(e) => setFinding(e.target.value)}
            placeholder="Is chat mein dhundo"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none"
          />
        </label>
      )}
      <div ref={boxRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
        {shown.map((msg) => {
          const mine = sameUid(msg.from, snap.me.globalId);
          const url = msg.mediaKey ? safeMediaSrc(snap.urls[msg.mediaKey]) : null;
          const isSelected = selectedIds.includes(msg.id);
          return (
            <div
              key={msg.id}
              onPointerDown={(e) => {
                if (e.button === 0 || e.pointerType === "touch") handlePressStart(msg.id);
              }}
              onPointerUp={handlePressEnd}
              onPointerCancel={handlePressEnd}
              onPointerMove={handlePressEnd}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                if (didLongPress.current) {
                  e.preventDefault();
                  e.stopPropagation();
                  didLongPress.current = false;
                  return;
                }
                if (selectionMode) {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleSelectMsg(msg.id);
                }
              }}
              style={{ WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
              className={`flex rounded-xl px-1 py-0.5 transition-colors select-none ${
                isSelected ? "bg-primary/25 ring-1 ring-primary/50" : ""
              } ${mine ? "justify-end" : "justify-start"}`}
            >
              <div className={`max-w-xs rounded-lg px-3 py-2 text-sm leading-relaxed ${msg.system ? "bg-elevated text-muted" : mine ? "bg-bubble" : "bg-elevated"}`}>
                {!mine && isGroupId(key) && !msg.system && (
                  <div className="mb-1 text-xs font-semibold text-primary">{nameOf(snap, msg.from)}</div>
                )}
                {msg.replyTo && (
                  <div className="mb-1 border-l-2 border-primary pl-2 text-xs text-muted">
                    {msg.replyTo.author}: {msg.replyTo.preview}
                  </div>
                )}
                {msg.isDeleted ? (
                  <p className="italic text-muted">This message was deleted</p>
                ) : (
                  <>
                    {msg.content && <p className="break-words whitespace-pre-wrap">{msg.content}</p>}

                    {/* Universal WhatsApp Style Download Card with Blur Thumbnail */}
                    {msg.mediaKey && !msg.isDownloaded && !mine && (
                      <div className="relative mt-1.5 min-w-[220px] max-w-[270px] overflow-hidden rounded-2xl border border-border bg-black/60 p-3.5 text-center shadow-lg">
                        {msg.mediaThumb && (
                          <img
                            src={msg.mediaThumb}
                            alt=""
                            className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-md"
                          />
                        )}
                        <div className="relative z-10 flex flex-col items-center justify-center gap-2 py-1">
                          {msg.transferProgress !== undefined && msg.transferProgress < 100 ? (
                            <div className="flex w-full flex-col items-center gap-1.5">
                              <span className="font-mono text-xs font-semibold text-primary">
                                {msg.transferProgress <= 1 && !online
                                  ? "Waiting for sender..."
                                  : `Downloading ${msg.transferProgress}%`}
                              </span>
                              <div className="h-1.5 w-36 overflow-hidden rounded-full bg-white/20">
                                <div
                                  className="h-full bg-primary transition-all duration-150"
                                  style={{ width: `${msg.transferProgress}%` }}
                                />
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void (eng as any).requestMediaDownload(msg.id)}
                              className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-fg shadow-xl transition-all active:scale-95"
                            >
                              <span className="text-base leading-none font-bold">↓</span>
                              <span>
                                {msg.mediaMime?.startsWith("image/")
                                  ? "Photo"
                                  : msg.mediaMime?.startsWith("video/")
                                  ? "Video"
                                  : msg.mediaMime?.startsWith("audio/")
                                  ? "Audio"
                                  : "Document"}
                                {msg.mediaSize ? ` (${(msg.mediaSize / (1024 * 1024)).toFixed(1)} MB)` : ""}
                              </span>
                            </button>
                          )}
                          <span className="max-w-[220px] truncate font-mono text-[11px] text-white/90">
                            {msg.mediaName || "Attachment"}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Sender Upload / Compression & Transfer Progress Bar */}
                    {msg.transferProgress !== undefined && (msg.isDownloaded || mine) && (
                      <div className="my-1.5 min-w-[180px] space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-semibold text-primary">
                          <span>{mine && msg.status === "queued" ? "Compressing & Uploading..." : "Sending..."}</span>
                          <span className="font-mono tabular-nums">{msg.transferProgress}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/30">
                          <div
                            className="h-full bg-primary transition-all duration-200"
                            style={{ width: `${msg.transferProgress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Download Complete hone ke baad Image Card */}
                    {url && (msg.isDownloaded || mine) && msg.mediaMime?.startsWith("image/") && (
                      <button type="button" onClick={() => onPreview({ url, mime: msg.mediaMime || "image/jpeg", name: msg.mediaName || "photo" })}>
                        <img src={url} alt="" className="mt-1 max-h-56 rounded-lg object-cover" />
                      </button>
                    )}

                    {/* Download Complete hone ke baad Fixed-Width Audio Player Card (Forward karne par bhi size kam nahi hoga) */}
                    {url && (msg.isDownloaded || mine) && msg.mediaMime?.startsWith("audio/") && (
                      <div
                        className="mt-1.5 w-[250px] max-w-full rounded-xl bg-black/25 p-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <audio src={url} controls preload="metadata" className="h-9 w-full min-w-[230px]" />
                        {msg.mediaSize && (
                          <div className="mt-0.5 flex justify-between px-1 text-[10px] font-mono text-muted">
                            <span>Audio (64kbps)</span>
                            <span>
                              {msg.mediaSize >= 1024 * 1024
                                ? `${(msg.mediaSize / (1024 * 1024)).toFixed(2)} MB`
                                : `${Math.max(1, Math.round(msg.mediaSize / 1024))} KB`}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Download Complete hone ke baad Video Card */}
                    {url && (msg.isDownloaded || mine) && msg.mediaMime?.startsWith("video/") && (
                      <div className="relative mt-1 overflow-hidden rounded-xl bg-black/60">
                        <video src={url} className="max-h-56 w-full object-cover opacity-85" playsInline />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <button
                            type="button"
                            onClick={() => onPreview({ url, mime: msg.mediaMime || "video/mp4", name: msg.mediaName || "video" })}
                            className="grid size-12 place-items-center rounded-full bg-black/60 text-white shadow-xl backdrop-blur-md hover:scale-110 active:scale-95 transition-transform"
                          >
                            ▶
                          </button>
                        </div>
                        {msg.mediaSize && (
                          <span className="absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-white/90 backdrop-blur-sm">
                            {(msg.mediaSize / (1024 * 1024)).toFixed(1)} MB
                          </span>
                        )}
                      </div>
                    )}

                    {/* WhatsApp-Style Document / PDF Bubble with Top Page Preview + Direct Mobile App Open */}
                    {url && (msg.isDownloaded || mine) && !msg.mediaMime?.startsWith("image/") && !msg.mediaMime?.startsWith("audio/") && !msg.mediaMime?.startsWith("video/") && (() => {
                      const docName = msg.mediaName || "Document.pdf";
                      const ext = docName.includes(".") ? docName.split(".").pop()?.toUpperCase() || "PDF" : "PDF";
                      const isPdfDoc = ext === "PDF" || msg.mediaMime === "application/pdf";
                      const sizeLabel = msg.mediaSize
                        ? msg.mediaSize >= 1024 * 1024
                          ? `${(msg.mediaSize / (1024 * 1024)).toFixed(1)} MB`
                          : `${Math.max(1, Math.round(msg.mediaSize / 1024))} kB`
                        : "";

                      return (
                        <button
                          type="button"
                          onClick={async (e) => {
                            if (selectionMode) return;
                            e.stopPropagation();
                            try {
                              const res = await fetch(url);
                              const blob = await res.blob();
                              const fileMime = isPdfDoc ? "application/pdf" : (msg.mediaMime || blob.type || "application/octet-stream");
                              if (await openFileWithAndroidBridge(url, docName, fileMime)) {
                                return;
                              }
                              if (await openFileWithAndroidBridge(url, docName, fileMime)) return;
                              const fileObj = new File([blob], docName, { type: fileMime });

                              // Direct Mobile App Chooser (WhatsApp ki tarah "Open with" dialog — bina Downloads folder me dhoonde)
                              if (typeof navigator !== "undefined" && navigator.canShare && navigator.canShare({ files: [fileObj] })) {
                                await navigator.share({
                                  files: [fileObj],
                                  title: docName,
                                });
                                return;
                              }

                              const win = window.open(url, "_blank", "noopener,noreferrer");
                              if (!win) {
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = docName;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                              }
                            } catch (err: any) {
                              if (err?.name !== "AbortError") {
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = docName;
                                a.click();
                              }
                            }
                          }}
                          className="mt-1 flex w-[250px] max-w-full flex-col overflow-hidden rounded-xl border border-border/80 bg-black/25 text-left transition-all hover:border-primary active:scale-[0.99]"
                        >
                          {/* Top Document Page Visual Preview Strip (WhatsApp Style) */}
                          <div className="relative h-24 w-full overflow-hidden bg-white/95 px-3 py-2 text-neutral-800">
                            {isPdfDoc ? (
                              <embed
                                src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
                                type="application/pdf"
                                className="pointer-events-none h-36 w-full border-0"
                              />
                            ) : (
                              <div className="flex h-full flex-col justify-center gap-1.5 opacity-60">
                                <div className="h-2 w-3/4 rounded bg-neutral-400" />
                                <div className="h-2 w-full rounded bg-neutral-300" />
                                <div className="h-2 w-5/6 rounded bg-neutral-300" />
                                <div className="h-2 w-2/3 rounded bg-neutral-300" />
                              </div>
                            )}
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-black/30 to-transparent" />
                          </div>

                          {/* Bottom File Metadata & Action Row */}
                          <div className="flex items-center justify-between gap-2.5 bg-surface/95 px-3 py-2.5">
                            <div className="grid size-8 shrink-0 place-items-center rounded-md bg-danger/20 text-[10px] font-bold text-danger">
                              {ext}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-semibold text-fg">{docName}</div>
                              <div className="mt-0.5 text-[10px] text-muted">
                                {sizeLabel ? `${sizeLabel} · ` : ""}{ext}
                              </div>
                            </div>
                            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border text-xs text-primary">
                              ↗
                            </span>
                          </div>
                        </button>
                      );
                    })()}

                    {msg.location && <LocationCard lat={msg.location.lat} lng={msg.location.lng} />}
                    {msg.contactCard && (
                      <button type="button" className="mt-1 block text-left" onClick={() => eng.note(msg.contactCard?.tag || "")}>
                        <span className="font-semibold">{msg.contactCard.name}</span>
                        <span className="block font-mono text-xs text-muted">{msg.contactCard.tag}</span>
                      </button>
                    )}
                  </>
                )}
                <div className="mt-1 flex items-center justify-end gap-1 text-xs text-muted">
                  {msg.editedAt && <span>edited</span>}
                  <span className="tabular-nums">{formatWhen(msg.timestamp)}</span>
                  {snap.starred.includes(msg.id) && <Star className="size-3 text-primary" />}
                  {mine && !msg.system && <Tick status={msg.status} />}
                </div>
              </div>
            </div>
          );
        })}
        {typing && <p className="text-xs text-primary">{snap.typing?.name} typing…</p>}
      </div>
      {reply && (
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted">
          <span className="truncate">Reply · {previewText(reply)}</span>
          <button type="button" aria-label="Cancel reply" onClick={() => setReply(null)}><X className="size-4" /></button>
        </div>
      )}
      {editing && (
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-primary">
          <span>Editing message</span>
          <button type="button" onClick={() => { setEditing(null); setText(""); eng.setTyping(key, false); }}>Cancel</button>
        </div>
      )}
      {blocked && <p className="px-3 py-2 text-xs text-danger">Ye peer blocked hai. Unblock profile se karo.</p>}

      {audioUrl && (
        <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2">
          <audio src={audioUrl} controls className="h-9 flex-1" />
          <button
            type="button"
            className="grid size-9 place-items-center rounded-full bg-danger text-fg"
            onClick={discardVoice}
            aria-label="Discard voice note"
          >
            <Trash2 className="size-4" />
          </button>
          <button
            type="button"
            className="grid size-9 place-items-center rounded-full bg-primary text-primary-fg"
            onClick={sendVoicePreview}
            aria-label="Send voice note"
          >
            <Send className="size-4" />
          </button>
        </div>
      )}

      <div className="relative flex items-end gap-1 border-t border-border p-2">
        {attach && (
          <div className="absolute bottom-16 left-2 grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface p-2.5 shadow-2xl z-20">
            <AttachBtn
              label="Media"
              onClick={() => {
                if (fileRef.current) {
                  fileRef.current.accept = "image/*,video/*,audio/*";
                  fileRef.current.click();
                }
                setAttach(false);
              }}
            >
              <ImageIcon className="size-4 text-emerald-400" />
            </AttachBtn>
            <AttachBtn
              label="Document"
              onClick={() => {
                if (fileRef.current) {
                  fileRef.current.accept = "*/*";
                  fileRef.current.click();
                }
                setAttach(false);
              }}
            >
              <FileText className="size-4 text-sky-400" />
            </AttachBtn>
            <AttachBtn
              label="Location"
              onClick={() => {
                setAttach(false);
                if (!navigator.geolocation) return eng.note("Location support nahi hai.");
                navigator.geolocation.getCurrentPosition(
                  (pos) => eng.sendLocation(key, pos.coords.latitude, pos.coords.longitude),
                  () => eng.note("Location permission nahi mili."),
                  { timeout: 8000 }
                );
              }}
            >
              <MapPin className="size-4 text-amber-400" />
            </AttachBtn>
            <AttachBtn
              label="Contact"
              onClick={() => {
                setAttach(false);
                setShowContactPicker(true);
              }}
            >
              <UserRound className="size-4 text-purple-400" />
            </AttachBtn>
          </div>
        )}

        {/* 2-Option WhatsApp-Style Contact Chooser Modal */}
        {showContactPicker && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
            onClick={() => setShowContactPicker(false)}
          >
            <div
              className="w-full max-w-xs space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-border pb-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-primary">Share Contact</h4>
                <button type="button" onClick={() => setShowContactPicker(false)} className="text-muted hover:text-fg">
                  <X className="size-4" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  className="flex flex-col items-center justify-center p-3 rounded-xl border border-primary/40 bg-primary/10 text-xs font-semibold text-primary hover:bg-primary/20 active:scale-95 transition-all text-center gap-1.5"
                  onClick={async () => {
                    if (typeof navigator !== "undefined" && "contacts" in navigator && "ContactsManager" in window) {
                      try {
                        const picked = await (navigator as any).contacts.select(["name", "tel"], { multiple: false });
                        if (picked && picked[0]) {
                          const cName = Array.isArray(picked[0].name) ? picked[0].name[0] : picked[0].name || "Contact";
                          const cTel = Array.isArray(picked[0].tel) ? picked[0].tel[0] : picked[0].tel || "";
                          eng.sendContactCard(key, { name: String(cName), tag: String(cTel) });
                          setShowContactPicker(false);
                          eng.note(`${cName} share ho gaya.`);
                          return;
                        }
                      } catch {}
                    }
                    const manualName = window.prompt("Contact Name enter karein:");
                    if (!manualName) return;
                    const manualNum = window.prompt("Mobile Number enter karein:");
                    if (manualNum) {
                      eng.sendContactCard(key, { name: manualName, tag: manualNum });
                      setShowContactPicker(false);
                      eng.note(`${manualName} share ho gaya.`);
                    }
                  }}
                >
                  <span className="text-lg">📱</span>
                  <span>Phone Book / Mobile</span>
                </button>

                <div className="flex flex-col items-center justify-center p-3 rounded-xl border border-border bg-bg text-xs font-semibold text-fg text-center gap-1.5">
                  <span className="text-lg">🌐</span>
                  <span>Mesh Contacts</span>
                </div>
              </div>

              <div className="max-h-48 space-y-1 overflow-y-auto pt-2 border-t border-border">
                <span className="text-[10px] text-muted font-semibold block px-1">CHOOSE SAVED MESH PEER</span>
                {snap.contacts.length === 0 ? (
                  <p className="text-xs text-muted text-center py-3">Koi saved mesh contact nahi hai.</p>
                ) : (
                  snap.contacts.map((c) => (
                    <button
                      key={c.tag}
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg p-2 text-left hover:bg-elevated text-xs transition-colors"
                      onClick={() => {
                        eng.sendContactCard(key, c);
                        setShowContactPicker(false);
                        eng.note(`${c.name} ka card bhej diya.`);
                      }}
                    >
                      <span className="font-semibold text-fg truncate">{c.name}</span>
                      <span className="font-mono text-[10px] text-muted truncate max-w-[120px]">{c.tag}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void eng.sendFile(key, file);
          }}
        />
        <IconBtn label="Attach" onClick={() => setAttach((v) => !v)}>
          <Plus className="size-5" />
        </IconBtn>

        {recording ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger animate-pulse">
            <span className="size-2 rounded-full bg-danger animate-ping" />
            <span>Recording audio...</span>
            <span className="ml-auto font-mono tabular-nums">
              {Math.floor(recordSecs / 60)}:{String(recordSecs % 60).padStart(2, "0")}
            </span>
          </div>
        ) : (
          <label className="min-w-0 flex-1">
            <span className="sr-only">Message</span>
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                eng.setTyping(key, e.target.value.length > 0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Message likho"
              className="w-full rounded-full border border-border bg-bg px-4 py-3 text-sm outline-none"
            />
          </label>
        )}

        {text.trim() ? (
          <button type="button" className="grid size-11 place-items-center rounded-full bg-primary text-primary-fg" aria-label="Send" onClick={send}>
            <Send className="size-5" />
          </button>
        ) : (
          <button
            type="button"
            className={`grid size-11 place-items-center rounded-full ${recording ? "bg-danger text-fg" : "bg-elevated"}`}
            aria-label="Voice note"
            onClick={() => void toggleMic()}
          >
            <Mic className="size-5" />
          </button>
        )}
      </div>

      <div className="flex gap-2 px-3 pb-3 text-xs text-muted">
        <button type="button" onClick={() => { if (window.confirm("Is chat ka history delete karein?")) eng.clearThread(key); }}>Clear chat</button>
        {!isGroupId(key) && <button type="button" onClick={() => eng.toggleBlock(key)}>{blocked ? "Unblock" : "Block"}</button>}
        {group && <button type="button" onClick={() => eng.leaveGroup(group.id)}>Leave group</button>}
        {!isGroupId(key) && !snap.contacts.some((c) => sameUid(c.tag, key)) && (
          <button type="button" onClick={() => eng.saveContact(nameOf(snap, key), key)}>Save contact</button>
        )}
      </div>

      {/* WhatsApp-Style Smart Delete Modal (Delete for Me vs Delete for Everyone) */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => setShowDeleteModal(false)}
        >
          <div
            className="w-full max-w-xs space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-sm font-semibold text-fg">
              Delete {selectedIds.length > 1 ? `${selectedIds.length} messages` : "message"}?
            </h4>
            <p className="text-xs text-muted">
              {allSelectedMine
                ? "Aap in messages ko sirf apne device se ya sabhi ke liye delete kar sakte hain."
                : "Chune gaye messages mein doosre user ke messages shamil hain, isliye sirf aapke liye delete hoga."}
            </p>
            <div className="flex flex-col gap-2 pt-2">
              {allSelectedMine && (
                <button
                  type="button"
                  className="w-full rounded-xl bg-danger/15 border border-danger/40 py-2.5 text-xs font-semibold text-danger hover:bg-danger/25"
                  onClick={() => {
                    (eng as any).deleteMessagesBulk(key, selectedIds, "everyone");
                    setShowDeleteModal(false);
                    setSelectedIds([]);
                  }}
                >
                  Delete for everyone
                </button>
              )}
              <button
                type="button"
                className="w-full rounded-xl bg-elevated py-2.5 text-xs font-semibold text-fg hover:bg-elevated/80"
                onClick={() => {
                  (eng as any).deleteMessagesBulk(key, selectedIds, "me");
                  setShowDeleteModal(false);
                  setSelectedIds([]);
                }}
              >
                Delete for me
              </button>
              <button
                type="button"
                className="w-full py-1.5 text-xs text-muted hover:text-fg"
                onClick={() => setShowDeleteModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* WhatsApp-Style Forward Picker Modal */}
      {showForwardModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => setShowForwardModal(false)}
        >
          <div
            className="w-full max-w-xs space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-primary">
                Forward {selectedIds.length} message(s) to...
              </h4>
              <button type="button" onClick={() => setShowForwardModal(false)} className="text-muted hover:text-fg">
                <X className="size-4" />
              </button>
            </div>

            <div className="max-h-60 space-y-1 overflow-y-auto">
              {[...new Set([
                ...snap.contacts.map((c) => c.tag),
                ...snap.peers.map((p) => p.globalId),
                ...snap.groups.map((g) => g.id),
                ...Object.keys(snap.chats),
              ])]
                .filter((t) => !sameUid(t, snap.me.globalId))
                .map((target) => {
                  const checked = forwardTargets.includes(target);
                  return (
                    <label
                      key={target}
                      className="flex cursor-pointer items-center justify-between rounded-lg p-2 text-xs hover:bg-elevated"
                    >
                      <span className="truncate font-semibold text-fg">{nameOf(snap, target)}</span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setForwardTargets((prev) =>
                            e.target.checked ? [...prev, target] : prev.filter((x) => x !== target)
                          );
                        }}
                      />
                    </label>
                  );
                })}
            </div>

            <button
              type="button"
              disabled={forwardTargets.length === 0}
              className="min-h-10 w-full rounded-xl bg-primary text-xs font-semibold text-primary-fg disabled:opacity-40"
              onClick={() => {
                (eng as any).forwardMessages(forwardTargets, selectedMsgs);
                setShowForwardModal(false);
                setSelectedIds([]);
              }}
            >
              Forward ({forwardTargets.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Tick({ status }: { status: Msg["status"] }) {
  if (status === "queued") return <Clock className="size-3.5" aria-label="Queued" />;
  if (status === "sent") return <Check className="size-3.5" aria-label="Sent" />;
  return <CheckCheck className={`size-3.5 ${status === "read" ? "text-primary" : ""}`} aria-label={status} />;
}

function FeedList({
  snap,
  eng,
  onOpen,
  onChat,
}: {
  snap: Snap;
  eng: MeshEngine;
  onOpen: (id: string) => void;
  onChat: (tag: string) => void;
}) {
  const [filter, setFilter] = useState<Category>("all");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [groupId, setGroupId] = useState(snap.groups[0]?.id || "");
  const [menu, setMenu] = useState<string | null>(null);
  const posts = visiblePosts(snap, filter);

  return (
    <div>
      <div className="flex border-b border-border">
        {(["all", "friends", "groups"] as Category[]).map((item) => (
          <button
            key={item}
            type="button"
            className={`min-h-11 flex-1 text-sm ${filter === item ? "text-primary" : "text-muted"}`}
            onClick={() => setFilter(item)}
          >
            {item === "all" ? "Public" : item === "friends" ? "Friends" : "Groups"}
          </button>
        ))}
      </div>
      <form
        className="space-y-2 border-b border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() && !file) return;
          void eng.publishPost({ text, category: filter === "all" ? "all" : filter, groupId, file }).then((err) => {
            if (err) eng.note(err);
            else {
              setText("");
              setFile(null);
            }
          });
        }}
      >
        <label className="block">
          <span className="sr-only">Post</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Mesh par kya chal raha hai?"
            className="h-20 w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none"
          />
        </label>
        <div className="flex items-center gap-2">
          <label className="grid size-11 cursor-pointer place-items-center rounded-lg border border-border" aria-label="Attach photo">
            <ImageIcon className="size-5" />
            <input
              type="file"
              accept="image/*,video/*,audio/*"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("gvnd-open-live", { detail: { level: snap.me.verification?.level || 0 } }))}
            className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold ${(snap.me.verification?.level || 0) >= 2 ? "border-danger/60 bg-danger/15 text-danger" : "border-border bg-bg text-muted opacity-60"}`}
            title="Live Stream (Level 2 Verified Only · 360p · 100MB Auto-Post)"
          >
            <span className="size-2 rounded-full bg-danger animate-pulse" />
            Live
          </button>
          {filter === "groups" && (
            <select
              aria-label="Group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="min-h-11 flex-1 rounded-lg border border-border bg-bg px-2 text-sm"
            >
              {snap.groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{file ? file.name : "Photo / Video / Audio"}</span>
          <button type="submit" className="min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-fg">Post</button>
        </div>
      </form>
      {posts.length === 0 && <Empty icon={Newspaper} title="Is feed mein kuch nahi" body="Public posts sabko dikhte hain. Friends posts sirf contacts ko." />}
      <ul>
        {posts.map((post) => (
          <li key={post.id} className="relative border-b border-border px-4 py-3">
            <div className="flex items-start gap-3">
              <button type="button" aria-label={`Chat ${post.author}`} onClick={() => onChat(post.globalId)}>
                <Avatar name={post.author} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <button type="button" className="min-w-0 text-left" onClick={() => onOpen(post.id)}>
                    <div className="truncate font-semibold">{post.author}</div>
                    <div className="truncate font-mono text-xs text-muted">{post.globalId}</div>
                  </button>
                  <button type="button" aria-label="Post options" onClick={() => setMenu(menu === post.id ? null : post.id)}>
                    <MoreVertical className="size-5 text-muted" />
                  </button>
                </div>
                {menu === post.id && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Mini onClick={() => { eng.hidePost(post.id); setMenu(null); }}>Hide</Mini>
                    <Mini onClick={() => { eng.reportPost(post.id); setMenu(null); }}>Report</Mini>
                    {sameUid(post.globalId, snap.me.globalId) && (
                      <Mini onClick={() => { eng.deletePost(post.id); setMenu(null); }}>Delete</Mini>
                    )}
                    <Mini onClick={() => { void navigator.clipboard.writeText(post.globalId); eng.note("Tag copy ho gaya."); setMenu(null); }}>Copy tag</Mini>
                  </div>
                )}
                <button type="button" className="mt-2 block w-full text-left" onClick={() => onOpen(post.id)}>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{post.content}</p>
                  {post.mediaKey && safeMediaSrc(snap.urls[post.mediaKey]) && (() => {
                  const mUrl = safeMediaSrc(snap.urls[post.mediaKey]) || "";
                  const mType = (post as any).mediaType || "";
                  if (mType.startsWith("video/") || mUrl.includes("video")) {
                    return (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          window.dispatchEvent(new CustomEvent("gvnd-open-reel", { detail: { postId: post.id } }));
                        }}
                        className="relative mt-2 overflow-hidden rounded-xl border border-border bg-black"
                      >
                        <video src={mUrl} preload="metadata" muted playsInline className="max-h-72 w-full object-cover" />
                        <span className="absolute bottom-2 right-2 rounded-full bg-black/75 px-2.5 py-1 text-[11px] font-semibold text-white">
                          ▶ Reel Mode
                        </span>
                      </div>
                    );
                  }
                  if (mType.startsWith("audio/") || mUrl.includes("audio")) {
                    return <audio src={mUrl} controls preload="metadata" className="mt-2 w-full" />;
                  }
                  return <img src={mUrl} alt="" className="mt-2 max-h-64 w-full rounded-lg object-cover" />;
                })()}
                </button>
                <div className="mt-2 flex items-center gap-4 text-sm text-muted">
                  <button type="button" className={`inline-flex items-center gap-1 ${post.likes.some((id) => sameUid(id, snap.me.globalId)) ? "text-danger" : ""}`} onClick={() => eng.toggleLike(post.id)}>
                    <Star className="size-4" /> <span className="tabular-nums">{post.likes.length}</span>
                  </button>
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => eng.toggleRepost(post.id)}>
                    <Repeat2 className="size-4" /> <span className="tabular-nums">{post.reposts.length}</span>
                  </button>
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => onOpen(post.id)}>
                    <MessageCircle className="size-4" /> <span className="tabular-nums">{post.replies.length}</span>
                  </button>
                  <span className="ml-auto text-xs tabular-nums">{formatWhen(post.timestamp)}</span>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function visiblePosts(snap: Snap, filter: Category): Post[] {
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

function PostDeck({
  snap,
  eng,
  postId,
  onClose,
  onPreview,
}: {
  snap: Snap;
  eng: MeshEngine;
  postId: string;
  onClose: () => void;
  onPreview: (item: { url: string; mime: string; name: string }) => void;
}) {
  const post = snap.posts.find((p) => p.id === postId);
  const [text, setText] = useState("");

  if (!post) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-muted">
        <div>
          <p className="text-sm">Ye post available nahi hai ya delete ho chuka hai.</p>
          <button type="button" className="mt-3 rounded-lg bg-elevated px-4 py-2 text-xs text-fg" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const url = post.mediaKey ? safeMediaSrc(snap.urls[post.mediaKey]) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-3">
        <button type="button" aria-label="Close post" onClick={onClose}><X className="size-5" /></button>
        <div className="min-w-0">
          <div className="truncate font-semibold">{post.author}</div>
          <div className="truncate font-mono text-xs text-muted">{post.globalId}</div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {url && (
          <button type="button" className="block w-full bg-bg" onClick={() => onPreview({ url, mime: post.mediaMime || "image/jpeg", name: post.mediaName || "photo" })}>
            <img src={url} alt="" className="max-h-96 w-full object-contain" />
          </button>
        )}
        <p className="px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">{post.content}</p>
        <ul className="space-y-2 px-4 pb-4">
          {post.replies.map((reply) => (
            <li key={reply.id} className="rounded-lg bg-elevated px-3 py-2 text-sm">
              <div className="font-semibold text-primary">{reply.author}</div>
              <p>{reply.text}</p>
              <div className="mt-1 flex gap-3 text-xs text-muted">
                <button type="button" onClick={() => eng.reactComment(post.id, reply.id, "like")}>Like {reply.likedBy.length}</button>
                <button type="button" onClick={() => eng.reactComment(post.id, reply.id, "dislike")}>Dislike {reply.dislikedBy.length}</button>
              </div>
            </li>
          ))}
          {post.replies.length === 0 && <li className="text-sm text-muted">Koi comment nahi.</li>}
        </ul>
      </div>
      <form
        className="flex gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          eng.addComment(post.id, text.trim());
          setText("");
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment" className="min-w-0 flex-1 rounded-full border border-border bg-bg px-4 py-3 text-sm outline-none" />
        <button type="submit" className="min-h-11 rounded-full bg-primary px-4 text-sm font-semibold text-primary-fg">Post</button>
      </form>
    </div>
  );
}

function Comments({ snap, eng, postId, onClose }: { snap: Snap; eng: MeshEngine; postId: string; onClose: () => void }) {
  const post = snap.posts.find((p) => p.id === postId);
  const [text, setText] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  if (!post) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-bg/70" onClick={onClose}>
      <div className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-t-lg bg-surface" role="dialog" aria-modal="true" aria-label="Comments" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold">Comments · {post.replies.length}</h2>
          <button type="button" aria-label="Close comments" onClick={onClose}><X className="size-5" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {post.replies.length === 0 && <p className="py-6 text-center text-sm text-muted">Pehla comment likho.</p>}
          {post.replies.map((reply) => (
            <article key={reply.id} className="rounded-lg bg-elevated px-3 py-2 text-sm">
              <div className="flex justify-between gap-2">
                <b className="text-primary">{reply.author}</b>
                <span className="text-xs text-muted tabular-nums">{formatWhen(reply.time)}</span>
              </div>
              <p className="mt-1">{reply.text}</p>
              <div className="mt-2 flex gap-3 text-xs text-muted">
                <button type="button" onClick={() => eng.reactComment(post.id, reply.id, "like")}>Like {reply.likedBy.length}</button>
                <button type="button" onClick={() => eng.reactComment(post.id, reply.id, "dislike")}>Dislike {reply.dislikedBy.length}</button>
                <button type="button" onClick={() => setParent(reply.id)}>Reply</button>
              </div>
              {reply.subReplies.length > 0 && (
                <ul className="mt-2 space-y-1 border-l border-primary pl-2">
                  {reply.subReplies.map((sub) => (
                    <li key={sub.id} className="text-xs">
                      <b className="text-primary">{sub.author}: </b>{sub.text}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
        <form
          className="flex gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            eng.addComment(post.id, text.trim(), parent);
            setText("");
            setParent(null);
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={parent ? "Reply" : "Comment likho"}
            className="min-w-0 flex-1 rounded-full border border-border bg-bg px-4 py-3 text-sm outline-none"
          />
          <button type="submit" className="min-h-11 rounded-full bg-primary px-4 text-sm font-semibold text-primary-fg">Send</button>
        </form>
      </div>
    </div>
  );
}

function CallsPane({ snap, eng, onOpen }: { snap: Snap; eng: MeshEngine; onOpen: (tag: string) => void }) {
  const [tag, setTag] = useState("");
  const [pin, setPin] = useState("");
  return (
    <div className="space-y-3 p-3">
      <form
        className="space-y-2 rounded-lg border border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void eng.startCall(tag.trim(), "voice", { pin, dialer: true }).then((err) => err && eng.note(err));
        }}
      >
        <p className="text-sm text-muted">Direct dial ke liye peer ka PIN enter karein. Saved contacts ko PIN ki jarurat nahi hai.</p>
        <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="@handle@hub#id" aria-label="Global tag" className="w-full rounded-lg border border-border bg-bg px-3 py-3 text-sm outline-none" />
        <input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="4 digit PIN" aria-label="Calling PIN" inputMode="numeric" className="w-full rounded-lg border border-border bg-bg px-3 py-3 text-sm outline-none" />
        <div className="flex gap-2">
          <button type="submit" className="min-h-11 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-fg">Voice</button>
          <button
            type="button"
            className="min-h-11 flex-1 rounded-lg border border-border text-sm font-semibold"
            onClick={() => void eng.startCall(tag.trim(), "video", { pin, dialer: true }).then((err) => err && eng.note(err))}
          >
            Video
          </button>
        </div>
      </form>
      {snap.callLogs.length === 0 ? (
        <Empty icon={Phone} title="Koi call nahi" body="Dial karo ya kisi chat se call lagao." />
      ) : (
        <ul>
          {snap.callLogs.map((log) => (
            <li key={log.id}>
              <button type="button" className="flex w-full items-center gap-3 px-2 py-3 text-left" onClick={() => onOpen(log.tag)}>
                <Avatar name={log.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{log.name}</span>
                  <span className="text-sm text-muted">
                    {log.direction === "in" ? "Incoming" : "Outgoing"} · {log.mode} · {log.result}
                    {log.duration ? ` · ${formatDuration(log.duration)}` : ""}
                  </span>
                </span>
                <span className="text-xs text-muted tabular-nums">{formatWhen(log.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContactsPane({
  snap,
  eng,
  onOpen,
}: {
  snap: Snap;
  eng: MeshEngine;
  onOpen: (tag: string) => void;
}) {
  const [tabMode, setTabMode] = useState<"phone" | "handle">("phone");
  const [phoneName, setPhoneName] = useState("");
  const [phone, setPhone] = useState("");
  const [countryCode, setCountryCode] = useState("+91");
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [searchResult, setSearchResult] = useState<{
    found: boolean;
    tag: string;
    name: string;
    phone: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cleanDigits = phone.replace(/\D/g, "").slice(-10);

  // 1. Mobile Number Verification & Chat Flow
  const handlePhoneSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (cleanDigits.length < 10) {
      eng.note("Kripya 10-digit mobile number dalein.");
      return;
    }

    try {
      const fullPhone = `${countryCode}${cleanDigits}`;
      // Check live mesh & persistent offline directory
      const matchedNode = eng.findPeerByPhone(fullPhone);

      // STRICT RULE: Peer tabhi discover hoga jab wo VERIFIED ho aur LEVEL >= 1 ho (Pending discover nahi hoga)
      const isEligiblePeer = Boolean(
        matchedNode &&
        matchedNode.verification?.verified === true &&
        matchedNode.verification?.level !== undefined &&
        matchedNode.verification.level >= 1
      );

      if (isEligiblePeer && matchedNode) {
        // CASE 1: NODE DISCOVERED & VERIFIED -> No SMS allowed, strictly Mesh Chat
        const displayName = phoneName.trim() || matchedNode.name || `User ${cleanDigits.slice(-4)}`;
        eng.saveContact(displayName, matchedNode.globalId);
        setSearchResult({
          found: true,
          tag: matchedNode.globalId,
          name: displayName,
          phone: fullPhone,
          isOnline: Boolean(matchedNode.isOnline),
        } as any);
        eng.note(
          matchedNode.isOnline
            ? `${displayName} mesh par online hain!`
            : `${displayName} mesh node hain (Offline mode: message queue ho jayega).`
        );
      } else {
        // CASE 2: DISCOVERY FAILED -> Allow SMS Invite only
        setSearchResult({
          found: false,
          tag: "",
          name: phoneName.trim() || `User ${cleanDigits.slice(-4)}`,
          phone: fullPhone,
          isOnline: false,
        } as any);
        eng.note("Ye number GVND Connect par discover nahi hua. SMS Invite bhej sakte hain.");
      }
    } catch (err: any) {
      eng.note("Search error: " + (err?.message || "Failed"));
    }
  };

  // 2. Direct Tag/Handle Save Flow
  const handleTagSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTag = tag.trim();
    const cleanName = name.trim() || cleanTag;

    if (!cleanTag) {
      eng.note("Tag dalein (@handle@hub#id)");
      return;
    }

    const formattedTag = cleanTag.startsWith("@") ? cleanTag : `@${cleanTag}`;
    const err = eng.saveContact(cleanName, formattedTag);
    if (err) {
      eng.note(err);
      return;
    }
    eng.note(`${cleanName} jud gaye!`);
    setName("");
    setTag("");
    onOpen(formattedTag);
  };

  // 3. SMS Invite Intent (Real Origin Link)
  const handleSendInviteSMS = () => {
    const fullPhone = `${countryCode}${cleanDigits}`;
    const targetName = phoneName.trim() || "Dost";
    const currentOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8081";

    const bodyText = `Namaste ${targetName}! Mujhe GVND Connect par join karein.\n\nMera Global Node: ${snap.me.globalId}\nWeb App Link: ${currentOrigin}/?hub=${snap.me.hub}&peer=${snap.me.discriminator}`;
    window.location.href = `sms:${fullPhone}?body=${encodeURIComponent(bodyText)}`;
  };

  // Native Contact Picker (No File-Picker Fallback Loop)
  const handleNativeContactPicker = async () => {
    if (typeof window !== "undefined" && window.AndroidBridge && window.AndroidBridge.getContacts) {
      try {
        window.AndroidBridge.requestPermissionsNow?.();
        const raw = window.AndroidBridge.getContacts();
        const list = JSON.parse(raw || "[]");
        if (Array.isArray(list) && list.length > 0) {
          let added = 0;
          for (const item of list.slice(0, 50)) {
            if (item.tel) {
              eng.addContactByPhone(item.name || item.tel, item.tel);
              added++;
            }
          }
          eng.note(`${added} phone contacts sync ho gaye!`);
          return;
        } else {
          eng.note("Contacts permission allow karein — App Settings khul rahi hai.");
          window.AndroidBridge.openAppSettings?.();
          return;
        }
      } catch (e) {}
    }
    if (typeof navigator !== "undefined" && "contacts" in navigator && "ContactsManager" in window) {
      try {
        const picked = await (navigator as any).contacts.select(["name", "tel"], { multiple: false });
        if (picked && picked.length > 0) {
          const selected = picked[0];
          const rawName = Array.isArray(selected.name) ? selected.name[0] : selected.name || "";
          const rawList = Array.isArray(selected.tel) ? selected.tel[0] : selected.tel || "";
          const cleanTel = String(rawList).replace(/\D/g, "").slice(-10);

          setTabMode("phone");
          if (rawName) setPhoneName(String(rawName));
          if (cleanTel) setPhone(cleanTel);
          setSearchResult(null);
          eng.note(`${rawName || "Contact"} select ho gaya!`);
          return;
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        console.warn("Native Contact API failed:", err);
      }
    }

    setTabMode("phone");
    const nameInput = document.querySelector('input[placeholder*="Contact Name"]') as HTMLInputElement;
    if (nameInput) nameInput.focus();
    eng.note("Device contact access restricted hai. Yahan naam aur 10-digit number dalein.");
  };

  // VCF Import
  const handleVcfImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const lines = text.split(/\r\n|\r|\n/);
      let count = 0;
      let currentName = "";
      let currentPhone = "";

      for (const line of lines) {
        if (line.startsWith("FN:")) {
          currentName = line.substring(3).trim();
        } else if (line.startsWith("TEL") && line.includes(":")) {
          currentPhone = line.substring(line.indexOf(":") + 1).replace(/\D/g, "").slice(-10);
        } else if (line.startsWith("END:VCARD")) {
          if (currentPhone.length === 10) {
            eng.addContactByPhone(currentName || `User ${currentPhone.slice(-4)}`, `+91${currentPhone}`);
            count++;
          }
          currentName = "";
          currentPhone = "";
        }
      }

      eng.note(`${count} contacts VCF se import ho gaye!`);
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-4 p-3">
      <input
        ref={fileInputRef}
        type="file"
        accept=".vcf,text/vcard"
        className="hidden"
        onChange={handleVcfImport}
      />

      <div className="space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
            New Contact / Chat
          </h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleNativeContactPicker}
              className="flex items-center gap-1 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 active:scale-95 transition-all"
            >
              📖 Phonebook
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 rounded-lg border border-border bg-bg px-2.5 py-1 text-xs font-medium text-muted hover:text-fg hover:border-primary active:scale-95 transition-all"
            >
              📂 Import VCF
            </button>
          </div>
        </div>

        <div className="flex rounded-xl border border-border bg-bg p-1 text-xs">
          <button
            type="button"
            className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
              tabMode === "phone" ? "bg-primary text-primary-fg shadow" : "text-muted hover:text-fg"
            }`}
            onClick={() => {
              setTabMode("phone");
              setSearchResult(null);
            }}
          >
            By Mobile Number
          </button>
          <button
            type="button"
            className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
              tabMode === "handle" ? "bg-primary text-primary-fg shadow" : "text-muted hover:text-fg"
            }`}
            onClick={() => {
              setTabMode("handle");
              setSearchResult(null);
            }}
          >
            By Handle / Tag
          </button>
        </div>

        {tabMode === "phone" ? (
          <form onSubmit={handlePhoneSubmit} className="space-y-2.5 pt-1">
            <input
              value={phoneName}
              onChange={(e) => setPhoneName(e.target.value)}
              placeholder="Contact Name (e.g. Setu)"
              className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary"
            />
            <div className="flex gap-2">
              <select
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className="rounded-xl border border-border bg-bg px-2 py-2 text-xs font-medium text-fg outline-none"
              >
                <option value="+91">🇮🇳 +91</option>
                <option value="+1">🇺🇸 +1</option>
                <option value="+44">🇬🇧 +44</option>
              </select>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit Phone Number"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/\D/g, ""));
                  setSearchResult(null);
                }}
                className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 py-2 font-mono text-sm text-fg outline-none focus:border-primary"
              />
            </div>

            {/* Case A: Node Discover Ho Gaya -> Strictly Mesh Chat Only (No SMS) */}
            {searchResult && searchResult.found && (
              <div className="space-y-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                    <span
                      className={`size-2 rounded-full ${
                        (searchResult as any).isOnline ? "bg-emerald-500 animate-pulse" : "bg-amber-400"
                      }`}
                    />
                    {(searchResult as any).isOnline ? "Verified Node (Online)" : "Verified Node (Mesh Node)"}
                  </div>
                  <span className="text-[11px] text-muted">
                    {(searchResult as any).isOnline ? "In Direct Range" : "Store & Forward Queue"}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-muted truncate">{searchResult.tag}</div>

                <button
                  type="button"
                  onClick={() => onOpen(searchResult.tag)}
                  className="min-h-10 w-full rounded-lg bg-emerald-600 text-xs font-semibold text-white shadow hover:bg-emerald-500 active:scale-95 transition-all"
                >
                  💬 {(searchResult as any).isOnline ? "Start Direct Chat" : "Open Chat & Queue Message"}
                </button>
              </div>
            )}

            {/* Case B: Node Discover NAHI Hua -> Strictly SMS Invite Only */}
            {searchResult && !searchResult.found && (
              <div className="space-y-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs">
                <p className="text-amber-300">
                  <b>{searchResult.name}</b> (+91 {cleanDigits}) GVND Connect par discover nahi hue.
                </p>
                <p className="text-[11px] text-muted leading-relaxed">
                  Unhe GVND Connect se jodne ke liye SMS invite bhejein.
                </p>
                <button
                  type="button"
                  onClick={handleSendInviteSMS}
                  className="min-h-10 w-full rounded-lg bg-sky-600 text-xs font-semibold text-white shadow hover:bg-sky-500 active:scale-95 transition-all"
                >
                  📩 Send SMS Invite
                </button>
              </div>
            )}

            {!searchResult && (
              <button
                type="submit"
                disabled={cleanDigits.length < 10}
                className="min-h-11 w-full rounded-xl bg-primary text-xs font-semibold text-primary-fg shadow transition-opacity disabled:opacity-40"
              >
                Check on GVND Connect
              </button>
            )}
          </form>
        ) : (
          <form onSubmit={handleTagSubmit} className="space-y-2.5 pt-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contact Name (e.g. Setu)"
              className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary"
            />
            <input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="@handle@hub#id (e.g. @setu@mrt#setu01)"
              className="w-full rounded-xl border border-border bg-bg px-3 py-2 font-mono text-sm text-fg outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={!tag.trim()}
              className="min-h-11 w-full rounded-xl bg-primary text-xs font-semibold text-primary-fg shadow transition-opacity disabled:opacity-40"
            >
              Add Contact & Start Chat
            </button>
          </form>
        )}
      </div>

      <div>
        <h4 className="mb-2 px-1 text-xs font-semibold text-muted">Saved Contacts ({snap.contacts.length})</h4>
        {snap.contacts.length === 0 ? (
          <Empty icon={Users} title="Koi contact nahi" body="Mobile number ya handle daal kar contact add karein." />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface overflow-hidden">
            {snap.contacts.map((c) => {
              const isLive = snap.peers.some((p) => sameUid(p.globalId, c.tag));
              return (
                <li key={c.tag} className="flex items-center gap-3 p-3 hover:bg-elevated/40">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => onOpen(c.tag)}
                  >
                    <Avatar name={c.name} online={isLive} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-fg">{c.name}</span>
                        {isLive && (
                          <span className="size-2 rounded-full bg-emerald-500" title="Online on Mesh" />
                        )}
                      </div>
                      <div className="truncate font-mono text-xs text-muted">{c.tag}</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${c.name}`}
                    className="grid size-9 place-items-center rounded-lg text-muted hover:text-danger hover:bg-bg"
                    onClick={() => eng.removeContact(c.tag)}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function SearchPane({ snap, onOpen, onPost }: { snap: Snap; onOpen: (tag: string) => void; onPost: (id: string) => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const peers = snap.peers.filter((p) => !query || p.name.toLowerCase().includes(query) || p.globalId.toLowerCase().includes(query));
  const contacts = snap.contacts.filter((c) => !query || c.name.toLowerCase().includes(query) || c.tag.toLowerCase().includes(query));
  const posts = query ? snap.posts.filter((p) => p.content.toLowerCase().includes(query) || p.author.toLowerCase().includes(query)) : [];
  const msgs = query
    ? Object.entries(snap.chats).flatMap(([tag, list]) =>
        list.filter((m) => (m.content || "").toLowerCase().includes(query)).map((m) => ({ tag, m })),
      )
    : [];
  return (
    <div>
      <div className="p-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Peers, contacts, posts" aria-label="Search" className="w-full rounded-lg border border-border bg-bg px-3 py-3 text-sm outline-none" />
      </div>
      {!query && <Empty icon={Search} title="Search" body="Naam, tag, ya post ka tukda likho." />}
      <ul>
        {peers.map((peer) => (
          <Hit key={peer.globalId} title={peer.name} meta={`${peer.via} · ${peer.globalId}`} onClick={() => onOpen(peer.globalId)} />
        ))}
        {contacts.map((c) => (
          <Hit key={c.tag} title={c.name} meta={`Contact · ${c.tag}`} onClick={() => onOpen(c.tag)} />
        ))}
        {posts.map((p) => (
          <Hit key={p.id} title={p.author} meta={p.content} onClick={() => onPost(p.id)} />
        ))}
        {msgs.map(({ tag, m }) => (
          <Hit key={m.id} title={nameOf(snap, tag)} meta={m.content} onClick={() => onOpen(tag)} />
        ))}
      </ul>
    </div>
  );
}

function ProfilePane({ snap, eng, onOpen }: { snap: Snap; eng: MeshEngine; onOpen: (tag: string) => void }) {
  const [name, setName] = useState(snap.me.name);
  const [handle, setHandle] = useState(snap.me.handle);
  const [hub, setHub] = useState(snap.me.hub);
  const [bio, setBio] = useState(snap.me.bio);
  const [key, setKey] = useState(snap.hubKey);
  const [showQrModal, setShowQrModal] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [showDevicesModal, setShowDevicesModal] = useState(false);
  const [selfPhoneInput, setSelfPhoneInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const mine = snap.posts.filter((p) => sameUid(p.globalId, snap.me.globalId) && !p.deleted).length;
  const starred = Object.values(snap.chats)
    .flat()
    .filter((m) => snap.starred.includes(m.id));

  // Level 1 (Self-SMS) ya Level 2 (2+ Peers Vouched) check
  const isLevel1Or2 =
    Boolean(snap.me.verification?.verified) &&
    (snap.me.verification?.level === 1 ||
      snap.me.verification?.level === 2 ||
      snap.me.verification?.type === "self_sms" ||
      snap.me.verification?.type === "peer_vouched");

  // Dynamic Identity Value: Verified hone par Real Mobile Number, warna Short Hash
  const verifiedPhoneStored =
    typeof window !== "undefined" ? localStorage.getItem("meshnet_verified_phone") : null;
  const pendingPhoneStored =
    typeof window !== "undefined" ? localStorage.getItem("meshnet_pending_phone") : null;

  const actualPhoneNumber =
    snap.me.verification?.phone || verifiedPhoneStored || pendingPhoneStored;

  const displayIdentityValue = isLevel1Or2
    ? actualPhoneNumber || "+91 (Tap to Enter Number)"
    : snap.me.verification?.phoneHash
    ? snap.me.verification.phoneHash.slice(0, 10)
    : "hw_mesh_node";

  return (
    <div className="space-y-3 p-3 pb-16">
      <div className="rounded-2xl bg-primary/15 p-4 relative overflow-hidden">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1 pr-2">
            <div className="text-xs text-primary">Your node</div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold text-balance">{snap.me.name}</h2>
              <VerificationBadge verified={snap.me.verification?.verified} type={snap.me.verification?.type} />
            </div>
            <p className="mt-1 break-all font-mono text-sm text-primary">
              {snap.me.globalId}
              {(snap.me as any).instanceId !== undefined && (
                <span className="ml-1 text-xs font-mono text-emerald-400 font-bold">
                  /{ (snap.me as any).instanceId }
                </span>
              )}
            </p>
            <p className="mt-2 text-sm text-muted">{snap.me.bio || "No bio"}</p>
          </div>

          {/* Right Red Circle Area: Profile Picture Selector */}
          <div className="relative shrink-0">
            <label className="relative grid size-16 cursor-pointer place-items-center rounded-full border-2 border-dashed border-primary/40 bg-surface shadow-md hover:border-primary transition-all overflow-hidden group">
              {(snap.me as any).avatarUrl ? (
                <img
                  src={(snap.me as any).avatarUrl}
                  alt="Profile"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-primary/70 group-hover:text-primary">
                  <ImageIcon className="size-6" />
                  <span className="text-[9px] font-medium mt-0.5">Photo</span>
                </div>
              )}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void (eng as any).setAvatarFile(file);
                }}
              />
            </label>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Stat n={mine} label="Posts" />
          <Stat n={snap.contacts.length} label="Contacts" />
          <Stat n={snap.outbox} label="Queued" />
        </div>
      </div>

      <section className="space-y-2 rounded-2xl border border-border p-3">
        <div className="text-xs text-muted">Calling PIN</div>
        <div className="font-mono text-2xl tracking-widest text-primary tabular-nums">{snap.me.secretPin}</div>
        <button type="button" className="min-h-11 w-full rounded-xl border border-border text-sm" onClick={() => eng.regenPin()}>
          Regenerate PIN
        </button>
      </section>

      {/* Node Trust Status Section */}
      <section className="space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted">Node Trust Status</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-sm font-semibold text-fg">
                {snap.me.verification?.verified
                  ? snap.me.verification.level === 2
                    ? "Peer Vouched Node (Level 2)"
                    : "SIM Verified Node (Level 1)"
                  : snap.me.verification?.phone
                  ? "Pending Peer Vouch"
                  : "Unverified Node"}
              </span>
              <VerificationBadge verified={snap.me.verification?.verified} type={snap.me.verification?.type} />
            </div>
          </div>
          {snap.me.verification?.verified ? (
            <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
              LEVEL {snap.me.verification.level} · {snap.me.verification.type?.toUpperCase()}
            </span>
          ) : snap.me.verification?.phone ? (
            <span className="rounded-full bg-amber-500/15 border border-amber-500/30 px-2.5 py-0.5 text-xs font-semibold text-amber-400">
              PENDING ({snap.me.verification.vouchedBy?.length || 0}/3 VOUCHED)
            </span>
          ) : null}
        </div>

        {!snap.me.verification?.verified ? (
          <div className="space-y-2.5 border-t border-border pt-3">
            <p className="text-xs leading-relaxed text-muted">
              Unverified accounts par restrictions hain. Self-SMS se apna real mobile number bind karein.
            </p>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-semibold text-primary-fg hover:opacity-95 active:scale-95 transition-all shadow-sm"
                onClick={() => setShowVerifyModal(true)}
              >
                <ShieldCheck className="size-4" /> Verify to Get Full Access
              </button>
              <button
                type="button"
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-3 text-xs font-semibold text-fg hover:border-primary active:scale-95 transition-all"
                onClick={() => setShowDevicesModal(true)}
              >
                💻 Linked Devices
              </button>
            </div>
          </div>
        ) : (
          <div className="border-t border-border pt-3 flex items-center justify-between text-xs">
            <div className="flex flex-col">
              <span className="text-muted text-[11px]">
                {isLevel1Or2 ? "Verified Mobile Number" : "Hardware Identity Token"}
              </span>
              <button
                type="button"
                className="font-mono text-xs font-bold text-emerald-400 mt-0.5 text-left hover:underline"
                onClick={() => {
                  if (!actualPhoneNumber) {
                    const num = window.prompt("Apna verified 10-digit mobile number enter karein:");
                    if (num && num.replace(/\D/g, "").length >= 10) {
                      const cleanNum = `+91${num.replace(/\D/g, "").slice(-10)}`;
                      localStorage.setItem("meshnet_verified_phone", cleanNum);
                      eng.setVerification({
                        ...(snap.me.verification || { verified: true, type: "self_sms", level: 1 }),
                        phone: cleanNum,
                        verified: true,
                      });
                      eng.note("Mobile number profile me jud gaya!");
                    }
                  }
                }}
              >
                {displayIdentityValue}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg hover:border-primary active:scale-95 transition-all flex items-center gap-1.5"
                onClick={() => setShowDevicesModal(true)}
              >
                💻 Linked Devices
              </button>
            </div>
          </div>
        )}
      </section>

      <form
        className="space-y-2 rounded-2xl border border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const err = eng.saveProfile({ name, handle, hub, bio });
          if (err) eng.note(err);
        }}
      >
        <Field label="Name" value={name} onChange={setName} />
        <Field label="Username" value={handle} onChange={setHandle} />
        <Field label="Hub" value={hub} onChange={setHub} />
        <label className="block text-xs text-muted">
          Bio
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="mt-1 h-16 w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary"
          />
        </label>
        <button type="submit" className="min-h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-fg shadow">
          Save profile
        </button>
      </form>

      <form
        className="space-y-2 rounded-2xl border border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const err = eng.setPassphrase(key);
          if (err) eng.note(err);
        }}
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Lock className="size-4 text-primary" /> Hub key
        </div>
        <p className="text-xs text-muted">
          DMs aur private feed AES-GCM se sealed hain. Doosre device par yahi key daalo.
        </p>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label="Hub key"
          className="w-full rounded-xl border border-border bg-bg px-3 py-3 font-mono text-sm outline-none focus:border-primary"
        />
        <button type="submit" className="min-h-11 w-full rounded-xl border border-border text-sm">
          Save hub key
        </button>
      </form>

      <div className="flex gap-2">
        <button
          type="button"
          className="min-h-11 flex-1 rounded-xl border border-border text-sm font-semibold hover:border-primary active:scale-95 transition-all"
          onClick={async () => {
            const pwd = window.prompt("Backup encrypt karne ke liye Security PIN ya Password banayein:");
            if (pwd === null) return;
            const data = await (eng as any).exportEncryptedBackup(pwd);
            const blob = new Blob([data], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `gvnd-connect-${snap.me.handle}-backup.meshvault`;
            a.click();
            URL.revokeObjectURL(url);
            eng.note("Encrypted backup download ho gaya!");
          }}
        >
          🔒 Encrypted Backup
        </button>
        <button
          type="button"
          className="min-h-11 flex-1 rounded-xl border border-border text-sm font-semibold hover:border-primary active:scale-95 transition-all"
          onClick={() => fileRef.current?.click()}
        >
          📥 Restore
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.meshvault,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void file.text().then(async (raw) => {
              const pwd = window.prompt("Backup ka Encryption PIN / Password enter karein:");
              if (pwd === null) return;
              const err = await (eng as any).importEncryptedBackup(raw, pwd);
              if (err) eng.note(err);
              else {
                eng.note("Node restored! Sub-instance ready.");
                window.setTimeout(() => window.location.reload(), 1000);
              }
            });
          }}
        />
      </div>

      <button
        type="button"
        className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/10 text-sm font-semibold text-primary"
        onClick={() => setShowQrModal(true)}
      >
        <QrCode className="size-4" /> Link to Web / Scan QR
      </button>

      <section className="space-y-2 rounded-2xl border border-border bg-surface p-3">
        <h3 className="text-sm font-semibold text-fg">Blocked ({snap.blocked.length})</h3>
        {snap.blocked.length === 0 ? (
          <p className="text-xs text-muted">Koi blocked user nahi hai.</p>
        ) : (
          <ul className="divide-y divide-border">
            {snap.blocked.map((bTag) => {
              const contact = snap.contacts.find((c) => sameUid(c.tag, bTag));
              const peer = snap.peers.find((p) => sameUid(p.globalId, bTag));
              const displayName = contact?.name || peer?.name || nameOf(snap, bTag);

              return (
                <li key={bTag} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0 flex-1 pr-2">
                    <span className="block truncate text-xs font-semibold text-fg">
                      {displayName}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted">
                      {bTag}
                    </span>
                  </div>
                  <button
                    type="button"
                    title="Unblock User"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/20 active:scale-95 transition-all"
                    onClick={() => eng.toggleBlock(bTag)}
                  >
                    <Ban className="size-3.5" /> Unblock
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="px-1 py-2 text-sm font-semibold">Pinned keys</h3>
        <p className="px-1 text-xs text-muted">Pehli hello par key pin hoti hai. Change aaye to packets drop ho jaate hain.</p>
        {snap.pins.map((pin) => (
          <button
            key={pin.uid}
            type="button"
            className="flex w-full items-center justify-between py-2 text-left text-sm"
            onClick={() => eng.forgetPin(pin.uid)}
          >
            <span>
              {pin.label}
              <span className="block font-mono text-xs text-muted">{pin.uid}</span>
            </span>
            <span className="text-xs text-primary">Forget</span>
          </button>
        ))}
      </section>

      {/* 1. Pure Hybrid Self-SMS & Hardware Binding Modal (No Manual Code Input) */}
      {showVerifyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => {
            if (!otpInput) setShowVerifyModal(false);
          }}
        >
          <div
            className="w-full max-w-xs space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border pb-2">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="size-4 text-emerald-400" />
                <h3 className="font-semibold text-fg text-sm">SIM & Hardware Binding</h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowVerifyModal(false);
                  setOtpInput("");
                }}
                className="text-muted hover:text-fg"
              >
                <X className="size-5" />
              </button>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              Yeh app aapke phone ke native SMS loopback aur local cryptographic keys se SIM ownership bind karti hai bina kisi central server ke.
            </p>

            <div className="space-y-1.5">
              <label className="text-xs text-muted">Aapka Mobile Number</label>
              <div className="flex gap-2">
                <span className="grid place-items-center rounded-lg border border-border bg-bg px-2.5 text-xs font-medium text-fg">
                  🇮🇳 +91
                </span>
                <input
                  type="tel"
                  inputMode="numeric"
                  placeholder="10-digit number"
                  maxLength={10}
                  disabled={Boolean(otpInput)}
                  value={selfPhoneInput}
                  onChange={(e) => setSelfPhoneInput(e.target.value.replace(/\D/g, ""))}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-fg outline-none focus:border-primary disabled:opacity-60"
                />
              </div>
            </div>

            {/* State A: Loopback Shoot Button */}
            {!otpInput ? (
              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  disabled={selfPhoneInput.length < 10}
                  className="min-h-11 w-full rounded-xl bg-primary text-xs font-semibold text-primary-fg disabled:opacity-40 active:scale-95 transition-all shadow"
                  onClick={() => {
                    const fullNum = `+91${selfPhoneInput}`;
                    localStorage.setItem("meshnet_pending_phone", fullNum);
                    const token = eng.startSelfSmsVerification(fullNum);
                    setOtpInput("LISTENING");
                    eng.note("SMS App khul raha hai. Send dabayein, verification auto-check hogi.");

                    // Strict Timeout: Pura 1 minute (60,000ms) ka samay
                    window.setTimeout(() => {
                      eng.confirmSelfSmsToken("LOOPBACK_CHECK_TIMEOUT");
                      setShowVerifyModal(false);
                      setOtpInput("");
                      eng.note("SMS Loopback confirm nahi hua! Status: Pending (3 Peers Vouch Jaruri)");
                    }, 60000);
                  }}
                >
                  Verify & Bind SIM
                </button>
                <button
                  type="button"
                  className="w-full text-center text-xs text-muted hover:text-fg pt-1"
                  onClick={() => setShowVerifyModal(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              /* State B: Auto-Verification Listening State (No Manual Code Box) */
              <div className="space-y-3 pt-2 text-center">
                <div className="flex flex-col items-center justify-center p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 gap-2">
                  <div className="size-5 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
                  <span className="text-xs font-semibold text-emerald-400">
                    Listening for Carrier Loopback...
                  </span>
                  <span className="text-[11px] text-muted">
                    SMS deliver hote hi hardware SIM lock verify ho jayega.
                  </span>
                </div>
                <button
                  type="button"
                  className="w-full text-center text-xs text-muted hover:text-danger pt-1"
                  onClick={() => {
                    setOtpInput("");
                    setShowVerifyModal(false);
                  }}
                >
                  Cancel Verification
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. Linked Devices Modal */}
      {showDevicesModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => setShowDevicesModal(false)}
        >
          <div
            className="w-full max-w-sm space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="font-semibold text-fg text-sm">Linked Devices</h3>
              <button
                type="button"
                onClick={() => setShowDevicesModal(false)}
                className="text-muted hover:text-fg"
              >
                <X className="size-5" />
              </button>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              Is node par Web session aur local mesh connections active hain.
            </p>

            <div className="space-y-2">
              {/* Primary Current Node - Stable Status (No Self Disconnect) */}
              <div className="flex items-center justify-between rounded-xl border border-border bg-bg p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-semibold text-fg">
                      {(snap.me as any).instanceId ? `Linked Sub-Node (/${(snap.me as any).instanceId})` : "Primary Device (Master Node)"}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-muted truncate block mt-0.5">
                    {snap.me.globalId}
                  </span>
                </div>
                <span className="text-[11px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                  This Device
                </span>
              </div>

              {/* Linked Sub-Instances / QR Sessions: Sirf tab aayega jab sach me koi doosra linked device mesh par mile */}
              {snap.peers.filter((p: any) => sameUid(p.globalId, snap.me.globalId)).map((peer: any) => {
                const instId = peer.instanceId || 1;
                return (
                  <div key={peer.globalId + instId} className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
                    <div>
                      <span className="font-semibold text-fg block">Linked Instance /{instId}</span>
                      <span className="text-[10px] text-emerald-400 font-mono">Active on Mesh</span>
                    </div>
                    <button
                      type="button"
                      className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1 text-[11px] font-medium text-danger hover:bg-danger/20 active:scale-95 transition-all"
                      onClick={() => {
                        if (window.confirm(`Instance /${instId} ko mesh se disconnect aur revoke karein?`)) {
                          (eng as any).revokeSubInstance(instId);
                        }
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                );
              })}

              {/* Dangerous Area: Remove Mobile Number at the bottom */}
              {snap.me.verification?.verified && (
                <div className="border-t border-border pt-3 mt-3">
                  <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 space-y-2">
                    <div>
                      <span className="text-xs font-semibold text-danger block">Remove Verified Mobile Number</span>
                      <p className="text-[11px] text-muted leading-tight mt-0.5">
                        Number hatate hi SIM ownership unbind ho jayegi.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="w-full rounded-lg bg-danger/15 border border-danger/40 py-2 text-xs font-semibold text-danger hover:bg-danger/25 active:scale-95 transition-all"
                      onClick={() => {
                        const confirmed = window.confirm(
                          "⚠️ Chetwani: Apna mobile number remove karne ke baad:\n\n" +
                          "1. Koi bhi peer aapko mobile number se search nahi kar payega.\n" +
                          "2. Aapka Level 1 verified access band ho jayega.\n" +
                          "3. Group banana aur verified feed privileges suspend ho jayenge.\n\n" +
                          "Kya aap sach mein mobile number unbind karna chahte hain?"
                        );
                        if (confirmed) {
                          localStorage.removeItem("meshnet_verified_phone");
                          localStorage.removeItem("meshnet_pending_phone");
                          eng.setVerification({ verified: false, type: "none", level: 0 });
                          setShowDevicesModal(false);
                          eng.note("Mobile number remove ho gaya. Status: Unverified.");
                        }
                      }}
                    >
                      Remove Mobile Number
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="pt-2">
              <button
                type="button"
                className="min-h-10 w-full rounded-xl bg-elevated text-xs font-semibold text-fg hover:bg-elevated/80"
                onClick={() => setShowDevicesModal(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Web QR Modal */}
      {showQrModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => setShowQrModal(false)}
        >
          <div
            className="w-full max-w-xs space-y-4 rounded-2xl border border-border bg-surface p-5 text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="font-semibold text-fg text-sm">Link Device / Scan QR</h3>
              <button
                type="button"
                onClick={() => setShowQrModal(false)}
                className="text-muted hover:text-fg"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="flex justify-center p-2">
              <QRCodeSVG
                value={JSON.stringify({
                  disc: snap.me.discriminator,
                  hub: snap.me.hub,
                  pin: snap.me.secretPin,
                  pubKey: snap.me.globalId,
                })}
                size={180}
              />
            </div>

            <p className="text-xs text-muted">
              Doosre phone ya browser se scan karke instant chat connect karein.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Hub({ snap, eng, onGroup }: { snap: Snap; eng: MeshEngine; onGroup: () => void }) {
  const [showShareModal, setShowShareModal] = useState(false);
  const [hotspotSsid, setHotspotSsid] = useState("GVND-Connect-Hotspot");
  const [hotspotPass, setHotspotPass] = useState("");
  const localUrl = getLocalHostShareUrl() || "http://192.168.43.1:18081";

  // Standard Wi-Fi connection QR payload string
  const wifiQrPayload = hotspotPass
    ? `WIFI:T:WPA;S:${hotspotSsid};P:${hotspotPass};;`
    : `WIFI:T:nopass;S:${hotspotSsid};;`;

  return (
    <div className="m-auto flex w-full max-w-lg flex-col gap-4 p-6">
      <div className="rounded-lg border border-border bg-surface p-5 text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-full border border-primary bg-primary/10 text-primary">
          <Radio className="size-7" />
        </div>
        <h2 className="mt-3 text-xl font-semibold text-balance">Hotspot Station</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted text-pretty">
          Ye node local ad-hoc mesh par live hai. Same Wi-Fi/Hotspot ya hub key par chats, chunked media aur calls relay hoti hain.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 text-left">
          <Metric k="Online" v={`${snap.peers.length} nodes`} />
          <Metric k="WebRTC" v={snap.rtcPeers ? `${snap.rtcPeers} linked` : "Waiting"} />
          <Metric k="Auto Storage Cap" v={`${(eng as any).getDynamicReelQuotaMB()} MB`} />
          <Metric k="Routing" v="Multi-hop (64KB Swarm)" />
        </div>
        
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            className="min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-fg hover:opacity-90 transition-opacity"
            onClick={() => setShowShareModal(true)}
          >
            📡 Share Hotspot & Portal QR
          </button>
          <button
            type="button"
            className="min-h-11 rounded-lg border border-border px-4 text-sm hover:bg-elevated transition-colors"
            onClick={onGroup}
          >
            New Group
          </button>
        </div>
        <p className="mt-3 font-mono text-xs text-muted">Active Node: {snap.me.globalId}</p>
      </div>

      {/* Hotspot & Offline Web URL Sharing Modal */}
      {showShareModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => setShowShareModal(false)}
        >
          <div
            className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-surface p-5 text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="font-semibold text-fg text-sm">Join Local Mesh Hotspot</h3>
              <button
                type="button"
                onClick={() => setShowShareModal(false)}
                className="text-muted hover:text-fg"
              >
                <X className="size-5" />
              </button>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              Doosre phone ke camera se scan karke Wi-Fi se auto-connect karein aur bina internet mesh app use karein.
            </p>

            {/* Inputs for Host's Hotspot Details */}
            <div className="space-y-2 text-left">
              <div>
                <label className="text-[11px] text-muted font-medium">Hotspot Name (SSID)</label>
                <input
                  value={hotspotSsid}
                  onChange={(e) => setHotspotSsid(e.target.value)}
                  placeholder="e.g. GVND Connect-Hotspot"
                  className="mt-0.5 w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-xs text-fg outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted font-medium">Hotspot Password (Optional)</label>
                <input
                  type="text"
                  value={hotspotPass}
                  onChange={(e) => setHotspotPass(e.target.value)}
                  placeholder="Khali chhoden agar open hotspot hai"
                  className="mt-0.5 w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-xs text-fg outline-none"
                />
              </div>
            </div>

            {/* Generated Wi-Fi QR */}
            <div className="flex flex-col items-center justify-center py-2">
              <QRCodeSVG value={wifiQrPayload} size={160} />
              <span className="mt-2 text-[11px] font-mono text-primary font-medium">
                Scan to Connect Wi-Fi
              </span>
            </div>

            {/* Direct Portal Link Info */}
            <div className="rounded-lg border border-border bg-bg p-2.5 text-left text-xs">
              <span className="text-muted block text-[10px] uppercase font-semibold">Offline Browser URL:</span>
              <span className="font-mono text-emerald-400 font-semibold select-all break-all">
                {localUrl}
              </span>
            </div>

            <button
              type="button"
              className="min-h-10 w-full rounded-lg bg-elevated text-xs font-semibold text-fg hover:bg-elevated/80"
              onClick={() => setShowShareModal(false)}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CallOverlay({ snap, eng }: { snap: Snap; eng: MeshEngine }) {
  const call: LiveCall | null = snap.call;
  const remoteRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const remote = remoteRef.current;
    const local = localRef.current;

    if (remote) {
      remote.srcObject = eng.remoteStream;
      remote.volume = call?.volume ?? 1;
    }
    if (local) {
      local.srcObject = eng.localStream;
    }

    return () => {
      if (remote) remote.srcObject = null;
      if (local) local.srcObject = null;
    };
  }, [eng, call?.volume, snap.mediaTick, call?.phase, snap.incoming, call?.mode]);

  if (snap.incoming && !call) {
    const inc = snap.incoming;
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-bg px-6 py-10" role="dialog" aria-modal="true" aria-label="Incoming call">
        <div className="text-center">
          <p className="text-sm text-primary">Incoming {inc.mode} call</p>
          <h2 className="mt-2 text-2xl font-semibold text-balance">{inc.name}</h2>
          <p className="mt-1 font-mono text-xs text-muted">{inc.from}</p>
        </div>
        <div className="flex gap-4">
          <button type="button" className="grid size-16 place-items-center rounded-full bg-danger text-fg" aria-label="Decline" onClick={() => eng.declineCall()}>
            <PhoneOff className="size-6" />
          </button>
          <button type="button" className="grid size-16 place-items-center rounded-full bg-primary text-primary-fg" aria-label="Accept" onClick={() => void eng.acceptCall()}>
            <Phone className="size-6" />
          </button>
        </div>
      </div>
    );
  }
  if (!call) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg px-4 py-6" role="dialog" aria-modal="true" aria-label="Call">
      <div className="text-center">
        <h2 className="text-xl font-semibold">{call.name}</h2>
        <p className="text-sm text-primary">{call.phase === "connected" ? formatDuration(call.seconds) : "Ringing…"}</p>
        {call.loopback && <p className="mt-1 text-xs text-muted">Nearby node — remote camera nahi hai. Local mic on hai.</p>}
      </div>
      <div className="relative mx-auto mt-4 w-full max-w-3xl flex-1 overflow-hidden rounded-lg bg-elevated">
        <video ref={remoteRef} autoPlay playsInline className={`h-full w-full object-contain ${call.mode === "video" && !call.loopback ? "" : "sr-only"}`} />
        {call.mode === "video" && (
          <video ref={localRef} autoPlay muted playsInline className="absolute top-3 right-3 h-36 w-24 rounded-lg border border-primary object-cover" />
        )}
      </div>
      <label className="mx-auto mt-4 flex w-full max-w-xs items-center gap-2 text-xs text-muted">
        <Volume2 className="size-4" />
        <input type="range" min={0} max={1} step={0.05} value={call.volume} aria-label="Volume" onChange={(e) => eng.setVolume(Number(e.target.value))} className="w-full" />
      </label>
      <div className="mt-4 flex items-center justify-center gap-3">
        <button type="button" className="grid size-14 place-items-center rounded-full bg-elevated" aria-label={call.mic ? "Mute" : "Unmute"} onClick={() => eng.setMic(!call.mic)}>
          <Mic className={`size-5 ${call.mic ? "" : "text-danger"}`} />
        </button>
        <button type="button" className="grid size-14 place-items-center rounded-full bg-elevated" aria-label="Camera" onClick={() => eng.setCam(!call.cam)}>
          <Video className={`size-5 ${call.cam ? "" : "text-danger"}`} />
        </button>
        <button type="button" className="grid size-14 place-items-center rounded-full bg-danger text-fg" aria-label="Hang up" onClick={() => eng.hangup()}>
          <PhoneOff className="size-5" />
        </button>
      </div>
    </div>
  );
}

function Composer({
  snap,
  eng,
  mode,
  onClose,
  onOpen,
  onMode,
}: {
  snap: Snap;
  eng: MeshEngine;
  mode: "chat" | "group";
  onClose: () => void;
  onOpen: (tag: string) => void;
  onMode: (mode: "chat" | "group") => void;
}) {
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-bg/70 md:items-center" onClick={onClose}>
      <form
        className="w-full max-w-md space-y-3 rounded-t-lg bg-surface p-4 md:rounded-lg"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "chat" ? "New chat" : "New group"}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "group") {
            const id = eng.createGroup(groupName, picked);
            if (id) {
              onOpen(id);
              onClose();
            }
            return;
          }
          const clean = tag.trim();
          if (!tagOk(clean)) {
            eng.note("Tag @name@hub#id jaisa hona chahiye.");
            return;
          }
          if (name.trim()) eng.saveContact(name.trim(), clean);
          onOpen(clean);
          onClose();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{mode === "chat" ? "New chat" : "New group"}</h2>
          <button type="button" aria-label="Close" onClick={onClose}><X className="size-5" /></button>
        </div>
        <div className="flex gap-2 text-sm">
          <button type="button" className={mode === "chat" ? "text-primary" : "text-muted"} onClick={() => onMode("chat")}>Direct</button>
          <button type="button" className={mode === "group" ? "text-primary" : "text-muted"} onClick={() => onMode("group")}>Group</button>
        </div>
        {mode === "chat" ? (
          <>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" className="w-full rounded-lg border border-border bg-bg px-3 py-3 text-sm outline-none" />
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="@meera@mrt#meera001" aria-label="Global tag" className="w-full rounded-lg border border-border bg-bg px-3 py-3 text-sm outline-none" />
          </>
        ) : (
          <>
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Group name" aria-label="Group name" className="w-full rounded-lg border border-border bg-bg px-3 py-3 text-sm outline-none" />
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {snap.contacts.map((contact) => (
                <li key={contact.tag}>
                  <label className="flex items-center gap-2 py-1 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.some((p) => sameUid(p, contact.tag))}
                      onChange={(e) => {
                        setPicked((cur) =>
                          e.target.checked ? [...cur, contact.tag] : cur.filter((p) => !sameUid(p, contact.tag)),
                        );
                      }}
                    />
                    {contact.name}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        <button type="submit" className="min-h-11 w-full rounded-lg bg-primary text-sm font-semibold text-primary-fg">
          {mode === "chat" ? "Open chat" : "Create group"}
        </button>
      </form>
    </div>
  );
}

function Preview({ item, onClose }: { item: { url: string; mime: string; name: string }; onClose: () => void }) {
  const isPdf = item.mime === "application/pdf" || item.name.toLowerCase().endsWith(".pdf");

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/95 p-3 backdrop-blur-md" role="dialog" aria-modal="true">
      {/* Top Action Bar with Title, Save & Close */}
      <div className="mb-2 flex w-full max-w-4xl items-center justify-between gap-2 rounded-xl bg-surface/90 px-3 py-2 text-xs shadow">
        <span className="truncate font-semibold text-fg">{item.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={item.url}
            download={item.name}
            className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-fg hover:opacity-90"
          >
            Save
          </a>
          <button
            type="button"
            className="grid size-8 place-items-center rounded-full bg-elevated text-fg hover:bg-danger hover:text-white"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {item.mime.startsWith("image/") && (
        <img src={item.url} alt="" className="max-h-[82dvh] max-w-full rounded-lg object-contain shadow-2xl" />
      )}
      {item.mime.startsWith("video/") && (
        <div className="flex w-full max-w-3xl justify-center">
          <video src={item.url} controls autoPlay playsInline className="max-h-[82dvh] max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
      {item.mime.startsWith("audio/") && (
        <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 text-center shadow-2xl">
          <p className="mb-3 text-sm font-semibold">{item.name}</p>
          <audio src={item.url} controls autoPlay className="w-full" />
        </div>
      )}
      {isPdf && (
        <div className="flex h-[82dvh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-2xl">
          <object data={item.url} type="application/pdf" className="h-full w-full">
            <iframe src={item.url} title={item.name} className="h-full w-full border-0" />
          </object>
        </div>
      )}
      {!item.mime.startsWith("image/") && !item.mime.startsWith("video/") && !item.mime.startsWith("audio/") && !isPdf && (
        <div className="w-full max-w-xs rounded-2xl border border-border bg-surface p-6 text-center shadow-2xl">
          <FileText className="mx-auto mb-3 size-10 text-primary" />
          <p className="mb-4 truncate text-sm font-semibold">{item.name}</p>
          <a href={item.url} download={item.name} className="block w-full rounded-xl bg-primary px-5 py-3 font-semibold text-primary-fg shadow">
            Download File
          </a>
        </div>
      )}
    </div>
  );
}

function Avatar({ name, online = false, src }: { name: string; online?: boolean; src?: string }) {
  return (
    <span className="relative grid size-11 shrink-0 place-items-center">
      <span className="size-11 overflow-hidden rounded-full bg-primary/15 font-semibold text-primary grid place-items-center">
        {src ? (
          <img src={src} alt={name} className="h-full w-full object-cover" />
        ) : (
          initial(name)
        )}
      </span>
      {online && (
        <span className="absolute right-0 bottom-0 size-3 rounded-full bg-emerald-500 ring-2 ring-surface z-20 shadow-sm" />
      )}
    </span>
  );
}

function VerificationBadge({
  info,
  verified,
  type,
}: {
  info?: VerificationInfo;
  verified?: boolean;
  type?: string;
}) {
  const isVerified = info?.verified ?? verified;
  const vType = info?.type ?? type ?? "sim";
  if (isVerified) {
    return (
      <span title={`Verified via ${vType.toUpperCase()}`} className="inline-flex items-center text-emerald-500">
        <ShieldCheck className="size-4" />
      </span>
    );
  }
  return (
    <span title="Unverified Peer" className="inline-flex items-center text-amber-500/70">
      <ShieldAlert className="size-3.5" />
    </span>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-fg">
      {children}
    </button>
  );
}

function Mini({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="rounded-md bg-bg px-2 py-1 text-xs" onClick={onClick}>
      {children}
    </button>
  );
}

function AttachBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-11 items-center gap-2 rounded-lg bg-elevated px-3 text-sm">
      {children}
      {label}
    </button>
  );
}

function Empty({ icon: Icon, title, body }: { icon: typeof Radio; title: string; body: string }) {
  return (
    <div className="px-6 py-14 text-center">
      <Icon className="mx-auto size-8 text-muted" />
      <h2 className="mt-3 font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted text-pretty">{body}</p>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-3 text-sm text-fg outline-none" />
    </label>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-lg bg-surface px-2 py-2">
      <b className="block text-lg text-primary tabular-nums">{n}</b>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg bg-bg px-3 py-2">
      <div className="text-xs text-muted">{k}</div>
      <div className="font-semibold">{v}</div>
    </div>
  );
}

function Hit({ title, meta, onClick }: { title: string; meta: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" className="w-full px-4 py-3 text-left hover:bg-elevated" onClick={onClick}>
        <div className="truncate font-semibold">{title}</div>
        <div className="truncate text-sm text-muted">{meta}</div>
      </button>
    </li>
  );
}

function LocationCard({ lat, lng }: { lat: number; lng: number }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const googleMapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
  return (
    <a href={googleMapsUrl} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-2 rounded-lg bg-bg px-2.5 py-2 text-xs hover:border-primary border border-border transition-all">
      <MapPin className="size-4 text-emerald-400" />
      <div className="flex flex-col">
        <span className="font-semibold text-fg">Google Maps Location</span>
        <span className="tabular-nums text-muted text-[11px]">{lat.toFixed(5)}, {lng.toFixed(5)}</span>
      </div>
    </a>
  );
}
