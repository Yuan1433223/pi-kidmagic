/**
 * P0-4 语音：火山引擎「单流 TTS」→ mp3（HTTP SSE，零第三方依赖）
 * - 认证：Authorization: Bearer; <appid>.<base64url(HMAC-SHA256(accessKey, issueTime))>
 * - 输出 mp3，前端用 <audio> 直接播放
 */
import { createHmac, randomUUID } from "node:crypto";

export interface VolcTtsConfig {
	url: string; // 如 https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse
	appId: string;
	accessKey: string;
	resourceId: string; // seed-tts-2.0
	speaker: string; // zh_female_cancan_uranus_bigtts
	uid: string;
}

/** 单流 TTS：文本 → mp3 Buffer；失败抛 Error */
export async function volcTts(cfg: VolcTtsConfig, text: string): Promise<Buffer> {
	const issueTime = new Date().toISOString().replace(/\.\d+Z$/, "Z"); // 如 2026-10-09T08:00:00Z
	const sig = createHmac("sha256", cfg.accessKey).update(issueTime).digest("base64url");
	const token = `${cfg.appId}.${sig}`;
	const reqid = randomUUID();

	const body = JSON.stringify({
		user: { uid: cfg.uid },
		audio: { voice_type: cfg.speaker, encoding: "mp3", speed_ratio: 1.0 },
		request: { reqid, text, operation: "query", text_type: "plain" },
	});

	const resp = await fetch(cfg.url, {
		method: "POST",
		headers: {
			"Authorization": `Bearer; ${token}`,
			"X-Api-App-Key": cfg.appId,
			"X-Api-Access-Key": cfg.accessKey,
			"X-Api-Resource-Id": cfg.resourceId,
			"X-Api-Request-Id": reqid,
			"Content-Type": "application/json",
		},
		body,
	});
	if (!resp.ok) throw new Error(`火山TTS HTTP ${resp.status}`);

	const raw = await resp.text();
	// SSE 逐行解析：`event:data` 的 `data:` 行是 JSON，其 `data` 字段为 base64 音频
	const chunks: Buffer[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		try {
			const obj = JSON.parse(payload) as { code?: number; data?: string; message?: string };
			// 火山 unidirectional SSE 成功事件 code=20000000（不是 300）；0 / 无 code 亦视为成功。
			if (obj.code && ![20000000, 0].includes(obj.code))
				throw new Error(`火山TTS事件错误 code=${obj.code}${obj.message ? ` ${obj.message}` : ""}`);
			if (typeof obj.data === "string" && obj.data) chunks.push(Buffer.from(obj.data, "base64"));
		} catch {
			// 尾部 `data:[end]` 等非 JSON 行忽略
		}
	}
	if (!chunks.length) throw new Error(`火山TTS无音频返回（原始响应前300字：${raw.slice(0, 300)}）`);
	return Buffer.concat(chunks);
}
