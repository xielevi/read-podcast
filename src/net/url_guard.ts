/**
 * 出站 URL 的公网校验（Worker 侧的 SSRF 防御纵深）：只放行 http(s)、不含凭据、主机名不是本机 / 内网名、
 * 字面量 IP 不落在私网 / 保留网段（含 IPv4-mapped、NAT64、6to4 内嵌的 IPv4）。
 *
 * 这里只看 URL 字面量，不解析 DNS；Workers 本身也到达不了私网。权威的拦截在真正抓取的一侧
 * （转录服务逐跳复核重定向）。RSS / 封面 / 音频三类出站 URL 共用这一份规则，调用方把拒绝原因
 * 翻译成各自的错误类型。
 */

export type UrlRejection = "invalid" | "protocol" | "credentials" | "non_public_host";

export type PublicUrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRejection };

function ipv4ToInt(host: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some(part => part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedIPv4(value: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const start = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((start & mask) >>> 0);
  });
}

/** 把 IPv6 字面量展开成 8 个 16 位组；无法解析返回 null。 */
function parseIPv6(host: string): number[] | null {
  let text = host;
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (embedded) {
    const v4 = ipv4ToInt(embedded[1]);
    if (v4 === null) return null;
    text = `${text.slice(0, embedded.index)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const numbers = groups.map(group => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}

function isBlockedIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embeddedV4 = (((g6 << 16) | g7) >>> 0);
  if (groups.every(value => value === 0)) return true; // ::
  if (groups.slice(0, 7).every(value => value === 0) && g7 === 1) return true; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isBlockedIPv4(embeddedV4); // IPv4-mapped
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isBlockedIPv4(embeddedV4); // IPv4-compatible
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isBlockedIPv4(embeddedV4); // NAT64
  if (g0 === 0x2002) return isBlockedIPv4((((g1 << 16) | g2) >>> 0)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa"];

/** 检查一个 URL 是否是可以出站访问的公网 http(s) 地址。 */
export function checkPublicHttpUrl(raw: string): PublicUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "protocol" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  return isPublicHost(url.hostname) ? { ok: true, url } : { ok: false, reason: "non_public_host" };
}

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) return false;
  if (host.includes(":")) {
    const groups = parseIPv6(host);
    return groups !== null && !isBlockedIPv6(groups);
  }
  const v4 = ipv4ToInt(host);
  if (v4 !== null) return !isBlockedIPv4(v4);
  // 单标签主机名（intranet、printer）只可能解析到内网
  return host.includes(".");
}
