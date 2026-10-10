/**
 * 素材视觉理解（P1 独立模块，不依赖 Pi 的图片 content 抽象）。
 *
 * 直接调 qwen 专属实例的 OpenAI 兼容端点（chat/completions），把孩子上传的图片
 * 转成结构化实体：{type: character|setting|prop, label}。
 * 走独立 fetch 而非 agent 主循环，避免占用对话轮次与上下文。
 */
export interface VisualEntity {
	type: "character" | "setting" | "prop";
	label: string;
	/** 关键外观/视觉特征（角色：颜色、形状、特征；场景：色调、主要元素），agent 据此不追问外观 */
	appearance?: string;
}

export interface VisualUnderstandConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
}

const ENTITY_TYPES = new Set(["character", "setting", "prop"]);

/** 从模型输出里提取 JSON 数组（容忍 ```json 包裹 / 前后杂文本） */
export function extractEntityJsonArray(text: string): VisualEntity[] {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = fence ? fence[1] : text;
	const start = raw.indexOf("[");
	const end = raw.lastIndexOf("]");
	if (start < 0 || end < start) throw new Error("模型未返回 JSON 数组");
	const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error("返回不是 JSON 数组");
	const entities: VisualEntity[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const o = item as { type?: unknown; label?: unknown; appearance?: unknown };
		if (typeof o.type !== "string" || !ENTITY_TYPES.has(o.type)) continue;
		if (typeof o.label !== "string" || !o.label.trim()) continue;
		entities.push({
			type: o.type as VisualEntity["type"],
			label: o.label.trim(),
			appearance: typeof o.appearance === "string" && o.appearance.trim() ? o.appearance.trim() : undefined,
		});
	}
	return entities;
}

/** 对一组图片（通常单张）做视觉理解，返回实体列表 */
export async function visualUnderstand(
	images: { mimeType: string; base64: string }[],
	config: VisualUnderstandConfig,
): Promise<VisualEntity[]> {
	if (images.length === 0) return [];
	const base = config.baseUrl.replace(/\/+$/, "");
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify({
			model: config.modelId,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text:
								"这是一张儿童创作的画/手工作品或照片。请识别里面的人物（主角或配角）、场景、道具。" +
								"只输出 JSON 数组，不要任何其他文字，格式：{\"type\":\"character\"|\"setting\"|\"prop\",\"label\":\"简短中文名\",\"appearance\":\"关键外观/视觉特征（简短，如羽毛颜色、形状、场景色调），没有可省略\"}。" +
								"例如 [{\"type\":\"character\",\"label\":\"小兔子\",\"appearance\":\"白色圆身体，长耳朵，红色眼睛\"},{\"type\":\"setting\",\"label\":\"大森林\",\"appearance\":\"翠绿树木，阳光透过树叶\"}]。" +
								"如果画面复杂，最多输出 4 个最重要的实体。",
						},
						...images.map((img) => ({
							type: "image_url",
							image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
						})),
					],
				},
			],
			stream: false,
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`视觉理解失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	const text = data.choices?.[0]?.message?.content ?? "";
	if (!text.trim()) throw new Error("视觉理解返回为空");
	return extractEntityJsonArray(text);
}
