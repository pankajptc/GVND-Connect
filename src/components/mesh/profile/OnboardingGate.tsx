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
import { Avatar, Empty, Field, IconBtn, Metric, Mini, Stat, VerificationBadge } from "@/components/mesh/shared/UiPrimitives";

export function OnboardingGate({ snap, eng, onDone }: { snap: Snap; eng: MeshEngine; onDone: () => void }) {
  const [mode, setMode] = useState<"signup" | "vault" | "pin" | "desktop">("signup");
  const [desktopSessionCode] = useState(() => "GVND-DESK-" + Math.random().toString(36).slice(2, 10).toUpperCase());
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [phone, setPhone] = useState("");
  const [vaultText, setVaultText] = useState("");
  const [vaultFileName, setVaultFileName] = useState("");

  const [authErr, setAuthErr] = useState("");
  useEffect(() => {
    (window as any).__gvndOnNativeFilePicked = (payload: any) => {
      if (payload?.purpose === "onboarding_gvnd" && payload?.text) {
        setVaultFileName(payload.name || "backup.gvnd");
        setVaultText(payload.text);
        setAuthErr("");
        eng.note("Backup file select ho gayi! Ab Password/PIN dalein.");
      }
    };
    return () => { delete (window as any).__gvndOnNativeFilePicked; };
  }, [eng]);
  return (
    <main className="h-dvh overflow-y-auto bg-bg px-4 py-8 text-fg">
      <div className="mx-auto my-auto w-full max-w-md space-y-5 rounded-3xl border border-border bg-surface p-6 shadow-2xl">
        {(authErr || snap.toast) && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-red-400/50 bg-gradient-to-r from-red-500/20 via-rose-500/20 to-red-500/20 px-4 py-3 text-center shadow-lg">
            <span className="text-xs font-semibold tracking-wide text-red-200">
              {authErr || snap.toast}
            </span>
          </div>
        )}
        <div className="text-center">
          <img src="/favicon.svg" alt="GVND Connect" className="mx-auto size-14 rounded-2xl shadow-md" />
          <h1 className="mt-3 text-xl font-bold">GVND Connect</h1>
          <p className="mt-1 text-xs text-muted">100% Decentralised Offline & Online Mesh Network</p>
          <div className="mt-3 overflow-hidden rounded-2xl border border-primary/30 bg-bg/60 shadow-md">
            <img
              src="/gvnd-mesh-banner.gif"
              alt="100% Secure Offline Mesh & Decentralized Network"
              className="h-auto w-full object-cover"
            />
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1 rounded-xl border border-border bg-bg p-1 text-[11px] font-semibold">
          <button
            type="button"
            onClick={() => setMode("signup")}
            className={`rounded-lg py-2 ${mode === "signup" ? "bg-primary text-primary-fg" : "text-muted"}`}
          >
            New Account
          </button>
          <button
            type="button"
            onClick={() => setMode("vault")}
            className={`rounded-lg py-2 ${mode === "vault" ? "bg-primary text-primary-fg" : "text-muted"}`}
          >
            .gvnd File
          </button>
          <button
            type="button"
            onClick={() => setMode("pin")}
            className={`rounded-lg py-2 ${mode === "pin" ? "bg-primary text-primary-fg" : "text-muted"}`}
          >
            Handle + PIN
          </button>
          <button
            type="button"
            onClick={() => setMode("desktop")}
            className={`rounded-lg py-2 ${mode === "desktop" ? "bg-primary text-primary-fg" : "text-muted"}`}
          >
            Link Web
          </button>
        </div>

        {mode === "signup" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const res = (eng as any).completeNewOnboarding({ name, handle, pin, phone });
              if (!res.ok) {
                eng.note(res.err || "Details check karein.");
                return;
              }
              onDone();
            }}
          >
            <div>
              <label className="text-xs text-muted">Aapka Naam</label>
              <input
                type="text"
                placeholder="e.g. Pankaj Singh"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="text-xs text-muted">Username (Handle)</label>
              <input
                type="text"
                placeholder="e.g. pankaj"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="text-xs text-muted">Secret PIN / Passphrase (Login ke liye)</label>
              <input
                type="password"
                placeholder="Kam se kam 4 digits/letters"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="text-xs text-muted">Mobile Number (Optional — Level 1 SMS Verify ke liye)</label>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit mobile number"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-xl border border-border bg-bg px-3 py-2.5 font-mono text-sm outline-none focus:border-primary"
              />
            </div>
            <button type="submit" className="min-h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-fg shadow">
              {phone.length === 10 ? "Create Account & Verify SMS" : "Continue (Level 0 Mesh Mode)"}
            </button>
          </form>
        )}

        {mode === "vault" && (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setAuthErr("");
              if (!vaultText) {
                setAuthErr("Pehle .gvnd backup file select karein.");
                return eng.note("Pehle .gvnd backup file select karein.");
              }
              if (!pin.trim()) {
                setAuthErr("Backup file ka Password / PIN dalein.");
                return eng.note("Backup file ka Password / PIN dalein.");
              }
              const res = await (eng as any).importEncryptedGvndFile(vaultText, pin);
              if (!res.ok) {
                setAuthErr(res.err || "Galat Password! File decrypt nahi hui.");
                return eng.note(res.err || "Galat Password! File decrypt nahi hui.");
              }
              onDone();
            }}
          >
            <p className="text-xs text-muted">Apni encrypted <code className="text-fg">.gvnd</code> backup file select karein aur password dalein.</p>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined" && (window as any).AndroidBridge?.pickNativeFile) {
                  (window as any).AndroidBridge.pickNativeFile("*/*", "onboarding_gvnd");
                  return;
                }
                document.getElementById("ob-gvnd-file-input")?.click();
              }}
              className="block w-full cursor-pointer rounded-xl border border-dashed border-primary/50 bg-bg p-4 text-center text-xs font-semibold text-primary hover:bg-primary/10"
            >
              {vaultFileName ? `Selected: ${vaultFileName}` : "Choose .gvnd Backup File"}
            </button>
            <input
              id="ob-gvnd-file-input"
              type="file"
              accept="*/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setVaultFileName(f.name);
                void f.text().then((t) => setVaultText(t));
              }}
            />
            <input
              type="password"
              placeholder="Backup File Password / PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-primary"
            />
            <button type="submit" className="min-h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-fg shadow">
              Decrypt & Restore Account
            </button>
          </form>
        )}

        {mode === "desktop" && (
          <div className="space-y-3 text-center">
            <p className="text-xs text-muted">
              Apne Mobile App mein <b className="text-fg">Profile → Link to Web / Scan QR</b> khol kar is Desktop QR ko scan karein:
            </p>
            <div className="flex justify-center rounded-2xl border border-border bg-white p-3 mx-auto w-fit">
              <QRCodeSVG
                value={JSON.stringify({
                  type: "gvnd_desktop_pair",
                  session: desktopSessionCode,
                  host: typeof window !== "undefined" ? window.location.origin : "",
                })}
                size={180}
              />
            </div>
            <div className="rounded-xl border border-border bg-bg px-3 py-2 font-mono text-xs text-primary">
              Session Code: {desktopSessionCode}
            </div>
            <p className="text-[11px] text-muted">
              Scan karne ke baad mobile par dikhne wale Handle + PIN se yahan instant login ho jayega.
            </p>
          </div>
        )}

        {mode === "pin" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setAuthErr("");
              const res = (eng as any).loginWithPassphrase(handle, pin, false);
              if (!res?.ok) {
                const msg = res?.err || "Galat Handle ya Secret PIN!";
                setAuthErr(msg);
                eng.note(msg);
                if (res?.notFound) {
                  setMode("signup");
                }
                return;
              }
              localStorage.setItem("gvnd_onboarded_v1", "1");
              onDone();
            }}
          >
            <p className="text-xs text-muted">Bina backup file ke kisi bhi online ya offline device par apni exact Hash ID kholein.</p>
            <input
              type="text"
              placeholder="Username / Handle (e.g. pankaj)"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-primary"
            />
            <input
              type="password"
              placeholder="Secret PIN / Passphrase"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-primary"
            />
            <button type="submit" className="min-h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-fg shadow">
              Login with Deterministic ID
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

