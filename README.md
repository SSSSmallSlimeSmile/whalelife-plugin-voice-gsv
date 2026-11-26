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
POST /plugins/voice-gsv/check-ref   检查当前音色的参考音能不能用（只读，不调引擎）
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
  "pipe_sentences": true,
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

### 检查参考音

音色页那个「检查参考音」按钮，只读、不调引擎，一次说清这套参考音能不能用。它查的都不是审美，是「引擎会怎么用这份文件」：

- 文件在不在；不在启动参数的 `--allow-path` 里，引擎直接回 403
- `prompt_text` 空没空——空着引擎不出声
- 时长：短于 5 秒、长于 30 秒都提示
- 静音占比（20ms 一帧、RMS 低于 0.5% 算静音）：超过 30% 提示，那些空段模型也会当特征学
- 文本字数和音频长度的比例：正常中文 3–6 字/秒，差太远多半是那行字跟音频不是同一段
- 采样率低于 32k 提示会重采样
- 不是标准 RIFF/PCM 的 wav：说明时长和静音占比这两项判断不了，不硬猜

这些提示分两档：`fail` 是会让它念不出来的（文件不在、不在白名单、文本为空），`warn` 是能念但音色会偏。

实际跑过的六种：正常那套（只有静音 33.2% 一条 warn）、4.11 秒 43% 静音、文件不存在、不在 `--allow-path` 里的 wav、`prompt_text` 为空、非 wav 文件。返回的都是对应那一档。

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

### 中英混排：数字和单位

引擎自己判语种，`text_lang` 传什么都没区别（同一句 `zh` / `auto` 出来的 wav 逐字节相同）。它一旦把整段判成中文，字母就按中文音素硬拼——「K 盘」「4.3 GB」会念成既不像中文也不像英文的声音。

`forSpeech` 只改「送进去会读歪」的那几类：数字、盘符、被中文夹住的单个字母（档位 A → 档位诶）、箭头。成句英文不动。

单位缩写有两套读法：

- 白名单里的词（`pronounce_keep`，默认 `GB MB KB TB GiB MiB KiB`）**原样交给引擎**，按英文念
- 不在名单里的走中文读法（`ms` → 毫秒、`MB` 清空白名单后 → 兆字节）

页面上「念出来」页那栏「这些词原样念，不改中文」就是改这份名单：逗号分隔，最多 40 个，每项只收字母数字和 `_.+-`；重复、非法项会被丢掉。清空就全用中文读法。

数字仍然中文化（4.3 → 四点三），白名单只管它自己那几个词。

## 句子级流水（`pipe_sentences`，默认开）

长文会被 `max_chars` 切成几句。默认的走法是串行：合成一句 → 播完 → 再合成下一句，每句都要等一遍。

勾上「句子级流水」之后改成预取一句：第一句合成完就开始播，播的时候下一句已经在合成，播完直接接。等待从「每句都等」变成「只等第一句」。

- 每句仍是完整的 wav，顺序播放，**不做波形拼接**——上次为了拼接把头里 `bits` 写成 43，网页点开是 0:00/0:00，就是这个坑
- 只预取一句，不排队，内存里最多多压一段音频
- 某句合成失败：正在播的那句照常播完，然后抛错，后面的不再合成（错误延迟到轮到它时抛，不会变成未处理的 rejection）
- 只有一句（`parts.length === 1`）时直接走串行，不做无意义的包装
- 页面上在「念出来」那页，勾掉就退回串行

**实测（本机 8G 卡、kanturbo 4 步、热态）：** 148 字切两句，合成一句约 1 秒，播一句 8–10 秒。

| | 总耗时 | 出声延迟 |
|---|---|---|
| 串行 | 28.1 s | 等第一句合成完（约 1 s） |
| 流水 | 29.5 s | 同上 |

也就是说：**这台机器上收益约等于零**，两次差别在噪声范围内。原因很直接——合成比播放快一个数量级，瓶颈在播放，不在调度。流水能省的只是「合成下一句的那点时间」，而那只占一秒多。

它真正有用的是「合成慢于播放」的场景：云端引擎、步数调高、句子特别长。现在这个配置下勾着不亏，也别指望它把长文变快。

## 新的顶掉旧的（`interrupt_reading`，代码默认关）

以前的行为是排队：正在念的那句一定念完，新进来的往后排，队列满两条（`queue.length >= 2`）就丢最老的那条。所以连点三次「念」，第二句被丢，第一句照旧念完。

勾上这个开关之后换成打断：

- 新的一段进来，当场掐掉正在念的那句（杀掉那个播放用的 powershell 子进程，`PlaySync` 跟着结束），排队的也一起清
- `/say`、`/test` 不再回 409「上一段还在念」，而是掐掉旧的接着念新的
- 自动念那条路也一样（`enqueue`）
- 被掐掉的那一轮返回 `{ok:false, cancelled:true}`，不是报错

实现上用一个轮号 `gen`：掐断时加一，合成/播放循环每过一个 await 点就比一次，号不对就抛「念话被打断」并且不再往下合成。所以掐断不会留下半截未处理的 rejection。

**实测（本机，热态）**

| | 结果 |
|---|---|
| 关（默认） | 第二句 `409 上一段还在念`，第一句完整念完 17.7 s |
| 开 | 第二句 200 立刻开始念；第一句在 5.98 s 返回 `cancelled: true`；之后第三句正常 |

页面上在「念出来」那页，叫「新的顶掉旧的」。

## 停服务的两条修正（0.4.6）

原来越界两处：

一、**`gsv_stop` 按端口找 PID 就杀**，端口被别的程序占着也照杀。现在先认进程名（`tasklist /FI "PID eq N"` 取映像名），跟 `gsv.exe` 的 basename 对不上就不动它；文本前端那侧只认 `python*`。

二、**`taskkill` 失败也回「已结束」**。现在杀完回查端口，真空了才算 `stopped`；被拒绝的进程会写进回执，例如：

```
已结束：29444；端口 9880 上的 34612 是「gsv_server.exe」，不是我们的程序，没动它
```

实测（真宿主）：把 `gsv.exe` 临时指成 notepad.exe 再点停 → 引擎 34612 没被杀，回执照上面那样写明；还原配置后正常停 `34612, 13376`，再起回来 3 秒内 9880/9882 都在。

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
