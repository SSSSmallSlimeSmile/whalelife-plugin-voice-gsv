# voice-gsv · 嗓子 · GSV

语音一套管完：引擎启停（gsv.cpp）+ 单句合成（`speak`）+ 念出来（`mouth_say`、网页「念」按钮、自动念）。

0.3.0 起把原来的 `mouth`（嘴巴）插件并进来了。**为什么并**：两个插件各存一份配置，`url` / `ref_audio` / `prompt_text` / `text_lang` / `prompt_lang` / `speed` / `max_chars` / `timeout_ms` / `out_dir` 九个字段完全重复，改音色得改两处，漏一处就一个响一个哑。并完只剩一份配置。

## 来源：本机自建

**这个插件没有上游仓库。** 搬进 WhaleLife 时从 AstrBot 那边的语音能力并过来的，GPT-SoVITS 服务、参考音频、参数都出自我们自己的环境。作者公开的仓库里没有 voice。

## 文件

| 文件 | 干什么 |
|---|---|
| `index.ts` | 配置、引擎启停、合成（本地 + 云端）、播放、工具、路由、自动念 |
| `speech.ts` | 纯函数：文本清洗 `forSpeech`、分段 `splitForSpeech`、WAV 头修补 `fixWavHeader`、URL 拼接 `joinUrl`。从原 mouth 原样搬 |
| `voices.ts` | 云端音色探测（用一个非法 voice_id 让云端把合法值报出来）。原样搬 |
| `ui.ts` | 一页：状态 + 启停 + 引擎参数 + 念出来参数 + 云端 + 试念 |

## 工具（名字没改，技能和画布引用照旧）

| 工具 | 危险级 | 说明 |
|---|---|---|
| `speak` | ask | 合成一段话（200 字以内），可选本机播放，返回 `[[voice:路径]]` |
| `mouth_say` | safe | 念出来：清洗 → 分段 → 逐段合成播放。耳朵插件在拿到回复后调它 |
| `gsv_status` | safe | 服务在不在、端口通不通、PID |
| `gsv_start` | ask | 拉起引擎，默认不等加载完；`wait:true` 等到端口通（最多 3 分钟） |
| `gsv_stop` | ask | 按端口找 PID，连子进程一起结束 |

## 路由

```
GET  /plugins/voice-gsv/           配置页
POST /plugins/voice-gsv/status     引擎状态
POST /plugins/voice-gsv/start      启动引擎
POST /plugins/voice-gsv/stop       停止引擎
POST /plugins/voice-gsv/say        念一段文字（聊天页那颗「念」按钮打这条）
POST /plugins/voice-gsv/test       念一句固定的试音话
POST /plugins/voice-gsv/voices     读云端合法音色
POST /plugins/voice-gsv/refs       列参考音目录里的 wav（音色库用）
POST /plugins/voice-gsv/save       保存（body: { top: {...}, gsv: {...} }）
POST /plugins/voice-gsv/sync-refer 把当前音色设成引擎的默认参考音（见下节）
```

宿主只允许本插件 id 下的路由，所以旧的 `/plugins/mouth/say` 没有保留别名——`core/ui/app.js` 里那颗按钮已经改成打 `/plugins/voice-gsv/say`。

## 配置

`data/config.json`，顶层是语音参数，`gsv` 里是进程参数。

```json
{
  "enabled": true,
  "auto_scope": "f9",
  "url": "http://127.0.0.1:9880",
  "voice_name": "furina",
  "voices": [{ "name": "furina", "ref_audio": "...\\refs\\furina_ref23.wav", "prompt_text": "...", "prompt_lang": "zh" }],
  "ref_audio": "...\\refs\\furina_ref23.wav",
  "prompt_text": "参考音频对应的原文",
  "text_lang": "zh",
  "prompt_lang": "zh",
  "sync_default_refer": true,
  "speed": 1.1,
  "max_chars": 110,
  "timeout_ms": 120000,
  "engine": "local",
  "gsv": {
    "auto_start": false,
    "stop_on_exit": true,
    "exe": "...\\gsv\\gsv_server.exe",
    "args": ["--models", "...", "--device", "vulkan:0", "--host", "127.0.0.1", "--port", "9880",
             "--sidecar", "127.0.0.1:9882", "--allow-path", "...\\refs"],
    "cwd": "...\\GSV\\runtime\\gsv",
    "host": "127.0.0.1",
    "port": 9880,
    "log": "...\\logs\\whalelife_9880.log",
    "start_wait_ms": 180000,
    "sidecar_port": 0,
    "sidecar_exe": "",
    "sidecar_script": ""
  }
}
```

`gsv.exe` 原来叫 `gsv.python`，换 gsv.cpp 之后改名。旧配置里的 `python` 键不再被读。

**默认 `auto_start: false`**——引擎手动点。8.4G 常驻不划算，ComfyUI 也在抢内存。

**文本前端（text_sidecar）由插件一起管。** gsv_server 不会自己拉起它——以前是手动起一个
`python text_sidecar.py --port 9882`，重启就哑，英文和多语种会 500。现在 `gsv_start` 会把两个都起，`gsv_stop` 两个端口一起停。

- 端口：显式 `sidecar_port` > 引擎参数里 `--sidecar` 那个 > 9882
- 程序/脚本：从 `gsv_server.exe` 往上找带 `python\python.exe` 的那层（`<runtime>\python\python.exe`、`<runtime>\frontend\text_sidecar.py`），也可用 `sidecar_exe` / `sidecar_script` 显式指定
- 引擎活着、前端单独死了：`gsv_start` 会把前端补起来，并在回执里写明补的是哪一头

## 音色库

`voices` 是一组参考音，`voice_name` 挑当前用哪套。念的时候先按名字取，取不到就退回顶层那对 `ref_audio` / `prompt_text`——所以老的单项配置照样能用。

- 页面「音色」那页的「音色库」：下拉选当前音色；「读目录」从启动参数 `--allow-path` 的目录里列出 wav；挑一个填进表单，补上「这段音频说的是什么」，点「存成音色」。
- `speak` 工具多一个 `voice` 参数，可以单次指定，不改配置。
- `prompt_text` 必须跟音频逐字对应，写错音色会飘。这层没法自动校验，只能靠填的人。

`/refs` 只读目录，不写、不删 wav。

## 默认参考音同步（省掉两个字段）

gsv.cpp 的 `/change_refer` 能让引擎记住一套参考音，之后 `/tts` 可以**不带** `ref_audio_path` / `prompt_text`。省下来的是最容易出错的那两个字段——写错一个字音色就飘。

`sync_default_refer: true`（默认开）时：

- **第一次念话前**先同步一次（懒同步，失败 60 秒内不重试）
- `gsv_start` 带 `wait: true`、端口通了之后同步一次
- 同步成功的那套音色，念话时就不带那两个字段；换了音色会按新的 key 重新同步
- **引擎重启会丢**。这时那句会先失败一次，插件自动改带字段重打，并补一次同步——下一句就回到省略状态
- 关掉这个开关，就每轮都带字段，行为跟 0.3.2 一样

状态可以在 `/plugins/voice-gsv/status` 的 `referSync` 里看（`ok` / `at` / `error`）。

实测（2026-11-26，9880 上的 gsv.cpp）：

```text
同步后不带字段 → 200，和带字段那次逐字节相同（同文本同种子）
关掉开关      → 日志「带参考音字段」，出声正常
杀掉引擎（不经插件）再念 → 这句自动带字段重打成功，日志留一行「引擎没记住默认音色」
```

## 后端从 api_v2.py 换到 gsv.cpp

2026-11-26。原先对着 `pythonw.exe api_v2.py`，现在跑 `gsv_server.exe`（ggml/Vulkan，不吃 CUDA）。

- 接口：合成改走 **POST JSON**（`content-type: application/json`）。实测表单会报 `bad json`，只有 JSON 体认；GET query 它其实也认，但整段文本挤在 URL 里会先撞长度上限，报的还不是业务错，所以不走了。字段名跟 api_v2 一样，没改。
- 实测热启动（RTX 5070 Laptop 8G）：5 字 383–566ms、34 字 1044–1249ms、98 字 7199ms，RTF 0.11–0.45
- **坑**：`text_lang` 填 `en` / `auto` 会 500，因为 fast-langdetect 模型目录跟代码期望的路径对不上；建 junction 接上。gsv.cpp 重装会丢，得重跑：

```powershell
New-Item -ItemType Junction `
  -Path   'K:\gsv.cpp\GSV\runtime\frontend\frontend\GPT_SoVITS\pretrained_models\fast_langdetect' `
  -Target 'K:\gsv.cpp\GSV\runtime\models\frontend\fast_langdetect'
```

- `--allow-path` 必须包含参考音所在目录，否则 403

## 念之前会做什么

`forSpeech` 去掉：代码块（换成「代码略」）、行内代码、`[[img:]]` / `[[voice:]]` 标记、图片语法、链接（保留文字）、裸 URL、表格（换成「表格略」）、Windows 路径（换成「（略）」）、Markdown 强调符与标题井号。然后按 `max_chars` 按句切段，逐段合成播放。

**拒念的门槛**：只在「清洗后只剩代码/表格占位」时才拒。原先是剩余字数 < 6 就拒，结果「嗓子合好了。」这种五个字的短句也被当成空话挡掉——0.3.0 一并修了。

## 自动念

两层的：`auto_read` 是总开关，`auto_scope` 是勾上之后念哪些。

- `auto_read`（默认 `false`）：不勾就完全不自动出声，网页回复不念，聊天页那颗「念」按钮照旧能点
- `auto_scope`：`f9` 只有按 F9 说话才念（那几轮由耳朵调 `mouth_say`，这里不再自己念）；`all` 每句回复都念，网页里打字的也念；`lead` 只念每段回复的第一段（按空行分段；开头只有代码/表格的块跳过；开头是清单就先跳过清单、念清单后面那段正文），长回答不至于念好几分钟
- `f9` 那一档要求装了「耳朵」插件：判断方式是工具表里有没有 `ear_*`。没有就把那个选项禁掉，页面写明原因（`status.earInstalled`）

`channel/reply` 里跳过 `origin.platform === "ear"` 的事件，就是为了不重复。

想让别的插件自己决定何时念，不用加接口：它自己判断时机，调 `mouth_say` 工具或 `POST /plugins/voice-gsv/say` 就行。把 `auto_read` 关掉，免得两边各念一遍。

## 换 gsv.cpp 那次踩过的两件事

1. 引擎输出重定向：`cmd /c start /b` 起长驻进程时脚本会等管道，直接卡死；用 `spawn` detached 才脱得开
2. 页面保存一次会把整组 `gsv` 字段一起提交——只改端口也等于确认了程序路径和参数

## 验证状态（0.3.0 合并时）

- `tsc --noEmit`（plugins/voice-gsv 四个文件）0 error
- `POST /plugins/voice-gsv/say {text:"嗓子合好了。"}` → 200，1 段，2234ms，出声
- `POST /plugins/voice-gsv/say {text:"```js..."}` → 500「这段只有代码和表格」，按预期拒
- 页面 200，含状态条、启停按钮、四个页签（念出来 / 音色 / 引擎 / 云端）、试念按钮
- 配置页分四页：**念出来**（总开关、引擎、自动念、语速、模型、步数、地址、字数、默认音色同步）、**音色**（音色库 + 手填参考音）、**引擎**（启停行为、程序与参数、端口、日志）、**云端**（Key 与音色）。页签在标题行，跟「保存」同一行；保存一次提交全部四页的字段
- 状态接口读到 `open:true, pids:[20004]`（gsv_server 在跑）

**没验的**：云端那条路（`engine != local`）这轮没打过；真浏览器里点保存那一跳；长文分段播放的实际听感。
