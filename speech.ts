/*! 念话用的纯函数：文本清洗、分段、WAV 头修补、URL 拼接。
 * 从原「嘴巴」插件原样搬过来，行为一个字没改。只有副作用（合成、播放）留在 index.ts。
 */

/** 去掉念出来会变成噪音的东西。 */
export function forSpeech(input: string): string {
  let s = String(input ?? "");
  s = s.replace(/```[\s\S]*?```/g, "。代码略。");
  s = s.replace(/`[^`]*`/g, "");
  s = s.replace(/\[\[[a-z]+:[^\]]*\]\]/gi, "");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/[^\s)）]+/g, "");
  const lines: string[] = [];
  let inTable = false;
  for (const line of s.split(/\r?\n/)) {
    let t = line.trim();
    if (t.startsWith("|")) {
      if (!inTable) {
        lines.push("表格略");
        inTable = true;
      }
      continue;
    }
    inTable = false;
    if (!t) continue;
    if (/^[-:|\s]{3,}$/.test(t)) continue;
    t = t.replace(/^#{1,6}\s*/, "");
    t = t.replace(/^[-*+]\s+/, "");
    lines.push(t);
  }
  s = lines.join("，");
  s = s.replace(/[A-Za-z]:\\[^\s，。；、）)]*/g, "（略）");
  s = s.replace(/（略）([，,、\s]*（略）)+/g, "（略）");
  s = s.replace(/\s*（略）\s*/g, "（略）");
  s = s.replace(/\*\*|__|~~|\*/g, "");
  s = s.replace(/[，,]{2,}/g, "，");
  s = s.replace(/，\s*，/g, "，");
  s = s.replace(/([。！？；])，/g, "$1");
  s = s.replace(/，([。！？；])/g, "$1");
  s = s.replace(/\s+([，。！？；])/g, "$1");
  s = s.replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

/** 按句切，每段不超过 max 字，切不到就硬截，不丢字。 */
export function splitForSpeech(text: string, max: number): string[] {
  const limit = Math.max(20, max);
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    for (const ch of ["。", "！", "？", "；", "，", "、", " "]) {
      const index = rest.lastIndexOf(ch, limit);
      if (index > cut) cut = index;
    }
    if (cut < limit * 0.4) cut = limit - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter((part) => part.length > 0);
}

/** 云端是流式返回，RIFF 和 data 的长度都是 0xFFFFFFFF 占位，SoundPlayer 会拒播，得重算。 */
export function fixWavHeader(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.slice(0, 4).toString("ascii") !== "RIFF") return buf;
  const dataAt = buf.indexOf(Buffer.from("data", "ascii"), 12);
  if (dataAt < 0) return buf;
  const copy = Buffer.from(buf);
  if (copy.readUInt32LE(4) === 0xffffffff) copy.writeUInt32LE(copy.length - 8, 4);
  if (copy.readUInt32LE(dataAt + 4) === 0xffffffff) copy.writeUInt32LE(copy.length - dataAt - 8, dataAt + 4);
  return copy;
}

/** base_url 去尾斜杠、path 补前导斜杠，拼成一个地址。 */
export function joinUrl(base: string, path: string): string {
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  const p = String(path ?? "").trim();
  if (!b) return p;
  return b + (p.startsWith("/") ? p : "/" + p);
}
