/**
 * 正式稿文件名规则（行为迁移自 mac_worker/core/naming.py，Edge 迁移后为唯一权威）。
 *
 * `buildFilenameBase` 是 writing 仓库文件名的唯一来源，必须与既有命名逐字节一致：
 * 仅替换路径分隔符/控制字符，不做 NFKC，保留全角「（）」等；
 * 一旦发生替换（或名字为空）。追加 sha256(raw)[:10] 短摘要，避免不同名字坍缩到同一文件。
 */

const UNSAFE_COMPONENT_CHARS = /[/\\\x00-\x1f\x7f]+/g;

async function sha256Prefix(value: string, length = 10): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, length);
}

/**
 * 把不可信显示文本收敛成一个确定的文件系统分量。
 * 安全名保持字节兼容既有缓存；只替换路径分隔符与控制字符，必要时追加短摘要。
 */
export async function safeStorageComponent(value: string, fallback = "item"): Promise<string> {
  const raw = String(value ?? "").trim();
  let cleaned = raw.replace(UNSAFE_COMPONENT_CHARS, "_");
  let changed = cleaned !== raw;
  if (!cleaned || cleaned === "." || cleaned === "..") {
    cleaned = fallback;
    changed = true;
  }
  if (changed) {
    const digest = await sha256Prefix(raw, 10);
    cleaned = `${cleaned.replace(/[ ._]+$/, "") || fallback}-${digest}`;
  }
  return cleaned;
}

/**
 * 生成稳定且兼容历史缓存的正式稿文件名基。
 * 数字集号（`474 标题`）与 Vol 形态（`Vol.12｜标题`）保持原生命名习惯。
 */
export async function buildFilenameBase(podcastName: string, dateStr: string, episodeTitle: string): Promise<string> {
  const title = String(episodeTitle ?? "");
  const numeric = /^(\d+)\s+([\s\S]*)/.exec(title);
  if (numeric) {
    return safeStorageComponent(`${dateStr}_${podcastName}_${numeric[1]}_${numeric[2].trim()}`, "episode");
  }
  const volume = /^(Vol\.\d+)\s*[｜|]\s*([\s\S]*)/.exec(title);
  if (volume) {
    return safeStorageComponent(`${dateStr}_${podcastName}_${volume[1]}_${volume[2].trim()}`, "episode");
  }
  return safeStorageComponent(`${dateStr}_${podcastName}_${title}`, "episode");
}
