/*! WhaleLife「嗓子」插件页：引擎启停 + 语音参数 + 自动念，一页管完。 */

export async function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: any) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

const bool = (v: any) => v === true || v === "on" || v === "true";
const text = (v: any) => String(v ?? "").trim();

/** 返回 { top, gsv }：顶层是语音参数，gsv 是服务进程那一组。 */
export function sanitize(input: any): { top: Record<string, unknown>; gsv: Record<string, unknown> } {
  const raw = input && typeof input === "object" ? input : {};
  // 页面提交的是 { top, gsv } 两段；直接 POST 平铺字段也认。
  const nested = raw.top && typeof raw.top === "object" ? raw.top : null;
  const nestedGsv = raw.gsv && typeof raw.gsv === "object" ? raw.gsv : null;
  const src: any = nested || nestedGsv ? { ...(nested ?? {}), ...(nestedGsv ?? {}) } : raw;
  const top: Record<string, unknown> = {};
  const gsv: Record<string, unknown> = {};

  for (const key of ["enabled", "auto_start", "stop_on_exit"]) {
    if (key in src) {
      const target = key === "enabled" ? top : gsv;
      target[key] = bool(src[key]);
    }
  }
  if ("url" in src) {
    const value = text(src.url);
    if (value) top.url = value.replace(/\/+$/, "");
  }
  if ("ref_audio" in src) top.ref_audio = text(src.ref_audio);
  if ("prompt_text" in src) top.prompt_text = text(src.prompt_text);
  if ("text_lang" in src) {
    const value = text(src.text_lang) || "zh";
    if (/^[A-Za-z_]{2,12}$/.test(value)) top.text_lang = value;
  }
  if ("prompt_lang" in src) {
    const value = text(src.prompt_lang) || "zh";
    if (/^[A-Za-z_]{2,12}$/.test(value)) top.prompt_lang = value;
  }
  if ("speed" in src) {
    const n = Number(src.speed);
    if (Number.isFinite(n)) top.speed = Math.min(2, Math.max(0.5, Math.round(n * 10) / 10));
  }
  if ("voice" in src) {
    const value = text(src.voice);
    if (!value || /^[A-Za-z0-9_.-]{1,64}$/.test(value)) top.voice = value;
  }
  if ("voice_name" in src) {
    const value = text(src.voice_name);
    if (!value || /^[^\s]{1,40}$/.test(value)) top.voice_name = value;
  }
  if ("voices" in src) {
    const list = Array.isArray(src.voices) ? src.voices : [];
    top.voices = list
      .filter((one: any) => one && typeof one === "object")
      .map((one: any) => ({
        name: text(one.name).slice(0, 40),
        ref_audio: text(one.ref_audio),
        prompt_text: text(one.prompt_text),
        prompt_lang: /^[A-Za-z_]{2,12}$/.test(text(one.prompt_lang)) ? text(one.prompt_lang) : "zh",
      }))
      .filter((one: any) => one.name && one.ref_audio)
      .slice(0, 20);
  }
  if ("sample_steps" in src) {
    const n = Number(src.sample_steps);
    if (Number.isFinite(n)) top.sample_steps = Math.min(32, Math.max(0, Math.round(n)));
  }
  if ("max_chars" in src) {
    const n = Number(src.max_chars);
    if (Number.isFinite(n)) top.max_chars = Math.min(200, Math.max(40, Math.round(n)));
  }
  if ("engine" in src) {
    const value = text(src.engine);
    if (value === "local" || value === "deepseek") top.engine = value;
    else if (/^tts:[A-Za-z0-9_.-]{1,64}$/.test(value)) top.engine = value;
  }
  if ("sync_default_refer" in src) top.sync_default_refer = bool(src.sync_default_refer);
  if ("auto_read" in src) top.auto_read = bool(src.auto_read);
  if ("auto_scope" in src) {
    const value = text(src.auto_scope).toLowerCase();
    if (value === "f9" || value === "all" || value === "lead") top.auto_scope = value;
  }
  if ("cloud_url" in src) {
    const value = text(src.cloud_url);
    if (value) top.cloud_url = value.replace(/\/+$/, "");
  }
  if ("cloud_model" in src) top.cloud_model = text(src.cloud_model);
  if ("cloud_path" in src) {
    const value = text(src.cloud_path);
    if (value) top.cloud_path = value.startsWith("/") ? value : "/" + value;
  }
  if ("cloud_key" in src) top.cloud_key = text(src.cloud_key);
  if ("cloud_voice" in src) {
    const value = text(src.cloud_voice);
    if (/^[a-z0-9_.-]{2,32}$/i.test(value)) top.cloud_voice = value;
  }

  if ("exe" in src) gsv.exe = text(src.exe);
  if ("cwd" in src) gsv.cwd = text(src.cwd);
  if ("log" in src) gsv.log = text(src.log);
  if ("host" in src) {
    const value = text(src.host);
    if (/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) gsv.host = value;
  }
  if ("port" in src) {
    const n = Math.round(Number(src.port));
    if (Number.isFinite(n) && n >= 1 && n <= 65535) gsv.port = n;
  }
  if ("start_wait_ms" in src) {
    const n = Math.round(Number(src.start_wait_ms));
    if (Number.isFinite(n)) gsv.start_wait_ms = Math.min(600_000, Math.max(10_000, n));
  }
  if ("args" in src) {
    const raw = src.args;
    const list = Array.isArray(raw)
      ? raw.map((one: any) => text(one)).filter(Boolean)
      : text(raw).split(/\s+/).filter(Boolean);
    gsv.args = list.slice(0, 32);
  }
  return { top, gsv };
}

const STYLE = `
.panel-body .pg-row{display:block;margin:0}
.panel-body .pg-label{display:block!important;font-size:15px!important;font-weight:700!important;color:inherit;margin:0 0 10px;line-height:1.45}
.panel-body .pg-row input[type=text],.panel-body .pg-row input[type=password],.panel-body .pg-row input[type=number],.panel-body .pg-row select{display:block;width:100%;box-sizing:border-box;padding:10px 13px;font-size:14px;line-height:1.4;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-family:inherit}
.panel-body .pg-row input:focus,.panel-body .pg-row select:focus{outline:none;border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.12)}
.panel-body .pg-row input:disabled,.panel-body .pg-row select:disabled{opacity:.55;cursor:not-allowed}
.panel-body .pg-check{display:flex!important;align-items:center;gap:10px}
.panel-body .pg-check .pg-label{margin:0}
.panel-body .pg-pair{display:grid;grid-template-columns:1fr 1fr;column-gap:36px;margin:0 0 30px}
.panel-body .pg-pair>.pg-item:only-child{grid-column:1/-1}
.panel-body .pg-item{min-width:0}
.panel-body .pg-hint{margin:10px 0 0;font-size:12px;line-height:1.65;color:#797e8c}
.pg-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
.pg-state{margin:0 0 22px;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.7;border:1px solid transparent}
.pg-state.on{background:rgba(5,150,105,.10);border-color:rgba(5,150,105,.35);color:#047857}
.pg-state.off{background:rgba(127,127,127,.10);border-color:rgba(127,127,127,.35);color:#5f6673}
.pg-result{margin:22px 0 0;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;border:1px solid transparent}
.pg-result.wait{background:rgba(124,92,255,.10);border-color:rgba(124,92,255,.35);color:#6d4aff}
.pg-result.ok{background:rgba(5,150,105,.10);border-color:rgba(5,150,105,.35);color:#047857}
.pg-result.err{background:rgba(220,38,38,.10);border-color:rgba(220,38,38,.35);color:#b91c1c}
.pg-tip{margin:0 0 26px;padding:14px 16px;border-radius:10px;font-size:13px;line-height:1.75;background:rgba(124,92,255,.08);border:1px solid rgba(124,92,255,.25);color:#6d4aff}
.pg-sub{margin:0 0 14px;font-size:12px;font-weight:700;color:#797e8c;letter-spacing:.06em}
.pg-btns{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 10px}
.pg-hint .btn{margin-left:8px;padding:3px 10px;font-size:12px}
.pg-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-right:auto}
.pg-tab{padding:7px 13px;font-size:14px;line-height:1.2;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;font-family:inherit;opacity:.7}
.pg-tab:hover{opacity:1;background:rgba(127,127,127,.10)}
.pg-tab.on{opacity:1;font-weight:700;background:rgba(124,92,255,.12);border-color:rgba(124,92,255,.35);color:#6d4aff}
.pg-pg{display:block}
.pg-pg[hidden]{display:none!important}
@media(max-width:760px){.panel-body .pg-pair{grid-template-columns:1fr}}
`;

const VOICE_NAMES: Record<string, string> = {
  stella: "stella　海星，女声",
  tide: "tide　暗潮，男声",
};

function engineOptions(current: any, list: any[], esc: (v: any) => string): string {
  const now = String(current ?? "").trim() || "local";
  const rows = [
    `<option value="local"${now === "local" ? " selected" : ""}>本地 gsv.cpp（自己的音色）</option>`,
    `<option value="deepseek"${now === "deepseek" ? " selected" : ""}>DeepSeek 云端（stella / tide）</option>`,
  ];
  for (const one of Array.isArray(list) ? list : []) {
    const id = String(one?.id ?? "");
    if (!id) continue;
    const value = "tts:" + id;
    const label = String(one?.name ?? "") || String(one?.model ?? "") || id;
    rows.push(`<option value="${esc(value)}"${value === now ? " selected" : ""}>文字转语音 · ${esc(label)}（${esc(String(one?.provider ?? ""))}）</option>`);
  }
  if (now !== "local" && now !== "deepseek" && !rows.some((row) => row.includes(`value="${esc(now)}"`))) {
    rows.push(`<option value="${esc(now)}" selected>（当前配置里没有这条：${esc(now)}）</option>`);
  }
  return rows.join("");
}

function voiceOptions(current: any): string {
  const now = String(current ?? "stella").trim() || "stella";
  const list = ["stella", "tide"];
  if (!list.includes(now)) list.push(now);
  return list
    .map((one) => `<option value="${one}"${one === now ? " selected" : ""}>${VOICE_NAMES[one] ?? one}</option>`)
    .join("");
}

export function renderPage(cfg: any, status: any = {}, ttsList: any[] = []): string {
  const c = cfg ?? {};
  const g = c.gsv ?? {};
  const esc = (value: any) =>
    String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  const open = status?.open === true;
  const pids = Array.isArray(status?.pids) ? status.pids.join(", ") : "";
  const stateText = open
    ? `在运行（${esc(g.host)}:${esc(g.port)}）${pids ? "，PID：" + esc(pids) : ""}`
    : `没在运行（${esc(g.host)}:${esc(g.port)} 连不上）`;
  const argsText = Array.isArray(g.args) ? g.args.join(" ") : String(g.args ?? "");
  const engineNow = String(c.engine ?? "local");
  const cloud = engineNow !== "local";
  const fromModel = engineNow.startsWith("tts:");
  const scopeNow = c.auto_scope === "all" || c.auto_scope === "lead" ? c.auto_scope : "f9";
  const autoOn = c.auto_read === true;
  const earOn = status?.earInstalled === true;
  const dis = cloud ? "" : " disabled";
  const voiceList: any[] = Array.isArray((c as any).voices) ? ((c as any).voices as any[]) : [];
  const voiceNow = String((c as any).voice_name || "");
  const voiceOpts = ['<option value="">（不用库，用下面手填的）</option>']
    .concat(
      voiceList.map(
        (one: any) =>
          `<option value="${esc(one?.name ?? "")}"${String(one?.name ?? "") === voiceNow ? " selected" : ""}>${esc(one?.name ?? "")}</option>`,
      ),
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>嗓子 · 配置</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>${STYLE}</style></head><body>
<main class="page">
<section class="panel">
<div class="panel-header">
  <h2>嗓子</h2>
  <div class="pg-tabs">
    <button class="pg-tab on" type="button" data-pg="pg-say">念出来</button>
    <button class="pg-tab" type="button" data-pg="pg-voice">音色</button>
    <button class="pg-tab" type="button" data-pg="pg-engine">引擎</button>
    <button class="pg-tab" type="button" data-pg="pg-cloud">云端</button>
  </div>
  <div class="pg-actions"><button class="btn primary" type="button" id="save">保存</button></div>
</div>
<div class="panel-body">

<div class="pg-state ${open ? "on" : "off"}" id="state">${stateText}</div>

<div class="pg-btns">
  <button class="btn primary" type="button" id="start">启动服务</button>
  <button class="btn" type="button" id="stop">停止服务</button>
  <button class="btn" type="button" id="refresh">刷新状态</button>
  <button class="btn" type="button" id="try">念一句试试</button>
</div>

<section class="pg-pg" id="pg-say">
<p class="pg-tip">念之前会自动去掉：代码块、表格、链接、Windows 路径（换成「（略）」）、图片标记。<br>长回复按句切成多段，一段念完再念下一段。</p>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><div class="pg-check"><input type="checkbox" id="enabled"${c.enabled ? " checked" : ""}><label class="pg-label" for="enabled">允许念出来（总开关）</label></div><p class="pg-hint">关掉就完全不出声，聊天页的「念」按钮也不响。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="engine">合成引擎</label><select id="engine">${engineOptions(c.engine, ttsList, esc)}</select><p class="pg-hint">本地用你给的参考音色，不用等网络；云端字段在「云端」那页。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><div class="pg-check"><input type="checkbox" id="auto_read"${autoOn ? " checked" : ""}><label class="pg-label" for="auto_read">自动念</label></div><p class="pg-hint">勾上才自动出声，默认不勾。关着的时候网页回复不念，聊天页那颗「念」按钮照旧能点。</p></div><div class="pg-row" style="margin-top:12px"><label class="pg-label" for="auto_scope">什么时候出声</label><select id="auto_scope"${autoOn ? "" : " disabled"}><option value="f9"${scopeNow === "f9" ? " selected" : ""}${earOn ? "" : " disabled"}>只有按 F9 说话才念${earOn ? "" : "（「耳朵」没启用，选不了）"}</option><option value="all"${scopeNow === "all" ? " selected" : ""}>每一句回复都念（网页打字也念）</option><option value="lead"${scopeNow === "lead" ? " selected" : ""}>只念回复的开头第一段</option></select><p class="pg-hint">${earOn ? "同一个回复只念一次：按 F9 说的由「耳朵」交过来念，网页里打的由这里自己念。" : "「耳朵」插件现在没启用，所以「每一句回复都念」和「只念开头第一段」这两档可用。"}</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="speed">语速</label><input type="number" id="speed" step="0.1" min="0.5" max="2" value="${esc(c.speed)}"><p class="pg-hint">0.5 到 2.0，默认 1.1。云端不支持调语速。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="voice">模型（音色名）</label><input type="text" id="voice" value="${esc(c.voice)}" placeholder="留空 = 引擎当前的"><p class="pg-hint">点「检测引擎里有哪些」会问一次引擎。留空就用引擎自己加载的那个，换引擎重启后可能悄悄变。</p><div class="pg-btns" style="margin:8px 0 0"><button class="btn" type="button" id="probe_model">检测引擎里有哪些</button></div><div class="pg-hint" id="model_out" style="margin:6px 0 0"></div></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="sample_steps">采样步数</label><input type="number" id="sample_steps" step="1" min="0" max="32" value="${esc(c.sample_steps)}"><p class="pg-hint">实测 4 步和 8 步听不出差别，16 步底噪反而更高。填 0 = 不传，用引擎默认。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="url">合成地址</label><input type="text" id="url" value="${esc(c.url)}"><p class="pg-hint">默认 http://127.0.0.1:9880，端口要和「引擎」那页的「端口」一致。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="max_chars">每段最多几个字</label><input type="number" id="max_chars" step="10" min="40" max="200" value="${esc(c.max_chars)}"><p class="pg-hint">太长容易读出怪音，一般 110 就够。</p></div></div>
</div>

<div class="pg-item"><div class="pg-row"><div class="pg-check"><input type="checkbox" id="sync_default_refer"${c.sync_default_refer !== false ? " checked" : ""}><label class="pg-label" for="sync_default_refer">自动把当前音色设成引擎默认</label></div><p class="pg-hint">勾上后：启动服务或第一次念话时，先让引擎记住这套参考音，之后念话不再传音频路径和对应文本（少两个逐字要对上的字段）。引擎重启会丢，插件会重设一次；关掉它就每轮都带着传。</p></div></div>
</section>

<section class="pg-pg" id="pg-voice" hidden>
<p class="pg-tip">库里的一套音色 = 一段参考音频 + 它在说什么。引擎对着这两样学音色，所以那行文本要跟音频逐字对应，写错音色会飘。</p>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="voice_name">当前音色</label><select id="voice_name">${voiceOpts}</select><p class="pg-hint">选中的那套参考音。选「不用库」就用下面手填的那对。改动要保存。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="refs">参考音目录里的文件</label><select id="refs"><option value="">（点「读目录」）</option></select><p class="pg-hint">从启动参数 --allow-path 的目录里读。挑一个会填进下面表单。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="new_voice">音色名</label><input type="text" id="new_voice" placeholder="比如 furina"></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="new_ref">参考音频</label><input type="text" id="new_ref" placeholder="K:\\...\\refs\\xxx.wav"></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="new_text">这段音频说的是什么</label><input type="text" id="new_text"><p class="pg-hint">要跟音频逐字对应，写错音色会飘。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label">操作</label><div class="pg-btns" style="margin:0"><button class="btn" type="button" id="reload_refs">读目录</button><button class="btn" type="button" id="save_voice">存成音色</button><button class="btn" type="button" id="del_voice">删掉选中的</button></div><p class="pg-hint" id="voice_list">—</p></div></div>
</div>

<p class="pg-sub">手填 · 不用音色库时用这对</p>
<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="ref_audio">参考音频</label><input type="text" id="ref_audio" value="${esc(c.ref_audio)}"><p class="pg-hint">念的时候照着这个音色。留空则不念。目录要在启动参数 --allow-path 里。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="prompt_text">参考音频对应文本</label><input type="text" id="prompt_text" value="${esc(c.prompt_text)}"><p class="pg-hint">要跟上面的音频逐字对应，写错了音色会飘。</p></div></div>
</div>
</section>

<section class="pg-pg" id="pg-engine" hidden>
<p class="pg-hint" style="margin:0 0 26px">启动是异步的：命令发出去就返回，模型加载还要几十秒（gsv.cpp 约 25 秒），用「刷新状态」看端口通没通。停止是按端口 ${esc(g.port)} 找进程，连子进程一起结束。</p>

<p class="pg-sub">伴随行为</p>
<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><div class="pg-check"><input type="checkbox" id="auto_start"${g.auto_start ? " checked" : ""}><label class="pg-label" for="auto_start">WhaleLife 开启时自动拉起语音服务</label></div><p class="pg-hint">默认关着，手动点「启动服务」。勾上后主程序起来会检查端口，已经在跑就不重复拉起。</p></div></div>
  <div class="pg-item"><div class="pg-row"><div class="pg-check"><input type="checkbox" id="stop_on_exit"${g.stop_on_exit ? " checked" : ""}><label class="pg-label" for="stop_on_exit">关闭 WhaleLife 时一并关掉语音服务</label></div><p class="pg-hint">不勾的话，主程序退了服务还留着，下次起来直接复用。</p></div></div>
</div>

<p class="pg-sub">引擎程序（gsv_server.exe）</p>
<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="exe">引擎程序</label><input type="text" id="exe" value="${esc(g.exe)}" placeholder="...\\gsv\\gsv_server.exe"><p class="pg-hint">gsv.cpp 的 gsv_server.exe。路径写错启动会静默失败，看下面的日志。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="cwd">工作目录</label><input type="text" id="cwd" value="${esc(g.cwd)}" placeholder="...\\GSV\\runtime\\gsv"><p class="pg-hint">参数里的相对路径按这里算，留空就用程序所在目录。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="args">启动参数</label><input type="text" id="args" value="${esc(argsText)}" placeholder="--models ... --device vulkan:0 --host 127.0.0.1 --port 9880"><p class="pg-hint">空格分隔。--allow-path 必须包含参考音所在目录，否则合成会 403。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="log">日志文件</label><input type="text" id="log" value="${esc(g.log)}" placeholder="...\\logs\\gsv_9880.log"><p class="pg-hint">启动失败先看这里，输出是追加的。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="host">监听地址</label><input type="text" id="host" value="${esc(g.host)}"><p class="pg-hint">一般 127.0.0.1，只给本机用。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="port">端口</label><input type="number" id="port" step="1" min="1" max="65535" value="${esc(g.port)}"><p class="pg-hint">默认 9880，要和「念出来」那页的合成地址一致。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="start_wait_ms">等待就绪上限（毫秒）</label><input type="number" id="start_wait_ms" step="1000" min="10000" max="600000" value="${esc(g.start_wait_ms)}"><p class="pg-hint">只在需要「等它真起来」时用，默认 180 秒。</p></div></div>
</div>
</section>

<section class="pg-pg" id="pg-cloud" hidden>
<p class="pg-tip">选「本地 gsv.cpp（自己的音色）」时，这一页是灰的、填了也不生效。选「DeepSeek 云端」或某个「文字转语音」模型时才用得上。</p>

<div class="pg-pair" id="cloudrow">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="cloud_key">云端 API Key</label><input type="password" id="cloud_key" value="${esc(c.cloud_key)}" placeholder="留空就用主配置里 DeepSeek 那把"${dis || (fromModel ? " disabled" : "")}><p class="pg-hint">留空会自动读主配置里 id 含 deepseek 的 provider。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="cloud_voice">云端音色</label><select id="cloud_voice"${dis}>${voiceOptions(c.cloud_voice)}</select><p class="pg-hint">云端没给列表接口，点一下让它自己报一遍合法音色<button class="btn" type="button" id="loadvoices">读取云端音色</button></p></div></div>
</div>
</section>

<div class="pg-result" id="out" hidden></div>
</div>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const NAMES = { stella: "stella　海星，女声", tide: "tide　暗潮，男声" };
let VOICES = ${JSON.stringify(voiceList)};
function esc(one) {
  return String(one == null ? "" : one).replace(/[&<>"]/g, function (ch) {
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;";
  });
}
function voicePaint() {
  const sel = $("voice_name");
  const now = sel.value;
  sel.innerHTML = '<option value="">（不用库，用下面手填的）</option>' + VOICES.map(function (v) {
    return '<option value="' + esc(v.name) + '">' + esc(v.name) + "</option>";
  }).join("");
  sel.value = VOICES.some(function (v) { return v.name === now; }) ? now : "";
  $("voice_list").textContent = VOICES.length ? "库里有：" + VOICES.map(function (v) { return v.name; }).join("、") : "库里还是空的。";
}
function voiceSync() {
  const name = $("voice_name").value;
  const hit = VOICES.filter(function (v) { return v.name === name; })[0];
  if (!hit) return;
  $("ref_audio").value = hit.ref_audio || "";
  $("prompt_text").value = hit.prompt_text || "";
  $("new_voice").value = hit.name || "";
  $("new_ref").value = hit.ref_audio || "";
  $("new_text").value = hit.prompt_text || "";
}
async function loadRefs() {
  show("wait", "正在读参考音目录…");
  try {
    const r = await post("/plugins/voice-gsv/refs", {});
    const items = Array.isArray(r.items) ? r.items : [];
    const sel = $("refs");
    sel.innerHTML = '<option value="">（' + items.length + ' 个文件）</option>' + items.map(function (it) {
      const base = String(it.name || "").replace(/[.]wav$/i, "");
      return '<option value="' + esc(it.path) + '" data-base="' + esc(base) + '">' + esc(it.name) + (it.registered ? "（已入库）" : "") + "</option>";
    }).join("");
    const dirs = Array.isArray(r.dirs) ? r.dirs : [];
    show("ok", "读到 " + items.length + " 个参考音。目录：" + (dirs.join("；") || "（没有 --allow-path）"));
  } catch (error) {
    show("err", "读目录失败：" + (error && error.message ? error.message : error));
  }
}
function show(kind, text) {
  const box = $("out");
  box.hidden = false;
  box.className = "pg-result " + kind;
  box.textContent = text;
}
async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || value.reason || ("HTTP " + response.status));
  return value;
}
function paint(state) {
  const box = $("state");
  const open = state && state.open === true;
  box.className = "pg-state " + (open ? "on" : "off");
  box.textContent = open
    ? "在运行（" + state.host + ":" + state.port + "）" + (state.pids && state.pids.length ? "，PID：" + state.pids.join(", ") : "")
    : "没在运行（" + state.host + ":" + state.port + " 连不上）";
}
function cloudSync() {
  const value = $("engine").value;
  const isCloud = value !== "local";
  const fromModel = value.indexOf("tts:") === 0;
  $("cloud_key").disabled = !isCloud || fromModel;
  $("cloud_voice").disabled = !isCloud;
  $("loadvoices").disabled = !isCloud;
  $("cloudrow").style.opacity = isCloud && !fromModel ? "1" : "0.45";
}
$("engine").onchange = cloudSync;
cloudSync();
async function refresh() {
  try {
    const r = await post("/plugins/voice-gsv/status", {});
    paint(r.status || r);
    const at = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const live = r && r.status && r.status.open === true;
    const who = r && r.status && Array.isArray(r.status.pids) && r.status.pids.length ? "，PID：" + r.status.pids.join(", ") : "";
    const warn = r && r.voiceWarning;
    if (warn) show("err", "⚠ " + warn);
    else show("ok", "已刷新 · " + at + " · " + (live ? "在运行" + who : "没在运行"));
  } catch (error) {
    show("err", "查状态失败：" + (error && error.message ? error.message : error));
  }
}
$("refresh").onclick = () => { refresh(); };
$("start").onclick = async () => {
  show("wait", "正在拉起…");
  try {
    const r = await post("/plugins/voice-gsv/start", {});
    show("ok", r.message || "已发出启动命令。");
    setTimeout(refresh, 1500);
  } catch (error) {
    show("err", "没起成：" + (error && error.message ? error.message : error));
  }
};
$("stop").onclick = async () => {
  show("wait", "正在停…");
  try {
    const r = await post("/plugins/voice-gsv/stop", {});
    show("ok", r.message || "已停。");
    setTimeout(refresh, 1200);
  } catch (error) {
    show("err", "没停成：" + (error && error.message ? error.message : error));
  }
};
$("try").onclick = async () => {
  show("wait", "正在合成…第一次可能要等几秒");
  try {
    const r = await post("/plugins/voice-gsv/test", {});
    show("ok", r.text || "念完了。");
  } catch (error) {
    show("err", "没念成：" + (error && error.message ? error.message : error));
  }
};
$("probe_model").onclick = async () => {
  const out = $("model_out");
  out.textContent = "正在问引擎…";
  try {
    const r = await post("/plugins/voice-gsv/engine-models", {});
    if (!r.ok) { out.textContent = "没问到：" + (r.error || "未知原因"); return; }
    const names = (r.names || []).map(function (one) { return one.name; }).filter(Boolean);
    out.textContent = "";
    const head = document.createElement("span");
    head.textContent = "引擎当前：" + (r.current || "（空）") + "（" + r.elapsedMs + " ms） · 可选：";
    out.appendChild(head);
    if (!names.length) {
      out.appendChild(document.createTextNode("一个都没有"));
      return;
    }
    names.forEach(function (name, at) {
      if (at) out.appendChild(document.createTextNode(" "));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = name;
      btn.title = name === r.current ? "引擎现在加载的就是它" : "点一下填进上面的框";
      if (name === r.current) btn.style.borderColor = "#7c5cff";
      btn.onclick = function () {
        $("voice").value = name;
        head.textContent = "已填进上面的框： " + name + "（点「保存」才生效） · ";
      };
      out.appendChild(btn);
    });
  } catch (error) {
    out.textContent = "没问到：" + (error && error.message ? error.message : error);
  }
};
$("voice_name").onchange = voiceSync;
$("reload_refs").onclick = () => { loadRefs(); };
$("refs").onchange = () => {
  const opt = $("refs").selectedOptions[0];
  if (!opt || !opt.value) return;
  $("new_ref").value = opt.value;
  $("new_voice").value = opt.dataset.base || "";
  $("new_text").value = "";
};
$("save_voice").onclick = async () => {
  const name = $("new_voice").value.trim();
  const ref = $("new_ref").value.trim();
  if (!name || !ref) return show("err", "音色名和参考音频都得填。");
  const one = { name: name, ref_audio: ref, prompt_text: $("new_text").value, prompt_lang: "zh" };
  const at = VOICES.map(function (v) { return v.name; }).indexOf(name);
  if (at >= 0) VOICES[at] = one; else VOICES.push(one);
  voicePaint();
  $("voice_name").value = name;
  voiceSync();
  show("wait", "正在保存音色…");
  await saveAll();
};
$("del_voice").onclick = async () => {
  const name = $("voice_name").value;
  if (!name) return show("err", "先在上面选一个音色。");
  if (!confirm("从库里删掉「" + name + "」？（不动那个 wav 文件）")) return;
  VOICES = VOICES.filter(function (v) { return v.name !== name; });
  voicePaint();
  show("wait", "正在保存…");
  await saveAll();
};
voicePaint();
loadRefs();
$("loadvoices").onclick = async () => {
  const select = $("cloud_voice");
  const keep = select.value;
  show("wait", "正在问云端要音色…");
  try {
    const r = await post("/plugins/voice-gsv/voices", {});
    const list = Array.isArray(r.voices) ? r.voices : [];
    if (!list.length) throw new Error("云端没给出音色");
    select.innerHTML = list.map((v) => '<option value="' + v + '">' + (NAMES[v] || v) + "</option>").join("");
    select.value = list.indexOf(keep) >= 0 ? keep : list[0];
    show("ok", "云端报了 " + list.length + " 个音色：" + list.join("、") + (r.source === "cloud" ? "（从云端读到的）" : "（默认兜底）") + "。记得点保存。");
  } catch (error) {
    show("err", "没读到：" + (error && error.message ? error.message : error));
  }
};
async function saveAll() {
  show("wait", "保存中…");
  const body = {
    top: {
      enabled: $("enabled").checked,
      sync_default_refer: $("sync_default_refer").checked,
      auto_read: $("auto_read").checked,
      auto_scope: $("auto_scope").value,
      engine: $("engine").value,
      url: $("url").value,
      ref_audio: $("ref_audio").value,
      prompt_text: $("prompt_text").value,
      speed: $("speed").value,
      voice_name: $("voice_name").value,
      voices: VOICES,
    voice: $("voice").value,
    sample_steps: $("sample_steps").value,
      max_chars: $("max_chars").value,
      cloud_key: $("cloud_key").value,
      cloud_voice: $("cloud_voice").value,
    },
    gsv: {
      auto_start: $("auto_start").checked,
      stop_on_exit: $("stop_on_exit").checked,
      exe: $("exe").value,
      cwd: $("cwd").value,
      args: $("args").value,
      log: $("log").value,
      host: $("host").value,
      port: $("port").value,
      start_wait_ms: $("start_wait_ms").value,
    },
  };
  try {
    await post("/plugins/voice-gsv/save", body);
    show("ok", "已保存。语音参数下一次念就生效；引擎参数（程序、参数、端口）下一次启动服务才用新的。");
  } catch (error) {
    show("err", "保存失败：" + (error && error.message ? error.message : error));
  }
}
$("auto_read").onchange = function () { $("auto_scope").disabled = !this.checked; };
$("save").onclick = () => { saveAll(); };
const PGTABS = Array.prototype.slice.call(document.querySelectorAll(".pg-tab"));
function pageShow(id) {
  PGTABS.forEach(function (btn) { btn.classList.toggle("on", btn.dataset.pg === id); });
  Array.prototype.forEach.call(document.querySelectorAll(".pg-pg"), function (sec) { sec.hidden = sec.id !== id; });
}
PGTABS.forEach(function (btn) { btn.onclick = function () { pageShow(btn.dataset.pg); }; });
refresh();
</script>
</body></html>`;
}
