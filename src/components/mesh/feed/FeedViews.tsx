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
import { nameOf, visiblePosts } from "@/components/mesh/shared/meshHelpers";
import { Avatar, Empty, IconBtn, Mini, VerificationBadge } from "@/components/mesh/shared/UiPrimitives";

export function FeedList({
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
              className="sr-only pointer-events-none"
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


export function PostDeck({
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

export function Comments({ snap, eng, postId, onClose }: { snap: Snap; eng: MeshEngine; postId: string; onClose: () => void }) {
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

