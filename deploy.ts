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
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
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
        await mkdir(into, { recursive: true });
        await extractZip(zip, into);
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
