/**
 * Qwen-Image-3.0 图像生成（DashScope 原生异步接口，P1）。
 *
 * 不走 OpenAI 兼容（compatible-mode 只对文本 chat 开放）；图像生成是
 * 异步任务：POST generation → 拿 task_id → 轮询 GET /tasks/:id → SUCCEEDED 取 url。
 *
 * baseUrl 是专属实例 host 根（如 https://llm-xxx.cn-beijing.maas.aliyuncs.com），
 * 从 chat 的 QWEN_BASE_URL（.../compatible-mode/v1）推导：去掉尾部 /compatible-mode/v1。
 */

export interface DashScopeImageConfig {
	apiKey: string;
	/** 专属实例 host 根，例如 https://llm-xxx.cn-beijing.maas.aliyuncs.com */
	baseUrl: string;
	modelId: string;
	/** 输出尺寸（如 1024*1024），可选 */
	size?: string;
}

export interface GenerateImageOptions {
	prompt: string;
	/** 图生图主角一致性参考图（原画为锚，data URI），可选；P1 首版先文生图 */
	referenceImageDataUri?: string;
	/** 轮询超时（毫秒），默认 90s */
	timeoutMs?: number;
}

/** 从 chat baseUrl（.../compatible-mode/v1）推导图像生成 host 根 */
export function resolveImageBaseUrl(chatBaseUrl: string): string {
	return chatBaseUrl.replace(/\/compatible-mode\/v1\/?$/, "").replace(/\/+$/, "");
}

/**
 * 从环境解析 Qwen-Image 配置（与 server resolveModel 一致的三级 key fallback）。
 * 无 QWEN_BASE_URL / 无 key / 被禁用时返回 null（绘本只排版文字）。
 */
export function resolveDashScopeImageConfig(): DashScopeImageConfig | null {
	if (process.env.KIDMAGIC_IMAGE_DISABLED === "1") return null;
	const chatBase = process.env.QWEN_BASE_URL;
	const apiKey =
		process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
	if (!chatBase || !apiKey) return null;
	return {
		baseUrl: resolveImageBaseUrl(chatBase),
		apiKey,
		modelId: process.env.QWEN_IMAGE_MODEL ?? "qwen-image-3.0",
		size: process.env.QWEN_IMAGE_SIZE ?? "1024*1024",
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

interface TaskPoll {
	output?: {
		task_id?: string;
		task_status?: string;
		results?: { url?: string }[];
		message?: string;
		choices?: { message?: { content?: { type?: string; image?: string }[] } }[];
	};
}

/** 提交图像生成任务；专属实例同步返回图，公开 DashScope 异步返回 task_id，兼容两者 */
async function submitGeneration(
	baseUrl: string,
	config: DashScopeImageConfig,
	opts: GenerateImageOptions,
): Promise<{ mode: "sync"; url: string } | { mode: "async"; taskId: string }> {
	const content: Record<string, unknown>[] = [{ text: opts.prompt }];
	if (opts.referenceImageDataUri) {
		content.push({ image: opts.referenceImageDataUri });
	}
	const parameters: Record<string, unknown> = { prompt_extend: true };
	if (config.size) parameters.size = config.size;

	const res = await fetch(`${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
		body: JSON.stringify({
			model: config.modelId,
			input: { messages: [{ role: "user", content }] },
			parameters,
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Qwen-Image 提交失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	const data = (await res.json()) as TaskPoll;

	// 同步模式（专属实例 maas）：output.choices[0].message.content[0].image
	const choice = data.output?.choices?.[0]?.message?.content;
	if (Array.isArray(choice)) {
		const img = choice.find((c) => c.type === "image" && typeof c.image === "string" && c.image);
		if (img?.image) return { mode: "sync", url: img.image };
	}

	// 异步模式（公开 DashScope）：output.task_id
	const taskId = data.output?.task_id;
	if (taskId) return { mode: "async", taskId };

	throw new Error(`Qwen-Image 提交未返回图片或 task_id：${JSON.stringify(data).slice(0, 300)}`);
}

/** 轮询任务直到完成，返回图片 url（失败抛错） */
async function pollTask(baseUrl: string, config: DashScopeImageConfig, taskId: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, {
			method: "GET",
			headers: { Authorization: `Bearer ${config.apiKey}` },
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Qwen-Image 轮询失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
		}
		const data = (await res.json()) as TaskPoll;
		const status = data.output?.task_status;
		if (status === "SUCCEEDED") {
			const url = data.output?.results?.[0]?.url;
			if (!url) throw new Error("Qwen-Image 任务成功但未返回图片 url");
			return url;
		}
		if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
			throw new Error(`Qwen-Image 任务失败：${data.output?.message ?? status}`);
		}
		await sleep(2000);
	}
	throw new Error(`Qwen-Image 任务超时（${timeoutMs}ms）`);
}

/** 生成一张图，返回图片 url（优先同步图，否则异步轮询） */
export async function dashscopeGenerateImage(
	opts: GenerateImageOptions,
	config: DashScopeImageConfig,
): Promise<{ url: string }> {
	const result = await submitGeneration(config.baseUrl, config, opts);
	if (result.mode === "sync") return { url: result.url };
	const url = await pollTask(config.baseUrl, config, result.taskId, opts.timeoutMs ?? 90_000);
	return { url };
}
