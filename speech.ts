/*! 念话用的纯函数：文本清洗、口语化、分段、WAV 头修补、URL 拼接。
 * 从原「嘴巴」插件原样搬过来，行为一个字没改。只有副作用（合成、播放）留在 index.ts。
 */

const DIGIT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const UNIT = ["", "十", "百", "千"];

/** 逐位读：9880 → 九八八零，2026 → 二零二六。 */
function readByDigit(s: string): string {
  return [...s].map((ch) => DIGIT[Number(ch)] ?? ch).join("");
}

/** 1–3 位的数值读法：31 → 三十一，4 → 四。 */
function readSmall(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 999) return readByDigit(s);
  if (n === 0) return "零";
  if (n < 10) return DIGIT[n];
  if (n < 20) return "十" + (n % 10 ? DIGIT[n % 10] : "");
  let out = "";
  const str = String(n);
  for (let i = 0; i < str.length; i++) {
    const d = Number(str[i]);
    const pos = str.length - i - 1;
    if (d === 0) {
      if (out && !out.endsWith("零") && str.slice(i + 1).replace(/0/g, "")) out += "零";
      continue;
    }
    out += DIGIT[d] + UNIT[pos];
  }
  return out;
}

/** 一段阿拉伯数字读成中文：4.3 → 四点三，9880 → 九八八零，0.4.3 → 零点四点三。 */
function readNumber(s: string): string {
  return s
    .split(".")
    .map((part, i) => (i === 0 && part.length < 4 ? readSmall(part) : readByDigit(part)))
    .join("点");
}

/** 字母在中文里的近似读音，用于被中文包住的单个字母。 */
const LETTER: Record<string, string> = {
  A: "诶", B: "必", C: "西", D: "迪", E: "伊", F: "艾弗", G: "吉", H: "艾尺",
  I: "艾", J: "杰", K: "开", L: "艾勒", M: "艾姆", N: "艾恩", O: "欧", P: "皮",
  Q: "扣", R: "阿尔", S: "艾斯", T: "替", U: "优", V: "维", W: "达不溜",
  X: "艾克斯", Y: "歪", Z: "贼德",
};

/** 默认不改写、原样交给引擎的英文缩写。单位按英文词组念，比「吉字节」自然。页面上能改这份名单。 */
export const KEEP_DEFAULT = ["GB", "MB", "KB", "TB", "GiB", "MiB", "KiB"];

/** 常见单位与缩写的口语读法，长的放前面，先吃掉。 */
const WORDS: [RegExp, string][] = [
  [/\bGiB\b/g, "吉字节"], [/\bMiB\b/g, "兆字节"], [/\bKiB\b/g, "千字节"],
  [/\bGB\b/g, "吉字节"], [/\bMB\b/g, "兆字节"], [/\bKB\b/g, "千字节"], [/\bTB\b/g, "太字节"],
  [/\bkHz\b/g, "千赫兹"], [/\bHz\b/g, "赫兹"], [/\bfps\b/g, "帧每秒"],
  [/\bms\b/g, "毫秒"], [/\bsec\b|\bsecs\b/g, "秒"],
  [/\bUTF-8\b/g, "优替艾弗八"], [/\bJSON\b/g, "杰森"], [/\bAPI\b/g, "接口"],
];

/** 附近（前后各 8 个字符）有没有汉字。用来判断这一段该按中文读还是留给引擎按原文读。 */
const CJK_RE = /[\u4e00-\u9fa5]/;
function nearChinese(source: string, at: number, len: number): boolean {
  const win = source.slice(Math.max(0, at - 8), at) + source.slice(at + len, at + len + 8);
  return CJK_RE.test(win);
}

/**
 * 中英混排会念得既不像中文也不像英文——引擎把整段判成中文，字母就按中文音素硬拼。
 * 这里只改「送进去会读歪」的那几类：数字、单位缩写、盘符、被中文包住的单个字母。
 * 成句的英文词不动，那是内容，改了更糟。
 * 数字和单位只在贴着中文时才改写，纯英文上下文原样留着，把中英混排的活儿还给引擎。
 */
export function normalizeForSpeech(input: string, keep: string[] = KEEP_DEFAULT): string {
  let s = String(input ?? "");
  // 白名单里的词先抠出来换成不会撞任何规则的占位符，处理完再原样放回。
  const stash: string[] = [];
  const words = (Array.isArray(keep) ? keep : [])
    .map((one) => String(one ?? "").trim())
    .filter(Boolean)
    .slice(0, 40);
  if (words.length) {
    const esc = (w: string) => w.split("").map((ch) => "^$.*+?()[]{}|-".includes(ch) ? String.fromCharCode(92) + ch : ch).join("");
    const re = new RegExp("(?<![A-Za-z0-9])(?:" + words.map(esc).join("|") + ")(?![A-Za-z0-9])", "g");
    s = s.replace(re, (m: string) => {
      stash.push(m);
      return "\u0001" + "\u0002".repeat(stash.length) + "\u0001";
    });
  }
  for (const [re, to] of WORDS) {
    s = s.replace(re, (m: string, offset: number) => (nearChinese(s, offset, m.length) ? to : m));
  }
  s = s.replace(/\b([A-Z])\s*盘/g, "本地磁盘");
  s = s.replace(/(\d):(\d)/g, "$1点$2");
  s = s.replace(/(\d)\s*[-~]\s*(\d)/g, "$1到$2");
  // 前后紧贴字母数字的数字段不动：v5turbo 里的 5 不能变成「五」。
  s = s.replace(/(?<![A-Za-z0-9.])(?:\d+(?:\.\d+)+|\d+)(?![A-Za-z0-9])/g, (m: string, offset: number) =>
    nearChinese(s, offset, m.length) ? readNumber(m) : m,
  );
  s = s.replace(
    /(?<![\u4e00-\u9fa5A-Za-z])([A-Z])(?![\u4e00-\u9fa5A-Za-z]*[A-Za-z])/g,
    (m: string, ch: string, offset: number) => (nearChinese(s, offset, m.length) ? LETTER[ch] ?? ch : m),
  );
  s = s.replace(/([\u4e00-\u9fa5])\s*([A-Z])\s*(?=[\u4e00-\u9fa5])/g, (_m, pre: string, ch: string) => pre + (LETTER[ch] ?? ch));
  s = s.replace(/→/g, "变成");
  s = s.replace(/\u0001(\u0002+)\u0001/g, (_m: string, marks: string) => stash[marks.length - 1] ?? "");
  return s;
}

/** 去掉念出来会变成噪音的东西。 */
export function forSpeech(input: string, keep: string[] = KEEP_DEFAULT): string {
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
  s = normalizeForSpeech(s, keep);
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
