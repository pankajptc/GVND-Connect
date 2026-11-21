import { sameUid, uidOf, type Contact, type Group, type Peer } from "@/lib/mesh/model";

export function savePeerCacheEntry(globalId: string, name?: string, avatarUrl?: string): void {
  if (!globalId) return;
  try {
    const uKey = uidOf(globalId);
    const raw = localStorage.getItem("meshnet_peer_cache") || "{}";
    const pCache = JSON.parse(raw);
    const prev = pCache[uKey] || pCache[globalId] || {};
    const isGeneric = !name || name.startsWith("Peer ") || name === "GVND Peer";
    const cleanName = !isGeneric ? name : (prev.name || name || "Peer");
    const cleanAvatar = (avatarUrl && String(avatarUrl).length > 5) ? avatarUrl : (prev.avatarUrl || "");
    pCache[uKey] = {
      ...prev,
      name: cleanName,
      avatarUrl: cleanAvatar,
      globalId,
    };
    localStorage.setItem("meshnet_peer_cache", JSON.stringify(pCache));
  } catch (err) {
    console.warn("[mesh/presence] Failed to update peer cache:", err);
  }
}

export function resolvePeerName(
  tag: string,
  meGlobalId: string,
  meName: string,
  contacts: Contact[],
  presence: Map<string, Peer>,
  groups: Group[]
): string {
  if (sameUid(tag, meGlobalId)) return meName;
  const contact = contacts.find((c) => sameUid(c.tag, tag));
  if (contact?.name) return contact.name;
  const peer = presence.get(uidOf(tag));
  if (peer?.name && !peer.name.startsWith("Peer ") && peer.name !== "GVND Peer") return peer.name;
  try {
    const c = JSON.parse(localStorage.getItem("meshnet_peer_cache") || "{}");
    const hit = Object.entries(c).find(([k, v]) => sameUid(k, tag) || sameUid((v as { globalId?: string })?.globalId || "", tag));
    const cachedName = (hit?.[1] as { name?: string })?.name;
    if (cachedName && !cachedName.startsWith("Peer ") && cachedName !== "GVND Peer") return cachedName;
  } catch {}
  try {
    const dir = JSON.parse(localStorage.getItem("meshnet_known_directory") || "{}");
    const hit = Object.entries(dir).find(([k, v]) => sameUid(k, tag) || sameUid((v as { globalId?: string })?.globalId || "", tag));
    const dirName = (hit?.[1] as { name?: string })?.name;
    if (dirName && !dirName.startsWith("Peer ") && dirName !== "GVND Peer") return dirName;
  } catch {}
  const group = groups.find((g) => g.id === tag);
  if (group) return group.name;
  if (tag.startsWith("@") && tag.includes("@", 1)) {
    const h = tag.slice(1).split("@")[0];
    if (h && !h.startsWith("peer")) return h.charAt(0).toUpperCase() + h.slice(1);
  }
  return tag;
}
