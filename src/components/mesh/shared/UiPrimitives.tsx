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

export function Tick({ status }: { status: Msg["status"] }) {
  if (status === "queued") return <Clock className="size-3.5" aria-label="Queued" />;
  if (status === "sent") return <Check className="size-3.5" aria-label="Sent" />;
  return <CheckCheck className={`size-3.5 ${status === "read" ? "text-sky-300" : ""}`} aria-label={status} />;
}


export function Preview({ item, onClose }: { item: { url: string; mime: string; name: string }; onClose: () => void }) {
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
        <div className="flex w-full max-w-sm flex-col items-center rounded-2xl border border-border bg-surface p-6 text-center shadow-2xl">
          <div className="mb-3 grid size-14 place-items-center rounded-2xl bg-danger/15 text-danger">
            <FileText className="size-8" />
          </div>
          <p className="mb-1 line-clamp-2 text-sm font-semibold text-fg">{item.name}</p>
          <p className="mb-5 text-xs text-muted">PDF Document Ready</p>
          <div className="flex w-full flex-col gap-2.5">
            <button
              type="button"
              onClick={async () => {
                try {
                  if (await openFileWithAndroidBridge(item.url, item.name, "application/pdf")) return;
                  const res = await fetch(item.url);
                  const blob = await res.blob();
                  const fileObj = new File([blob], item.name, { type: "application/pdf" });
                  if (typeof navigator !== "undefined" && navigator.canShare && navigator.canShare({ files: [fileObj] })) {
                    await navigator.share({ files: [fileObj], title: item.name });
                    return;
                  }
                  window.open(item.url, "_blank", "noopener,noreferrer");
                } catch {}
              }}
              className="w-full rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-fg shadow"
            >
              Open in PDF App
            </button>
            <a
              href={item.url}
              download={item.name}
              className="w-full rounded-xl border border-border bg-elevated px-5 py-2.5 text-xs font-semibold text-fg"
            >
              Download / Save PDF
            </a>
          </div>
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

export function Avatar({ name, online = false, src }: { name: string; online?: boolean; src?: string }) {
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

export function VerificationBadge({
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

export function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-fg">
      {children}
    </button>
  );
}

export function Mini({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="rounded-md bg-bg px-2 py-1 text-xs" onClick={onClick}>
      {children}
    </button>
  );
}

export function AttachBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-11 items-center gap-2 rounded-lg bg-elevated px-3 text-sm">
      {children}
      {label}
    </button>
  );
}

export function Empty({ icon: Icon, title, body }: { icon: typeof Radio; title: string; body: string }) {
  return (
    <div className="px-6 py-14 text-center">
      <Icon className="mx-auto size-8 text-muted" />
      <h2 className="mt-3 font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted text-pretty">{body}</p>
    </div>
  );
}

export function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-3 text-sm text-fg outline-none" />
    </label>
  );
}

export function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-lg bg-surface px-2 py-2">
      <b className="block text-lg text-primary tabular-nums">{n}</b>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

export function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg bg-bg px-3 py-2">
      <div className="text-xs text-muted">{k}</div>
      <div className="font-semibold">{v}</div>
    </div>
  );
}

export function Hit({ title, meta, onClick }: { title: string; meta: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" className="w-full px-4 py-3 text-left hover:bg-elevated" onClick={onClick}>
        <div className="truncate font-semibold">{title}</div>
        <div className="truncate text-sm text-muted">{meta}</div>
      </button>
    </li>
  );
}

export function LocationCard({ lat, lng }: { lat: number; lng: number }) {
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


