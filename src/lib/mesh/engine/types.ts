import {
  DEFAULT_HUB_KEY,
  type CallLog,
  type Contact,
  type Group,
  type Msg,
  type Peer,
  type Post,
  type PublicIdentity,
} from "@/lib/mesh/model";

export type Via = "mail" | "bc" | "rtc";

export type Env = {
  v: 1;
  id: string;
  kind: "hello" | "dm" | "receipt" | "typing" | "edit" | "delete" | "feed" | "call" | "chunk";
  from: string;
  fromName: string;
  to?: string;
  key?: JsonWebKey;
  sig?: string;
  payload: unknown;
  ttl?: number;       // Max hops allowed
  hopPath?: string[]; // Routing trace
};

export type CallBody = {
  action: "offer" | "answer" | "ice" | "hangup" | "reject";
  callId: string;
  mode?: "voice" | "video";
  pin?: string;
  trusted?: boolean;
  reason?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export type WireMsg = Msg & { mediaData?: string };

export type IncomingCall = {
  callId: string;
  from: string;
  name: string;
  mode: "voice" | "video";
  sdp: RTCSessionDescriptionInit;
};

export type LiveCall = {
  callId: string;
  tag: string;
  name: string;
  mode: "voice" | "video";
  direction: "in" | "out";
  phase: "ringing" | "connected";
  seconds: number;
  mic: boolean;
  cam: boolean;
  volume: number;
  loopback: boolean;
};

export type Snap = {
  me: PublicIdentity;
  chats: Record<string, Msg[]>;
  contacts: Contact[];
  groups: Group[];
  posts: Post[];
  hidden: string[];
  blocked: string[];
  muted: string[];
  starred: string[];
  callLogs: CallLog[];
  peers: Peer[];
  pins: { uid: string; label: string }[];
  typing: { thread: string; name: string; until: number } | null;
  toast: string | null;
  incoming: IncomingCall | null;
  call: LiveCall | null;
  rtcPeers: number;
  outbox: number;
  urls: Record<string, string>;
  mediaTick: number;
  hubKey: string;
};

const EMPTY_ME: PublicIdentity = {
  name: "GVND Connect",
  handle: "gvnd",
  hub: "mrt",
  discriminator: "00000000",
  globalId: "@gvnd@mrt#00000000",
  bio: "",
  secretPin: "0000",
  publicKey: {},
  verification: { verified: false, type: "none", level: 0 },
};

export const EMPTY_SNAP: Snap = {
  me: EMPTY_ME,
  chats: {},
  contacts: [],
  groups: [],
  posts: [],
  hidden: [],
  blocked: [],
  muted: [],
  starred: [],
  callLogs: [],
  peers: [],
  pins: [],
  typing: null,
  toast: null,
  incoming: null,
  call: null,
  rtcPeers: 0,
  outbox: 0,
  urls: {},
  mediaTick: 0,
  hubKey: DEFAULT_HUB_KEY,
};

