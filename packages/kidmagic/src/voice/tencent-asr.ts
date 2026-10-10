/**
 * P0-4 语音：腾讯云「一句话识别」ASR（SentenceRecognition，TC3-HMAC-SHA256 签名，零第三方依赖）
 * - 短音频（≤60s）一次返回识别文本；孩子讲故事通常几十秒内，够用
 * - 前端 MediaRecorder 录 webm/opus 上传，VoiceFormat 由 mime 推断
 */
import { createHmac, createHash } from "node:crypto";

const HOST = "asr.tencentcloudapi.com";
const SERVICE = "asr";
const VERSION = "2019-06-14";
const ACTION = "SentenceRecognition";

/** 由浏览器 mime 推断腾讯 VoiceFormat */
export function mapVoiceFormat(mime: string): string {
	const m = mime.toLowerCase();
	if (m.includes("webm")) return "webm";
	if (m.includes("ogg")) return "ogg";
	if (m.includes("opus")) return "opus";
	if (m.includes("wav")) return "wav";
	if (m.includes("mp3")) return "mp3";
	if (m.includes("m4a")) return "m4a";
	return "wav";
}

/** TC3-HMAC-SHA256 签名，返回 Authorization 头与完整请求头 */
function tc3Headers(opts: {
	secretId: string;
	secretKey: string;
	region: string;
	payloadJson: string;
}): Record<string, string> {
	const { secretId, secretKey, region, payloadJson } = opts;
	const timestamp = Math.floor(Date.now() / 1000);
	const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC YYYY-MM-DD
	const contentType = "application/json; charset=utf-8";

	// 1. 规范请求
	const canonicalRequest = [
		"POST",
		"/",
		"",
		`content-type:${contentType}`,
		`host:${HOST}`,
		"",
		"content-type;host",
		createHash("sha256").update(payloadJson).digest("hex"),
	].join("\n");

	// 2. 待签名串
	const stringToSign = [
		"TC3-HMAC-SHA256",
		String(timestamp),
		`${date}/${SERVICE}/tc3_request`,
		createHash("sha256").update(canonicalRequest).digest("hex"),
	].join("\n");

	// 3. 派生密钥并签名
	const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
	const secretDate = hmac(`TC3${secretKey}`, date);
	const secretService = hmac(secretDate, SERVICE);
	const secretSigning = hmac(secretService, "tc3_request");
	const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");

	const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${date}/${SERVICE}/tc3_request, SignedHeaders=content-type;host, Signature=${signature}`;
	return {
		"Authorization": authorization,
		"Content-Type": contentType,
		"Host": HOST,
		"X-TC-Action": ACTION,
		"X-TC-Version": VERSION,
		"X-TC-Timestamp": String(timestamp),
		"X-TC-Region": region,
	};
}

export interface TencentAsrConfig {
	secretId: string;
	secretKey: string;
	region: string; // 如 ap-beijing
	engine: string; // 如 16k_zh
}

/** 一句话识别：传入音频原始字节 + mime，返回识别文本；失败抛 Error */
export async function tencentAsrSentence(
	cfg: TencentAsrConfig,
	p: { audioBytes: Buffer; mime: string },
): Promise<string> {
	const voiceFormat = mapVoiceFormat(p.mime);
	const payload = {
		ProjectId: 0,
		SubServiceType: 2, // uint64：2=一句话识别
		EngSerViceType: cfg.engine,
		SourceType: 1, // 本地文件字节
		VoiceFormat: voiceFormat,
		Data: p.audioBytes.toString("base64"),
		DataLen: p.audioBytes.length,
	};
	const payloadJson = JSON.stringify(payload);
	const headers = tc3Headers({ secretId: cfg.secretId, secretKey: cfg.secretKey, region: cfg.region, payloadJson });

	const resp = await fetch(`https://${HOST}`, { method: "POST", headers, body: payloadJson });
	const data = (await resp.json()) as {
		Response?: { Result?: string; Error?: { Code?: string; Message?: string } };
	};
	const respBody = data.Response;
	if (respBody?.Error) throw new Error(`腾讯ASR失败 ${respBody.Error.Code}: ${respBody.Error.Message}`);
	if (typeof respBody?.Result !== "string") throw new Error("腾讯ASR无返回文本");
	return respBody.Result;
}
