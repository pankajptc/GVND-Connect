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

import { messagesFor, nameOf, previewText, threadKey, totalUnread, unreadCount, visiblePosts } from "@/components/mesh/shared/meshHelpers";
import { AttachBtn, Avatar, Empty, Field, Hit, IconBtn, LocationCard, Metric, Mini, Preview, Stat, Tick, VerificationBadge } from "@/components/mesh/shared/UiPrimitives";
import { Comments, FeedList, PostDeck } from "@/components/mesh/feed/FeedViews";
import { CallOverlay, CallsPane, Composer } from "@/components/mesh/calls/CallViews";
import { ContactsPane, Hub, ProfilePane, SearchPane } from "@/components/mesh/profile/ProfileViews";
import { OnboardingGate } from "@/components/mesh/profile/OnboardingGate";

type Tab = "chats" | "feeds" | "calls" | "contacts" | "search" | "profile";

const TABS: { id: Tab; label: string; icon: typeof MessageCircle }[] = [
  { id: "chats", label: "Chats", icon: MessageCircle },
  { id: "feeds", label: "Feeds", icon: Newspaper },
  { id: "calls", label: "Calls", icon: Phone },
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "search", label: "Search", icon: Search },
  { id: "profile", label: "Profile", icon: UserRound },
];

export function MeshApp() {
  const [snap, setSnap] = useState<Snap | null>(null);
  const engRef = useRef<MeshEngine | null>(null);
  const [onboarded, setOnboarded] = useState<boolean>(false);

  useEffect(() => {
    const eng = getEngine();
    engRef.current = eng;
    setOnboarded(localStorage.getItem("gvnd_onboarded_v1") === "1");
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

  if (!onboarded) {
    return (
      <OnboardingGate
        snap={snap}
        eng={engRef.current}
        onDone={() => {
          localStorage.setItem("gvnd_onboarded_v1", "1");
          setOnboarded(true);
          setSnap({ ...engRef.current!.getSnapshot() });
        }}
      />
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
    const pushGuard = () => {
      try { window.history.pushState({ gvndGuard: Date.now() }, ""); } catch {}
    };
    pushGuard();
    const onPopState = () => {
      if (preview) { setPreview(null); pushGuard(); return; }
      if (commentsFor) { setCommentsFor(null); pushGuard(); return; }
      if (deckPost) { setDeckPost(null); pushGuard(); return; }
      if (composer) { setComposer(null); pushGuard(); return; }
      if (showHotspotStation) { setShowHotspotStation(false); pushGuard(); return; }
      if (chatTag) { setChatTag(null); pushGuard(); return; }
      if (tab !== "chats") { setTab("chats"); pushGuard(); return; }
      pushGuard();
    };
    (window as any).gvndHandleBack = () => {
      if ((window as any).__gvndSubModalClose) {
        (window as any).__gvndSubModalClose();
        return true;
      }
      if (preview) { setPreview(null); return true; }
      if (commentsFor) { setCommentsFor(null); return true; }
      if (deckPost) { setDeckPost(null); return true; }
      if (composer) { setComposer(null); return true; }
      if (showHotspotStation) { setShowHotspotStation(false); return true; }
      if (chatTag) { setChatTag(null); return true; }
      if (tab !== "chats") { setTab("chats"); return true; }
      return false;
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      delete (window as any).gvndHandleBack;
    };
  }, [preview, commentsFor, deckPost, composer, showHotspotStation, chatTag, tab]);

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
                <span className="relative inline-flex items-center justify-center">
                  <Icon className="size-5" />
                  {item.id === "chats" && unread > 0 && (
                    <span className="absolute -top-1.5 -right-3.5 min-w-[18px] rounded-full bg-primary px-1 py-0.2 text-[10px] font-bold leading-tight text-primary-fg tabular-nums shadow">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </span>
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
  const byUid = new Map<string, string>();
  for (const k of Object.keys(snap.chats)) byUid.set(uidOf(k) || k, k);
  for (const peer of snap.peers) {
    const u = uidOf(peer.globalId) || peer.globalId;
    if (!byUid.has(u)) byUid.set(u, peer.globalId);
  }
  const tags = new Set<string>(byUid.values());
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
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-semibold">{nameOf(snap, row.tag)}</span>
                    {!isGroupId(row.tag) && (
                      <VerificationBadge
                        verified={snap.peers.find((p) => sameUid(p.globalId, row.tag))?.verification?.verified}
                        type={snap.peers.find((p) => sameUid(p.globalId, row.tag))?.verification?.type}
                      />
                    )}
                  </span>
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
  const [showPeerProfile, setShowPeerProfile] = useState(false);
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
    eng.markRead(key);
  }, [eng, msgs.length, key]);

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
    const msgBody = text.trim();
    if (!msgBody) return;
    setText("");
    eng.sendText(
      key,
      msgBody,
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
          <button
            type="button"
            onClick={() => {
              if (!isGroupId(key)) setShowPeerProfile(true);
            }}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl py-1 pr-2 text-left transition-colors hover:bg-elevated/60 active:scale-[0.99]"
            title="View Public Profile"
          >
            <Avatar
              name={nameOf(snap, tag)}
              online={online || isGroupId(key)}
              src={
                (snap.peers.find((p) => sameUid(p.globalId, tag) || sameUid(p.globalId, key)) as any)?.avatarUrl ||
                (() => {
                  try {
                    const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
                    const hit = Object.entries(c).find(([k]) => sameUid(k, tag) || sameUid(k, key));
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
          </button>
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
                          <span>{(msg.transferProgress || 0) < 50 ? "Compressing..." : "Uploading..."}</span>
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
                            const fileMime = isPdfDoc ? "application/pdf" : (msg.mediaMime || "application/octet-stream");
                            onPreview({ url, mime: fileMime, name: docName });
                            return;
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
                      key={String(c.tag || "").startsWith("phone:") ? (String(c.tag).replace("phone:", "") + " • Not on Mesh (Tap to Invite)") : c.tag}
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg p-2 text-left hover:bg-elevated text-xs transition-colors"
                      onClick={() => {
                        eng.sendContactCard(key, c);
                        setShowContactPicker(false);
                        eng.note(`${c.name} ka card bhej diya.`);
                      }}
                    >
                      <span className="font-semibold text-fg truncate">{c.name}</span>
                      <span className="font-mono text-[10px] text-muted truncate max-w-[120px]">{String(c.tag || "").startsWith("phone:") ? (String(c.tag).replace("phone:", "") + " • Not on Mesh (Tap to Invite)") : c.tag}</span>
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
          className="sr-only pointer-events-none"
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
        {!isGroupId(key) && <button type="button" className="text-amber-400" onClick={() => { if (window.confirm("Is peer ko spam/fake report karein? High-trust report par turant Trust Score girega.")) (eng as any).reportPeerNode(key); }}>Report node</button>}
        {group && <button type="button" onClick={() => eng.leaveGroup(group.id)}>Leave group</button>}
        {!isGroupId(key) && !snap.contacts.some((c) => sameUid(c.tag, key)) && (
          <button type="button" onClick={() => eng.saveContact(nameOf(snap, key), key)}>Save contact</button>
        )}
      </div>

      {/* WhatsApp-Style Smart Delete Modal (Delete for Me vs Delete for Everyone) */}
      {showPeerProfile && !isGroupId(key) && (() => {
        const peerObj = snap.peers.find((p) => sameUid(p.globalId, key) || sameUid(p.globalId, tag));
        const cachedObj = (() => {
          try {
            const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
            const hit = Object.entries(c).find(([k]) => sameUid(k, key) || sameUid(k, tag));
            return (hit?.[1] as any) || {};
          } catch { return {}; }
        })();
        const displayAvatar = peerObj?.avatarUrl || cachedObj?.avatarUrl || "";
        const displayName = nameOf(snap, key);
        const displayGlobalId = peerObj?.globalId || cachedObj?.globalId || key;
        const displayBio = peerObj?.bio || cachedObj?.bio || "";
        const joinedTs = peerObj?.createdAt || cachedObj?.createdAt || (msgs[0]?.timestamp) || Date.now();
        const joinedLabel = new Date(joinedTs).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        const trust = eng.computeTrustScore(peerObj?.verification);
        const isSavedContact = snap.contacts.some((c) => sameUid(c.tag, key));
        const isBlocked = snap.blocked.includes(uidOf(key));

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            onClick={() => setShowPeerProfile(false)}
          >
            <div
              className="w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-surface shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Top Header Bar: Centered Title + Right Corner Close Button */}
              <div
                className="relative flex items-center justify-center border-b border-border/60 px-4 py-3.5"
                style={{ background: "linear-gradient(135deg, rgba(16,185,129,0.18), rgba(14,165,233,0.12))" }}
              >
                <span className="inline-flex items-center justify-center rounded-full border border-primary/35 bg-surface/90 px-3.5 py-1 text-[11px] font-bold tracking-wider text-primary uppercase shadow-sm">
                  GVND Connect Card
                </span>
                <button
                  type="button"
                  onClick={() => setShowPeerProfile(false)}
                  aria-label="Close profile"
                  style={{ position: "absolute", right: "14px", top: "50%", transform: "translateY(-50%)" }}
                  className="grid size-8 place-items-center rounded-full border border-border bg-surface/90 text-muted transition-colors hover:text-fg"
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* Body Content with Generous Spacing */}
              <div className="p-5">
                {/* Avatar with Bottom-Right Solid Green Online Dot */}
                <div className="flex flex-col items-center text-center">
                  <div className="relative inline-block">
                    <div
                      className="size-24 rounded-full p-[3px] shadow-lg"
                      style={{ background: "linear-gradient(135deg, #10b981, #0ea5e9)" }}
                    >
                      <div className="h-full w-full overflow-hidden rounded-full bg-surface">
                        {displayAvatar ? (
                          <img src={displayAvatar} alt={displayName} className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full w-full place-items-center bg-elevated text-3xl font-extrabold text-primary">
                            {initial(displayName)}
                          </div>
                        )}
                      </div>
                    </div>

                  </div>

                  {/* Name + Verification Badge */}
                  <div className="mt-3.5 flex items-center justify-center gap-1.5">
                    <h3 className="text-xl font-bold tracking-tight text-fg">{displayName}</h3>
                    <VerificationBadge verified={peerObj?.verification?.verified} type={peerObj?.verification?.type} />
                  </div>

                  {/* Copyable Mesh ID Hash Pill */}
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        if (navigator.clipboard && window.isSecureContext) {
                          void navigator.clipboard.writeText(displayGlobalId);
                        }
                        eng.note("Mesh ID copy ho gayi!");
                      } catch {}
                    }}
                    className="mt-2.5 inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3.5 py-1 font-mono text-xs font-medium text-primary transition-colors hover:bg-primary/20 active:scale-95"
                    title="Tap to copy Mesh ID"
                  >
                    <span className="truncate">{displayGlobalId}</span>
                    <Copy className="size-3.5 shrink-0 opacity-80" />
                  </button>

                  {/* Bio Box with Clean Margin */}
                  {displayBio && (
                    <div className="mt-3.5 w-full rounded-2xl border border-border bg-bg/70 px-4 py-3 text-center text-xs leading-relaxed text-fg/90">
                      “{displayBio}”
                    </div>
                  )}
                </div>

                {/* 3-Column Bento Stats Grid */}
                <div className="mt-4 grid grid-cols-3 gap-2.5">
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-bg/60 px-2 py-3 text-center">
                    <span className="text-[10px] font-semibold tracking-wider text-muted uppercase">Joined</span>
                    <span className="mt-1 text-xs font-bold text-fg">{joinedLabel}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-bg/60 px-2 py-3 text-center">
                    <span className="text-[10px] font-semibold tracking-wider text-muted uppercase">Trust</span>
                    <span className="mt-1 text-xs font-bold text-primary">{trust}/100</span>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-bg/60 px-2 py-3 text-center">
                    <span className="text-[10px] font-semibold tracking-wider text-muted uppercase">Status</span>
                    <span
                      className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold"
                      style={{ color: online ? "#22c55e" : undefined }}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: online ? "#22c55e" : "#6b7280" }}
                      />
                      {online ? "Online" : "Offline"}
                    </span>
                  </div>
                </div>

                {/* Voice & Video Call Buttons */}
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowPeerProfile(false);
                      void eng.startCall(displayGlobalId, "voice", { dialer: false });
                    }}
                    className="flex items-center justify-center gap-2 rounded-2xl bg-primary py-3 text-xs font-bold text-primary-fg shadow-md transition-transform active:scale-95"
                  >
                    <Phone className="size-4" /> Voice Call
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowPeerProfile(false);
                      void eng.startCall(displayGlobalId, "video", { dialer: false });
                    }}
                    className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-elevated py-3 text-xs font-bold text-fg transition-transform active:scale-95 hover:bg-elevated/80"
                  >
                    <Video className="size-4" /> Video Call
                  </button>
                </div>

                {/* Save Contact & Block Buttons */}
                <div className="mt-3 flex items-center gap-3">
                  {!isSavedContact ? (
                    <button
                      type="button"
                      onClick={() => {
                        eng.saveContact(displayName, displayGlobalId);
                        setShowPeerProfile(false);
                      }}
                      className="flex-1 rounded-2xl border border-primary/40 bg-primary/10 py-2.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
                    >
                      + Save to Contacts
                    </button>
                  ) : (
                    <div
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border py-2.5 text-xs font-semibold"
                      style={{
                        borderColor: "rgba(34,197,94,0.35)",
                        backgroundColor: "rgba(34,197,94,0.12)",
                        color: "#22c55e",
                      }}
                    >
                      <Check className="size-3.5" /> Saved Contact
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      eng.toggleBlock(key);
                      setShowPeerProfile(false);
                    }}
                    className="rounded-2xl border border-danger/35 bg-danger/10 px-4 py-2.5 text-xs font-semibold text-danger transition-colors hover:bg-danger/20"
                  >
                    {isBlocked ? "Unblock" : "Block"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

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

