export interface Identity { name: string; avatar: number }
export interface Transfer {
  id: string; name: string; size: number; done: number; speed: number;
  direction: "send" | "receive";
  status: "queued" | "transferring" | "verifying" | "completed" | "failed" | "interrupted";
  peer: string; started: number; finished?: number; path?: string; error?: string;
}
export type NATType = "unknown" | "cone" | "symmetric";
export interface PunchState {
  ready: boolean;
  preparing: boolean;
  token?: string;
  encrypted: boolean;
  natType?: NATType;
  hasIPv6?: boolean;
  port?: number;
  v6Port?: number;
  v4Port?: number;
  candidates?: string[];
  stunError?: string;
  error?: string;
  sentProbes?: number;
  recvPings?: number;
  recvPongs?: number;
  peerNat?: NATType;
  peerTargets?: string[];
  lastRemote?: string;
  dialError?: string;
}
export interface TokenPreview {
  encrypted: boolean;
  natType?: NATType;
  targets?: string[];
  hasIPv6: boolean;
  hasIPv4: boolean;
}
export interface PeerState {
  self: Identity; addresses: string[]; port: number; directReady: boolean; folder: string;
  state: "offline" | "idle" | "punching" | "connecting" | "waiting" | "request" | "verify" | "connected";
  sessionMode?: "direct" | "punch";
  peer?: Identity; address?: string; code?: string; localConfirmed?: boolean; pairingVersion: number; expires?: number;
  busy: boolean; error?: string; punch?: PunchState; records: Transfer[];
}
export const avatars = ["🦦", "🦊", "🐳", "🐧", "🐿️", "🐻", "🦭", "🐱"];
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export const active = (r: Transfer) => ["queued", "transferring", "verifying"].includes(r.status);
export function progress(r: Transfer) { return r.size === 0 ? (r.status === "completed" ? 100 : 0) : Math.max(0, Math.min(100, r.done / r.size * 100)); }
