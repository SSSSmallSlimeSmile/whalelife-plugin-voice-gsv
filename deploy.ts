/*! WhaleLife「嗓子」插件的部署检查与安装（gsv.cpp 引擎）。
 *
 * 一个插件里最费劲的不是合成，是让别人把它跑起来：引擎 exe、sidecar、七件 gguf 模型、
 * 前端三件（g2pw / bert_tokenizer / fast_langdetect）、还有 python。缺哪件，页面要说清楚。
 *
 * 能自动下的只有 GitHub release 上那个 15MB 的 win64 包（exe + dll + sidecar）。
 * 3.4G 的模型包不在 GitHub，插件不下、也不假装能下——只给清单，由人放进去。
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type DeployOpts = {
  /** 引擎 exe 的完整路径（配置里那个）。空则看 root。 */
  exe: string;
  /** 解包根目录：它下面应该是 runtime\gsv\gsv_server.exe。空则从 exe 往上推。 */
  root: string;
};

type Item = { key: string; path: string; bytes: number | null; need: number; note?: string };

/** root 下要有的东西。need 只是「小于这个数就算可疑」，不是精确值。 */
const REQUIRED: { rel: string; need: number; note?: string }[] = [
  { rel: "runtime/gsv/gsv_server.exe", need: 1_000_000 },
  { rel: "runtime/gsv/ggml-vulkan.dll", need: 1_000_000 },
  { rel: "runtime/gsv/ggml.dll", need: 10_000 },
  { rel: "runtime/gsv/ggml-base.dll", need: 10_000 },
  { rel: "runtime/gsv/ggml-cpu.dll", need: 10_000 },
  { rel: "runtime/frontend/text_sidecar.py", need: 1_000 },
  { rel: "runtime/python/python.exe", need: 10_000, note: "文本前端要用的 python" },
  { rel: "runtime/models/gsv-ar-q8.gguf", need: 50_000_000 },
  { rel: "runtime/models/gsv-bert-f16.gguf", need: 500_000_000 },
  { rel: "runtime/models/gsv-hubert-f16.gguf", need: 150_000_000 },
  { rel: "runtime/models/gsv-cond-f16.gguf", need: 50_000_000 },
  { rel: "runtime/models/gsv-dit-f16all.gguf", need: 500_000_000 },
  { rel: "runtime/models/gsv-refcode.gguf", need: 4_000_000 },
  { rel: "runtime/models/gsv-vocoder-f32.gguf", need: 40_000_000 },
  { rel: "runtime/models/frontend/g2pw/g2pW.onnx", need: 400_000_000, note: "中文多音字" },
  { rel: "runtime/models/frontend/bert_tokenizer/vocab.txt", need: 10_000 },
  { rel: "runtime/models/frontend/fast_langdetect/lid.176.bin", need: 100_000_000, note: "只有 en/auto 才用到" },
];

/** 从 exe 路径推解包根：<root>\runtime\gsv\gsv_server.exe → <root>。推不出来返回空。 */
export function rootFromExe(exe: string): string {
  const p = String(exe ?? "").trim();
  if (!p || !isAbsolute(p)) return "";
  return resolve(p, "..", "..", "..");
}

export async function checkDeploy(opts: DeployOpts) {
  const rootRaw = String(opts.root ?? "").trim();
  const root = rootRaw ? resolve(rootRaw) : rootFromExe(opts.exe);
  const items: Item[] = [];
  if (!root) {
    return { ok: false, root: "", reason: "没填引擎程序，也没能从它推出解包根目录", items, missing: 0, present: 0, voices: [] as string[] };
  }
  for (const r of REQUIRED) {
    const full = join(root, r.rel);
    let bytes: number | null = null;
    try {
      const st = await stat(full);
      bytes = st.isFile() ? st.size : null;
    } catch {
      bytes = null;
    }
    items.push({ key: r.rel.split("/").pop() ?? r.rel, path: full, bytes, need: r.need, note: r.note });
  }
  const missing = items.filter((i) => i.bytes === null || i.bytes < i.need).length;
  const voices: string[] = [];
  try {
    const dir = join(root, "runtime", "models", "voices");
    for (const name of await readdir(dir)) {
      try {
        const st = await stat(join(dir, name, "manifest.json"));
        if (st.isFile()) voices.push(name);
      } catch {
        /* 没有 manifest 的目录不算一套音色 */
      }
    }
  } catch {
    /* 目录都没建，就是一套音色也没有 */
  }
  return { ok: missing === 0, root, items, missing, present: items.length - missing, voices };
}

type Job = {
  id: string;
  url: string;
  dest: string;
  root: string;
  into: string;
  bytes: number;
  total: number | null;
  phase: "download" | "verify" | "extract" | "done" | "failed";
  /** 解压前看出来的包形状。 */
  shape?: "packaged" | "flat";
  sha256?: string;
  error?: string;
  startedAt: number;
};
let job: Job | null = null;

export const deployStatus = () => (job ? { ...job } : null);

async function sha256Of(file: string) {
  const hash = createHash("sha256");
  const fh = await open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return hash.digest("hex");
}

/** 下载到 dest，.part 续传；给了 sha 就校验。返回最终字节数。 */
async function downloadTo(url: string, dest: string, sha: string | undefined, onProgress: (n: number, total: number | null) => void) {
  await mkdir(dirname(dest), { recursive: true });
  const part = dest + ".part";
  let start = 0;
  try {
    start = (await stat(part)).size;
  } catch {
    start = 0;
  }
  const headers: Record<string, string> = { "user-agent": "whalelife-voice-gsv", accept: "application/octet-stream" };
  if (start > 0) headers.range = `bytes=${start}-`;
  const res = await fetch(url, { headers, redirect: "follow" });
  let append = false;
  let total: number | null = null;
  if (res.status === 206) {
    append = true;
    const m = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
    total = m ? Number(m[1]) : null;
  } else if (res.status === 416) {
    // 服务器说范围不合法：多半 .part 其实已经完整，当作下完，交给校验判。
    append = true;
    total = start;
  } else if (res.ok) {
    if (start > 0) {
      // 服务器不认 Range，只能从头来。旧分片先废掉，别拼出脏文件。
      await rm(part, { force: true });
      start = 0;
    }
    const len = res.headers.get("content-length");
    total = len ? Number(len) : null;
  } else {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText || ""}`.trim());
  }
  if (!res.body) throw new Error("这个地址没给响应体");

  let got = start;
  const out = createWriteStream(part, { flags: append ? "a" : "w" });
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      got += value.length;
      if (!out.write(value)) await new Promise<void>((done) => out.once("drain", () => done()));
      onProgress(got, total);
    }
  } finally {
    await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())));
  }
  if (total !== null && got < total) throw new Error(`下载不完整：${got}/${total} 字节`);
  if (sha) {
    const want = sha.replace(/^sha256:/i, "").toLowerCase();
    const have = await sha256Of(part);
    if (have !== want) {
      await rm(part, { force: true });
      throw new Error(`校验不符：期望 ${want.slice(0, 12)}…，实际 ${have.slice(0, 12)}…（这份分片已删）`);
    }
  }
  await rm(dest, { force: true });
  await rename(part, dest);
  return got;
}

function extractZip(zip: string, into: string) {
  return new Promise<void>((ok, fail) => {
    const ps = [
      "$ErrorActionPreference='Stop'",
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`,
    ].join("; ");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`解压失败（${code}）：${err.trim().slice(0, 300)}`))));
  });
}

/** 只读地列一遍 zip 里的名字。用 .NET 的 ZipFile，不落临时解压目录。 */
async function listZipEntries(zip: string): Promise<string[]> {
  const out = join(tmpdir(), `gsv-zip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const q = (v: string) => v.replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$z=[IO.Compression.ZipFile]::OpenRead('${q(zip)}')`,
    "try { $n=@($z.Entries | ForEach-Object { $_.FullName }) } finally { $z.Dispose() }",
    `[IO.File]::WriteAllLines('${q(out)}', $n, [Text.UTF8Encoding]::new($false))`,
  ].join("; ");
  await new Promise<void>((ok, fail) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`读不了这个包的目录（${code}）：${err.trim().slice(0, 200)}`))));
  });
  let text = "";
  try {
    text = await readFile(out, "utf8");
  } finally {
    await rm(out, { force: true });
  }
  return text.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
}

export type ZipShape = {
  /** packaged：自己带 runtime/ 前缀（官方完整包）；flat：平铺的 exe（GitHub 那个 15MB 包）。 */
  kind: "packaged" | "flat";
  /** 条目外面还套了几层目录，解压后要跳过这一段。 */
  strip: string;
  entries: number;
};

/** 从名字列表判断包形状。判不出来返回 null——那种包不该往盘上写。 */
export function pickZipShape(rawNames: string[]): ZipShape | null {
  // PowerShell 的 Compress-Archive 用反斜杠当分隔符，不符合 zip 规范但很常见。一律归一。
  const names = rawNames.map((n) => n.replace(/\\/g, "/"));
  const shallow = (pre: string) => pre.split("/").filter(Boolean).length <= 1;
  for (const n of names) {
    const i = n.indexOf("runtime/");
    if (i < 0) continue;
    const pre = n.slice(0, i);
    if (!shallow(pre)) continue;
    return { kind: "packaged", strip: pre, entries: names.length };
  }
  const exe = "gsv_server.exe";
  for (const n of names) {
    if (!n.toLowerCase().endsWith(exe)) continue;
    const pre = n.slice(0, n.length - exe.length);
    if (!shallow(pre)) continue;
    return { kind: "flat", strip: pre, entries: names.length };
  }
  return null;
}

/** 把 src 下的东西并进 dest：同名覆盖，dest 里多出来的（音色、自己放的模型）一律不动。 */
async function mergeMove(src: string, dest: string) {
  await mkdir(dest, { recursive: true });
  for (const name of await readdir(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    const sf = await stat(from);
    let dt: any = null;
    try {
      dt = await stat(to);
    } catch {
      dt = null;
    }
    if (sf.isDirectory() && dt?.isDirectory()) {
      await mergeMove(from, to);
      continue;
    }
    await rm(to, { recursive: true, force: true });
    await rename(from, to);
  }
}

export type InstallRequest = {
  url?: string;
  sha256?: string;
  root: string;
  extract?: boolean;
  /** 本地已经下好的 zip：给这个就不联网，直接校验 + 解压。 */
  zip?: string;
  /** 解压到哪。省略就是 root。引擎包是平铺的 exe+dll，得落到 root\runtime\gsv 才跟完整包一个形状。 */
  into?: string;
};

/** 起一个后台任务：下载（或直接用本地 zip）→ 校验 → 解压。立刻返回 id。 */
export function startInstall(req: InstallRequest) {
  if (job && job.phase !== "done" && job.phase !== "failed") throw new Error("已经有一个部署任务在跑");
  const root = resolve(String(req.root ?? "").trim() || ".");
  const id = "dep-" + Date.now().toString(36);
  const url = String(req.url ?? "").trim();
  const localZip = String(req.zip ?? "").trim();
  if (!url && !localZip) throw new Error("既没给下载地址，也没给本地 zip");
  const into = resolve(String(req.into ?? "").trim() || root);
  job = { id, url: url || localZip, dest: localZip, root, into, bytes: 0, total: null, phase: "download", sha256: req.sha256, startedAt: Date.now() };
  const cur = job;
  void (async () => {
    try {
      let zip = localZip;
      if (url) {
        const name = (() => {
          try {
            return decodeURIComponent(new URL(url).pathname.split("/").pop() || "gsv.zip");
          } catch {
            return "gsv.zip";
          }
        })();
        zip = join(dirname(root), name);
        cur.dest = zip;
        await downloadTo(url, zip, req.sha256, (n, total) => {
          cur.bytes = n;
          cur.total = total;
        });
      } else {
        if (!existsSync(zip)) throw new Error(`本地包不存在：${zip}`);
        cur.bytes = (await stat(zip)).size;
        cur.total = cur.bytes;
        if (req.sha256) {
          cur.phase = "verify";
          const want = req.sha256.replace(/^sha256:/i, "").toLowerCase();
          const have = await sha256Of(zip);
          if (have !== want) throw new Error(`校验不符：期望 ${want.slice(0, 12)}…，实际 ${have.slice(0, 12)}…`);
        }
      }
      if (req.extract !== false) {
        cur.phase = "extract";
        // 先看清楚包里是什么，再动盘。判不出来就一个字节都不写。
        const shape = pickZipShape(await listZipEntries(zip));
        if (!shape) {
          throw new Error("这个包不像 gsv.cpp 的引擎包：里面既没有 runtime/ 目录，也没有 gsv_server.exe。目标目录没动过。");
        }
        cur.shape = shape.kind;
        // 完整包自带 runtime/，落到解包根；平铺的引擎包得塞进 runtime\\gsv。
        const target = shape.kind === "packaged" ? root : join(root, "runtime", "gsv");
        cur.into = target;
        // 解到同级临时目录，验完形状再搬。搬的是 rename，失败最多留下临时目录，不会覆盖到一半。
        const staging = join(dirname(root), `.voice-gsv-incoming-${cur.id}`);
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        try {
          await extractZip(zip, staging);
          const real = join(staging, shape.strip);
          const anchor = shape.kind === "packaged" ? join(real, "runtime", "gsv", "gsv_server.exe") : join(real, "gsv_server.exe");
          if (!existsSync(anchor)) {
            throw new Error(`包解开了，但里面找不到 ${shape.kind === "packaged" ? "runtime\\gsv\\gsv_server.exe" : "gsv_server.exe"}。目标目录没动过。`);
          }
          await mergeMove(real, target);
        } finally {
          await rm(staging, { recursive: true, force: true }).catch(() => {});
        }
      }
      cur.phase = "done";
    } catch (error: any) {
      cur.phase = "failed";
      cur.error = error?.message ?? String(error);
    }
  })();
  return { id, root, into };
}

/** 只读一遍本地 zip 的 sha256，给「我手上这个包对不对」用。 */
export async function hashLocal(zip: string) {
  const p = resolve(String(zip ?? "").trim());
  const st = await stat(p);
  if (!st.isFile()) throw new Error("不是文件");
  return { path: p, bytes: st.size, sha256: await sha256Of(p) };
}

/** GitHub 上能自动下的那个包：15MB，只有 exe + 三个 ggml dll。sidecar、python、模型、音色都不在里面。 */
export const ENGINE_ASSET = {
  tag: "v0.1.3",
  url: "https://github.com/KakaruHayate/gsv.cpp/releases/download/v0.1.3/gsv.cpp-windows-x64-vulkan.zip",
  sha256: "f083aaa28cef019880aaf63e473083a56fb743a250dd9f6ac972652000e2920e",
  bytes: 15146625,
};
