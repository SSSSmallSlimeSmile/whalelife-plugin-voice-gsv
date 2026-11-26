/*! 云端音色探测：DeepSeek 没有音色列表接口（/voices 是 404），
 *  但用一个非法 voice_id 请求时，错误信息会写出合法值：
 *  Invalid voice_id '__probe__': supported values are 'stella' (default), 'tide'
 *  这条不生成音频，不计费。探不到就退回 stella / tide。
 */
export async function probeVoices(
  cfg: any,
  fallbackKey: string,
): Promise<{ voices: string[]; source: string; note?: string }> {
  const key = String(cfg?.cloud_key ?? "").trim() || String(fallbackKey ?? "").trim();
  if (!key) throw new Error("没配 DeepSeek 的 key，主配置里也没找到 deepseek 的 provider");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(String(cfg?.cloud_url || "https://api.deepseek.com/v1/tools/tts"), {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "测", voice_id: "__probe__", format: "wav", filter_markdown: true }),
      signal: controller.signal,
    });
    const text = await res.text();
    const at = text.search(/supported values/i);
    if (at < 0) {
      return { voices: ["stella", "tide"], source: "fallback", note: "云端没报出可选音色，用默认两个" };
    }
    const seg = text.slice(at);
    const found = Array.from(
      new Set((seg.match(/'[a-z0-9_.-]{2,32}'/gi) ?? []).map((one) => one.replace(/'/g, ""))),
    ).filter((one) => one !== "__probe__");
    if (!found.length) return { voices: ["stella", "tide"], source: "fallback" };
    return { voices: found, source: "cloud" };
  } catch (error: any) {
    if (controller.signal.aborted) throw new Error("连云端超时（20 秒）");
    throw new Error(`连不上云端：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}
