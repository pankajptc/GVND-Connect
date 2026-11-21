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
import { messagesFor, nameOf, previewText } from "@/components/mesh/shared/meshHelpers";
import { Avatar, Empty, Field, Hit, IconBtn, Metric, Mini, Stat, VerificationBadge } from "@/components/mesh/shared/UiPrimitives";

export function ContactsPane({
  snap,
  eng,
  onOpen,
}: {
  snap: Snap;
  eng: MeshEngine;
  onOpen: (tag: string) => void;
}) {
  const [contactLimit, setContactLimit] = useState(50);
  const loadMoreContactsRef = useRef<HTMLDivElement>(null);
  const [contactSearch, setContactSearch] = useState("");
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
          for (const item of list) {
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
    if (window.AndroidBridge && window.AndroidBridge.getContacts) {
      window.AndroidBridge.requestPermissionsNow?.();
      const raw = window.AndroidBridge.getContacts();
      const list = JSON.parse(raw || "[]");
      if (list.length > 0) {
        list.forEach((c: any) => c.tel && eng.addContactByPhone(c.name || c.tel, c.tel));
        eng.note(list.length + " phone contacts sync ho gaye!");
        return;
      } else {
        window.AndroidBridge.openAppSettings?.();
      }
    }
    eng.note("Contacts permission allow karein ya naam/number dalein.");
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
        accept="*/*"
        className="sr-only pointer-events-none"
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
          <input type="text" value={contactSearch} onChange={(e) => { setContactSearch(e.target.value); setContactLimit(50); }} placeholder="Search contacts by name or number..." className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-xs text-fg outline-none focus:border-primary" />
        {snap.contacts.length === 0 ? (
          <Empty icon={Users} title="Koi contact nahi" body="Mobile number ya handle daal kar contact add karein." />
        ) : (() => {
          const filteredContacts = snap.contacts.filter((c) => !contactSearch.trim() || c.name.toLowerCase().includes(contactSearch.toLowerCase()) || c.tag.toLowerCase().includes(contactSearch.toLowerCase()));
          const visibleContacts = filteredContacts.slice(0, contactLimit);
          const hasMoreContacts = visibleContacts.length < filteredContacts.length;
          return (
          <>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface overflow-hidden">
            {visibleContacts.map((c) => {
              const isLive = snap.peers.some((p) => sameUid(p.globalId, c.tag));
              return (
                <li key={String(c.tag || "").startsWith("phone:") ? (String(c.tag).replace("phone:", "") + " • Not on Mesh (Tap to Invite)") : c.tag} className="flex items-center gap-3 p-3 hover:bg-elevated/40">
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
                      <div className="truncate font-mono text-xs text-muted">{String(c.tag || "").startsWith("phone:") ? (String(c.tag).replace("phone:", "") + " • Not on Mesh (Tap to Invite)") : c.tag}</div>
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
          <div
            ref={(el) => {
              if (!el || !hasMoreContacts) return;
              const obs = new IntersectionObserver(
                (entries) => {
                  if (entries[0]?.isIntersecting) {
                    setContactLimit((prev) => prev + 50);
                  }
                },
                { rootMargin: "200px" }
              );
              obs.observe(el);
            }}
            className="mt-2 flex flex-col items-center justify-center gap-1.5 py-2 text-center"
          >
            <div className="text-[11px] text-muted">
              Showing <b className="text-fg">{visibleContacts.length}</b> of <b className="text-fg">{filteredContacts.length}</b> contacts
            </div>
            {hasMoreContacts && (
              <button
                type="button"
                onClick={() => setContactLimit((prev) => prev + 50)}
                className="rounded-xl border border-primary/40 bg-primary/15 px-4 py-2 text-xs font-semibold text-primary hover:bg-primary/25"
              >
                Load Next 50 Contacts ({Math.min(50, filteredContacts.length - visibleContacts.length)} more)
              </button>
            )}
          </div>
          </>
          );
        })()}
      </div>
    </div>
  );
}

export function SearchPane({ snap, onOpen, onPost }: { snap: Snap; onOpen: (tag: string) => void; onPost: (id: string) => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const peers = snap.peers.filter((p) => !query || p.name.toLowerCase().includes(query) || p.globalId.toLowerCase().includes(query));
  const contacts = ([] as typeof snap.contacts).filter((c) => !query || c.name.toLowerCase().includes(query) || c.tag.toLowerCase().includes(query));
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
          <Hit key={String(c.tag || "").startsWith("phone:") ? (String(c.tag).replace("phone:", "") + " • Not on Mesh (Tap to Invite)") : c.tag} title={c.name} meta={`Contact · ${String(c.tag || "").startsWith("phone:") ? (String(c.tag).replace("phone:", "") + " • Not on Mesh (Tap to Invite)") : c.tag}`} onClick={() => onOpen(c.tag)} />
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

export function ProfilePane({ snap, eng, onOpen }: { snap: Snap; eng: MeshEngine; onOpen: (tag: string) => void }) {
  const trustScore = eng.computeTrustScore(snap.me.verification);
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
  const [lastBackupPath, setLastBackupPath] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const mine = snap.posts.filter((p) => sameUid(p.globalId, snap.me.globalId) && !p.deleted).length;
  const starred = Object.values(snap.chats)
    .flat()
    .filter((m) => snap.starred.includes(m.id));

  // Level 1 (Self-SMS) ya Level 2 (2+ Peers Vouched) check
  const isLevel1Or2 = Boolean(snap.me.verification?.verified && trustScore > 0) &&
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
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-surface/70 px-2.5 py-0.5 text-[11px] font-medium text-muted">
              <span>Joined GVND:</span>
              <span className="font-semibold text-fg">
                {new Date(snap.me.createdAt || Date.now()).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
              </span>
            </div>
          </div>

          {/* Right Red Circle Area: Profile Picture Selector */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="relative grid size-16 cursor-pointer place-items-center rounded-full border-2 border-dashed border-primary/40 bg-surface shadow-md hover:border-primary transition-all overflow-hidden group active:scale-95"
              aria-label="Upload Profile Photo"
            >
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
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void (eng as any).setAvatarFile(file);
              }}
            />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Stat n={mine} label="Posts" />
          <Stat n={snap.contacts.length} label="Contacts" />
          <Stat n={snap.outbox} label="Queued" />
        </div>
      </div>

      <section className="space-y-2.5 rounded-2xl border border-border bg-surface p-3.5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-primary">Encrypted .gvnd Vault & Recovery</div>
          <span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-mono text-[11px] font-bold text-primary">
            Trust Score: {(eng as any).computeTrustScore?.(snap.me.verification) ?? 0}/100
          </span>
        </div>
        <p className="text-xs text-muted">
          Apni ID, private keys, contacts aur purani chats ko password-encrypted <code className="text-fg">.gvnd</code> file mein safe rakhein.
        </p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="button"
            onClick={async () => {
              const pwd = prompt("Backup file encrypt karne ke liye Secret Password / PIN dalein:");
              if (!pwd || pwd.trim().length < 4) {
                eng.note("Kam se kam 4-character password dalein.");
                return;
              }
              const vaultJson = await (eng as any).exportEncryptedGvndFile(pwd);
              const fileName = `gvnd-${snap.me.handle || "node"}-backup.gvnd`;
              if (typeof window !== "undefined" && (window as any).AndroidBridge?.saveAndOpenFile) {
                const b64 = btoa(unescape(encodeURIComponent(vaultJson)));
                const savedPath = String((window as any).AndroidBridge.saveAndOpenFile(b64, fileName, "application/octet-stream") || "");
                if (savedPath) {
                  setLastBackupPath(savedPath);
                  eng.note(`Backup saved: ${savedPath}`);
                  return;
                }
              }
              const blob = new Blob([vaultJson], { type: "application/octet-stream" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = fileName;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setLastBackupPath(`Downloads/${fileName}`);
              eng.note(`Encrypted backup saved: Downloads/${fileName}`);
            }}
            className="rounded-xl bg-primary px-3 py-2.5 text-xs font-semibold text-primary-fg"
          >
            Download .gvnd File
          </button>
          <label className="cursor-pointer rounded-xl border border-border bg-bg px-3 py-2.5 text-center text-xs font-semibold text-ink hover:border-primary">
            Restore .gvnd File
            <input
              type="file"
              accept="*/*"
              className="sr-only pointer-events-none"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                void f.text().then(async (txt) => {
                  const pwd = prompt("Is .gvnd file ka Secret Password / PIN dalein:");
                  if (!pwd) return;
                  const res = await (eng as any).importEncryptedGvndFile(txt, pwd);
                  if (!res.ok) eng.note(res.err || "Restore fail hua.");
                });
              }}
            />
          </label>
        </div>
        {lastBackupPath && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300 break-all">
            ✅ Backup File Saved: <b className="font-mono">{lastBackupPath}</b>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted">
          <span>Auto-Vouches: <b className="text-fg">{snap.me.verification?.vouchedBy?.length || 0}</b> (10+ par score badhta hai)</span>
          <span className={`font-bold tabular-nums ${trustScore >= 75 ? "text-emerald-400" : trustScore >= 40 ? "text-amber-400" : "text-rose-400"}`}>
            {trustScore}% Trusted
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-bg mt-1.5">
          <div
            className={`h-full rounded-full transition-all duration-500 ${trustScore >= 75 ? "bg-emerald-500" : trustScore >= 40 ? "bg-amber-400" : "bg-rose-500"}`}
            style={{ width: `${Math.max(6, Math.min(100, trustScore))}%` }}
          />
        </div>
      </section>

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
                  ? ((typeof window !== "undefined" && localStorage.getItem("gvnd_sms_verified") === "1") || (eng as any).trustLevel >= 1 ? "Level 1 Verified (SMS)" : "Unverified Node")
                  : ((typeof window !== "undefined" && localStorage.getItem("gvnd_sms_verified") === "1") || (eng as any).trustLevel >= 1 || (eng as any).profile?.verified ? "Verified Node (Level 1)" : "Unverified Node")}
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
              {((typeof window !== "undefined" && localStorage.getItem("gvnd_sms_verified") === "1") || (snap.me?.verification?.level || 0) >= 1) ? ("Verified Mobile: " + (((typeof window !== "undefined" && localStorage.getItem("gvnd_verified_phone")) || (snap.me?.verification as any)?.phone || "Active SIM")) + " • Level-1 Verified (Sabhi features unlocked!)") : "Unverified accounts par restrictions hain. Self-SMS se apna real mobile number bind karein."}
            </p>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-semibold text-primary-fg hover:opacity-95 active:scale-95 transition-all shadow-sm"
                onClick={() => {
    const isL1 = (typeof window !== "undefined" && localStorage.getItem("gvnd_sms_verified") === "1") || (snap.me?.verification?.level || 0) >= 1;
    if (isL1) {
      const ph = (typeof window !== "undefined" && localStorage.getItem("gvnd_verified_phone")) || (snap.me?.verification as any)?.phone || "";
      eng.note(ph ? ("Mobile Verified: " + ph + " (Level 1 Active)") : "Level 1 SMS Verification pehle se active hai!");
      return;
    }
    setShowVerifyModal(true);
  }}
              >
                <ShieldCheck className="size-4" /> {((typeof window !== "undefined" && localStorage.getItem("gvnd_sms_verified") === "1") || (snap.me?.verification?.level || 0) >= 1) ? "Verified (Level 1 ✓)" : "Verify to Get Full Access"}
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
          className="sr-only pointer-events-none"
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
            if (!otpInput) (() => { try { const inp = document.querySelector("input[type=tel], input[placeholder*=\"Mobile\"], input[placeholder*=\"8700\"]") as HTMLInputElement; if (inp?.value) localStorage.setItem("gvnd_verified_phone", "+91" + inp.value.replace(/[^0-9]/g, "").slice(-10)); } catch {} setShowVerifyModal(false); })();
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
                  (() => { try { const inp = document.querySelector("input[type=tel], input[placeholder*=\"Mobile\"], input[placeholder*=\"8700\"]") as HTMLInputElement; if (inp?.value) localStorage.setItem("gvnd_verified_phone", "+91" + inp.value.replace(/[^0-9]/g, "").slice(-10)); } catch {} setShowVerifyModal(false); })();
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
                      (() => { try { const inp = document.querySelector("input[type=tel], input[placeholder*=\"Mobile\"], input[placeholder*=\"8700\"]") as HTMLInputElement; if (inp?.value) localStorage.setItem("gvnd_verified_phone", "+91" + inp.value.replace(/[^0-9]/g, "").slice(-10)); } catch {} setShowVerifyModal(false); })();
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
                  onClick={() => (() => { try { const inp = document.querySelector("input[type=tel], input[placeholder*=\"Mobile\"], input[placeholder*=\"8700\"]") as HTMLInputElement; if (inp?.value) localStorage.setItem("gvnd_verified_phone", "+91" + inp.value.replace(/[^0-9]/g, "").slice(-10)); } catch {} setShowVerifyModal(false); })()}
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
                    Listening for Carrier Loopback... (SMS bhejte hi auto-verify hoga)
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
                    (() => { try { const inp = document.querySelector("input[type=tel], input[placeholder*=\"Mobile\"], input[placeholder*=\"8700\"]") as HTMLInputElement; if (inp?.value) localStorage.setItem("gvnd_verified_phone", "+91" + inp.value.replace(/[^0-9]/g, "").slice(-10)); } catch {} setShowVerifyModal(false); })();
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

      <section className="pt-3 pb-8">
        <button
          type="button"
          className="min-h-11 w-full rounded-xl border border-danger/40 bg-danger/10 text-sm font-semibold text-danger hover:bg-danger/20 active:scale-95 transition-all"
          onClick={() => {
            localStorage.removeItem("gvnd_onboarded_v1");
            window.location.reload();
          }}
        >
          Logout
        </button>
      </section>
    </div>
  );
}

export function Hub({ snap, eng, onGroup }: { snap: Snap; eng: MeshEngine; onGroup: () => void }) {
  const [showShareModal, setShowShareModal] = useState(false);
  const [hotspotSsid, setHotspotSsid] = useState("GVND-Connect-Hotspot");
  const [hotspotPass, setHotspotPass] = useState("");
  const localUrl = (((typeof window !== "undefined" && (window as any).AndroidBridge?.getHostUrl?.()) || getLocalHostShareUrl() || "Hotspot Off (Pehle Hotspot On Karein)"));

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
        <div className="mt-3 overflow-hidden rounded-2xl border border-primary/30 bg-bg/60 shadow-md">
          <img
            src="/gvnd-mesh-banner.gif"
            alt="100% Secure Offline Mesh & Decentralized Network"
            className="h-auto w-full object-cover"
          />
        </div>
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

