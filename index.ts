/*! WhaleLife「嗓子」插件：GPT-SoVITS（gsv.cpp）语音合成 + 进程托管 + 念出来。
 *
 * 0.3.0 起把原「嘴巴」插件合进来，一个插件管五件事：
 *   引擎启停（gsv_server.exe）· 单句合成（speak）· 文本清洗分段 + 播放（mouth_say）
 *   网页端的「念」按钮（/plugins/voice-gsv/say）· 聊天自动念（auto_scope）
 * 合成地址与参考音沿用原先两个插件里调好的参数，字段名跟 api_v2 一致，gsv.cpp 也认。
 */
import type { Context } from "../../core/context.ts";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, open, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, renderPage, sanitize } from "./ui.ts";
import { probeVoices } from "./voices.ts";
import { forSpeech, splitForSpeech, fixWavHeader, joinUrl, KEEP_DEFAULT } from "./speech.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  enabled: true,
  /** 自动念总开关。默认关着：勾上才自动出声。 */
  auto_read: false,
  auto_scope: "f9",
  url: "http://127.0.0.1:9880",
  ref_audio: "",
  prompt_text: "或许我也曾向往过这种力量，但那更像是一种讽刺。",
  text_lang: "zh",
  prompt_lang: "zh",
  speed: 1.1,
  voice: "",
  voice_name: "",
  sync_default_refer: true,
  voices: [] as { name: string; ref_audio: string; prompt_text?: string; prompt_lang?: string }[],
  sample_steps: 4,
  max_chars: 110,
  /** 句子级流水：第一句合成完就出声，播的时候下一句已经在合成。默认开。 */
  pipe_sentences: true,
  /** 新的一段进来就掐掉正在念的那句（连排队一起清）。默认关，保持排队的老行为。 */
  interrupt_reading: false,
  /** 原样交给引擎、不做中文化的英文缩写（页面上能改）。默认那几个单位按英文词组念。 */
  pronounce_keep: [...KEEP_DEFAULT] as string[],
  /** 强制按中文念的词，写「词」或「词=读法」；同一词两边都写时这一份优先。 */
  pronounce_cn: ["ms=毫秒", "px=像素", "pt=磅", "cm=厘米", "mm=毫米"] as string[],
  timeout_ms: 120_000,
  out_dir: join(HERE, "data", "out"),
  engine: "local",
  cloud_model: "",
  cloud_path: "/tools/tts",
  cloud_url: "https://api.deepseek.com/v1/tools/tts",
  cloud_key: "",
  cloud_voice: "stella",
  cloud_format: "wav",
  cloud_timeout_ms: 60_000,
  gsv: {
    auto_start: false,
    stop_on_exit: true,
    exe: "",
    args: [] as string[],
    cwd: "",
    host: "127.0.0.1",
    port: 9880,
    log: "",
    start_wait_ms: 180_000,
    sidecar_port: 0,
    sidecar_exe: "",
    sidecar_script: "",
  },
};

type GsvConfig = typeof DEFAULTS.gsv;
type Config = Omit<typeof DEFAULTS, "gsv"> & { gsv: GsvConfig };

const safe = <A, S>(fn: (args: A, session: S) => Promise<unknown> | unknown) =>
  async (args: A, session: S) => {
    try {
      return await fn(args, session);
    } catch (error: any) {
      return `错误：${error?.message ?? String(error)}`;
    }
  };

/** 装了「耳朵」插件没有：它注册 ear_* 那几个工具。只给页面上「只 F9」那一档做依据。 */
async function hasEar(tools: any): Promise<boolean> {
  try {
    const list = (await tools.list()) as any[];
    return Array.isArray(list) && list.some((one) => String(one?.name ?? "").startsWith("ear_"));
  } catch {
    return false;
  }
}

function replyJson(res: any, code: number, body: any) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

/** 正在播的那个 powershell 子进程。PlaySync 会一直阻塞到播完，所以掐它就是掐声音。 */
let CURRENT_PLAY: ChildProcess | null = null;

function playFile(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`],
      { windowsHide: true, timeout: 180_000 },
      (error) => {
        if (CURRENT_PLAY === child) CURRENT_PLAY = null;
        if (error) reject(new Error(`播放失败：${error.message}`));
        else resolve();
      },
    );
    CURRENT_PLAY = child;
  });
}

/** 等一个子进程真的退出，超时返回 false。 */
function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode !== null || child.signalCode !== null), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 掐掉正在念的那一句。被终止的播放会让 playFile reject。
 * 先按手里的子进程句柄杀——那是自己 spawn 出来的，不靠 PID 猜；200ms 没退才走 taskkill 兜底，
 * 那条按 PID 打，所以把映像名钉成 powershell.exe，免得打到系统把同一个号发给了别人。
 * 全程异步：原来是 execFileSync，最坏能把事件循环卡住 8 秒。
 */
async function stopPlayback(): Promise<boolean> {
  const child = CURRENT_PLAY;
  CURRENT_PLAY = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  try { child.kill(); } catch {}
  if (await waitExit(child, 200)) return true;
  if (!child.pid) return false;
  // 兜底：连子树一起。实测只调 child.kill() 有时那句 PlaySync 还活着，新的一句上来会两句叠着响。
  await new Promise<void>((resolve) => {
    execFile(
      "taskkill.exe",
      ["/T", "/F", "/PID", String(child.pid), "/FI", "IMAGENAME eq powershell.exe"],
      { windowsHide: true, timeout: 8_000 },
      () => resolve(),
    );
  });
  return true;
}

/** 端口有没有人在听。只看 TCP 连通，不问对方是谁。 */
function portOpen(port: number, host = "127.0.0.1", timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (v: boolean) => {
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** 按端口找 PID。netstat 是系统自带的，不依赖 PowerShell 编码。 */
function pidByPort(port: number, timeout = 15_000): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile("netstat.exe", ["-ano", "-p", "TCP"], { windowsHide: true, timeout }, (err, stdout) => {
      if (err || !stdout.trim()) return reject(new Error(`无法确认端口 ${port} 的监听进程：${err?.message ?? "netstat 没有输出"}`));
      const pids = new Set<number>();
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        if (cols[3] !== "LISTENING") continue;
        const local = cols[1] ?? "";
        if (!local.endsWith(`:${port}`)) continue;
        const pid = Number(cols[4]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      resolve([...pids]);
    });
  });
}

/** 文本前端（text_sidecar）的位置。引擎自己不会拉它，以前是手动起的，重启就哑。
 *  端口：显式配置 > 引擎参数里 --sidecar 那个 > 9882
 *  程序/脚本：显式配置 > 从 gsv_server.exe 往上找带 python\python.exe 的那层 */
function sidecarPlan(cfg: GsvConfig) {
  const args = Array.isArray(cfg.args) ? cfg.args : [];
  const at = args.indexOf("--sidecar");
  const spec = at >= 0 ? String(args[at + 1] ?? "") : "";
  const fromSpec = Number((spec.split(":").pop() ?? "").trim()) || 0;
  const port = Number(cfg.sidecar_port) || fromSpec || 9882;

  let exe = String(cfg.sidecar_exe ?? "").trim();
  let script = String(cfg.sidecar_script ?? "").trim();
  if (!exe || !script) {
    let dir = cfg.exe ? dirname(cfg.exe) : "";
    for (let i = 0; i < 4 && dir; i += 1) {
      const py = join(dir, "python", "python.exe");
      const sc = join(dir, "frontend", "text_sidecar.py");
      if (existsSync(py) && existsSync(sc)) {
        if (!exe) exe = py;
        if (!script) script = sc;
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return { port, exe, script };
}

async function gsvStatus(cfg: GsvConfig) {
  const open = await portOpen(cfg.port, cfg.host);
  const pids = open ? await pidByPort(cfg.port).catch(() => []) : [];
  const plan = sidecarPlan(cfg);
  const sidecarOpen = plan.port ? await portOpen(plan.port, cfg.host) : false;
  return { open, pids, sidecar: { port: plan.port, open: sidecarOpen, ready: Boolean(plan.exe && plan.script) } };
}

/** 拉起文本前端。跟引擎是两个进程，各自独立停。 */
async function sidecarStart(cfg: GsvConfig, logger: { info: (m: string) => void; warn: (m: string) => void }) {
  const plan = sidecarPlan(cfg);
  if (await portOpen(plan.port, cfg.host)) return { started: false, reason: "已经在跑了", port: plan.port };
  if (!plan.exe || !plan.script) return { started: false, reason: "找不到文本前端的程序或脚本（设置里「文本前端」那两格）", port: plan.port };

  let handle: any = null;
  if (cfg.log) {
    await mkdir(dirname(cfg.log), { recursive: true }).catch(() => {});
    await writeFile(cfg.log, `[${new Date().toISOString()}] ===== text_sidecar start =====\n`, { flag: "a" }).catch(() => {});
    handle = await open(cfg.log, "a").catch(() => null);
  }
  const child = spawn(plan.exe, [plan.script, "--port", String(plan.port)], {
    cwd: dirname(plan.script),
    windowsHide: true,
    detached: true,
    stdio: ["ignore", handle ? handle.fd : "ignore", handle ? handle.fd : "ignore"],
  });
  try {
    await once(child, "spawn");
    child.unref();
  } catch (error) {
    logger.warn(`文本前端启动失败：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  logger.info(`文本前端启动中，端口 ${plan.port}，pid=${child.pid ?? "?"}`);
  return { started: true, pid: child.pid ?? null, port: plan.port };
}

/** 拉起服务。detached，输出追加进日志，不等模型加载完。 */
async function gsvStart(cfg: GsvConfig, logger: { info: (m: string) => void; warn: (m: string) => void }) {
  if (await portOpen(cfg.port, cfg.host)) {
    // 引擎活着、文本前端单独死了的情况：补起来，别当成"什么都不用做"
    const sidecar = await sidecarStart(cfg, logger).catch((error: any) => ({
      started: false,
      reason: String(error?.message ?? error),
      port: 0,
    }));
    return { started: false, reason: "已经在跑了", sidecar };
  }
  if (!cfg.exe) throw new Error("没配引擎可执行文件（设置里「引擎程序」那一格）");

  let handle: any = null;
  if (cfg.log) {
    await mkdir(dirname(cfg.log), { recursive: true }).catch(() => {});
    handle = await open(cfg.log, "a").catch(() => null);
    const stamp = `[${new Date().toISOString()}] ===== whalelife start =====\n`;
    await writeFile(cfg.log, stamp, { flag: "a" }).catch(() => {});
  }

  const child = spawn(cfg.exe, cfg.args, {
    cwd: cfg.cwd || dirname(cfg.exe),
    windowsHide: true,
    detached: true,
    stdio: ["ignore", handle ? handle.fd : "ignore", handle ? handle.fd : "ignore"],
  });
  try {
    await once(child, "spawn");
    child.unref();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  logger.info(`GSV 启动中，pid=${child.pid ?? "?"}`);
  const sidecar = await sidecarStart(cfg, logger).catch((error: any) => ({
    started: false,
    reason: String(error?.message ?? error),
    port: 0,
  }));
  return { started: true, pid: child.pid ?? null, sidecar };
}

/** 进程映像名。tasklist 读不到（已经退了、权限不够）就回空串。 */
function imageName(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err || !stdout) return resolve("");
      const line = stdout.split(/\r?\n/).map((one) => one.trim()).find(Boolean) ?? "";
      const hit = /^"([^"]+)"/.exec(line);
      resolve(hit ? hit[1] : "");
    });
  });
}

/**
 * 按端口杀，但先认人：映像名对不上就不动它（端口被别的程序占着也不能一锅端）。
 * 杀完回查端口，真空了才算停——taskkill 失败不再谎报「已结束」。
 */
async function killPort(port: number, match: ((name: string) => boolean) | null) {
  const pids = await pidByPort(port);
  const refused: { pid: number; name: string; port: number }[] = [];
  const targets: number[] = [];
  for (const pid of pids) {
    const name = await imageName(pid);
    if (!name || !match || !match(name)) refused.push({ pid, name: name || "(读不到进程名)", port });
    else targets.push(pid);
  }
  for (const pid of targets) {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, () => {});
  }
  const deadline = Date.now() + 5000;
  while (targets.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(200, deadline - Date.now()))));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (!(await pidByPort(port, remaining)).length) return { stopped: true, pids: targets, refused };
  }
  return { stopped: false, pids: targets, refused };
}

/** 引擎和文本前端都停。两个端口各杀一次，主引擎先走。映像名对不上的拒绝动。 */
async function gsvStop(cfg: GsvConfig) {
  const plan = sidecarPlan(cfg);
  const want = cfg.exe ? basename(cfg.exe).toLowerCase() : "";
  const main = await killPort(cfg.port, want ? (name) => name.toLowerCase() === want : null);
  const side = plan.port && plan.port !== cfg.port ? await killPort(plan.port, (name) => /^python/i.test(name)) : { stopped: false, pids: [] as number[], refused: [] as any[] };
  return {
    stopped: main.stopped || side.stopped,
    pids: [...main.pids, ...side.pids],
    refused: [...main.refused, ...side.refused],
    sidecarStopped: side.stopped,
    sidecarPids: side.pids,
  };
}

/** 停服务的回执：杀掉的、被拒绝的都写出来，不把「没动」说成「已结束」。 */
function stopMessage(r: { stopped: boolean; pids: number[]; refused: { pid: number; name: string; port: number }[] }, cfg: GsvConfig) {
  const parts: string[] = [];
  if (r.pids.length) parts.push(`已尝试结束 PID ${r.pids.join(", ")}。${r.stopped ? "至少一个目标端口已确认释放" : "未能确认目标端口已释放，进程可能已退出"}`);
  for (const one of r.refused) parts.push(`端口 ${one.port} 上的 PID ${one.pid}（${one.name}）未通过进程识别，未结束`);
  if (!parts.length) {
    const ports = [...new Set([cfg.port, sidecarPlan(cfg).port])];
    return `端口 ${ports.join("、")} 未发现监听进程，没什么可停的`;
  }
  return parts.join("；");
}

async function waitPort(cfg: GsvConfig, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portOpen(cfg.port, cfg.host)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** 支持 ${ENV:NAME} 形式的引用，凭据本身不必写进任何配置文件 */
function expand(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const hit = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  return hit ? String(process.env[hit[1]] ?? "").trim() : raw;
}

/** 云端没单独填 key 时，读主配置里 id 含 deepseek 的 provider。 */
function mainConfigKey(): string {
  try {
    const file = join(HERE, "..", "..", "config", "config.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(raw?.providers) ? raw.providers : [];
    const found = list.find((one: any) => String(one?.id ?? "").includes("deepseek"));
    return expand(found?.api_key);
  } catch {
    return "";
  }
}

export async function apply(ctx: Context) {
  let cfg: Config = { ...DEFAULTS } as Config;
  let g: GsvConfig = DEFAULTS.gsv;
  let busy = false;
  // 队列项带语速和音色：排队的那句不该被按默认参数重念一遍。
  const queue: { text: string; speed?: number; voice?: string }[] = [];
  /** 每次「掐断」加一。合成/播放的循环带着本轮号，号一变就知道自己该收手了。 */
  let gen = 0;
  const CANCELLED = "念话被打断";

  async function reload() {
    const saved = await ctx.config.read<any>("config.json").catch(() => null);
    const flat = saved && typeof saved === "object" ? saved : {};
    cfg = {
      ...DEFAULTS,
      ...flat,
      gsv: { ...DEFAULTS.gsv, ...((flat.gsv as Partial<GsvConfig>) ?? {}) },
    };
    cfg.pronounce_keep = normalizeKeep((cfg as any).pronounce_keep);
    cfg.pronounce_cn = normalizeKeep((cfg as any).pronounce_cn);
    g = cfg.gsv;
    return cfg;
  }
  await reload();

  /** 白名单归一：数组或逗号/空白分隔的字符串都认，去空去重、截断。 */
  function normalizeKeep(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,，;；\s]+/) : [];
    const out: string[] = [];
    for (const one of list) {
      const word = String(one ?? "").trim();
      if (!word || out.includes(word)) continue;
      out.push(word.slice(0, 24));
      if (out.length >= 40) break;
    }
    return out;
  }

  /** 占一个新代际号，同时掐掉旧的：取号是同步的，掐是异步的。
   *  取号必须排在 await 之前——两条并发的请求要是等 cancelSpeech 加完号才去读 gen，
   *  会读到同一个号，两边的检查一起放行，结果是两句一起响。 */
  function beginSpeech(): { mine: number; halted: Promise<void> } {
    const mine = ++gen;
    queue.length = 0;
    return { mine, halted: stopPlayback().then(() => undefined, () => undefined) };
  }

  /** 掐掉正在念的和排队的。gen 加一，正在跑的那轮合成/播放循环到下一个 await 点就知道收手。
   *  返回的 promise 等到播放子进程真的没了才落定——要接着开新的一句，就得等它。 */
  function cancelSpeech(): Promise<void> {
    gen += 1;
    queue.length = 0;
    return stopPlayback().then(() => undefined, () => undefined);
  }

  /** 等当前持有者收手，同时让更新的请求淘汰正在等待的请求。 */
  async function waitIdle(mine: number, ms = 4000) {
    const deadline = Date.now() + ms;
    while (busy && mine === gen && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  function pump() {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        while (queue.length) {
          const next = queue.shift() as { text: string; speed?: number; voice?: string };
          try {
            await speakText(next.text, next.speed, next.voice);
          } catch (error: any) {
            const msg = String(error?.message ?? error);
            if (msg === CANCELLED) ctx.logger?.info?.("嗓子：这一段被新的一句顶掉了");
            else ctx.logger?.warn?.(`嗓子自动念失败：${msg}`);
          }
        }
      } finally {
        busy = false;
      }
    })();
  }

  /**
   * 一段的第一行是不是列表项。原来那版要求标记后面必须跟空白或结尾，
   * 于是「1、改代码」这种中文顿号直接接字的写法漏判了——整条清单被当成正文念。
   */
  const LIST_LINE = /^(?:[-*+•·](?:\s|$)|\d{1,2}[.)](?:\s|$)|\d{1,2}、(?![ \t]*\d))/;
  const RULE_LINE = /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
  const LIST_INDENT = /^(?: {2}|\t)/;

  /**
   * 取回复的第一段。空行分段，跳过只有代码/表格的块；开头是清单就跳过清单、念清单后面那段正文。
   * 一段都取不到返回空串。
   */
  function leadParagraph(input: string): string {
    let inList = false;
    for (const block of String(input ?? "").split(/\n\s*\n/)) {
      const lines = block.split(/\r?\n/);
      const first = lines.find((line) => line.trim() && !RULE_LINE.test(line.trim()));
      if (first === undefined) {
        inList = false;
        continue;
      }
      inList = inList && LIST_INDENT.test(first);
      let inBody = false;
      const body = lines.filter((line) => {
        const trimmed = line.trim();
        if (RULE_LINE.test(trimmed)) return false;
        if (inBody) return true;
        if (LIST_LINE.test(trimmed)) {
          inList = true;
          return false;
        }
        if (inList && LIST_INDENT.test(line)) return false;
        inList = false;
        inBody = true;
        return true;
      }).join("\n");
      const clean = forSpeech(body, cfg.pronounce_keep, cfg.pronounce_cn).trim();
      if (!clean) continue;
      const meat = clean.replace(/代码略|表格略/g, "").replace(/[\s\p{P}\p{S}]/gu, "");
      if (meat.length < 2) continue;
      return clean;
    }
    return "";
  }

  function enqueue(text: string, speed?: number, voice?: string) {
    if (cfg.interrupt_reading && (busy || queue.length)) {
      // 勾了「新的顶掉旧的」：掐掉正在念的，排队的也一起清，然后只念这一句。
      // 这里不等它落定——pump 起来还要先合成（几百毫秒），等合成完那个播放进程早没了。
      void cancelSpeech();
    }
    enqueuePending(text, speed, voice);
  }

  /** 已处理过打断的请求直接入队，保留原来的代际号与待播队列。 */
  function enqueuePending(text: string, speed?: number, voice?: string) {
    if (queue.length >= 2) queue.shift();
    queue.push({ text, speed, voice });
    pump();
  }

  /** 云端合成要的三样：地址、key、音色。配了 tts 模型就用模型配置，否则用本插件自己填的。 */
  function cloudTarget() {
    const engine = String(cfg.engine ?? "local").trim();
    const id = engine.startsWith("tts:")
      ? engine.slice(4).trim()
      : String(cfg.cloud_model ?? "").trim();
    if (id) {
      const link = ctx.models.connection(id);
      const key = expand(link.api_key);
      if (!key) throw new Error(`模型配置「${link.name}」里没有可用的 key`);
      return {
        url: joinUrl(link.base_url, String(cfg.cloud_path || "/tools/tts")),
        key,
        voice: String(cfg.cloud_voice || "stella"),
        where: `模型配置「${link.name}」`,
      };
    }
    const key = expand(cfg.cloud_key) || mainConfigKey();
    if (!key) {
      throw new Error("没选 tts 模型，本插件也没填云端 Key，主配置里也找不到 deepseek 的 provider");
    }
    return {
      url: String(cfg.cloud_url || "https://api.deepseek.com/v1/tools/tts"),
      key,
      voice: String(cfg.cloud_voice || "stella"),
      where: "本插件自己填的地址",
    };
  }

  async function synthCloud(text: string) {
    const target = cloudTarget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(cfg.cloud_timeout_ms) || 60_000);
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + target.key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice_id: target.voice,
          format: String(cfg.cloud_format || "wav"),
          filter_markdown: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`云端合成失败 HTTP ${res.status}：${detail.slice(0, 160)}`);
      }
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.length < 1000) throw new Error("云端返回的音频太小，可能合成失败");
      return fixWavHeader(raw);
    } catch (error: any) {
      if (controller.signal.aborted) throw new Error("云端合成超时");
      if (typeof error?.message === "string" && error.message.startsWith("云端")) throw error;
      throw new Error(`连不上云端合成（${target.url}）：${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 按名字取一套参考音；没配名字或名字对不上，就退回顶层那对 ref_audio / prompt_text。 */
  function resolveVoice(source: any, want?: string) {
    const list: any[] = Array.isArray(source?.voices) ? source.voices : [];
    const name = String(want ?? source?.voice_name ?? "").trim();
    const hit = name ? list.find((one) => one && String(one.name || "") === name) : undefined;
    if (hit && String(hit.ref_audio || "")) {
      return {
        name: String(hit.name || ""),
        ref_audio: String(hit.ref_audio),
        prompt_text: String(hit.prompt_text ?? ""),
        prompt_lang: String(hit.prompt_lang || source?.prompt_lang || "zh"),
      };
    }
    // 显式点名某个音色但库里没有 → 报错，别静默用别的嗓子
    const asked = String(want ?? "").trim();
    if (asked) {
      const names = list.map((one) => String(one?.name || "")).filter(Boolean);
      throw new Error(`没有这个音色：${asked}。现有音色：${names.length ? names.join("、") : "（空）"}`);
    }
    return {
      name: "",
      ref_audio: String(source?.ref_audio || ""),
      prompt_text: String(source?.prompt_text || ""),
      prompt_lang: String(source?.prompt_lang || "zh"),
    };
  }

  /**
   * 配置里点名的音色，库里查不到。
   * 不报错——配置过期不该让整条语音全废——但要说出来，不能悄悄用别的嗓子。
   */
  function staleVoice(source: any): string {
    const name = String(source?.voice_name || "").trim();
    if (!name) return "";
    const list: any[] = Array.isArray(source?.voices) ? source.voices : [];
    const hit = list.find((one) => one && String(one.name || "") === name && String(one.ref_audio || ""));
    if (hit) return "";
    const names = list.map((one) => String(one?.name || "")).filter(Boolean);
    return `配置里的音色「${name}」不在库里，现在用的是顶层那对参考音。库里有：${names.length ? names.join("、") : "（空）"}。`;
  }

  /** 启动参数里的 --allow-path 目录。引擎只让读这些目录下的文件，别的路径回 403。 */
  function allowDirs(): string[] {
    const list: string[] = Array.isArray(g.args) ? (g.args as string[]) : [];
    const dirs: string[] = [];
    for (let i = 0; i < list.length - 1; i += 1) {
      if (list[i] === "--allow-path" && list[i + 1]) dirs.push(list[i + 1]);
    }
    return dirs;
  }

  function normPath(one: string): string {
    return String(one || "").replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
  }

  /** 只做字符串比较，不碰文件系统：跟 gsv_server 自己的 allow-path 判断口径一致（大小写不敏感）。 */
  function underAllowPath(path: string, dirs: string[]): boolean {
    const target = normPath(path);
    return dirs.some((dir) => {
      const base = normPath(dir);
      if (!base) return false;
      return target === base || target.startsWith(base + "\\");
    });
  }

  /**
   * 读一个 wav 的头，算出时长、采样率、静音占比。
   * 只是为了让「检查参考音」能说人话，不参与合成。读不动就返回 null。
   */
  function inspectWav(path: string) {
    try {
      const buf = readFileSync(path);
      if (buf.length < 44) return null;
      if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
      let at = 12;
      let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
      let dataAt = 0;
      let dataSize = 0;
      while (at + 8 <= buf.length) {
        const id = buf.toString("ascii", at, at + 4);
        const size = buf.readUInt32LE(at + 4);
        at += 8;
        if (id === "fmt " && at + 16 <= buf.length) {
          fmt = {
            tag: buf.readUInt16LE(at),
            channels: buf.readUInt16LE(at + 2),
            rate: buf.readUInt32LE(at + 4),
            bits: buf.readUInt16LE(at + 14),
          };
        } else if (id === "data") {
          dataAt = at;
          dataSize = Math.min(size, buf.length - at);
          break;
        }
        at += size + (size % 2);
      }
      if (!fmt || !dataAt || !dataSize || !fmt.rate || !fmt.channels) return null;
      const frameBytes = Math.max(1, (fmt.bits / 8) * fmt.channels);
      const frames = Math.floor(dataSize / frameBytes);
      const seconds = frames / fmt.rate;
      // 静音占比：20ms 一帧，看每帧 RMS 是否低于 0.5%（-46 dB）。只认 8/16 位 PCM，别的算不出就不给。
      let silence: number | null = null;
      if ((fmt.bits === 16 || fmt.bits === 8) && fmt.tag === 1) {
        const chunk = Math.max(1, Math.round(fmt.rate * 0.02));
        let silent = 0;
        let total = 0;
        for (let f = 0; f + chunk <= frames; f += chunk) {
          let sum = 0;
          for (let i = 0; i < chunk; i += 1) {
            const off = dataAt + (f + i) * frameBytes;
            for (let c = 0; c < fmt.channels; c += 1) {
              const p = off + c * (fmt.bits / 8);
              if (p + fmt.bits / 8 > buf.length) break;
              const v = fmt.bits === 16 ? buf.readInt16LE(p) / 32768 : (buf[p] - 128) / 128;
              sum += v * v;
            }
          }
          const rms = Math.sqrt(sum / (chunk * fmt.channels));
          if (rms < 0.005) silent += 1;
          total += 1;
        }
        silence = total ? silent / total : null;
      }
      return { bytes: buf.length, rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, tag: fmt.tag, seconds, silence };
    } catch {
      return null;
    }
  }

  /**
   * 检查当前这套参考音到底能不能用。只读，不落盘、不调引擎。
   * 判据都来自「引擎会怎么用这份文件」，不是审美评分。
   */
  function checkRefer(want?: string) {
    const dirs = allowDirs();
    let picked: { name: string; ref_audio: string; prompt_text: string; prompt_lang: string };
    try {
      picked = resolveVoice(cfg, want);
    } catch (error: any) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    const path = String(picked.ref_audio || "");
    const prompt = String(picked.prompt_text || "");
    const issues: { level: "fail" | "warn"; text: string }[] = [];
    const info = path ? inspectWav(path) : null;
    const exists = !!path && existsSync(path);
    const inAllow = path ? underAllowPath(path, dirs) : false;

    if (!path) issues.push({ level: "fail", text: "没配参考音频，念不了。填一个 wav 路径，或者从音色库里选一套。" });
    else if (!exists) issues.push({ level: "fail", text: "文件不存在。路径写错了，或者那个 wav 被挪走了。" });
    if (path && exists && !inAllow) {
      issues.push({
        level: "fail",
        text: dirs.length
          ? "这个文件不在启动参数的 --allow-path 里，引擎会回 403。把它的目录加进 --allow-path，或者换一个在目录里的文件。"
          : "启动参数里没有 --allow-path，引擎什么参考音都不认。先在「引擎」页的启动参数里加 --allow-path。",
      });
    }
    if (!prompt.trim()) issues.push({ level: "fail", text: "「这段音频说的是什么」是空的。引擎要拿它对齐音频，空着不出声。" });
    if (info) {
      if (info.seconds > 0 && info.seconds < 5) {
        issues.push({ level: "warn", text: `只有 ${info.seconds.toFixed(2)} 秒。太短的话模型学到的音色偏紧，10–20 秒比较稳。` });
      }
      if (info.seconds > 30) issues.push({ level: "warn", text: `${info.seconds.toFixed(1)} 秒偏长，引擎按整段对齐，长段里带停顿容易拖音。` });
      if (info.rate && info.rate < 32000) issues.push({ level: "warn", text: `采样率 ${info.rate} Hz 偏低，gsv.cpp 是 48k 那一档，会重采样。` });
      if (info.silence != null && info.silence > 0.3) {
        issues.push({ level: "warn", text: `静音占了 ${(info.silence * 100).toFixed(1)}%。参考音里空的部分，模型也会当特征学进去。` });
      }
      const chars = Array.from(prompt.trim()).length;
      if (chars && info.seconds > 0) {
        const perSec = chars / info.seconds;
        if (perSec < 1.2 || perSec > 9) {
          issues.push({
            level: "warn",
            text: `文本 ${chars} 字对 ${info.seconds.toFixed(2)} 秒音频，语速大约 ${perSec.toFixed(1)} 字/秒。正常中文是 3–6，差太远多半是那行字跟音频不是同一段，音色会飘。`,
          });
        }
      }
    } else if (path && exists) {
      issues.push({ level: "warn", text: "读不出 wav 头（不是标准 RIFF/PCM？），时长和静音占比这两项没法判断。" });
    }

    return {
      ok: true,
      name: picked.name,
      refAudio: path,
      promptText: prompt,
      promptChars: Array.from(prompt.trim()).length,
      exists,
      inAllowPath: inAllow,
      allowDirs: dirs,
      bytes: info?.bytes ?? 0,
      wav: info ? { seconds: Number(info.seconds.toFixed(3)), rate: info.rate, channels: info.channels, bits: info.bits, silence: info.silence == null ? null : Number(info.silence.toFixed(3)) } : null,
      issues,
      pass: !issues.some((one) => one.level === "fail"),
    };
  }

  /** 引擎记住的默认参考音。gsv.cpp 重启后是空的，所以这份只在同一个引擎进程期间可信。 */
  let referSync: { ok: boolean; at: number; key: string; error: string } = { ok: false, at: 0, key: "", error: "" };
  const REFER_RETRY_MS = 60_000;

  /**
   * 把当前音色设成引擎的默认参考音。设过之后 /tts 可以不带 ref_audio_path 与 prompt_text，
   * 少两个每轮都要逐字对上的字段（写错一个字音色就飘）。
   */
  async function syncRefer(force = false): Promise<boolean> {
    if (String(cfg.engine || "local") !== "local") return referSync.ok;
    if (cfg.sync_default_refer === false) return referSync.ok;
    const picked = resolveVoice(cfg);
    if (!picked.ref_audio) return referSync.ok;
    const key = `${picked.ref_audio}|${picked.prompt_text}`;
    if (!force && referSync.key === key && Date.now() - referSync.at < REFER_RETRY_MS) return referSync.ok;
    try {
      const res = await fetch(`${cfg.url}/change_refer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          refer_wav_path: picked.ref_audio,
          prompt_text: picked.prompt_text,
          prompt_lang: picked.prompt_lang,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${detail.slice(0, 80)}`.trim());
      }
      referSync = { ok: true, at: Date.now(), key, error: "" };
      ctx.logger?.info?.(`默认音色已同步到引擎：${picked.name || picked.ref_audio}`);
    } catch (error: any) {
      referSync = { ok: false, at: Date.now(), key, error: String(error?.message ?? error) };
      ctx.logger?.warn?.(`默认音色没同步上：${referSync.error}`);
    }
    return referSync.ok;
  }

  async function synth(text: string, speedOverride?: number, voiceName?: string): Promise<Buffer> {
    if (String(cfg.engine || "local") !== "local") return synthCloud(text);
    // POST JSON：整段文本不进 URL。gsv.cpp 只收 JSON 体，不收 form（实测 form 报 bad json）。
    const picked = resolveVoice(cfg, voiceName);
    if (!picked.ref_audio) throw new Error("没配参考音频，念不了");
    const base: Record<string, unknown> = {
      text,
      text_lang: cfg.text_lang,
      text_split_method: "cut5",
      media_type: "wav",
      speed_factor: Number(speedOverride ?? cfg.speed),
      ...(String(cfg.voice || "").trim() ? { voice: String(cfg.voice).trim() } : {}),
      ...(Number(cfg.sample_steps) > 0 ? { sample_steps: Number(cfg.sample_steps) } : {}),
    };
    const withRef = {
      ref_audio_path: picked.ref_audio,
      prompt_lang: picked.prompt_lang,
      prompt_text: picked.prompt_text,
    };
    const pickedKey = `${picked.ref_audio}|${picked.prompt_text}`;
    const omitRef = cfg.sync_default_refer !== false && referSync.ok && referSync.key === pickedKey;
    ctx.logger?.info?.(`合成：${omitRef ? "引擎已记默认音色，不带参考音字段" : "带参考音字段"}`);
    try {
      return await postTts({ ...base, ...(omitRef ? {} : withRef) });
    } catch (error: any) {
      if (!omitRef) throw error;
      // 引擎可能重启过，默认参考音跟着丢了。清掉标记，带上字段重打一次，顺手补一次同步。
      referSync = { ok: false, at: 0, key: "", error: "引擎可能重启过，默认音色丢了" };
      ctx.logger?.warn?.(`引擎没记住默认音色（${error?.message ?? error}），这一句改带参考音重打`);
      const buf = await postTts({ ...base, ...withRef });
      void syncRefer(true).catch(() => false);
      return buf;
    }
  }

  /** 真发一次 /tts，回音频字节。错误按类型翻成人话。 */
  async function postTts(payload: Record<string, unknown>): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(cfg.timeout_ms) || 120_000);
    try {
      const res = await fetch(`${cfg.url}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`语音合成失败 HTTP ${res.status}：${detail.slice(0, 120)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error("返回的音频太小，可能合成失败");
      return buf;
    } catch (error: any) {
      if (controller.signal.aborted) throw new Error("语音合成超时");
      if (typeof error?.message === "string" && error.message.startsWith("语音合成失败")) throw error;
      if (typeof error?.message === "string" && error.message.includes("音频太小")) throw error;
      throw new Error(`连不上 GPT-SoVITS（${cfg.url}）：${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function saveWav(buf: Buffer): Promise<string> {
    await mkdir(cfg.out_dir, { recursive: true });
    const file = join(cfg.out_dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
    await writeFile(file, buf);
    return file;
  }

  /** 单句：合成一段，落盘，可选播放。 */
  async function speakOne(text: string, wantPlay: boolean, speed?: number, voiceName?: string) {
    const mine = gen;
    const check = () => {
      if (wantPlay && mine !== gen) throw new Error(CANCELLED);
    };
    if (String(cfg.engine || "local") === "local" && !resolveVoice(cfg, voiceName).ref_audio) throw new Error("没配参考音频，念不了");
    if (String(cfg.engine || "local") === "local" && !(await portOpen(g.port, g.host))) {
      throw new Error(`GPT-SoVITS 没在跑（${g.host}:${g.port}）。用 gsv_start 起它。`);
    }
    if (String(cfg.engine || "local") === "local" && cfg.sync_default_refer !== false && !referSync.ok) {
      await syncRefer().catch(() => false);
    }
    check();
    const buf = await synth(text, speed, voiceName);
    check();
    const file = await saveWav(buf);
    if (wantPlay) {
      check();
      try {
        await playFile(file);
      } finally {
        check();
      }
    }
    return file;
  }

  /** 长文：清洗、分段、逐段合成播放。 */
  async function speakText(rawText: string, speed?: number, voiceName?: string) {
    const mine = gen;
    const check = () => {
      if (mine !== gen) throw new Error(CANCELLED);
    };
    const playSegment = async (buf: Buffer) => {
      const file = await saveWav(buf);
      check();
      try {
        await playFile(file);
      } finally {
        check();
      }
    };
    await reload();
    check();
    const engine = String(cfg.engine || "local");
    if (engine === "local" && !resolveVoice(cfg).ref_audio) throw new Error("没配参考音频，念不了");
    const clean = forSpeech(rawText, cfg.pronounce_keep, cfg.pronounce_cn);
    if (!clean) throw new Error("这段话过滤后没什么可念的");
    // 只在「清洗后只剩代码/表格占位」时才拒念。原来的门槛是剩余字数 < 6，
    // 结果「嗓子合好了。」这种五个字的短句也被当成空话挡掉了。
    const meat = clean.replace(/代码略|表格略/g, "").replace(/[，。！？；、\s]/g, "");
    if (meat.length < 2 && /代码略|表格略/.test(clean)) throw new Error("这段只有代码和表格，没什么可念的");
    const parts = splitForSpeech(clean, Number(cfg.max_chars) || 110);
    await mkdir(cfg.out_dir, { recursive: true });
    check();
    const started = Date.now();
    // 句子级流水：先把第一句合成出来，开始播的时候第二句已经在合成。
    // 等待从「每句都等」变成「只等第一句」，接缝是一个完整的 wav 顺序播，
    // 不做波形拼接——那样容易把头写坏，也不做交叉淡化。
    const piped = cfg.pipe_sentences !== false && parts.length > 1;
    if (piped) {
      const take = (text: string) => synth(text, speed, voiceName).then((buf) => ({ buf } as const), (error) => ({ error } as const));
      let pending = take(parts[0]);
      for (let i = 0; i < parts.length; i += 1) {
        const now = await pending;
        check();
        if ("error" in now) throw now.error;
        if (i + 1 < parts.length) pending = take(parts[i + 1]);
        check();
        await playSegment(now.buf);
      }
    } else {
      for (const part of parts) {
        check();
        const buf = await synth(part, speed, voiceName);
        check();
        await playSegment(buf);
      }
    }
    check();
    return {
      ok: true,
      segments: parts.length,
      piped,
      chars: clean.length,
      ms: Date.now() - started,
      preview: clean.slice(0, 60),
    };
  }

  // ── 工具 ──────────────────────────────────────────────
  ctx.tools.register({
    name: "speak",
    description:
      "把一段话合成为语音。play 为 true 时同时在本机音箱播放。返回一个 [[voice:路径]] 标记，把标记原样写进回复，页面上会出现播放器。",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要念的话，200 字以内" },
        play: { type: "boolean", description: "是否立即播放，默认 true" },
        speed: { type: "number", description: "语速倍率，默认按配置" },
        voice: { type: "string", description: "音色名（设置页里那套参考音的名字）。不填就用当前音色" },
      },
      required: ["text"],
    },
    danger: "ask",
    run: safe(async (args: any) => {
      await reload();
      const text = String(args?.text ?? "").trim().slice(0, 200);
      if (!text) throw new Error("text 不能为空");
      const wantPlay = args?.play !== false;
      const warn = staleVoice(cfg);
      if (!wantPlay) {
        const file = await speakOne(text, false, args?.speed, args?.voice);
        return `已生成：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}\n把下面这行原样放进回复就能在页面里播放：\n[[voice:${file}]]${warn ? "\n注意：" + warn : ""}`;
      }
      // 播放这条路只有一把钥匙：跟 /say、mouth_say 共用 busy。
      // 不然两边各自起一个播放器，CURRENT_PLAY 只记得住后一个，先响的那句就掐不掉了。
      if (busy || queue.length) {
        if (cfg.interrupt_reading) {
          const { mine, halted } = beginSpeech();
          await halted;
          await waitIdle(mine);
          if (mine !== gen) throw new Error(CANCELLED);
          if (busy) {
            enqueuePending(text, args?.speed, args?.voice);
            return `已排队：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}\n上一段还在收尾，这句排在它后面念。这一句没有播放入口标记——声音会出来，但页面上不会有播放器。${warn ? "\n注意：" + warn : ""}`;
          }
        } else throw new Error("上一段还在念，等它念完再试");
      }
      let file: string;
      busy = true;
      try {
        file = await speakOne(text, true, args?.speed, args?.voice);
      } finally {
        busy = false;
        if (queue.length) pump();
      }
      return `已播放：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}\n把下面这行原样放进回复就能在页面里播放：\n[[voice:${file}]]${warn ? "\n注意：" + warn : ""}`;
    }),
  });

  // 给耳朵插件调用的入口：耳朵说完话拿到回复，交到这里念出来。
  // "F9 说完自动念"这件事归耳朵，念的实现归嗓子，两个插件各管一段。
  ctx.tools.register({
    name: "mouth_say",
    description:
      "把一段文字念出来：自动去掉代码块、表格、图片标记、链接和文件路径，长文按句子分段播放。由耳朵插件在拿到回复后调用。",
    schema: {
      type: "object",
      properties: { text: { type: "string", description: "要念的内容" } },
      required: ["text"],
    },
    danger: "safe",
    run: async (args: any) => {
      await reload();
      const text = String(args?.text ?? "").trim();
      if (!text) return "没做：没有文本。";
      if (!cfg.enabled) return "嗓子的「念出来」是关着的，没出声。";
      enqueue(text);
      return "已交给嗓子念。";
    },
  });

  ctx.tools.register({
    name: "gsv_status",
    description: "查语音服务在不在：端口通不通、占用端口的 PID 是哪些。",
    schema: { type: "object", properties: {} },
    danger: "safe",
    run: async () => {
      await reload();
      const s = await gsvStatus(g);
      const sc = s.sidecar.open ? "在跑" : s.sidecar.ready ? "没起" : "没配";
      if (!s.open) return `未在运行（${g.host}:${g.port} 连不上）；文本前端${sc}（端口 ${s.sidecar.port}）`;
      return `在运行（${g.host}:${g.port}），PID：${s.pids.join(", ") || "查不到"}；文本前端${sc}（端口 ${s.sidecar.port}）`;
    },
  });

  ctx.tools.register({
    name: "gsv_start",
    description:
      "按配置拉起语音服务（gsv_server.exe），默认不等模型加载完就返回。wait 为 true 时等到端口通，最多 3 分钟。",
    schema: {
      type: "object",
      properties: { wait: { type: "boolean", description: "是否等到端口可用，默认 false" } },
    },
    danger: "ask",
    run: safe(async (args: any) => {
      await reload();
      const r = await gsvStart(g, { info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m) });
      if (!r.started) {
        const sc: any = (r as any).sidecar;
        if (sc?.started) return `引擎本来就在跑（${g.host}:${g.port}）；文本前端刚才没在，已经补起（端口 ${sc.port}）。`;
        return `没做：${r.reason}${sc && sc.reason ? `（文本前端：${sc.reason}）` : ""}`;
      }
      const scNote = r.sidecar?.started ? `，文本前端也起了（端口 ${r.sidecar.port}）` : `，文本前端没起：${r.sidecar?.reason ?? "未知"}（它不在，英文和多语种会 500）`;
      if (args?.wait !== true) return `已拉起（pid=${r.pid ?? "?"}）${scNote}，模型加载要几十秒，用 gsv_status 看。`;
      const up = await waitPort(g, g.start_wait_ms);
      if (!up) return `已拉起，但 3 分钟内端口还没通，看日志 ${g.log}`;
      const synced = await syncRefer(true);
      return `已就绪（${g.host}:${g.port}）${synced ? "，默认音色已同步" : referSync.error ? `，默认音色没同步上：${referSync.error}` : ""}`;
    }),
  });

  ctx.tools.register({
    name: "gsv_stop",
    description: "按端口找 PID 并结束语音服务进程（连子进程一起）。",
    schema: { type: "object", properties: {} },
    danger: "ask",
    run: safe(async () => {
      await reload();
      const r = await gsvStop(g);
      referSync = { ok: false, at: 0, key: "", error: "发出停止请求后需重新同步默认音色" };
      return stopMessage(r, g);
    }),
  });

  // ── 网页 ──────────────────────────────────────────────
  ctx.web.page(
    "/plugins/voice-gsv/",
    async (_req: any, res: any) => {
      await reload();
      const status = { ...(await gsvStatus(g)), host: g.host, port: g.port, earInstalled: await hasEar(ctx.tools) };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(cfg, status, ctx.models.list("tts")));
    },
    { title: "嗓子", navigation: true },
  );

  ctx.web.api("/plugins/voice-gsv/status", async (_req: any, res: any) => {
    try {
      await reload();
      const s = await gsvStatus(g);
      return replyJson(res, 200, {
        ok: true,
        status: { ...s, host: g.host, port: g.port },
        referSync: { ok: referSync.ok, at: referSync.at, error: referSync.error },
        voiceWarning: staleVoice(cfg),
      });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/voice-gsv/start", async (_req: any, res: any) => {
    try {
      await reload();
      const r = await gsvStart(g, { info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m) });
      return replyJson(res, 200, {
        ok: true,
        started: r.started,
        message: r.started
          ? `已发出启动命令（pid=${r.pid ?? "?"}）。模型加载要几十秒，稍后刷新状态。日志：${g.log}`
          : `没有启动：${r.reason}`,
      });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/voice-gsv/stop", async (_req: any, res: any) => {
    try {
      await reload();
      const r = await gsvStop(g);
      referSync = { ok: false, at: 0, key: "", error: "发出停止请求后需重新同步默认音色" };
      return replyJson(res, 200, {
        ok: true,
        stopped: r.stopped,
        message: stopMessage(r, g),
      });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  // 把当前音色设成引擎的默认参考音。引擎重启后要重设一次；正常由 speakOne / gsv_start 自动做。
  ctx.web.api("/plugins/voice-gsv/sync-refer", async (_req: any, res: any) => {
    try {
      await reload();
      const synced = await syncRefer(true);
      return replyJson(res, 200, {
        ok: true,
        synced,
        referSync: { ok: referSync.ok, at: referSync.at, error: referSync.error },
      });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  const sayHandler = async (req: any, res: any) => {
    try {
      const body = await readBody(req);
      const text = String(body?.text ?? "").trim();
      if (!text) return replyJson(res, 400, { ok: false, error: "没有要念的文字" });
      await reload();
      if (busy || queue.length) {
        if (cfg.interrupt_reading) {
          // 勾了「新的顶掉旧的」：先同步占号，再掐旧的，最后等旧的那句真没了，免得两句叠响。
          // 占号排在 await 之前，并发的两条请求才会一个留下、另一个被判 CANCELLED。
          const { mine, halted } = beginSpeech();
          await halted;
          await waitIdle(mine);
          if (mine !== gen) throw new Error(CANCELLED);
          if (busy) {
            // 旧的合成请求还没回来，收手要几百毫秒到几秒。等不到就交给队列，
            // 别让这一句凭空消失——它已经被掐掉一次了，不该再吃掉第二条。
            enqueuePending(text);
            return replyJson(res, 200, { ok: true, queued: true, text: "上一段还在收尾，这一句排在它后面接着念。" });
          }
        } else {
          ctx.logger?.warn?.("念话请求", { status: "busy", chars: text.length });
          return replyJson(res, 409, { ok: false, error: "上一段还在念，等它念完" });
        }
      }
      busy = true;
      try {
        ctx.logger?.info?.("念话请求", { status: "start", chars: text.length, preview: text.slice(0, 40) });
        const r = await speakText(text);
        ctx.logger?.info?.("念话请求", { status: "ok", chars: r.chars, segments: r.segments, ms: r.ms });
        return replyJson(res, 200, r);
      } finally {
        busy = false;
        if (queue.length) pump();
      }
    } catch (error: any) {
      const msg = String(error?.message ?? error);
      if (msg === CANCELLED) return replyJson(res, 200, { ok: false, cancelled: true, error: "这一段被新的一句顶掉了" });
      ctx.logger?.warn?.("念话请求", { status: "fail", error: msg });
      return replyJson(res, 500, { ok: false, error: msg });
    }
  };
  // 宿主只允许本插件 id 下的路由，所以没法保留旧的 /plugins/mouth/say 别名；
  // 聊天页那颗「念」按钮已经跟着改成打这一条。
  ctx.web.api("/plugins/voice-gsv/say", sayHandler);

  ctx.web.api("/plugins/voice-gsv/test", async (_req: any, res: any) => {
    try {
      await reload();
      if (busy || queue.length) {
        if (cfg.interrupt_reading) {
          const { mine, halted } = beginSpeech();
          await halted;
          await waitIdle(mine);
          if (mine !== gen) throw new Error(CANCELLED);
          if (busy) {
            enqueuePending("嗓子通了，我是勘。这句话是用来试音色的。");
            return replyJson(res, 200, { ok: true, queued: true, text: "上一段还在收尾，试音句排在它后面念。" });
          }
        } else return replyJson(res, 409, { ok: false, error: "上一段还在念，等它念完" });
      }
      busy = true;
      try {
        const r = await speakText("嗓子通了，我是勘。这句话是用来试音色的。");
        return replyJson(res, 200, { ...r, text: `念完了：${r.segments} 段，${r.chars} 字，用时 ${(r.ms / 1000).toFixed(1)} 秒。` });
      } finally {
        busy = false;
        if (queue.length) pump();
      }
    } catch (error: any) {
      if (error?.message === CANCELLED) return replyJson(res, 200, { ok: false, cancelled: true, error: "这一段被新的一句顶掉了" });
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/voice-gsv/save", async (req: any, res: any) => {
    try {
      const { top, gsv } = sanitize(await readBody(req));
      if (!Object.keys(top).length && !Object.keys(gsv).length) throw new Error("没有可保存的字段");
      const saved: any = (await ctx.config.read<any>("config.json").catch(() => null)) ?? {};
      const merged: any = { ...saved, ...top };
      if (Object.keys(gsv).length) merged.gsv = { ...((saved?.gsv as any) ?? {}), ...gsv };
      await ctx.config.save("config.json", merged);
      await reload();
      return replyJson(res, 200, { ok: true, saved: [...Object.keys(top), ...Object.keys(gsv).map((k) => "gsv." + k)] });
    } catch (error: any) {
      return replyJson(res, 400, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/voice-gsv/voices", async (_req: any, res: any) => {
    try {
      await reload();
      const found = await probeVoices(cfg, mainConfigKey());
      return replyJson(res, 200, { ok: true, ...found });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  // 参考音目录里的 wav：给页面挑音色用。只读，不落盘。
  ctx.web.api("/plugins/voice-gsv/refs", async (_req: any, res: any) => {
    try {
      await reload();
      const argsList: string[] = Array.isArray(g.args) ? g.args : [];
      const dirs: string[] = [];
      for (let i = 0; i < argsList.length - 1; i += 1) {
        if (argsList[i] === "--allow-path" && argsList[i + 1]) dirs.push(argsList[i + 1]);
      }
      if (cfg.ref_audio) dirs.unshift(dirname(cfg.ref_audio));
      const known: any[] = Array.isArray(cfg.voices) ? (cfg.voices as any[]) : [];
      const used = new Set<string>();
      const items: any[] = [];
      for (const dir of dirs) {
        if (!dir || used.has(dir)) continue;
        used.add(dir);
        const files = await readdir(dir).catch(() => [] as string[]);
        for (const name of files.sort()) {
          if (!/.wav$/i.test(name)) continue;
          const path = join(dir, name);
          const info = await stat(path).catch(() => null);
          if (!info || !info.isFile()) continue;
          const hit = known.find((one) => one && String(one.ref_audio || "") === path);
          items.push({
            name,
            path,
            bytes: info.size,
            registered: Boolean(hit),
            voice: hit ? String(hit.name || "") : "",
          });
        }
      }
      return replyJson(res, 200, {
        ok: true,
        dirs: dirs.filter((one, at) => dirs.indexOf(one) === at),
        items,
        voices: known.map((one) => ({ name: one?.name ?? "", ref_audio: one?.ref_audio ?? "", prompt_text: one?.prompt_text ?? "", prompt_lang: one?.prompt_lang ?? "" })),
        current: String(cfg.voice_name || ""),
      });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  // 打开文件夹：只给「引擎」页那两个按钮用。只认固定几个目录，不收任意路径；只弹资源管理器，不动文件。
  ctx.web.api("/plugins/voice-gsv/open-folder", async (req: any, res: any) => {
    try {
      await reload();
      const body: any = await readBody(req);
      const which = String(body?.which ?? "voices");
      const argsList: string[] = Array.isArray(g.args) ? (g.args as string[]) : [];
      let modelsDir = "";
      for (let i = 0; i < argsList.length - 1; i += 1) {
        if (argsList[i] === "--models" && argsList[i + 1]) modelsDir = argsList[i + 1];
      }
      if (!modelsDir && g.exe) modelsDir = join(dirname(g.exe), "..", "models");
      if (!modelsDir) return replyJson(res, 400, { ok: false, error: "启动参数里没有 --models，推不出模型目录。" });
      const dir = which === "root" ? modelsDir : which === "refs" ? (allowDirs()[0] || "") : join(modelsDir, "voices");
      if (!dir) return replyJson(res, 400, { ok: false, error: "没有可打开的目录：启动参数里没有 --allow-path。" });
      if (!existsSync(dir)) return replyJson(res, 404, { ok: false, error: "目录不存在：" + dir });
      spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
      return replyJson(res, 200, { ok: true, dir });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  // 检查参考音：文件在不在、在不在 --allow-path 里、时长/静音占比、文本对不对得上。只读。
  ctx.web.api("/plugins/voice-gsv/check-ref", async (req: any, res: any) => {
    try {
      await reload();
      const body = await readBody(req);
      const want = String((body as any)?.voice ?? "").trim();
      const report = checkRefer(want || undefined);
      return replyJson(res, report.ok === false ? 400 : 200, report);
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  // 问引擎：现在认识哪几个模型包（音色名）。只读，不动配置。
  ctx.web.api("/plugins/voice-gsv/engine-models", async (_req: any, res: any) => {
    try {
      await reload();
      const base = joinUrl(String(cfg.url || ""), "/models");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const started = Date.now();
      let body: any;
      try {
        const answer = await fetch(base, { signal: ctrl.signal });
        if (!answer.ok) throw new Error(`引擎回了 HTTP ${answer.status}`);
        body = await answer.json();
      } finally {
        clearTimeout(timer);
      }
      const list: any[] = Array.isArray(body?.voices) ? body.voices : [];
      return replyJson(res, 200, {
        ok: true,
        elapsedMs: Date.now() - started,
        current: String(body?.current ?? ""),
        configured: String(cfg.voice || ""),
        modelsDir: String(body?.models_dir ?? ""),
        names: list.map((one) => ({
          name: String(one?.name ?? ""),
          complete: Boolean(String(one?.ar || "") && String(one?.cond || "") && String(one?.dit || "")),
        })),
      });
    } catch (error: any) {
      const msg = error?.name === "AbortError" ? "引擎 6 秒没回话，可能没起或者卡住了。" : error?.message ?? String(error);
      return replyJson(res, 200, { ok: false, error: msg });
    }
  });

  // ── 伴随行为 ──────────────────────────────────────────
  // 网页里打字也念。F9 那几轮由耳朵调 mouth_say，这里跳过，免得念两遍。
  ctx.on("channel/reply", async (ev: any) => {
    try {
      if (ev?.role !== "assistant") return;
      if (ev?.origin?.platform === "ear") return;
      await reload();
      if (!cfg.enabled) return;
      // 自动念默认关着：勾了才出声，网页里的回复才念。
      if (!cfg.auto_read) return;
      // 「只 F9」这一档网页不念：那几轮由耳朵调 mouth_say 念，这里再念就重复了。
      const scope = String(cfg.auto_scope || "f9");
      if (scope !== "all" && scope !== "lead") return;
      // 「只念开头」那一档：截到第一段，长回复不至于念上好几分钟。
      const raw = String(ev?.text ?? "");
      const text = scope === "lead" ? leadParagraph(raw) : raw.trim();
      if (!text) return;
      enqueue(text);
    } catch (error: any) {
      ctx.logger?.warn?.(`嗓子：这一句没念成，${error?.message ?? String(error)}`);
    }
  });

  // 伴随 WhaleLife 启动：只补缺，不重复拉起。默认关着，手动点。
  ctx.on("whalelife/ready", async () => {
    await reload();
    if (!g.auto_start) return;
    if (await portOpen(g.port, g.host)) {
      ctx.logger.info(`GSV 已在运行，不重复拉起（${g.host}:${g.port}）`);
      return;
    }
    const r = await gsvStart(g, { info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m) }).catch((error: any) => ({
      started: false,
      reason: error?.message ?? String(error),
    }));
    ctx.logger.info(r.started ? `GSV 已随主程序拉起（pid=${(r as any).pid ?? "?"}）` : `GSV 未拉起：${(r as any).reason ?? "?"}`);
  });

  if (g.stop_on_exit) {
    ctx.on("whalelife/shutdown", async () => {
      try {
        const r = await gsvStop(g);
        ctx.logger.info(stopMessage(r, g));
      } catch (error: any) {
        ctx.logger.warn(`GSV 停止状态无法确认：${error?.message ?? error}`);
      }
    });
  }

  ctx.logger?.info?.(
    `嗓子就绪（引擎 ${String(cfg.engine || "local") === "local" ? "本地 " + cfg.url : "云端 " + cfg.cloud_voice}，自动念 ${cfg.auto_read ? (cfg.auto_scope === "all" ? "全部" : cfg.auto_scope === "lead" ? "只念开头" : "只 F9") : "关"}）`,
  );
}
