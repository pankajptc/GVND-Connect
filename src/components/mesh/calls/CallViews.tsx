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
import { nameOf } from "@/components/mesh/shared/meshHelpers";
import { Avatar, Empty, IconBtn, Mini } from "@/components/mesh/shared/UiPrimitives";

export function CallsPane({ snap, eng, onOpen }: { snap: Snap; eng: MeshEngine; onOpen: (tag: string) => void }) {
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


export function CallOverlay({ snap, eng }: { snap: Snap; eng: MeshEngine }) {
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

export function Composer({
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

