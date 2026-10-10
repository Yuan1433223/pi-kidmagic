/**
 * 绘本页图像 prompt 构造（P0-5 一致性：角色/场景卡 + 每帧自包含 + schema 校验）。
 *
 * 产品红线：保留孩子原话（child_words）里的角色与情节，不新增孩子没讲的内容——
 * 图像 prompt 直接承载孩子元素，避免"AI 自由发挥"稀释原创感。
 *
 * P0-5 三项落地：
 * 1. 结构化卡片：world 不再是中文拼接串，而是「角色卡 / 场景卡」数组
 *    （name + appearance），来自 worker 内从库重建（asset_clusters 半自动确认的
 *    孩子素材角色/场景 + characters 角色卡 + story_elements 兜底）。
 * 2. 每帧自包含：单页 prompt 内写全"固定风格前缀 + 角色外观 + 场景 + 前一页 + 本页情节 +
 *    比例后缀"，不依赖跨页隐式上下文，页间不跳戏。
 * 3. schema 校验：卡片结构与最终 prompt 的自包含完整性由 consistency.ts 校验，
 *    生成前校验、失败只降级该页，不阻塞整本。
 */
export interface CharacterCard {
	name: string;
	appearance?: string;
}
export interface SettingCard {
	name: string;
	appearance?: string;
}
export interface WorldCards {
	characters?: CharacterCard[];
	settings?: SettingCard[];
}

/** 固定风格前缀：原创性 + 儿童绘本画风（与 IP 侵权规避一致） */
export const STYLE_PREFIX =
	"原创儿童绘本插画，温暖明亮画风，柔和色彩，适合 4-8 岁孩子的故事书。全部角色均为原创卡通形象，非任何已有的动画、书籍、游戏或影视角色，无商标或版权形象，请勿参考或模仿真实品牌与知名 IP。";
/** 固定比例后缀：单页绘本正方形构图 */
export const RATIO_SUFFIX = "正方形构图，单页绘本画面，画面饱满居中，留出足够安全边距。";

export function buildPageImagePrompt(
	childWords: string,
	opts?: { bookTitle?: string; cards?: WorldCards; prevPage?: string; hasReferenceImage?: boolean },
): string {
	const { bookTitle, cards, prevPage, hasReferenceImage } = opts ?? {};
	const parts: string[] = [STYLE_PREFIX];
	if (bookTitle) parts.push(`这是绘本《${bookTitle}》中的一页。`);
	if (hasReferenceImage) {
		parts.push(
			"已提供主角的参考图（孩子画的原画），画面中的角色形象必须严格以参考图为准，保持外貌一致，只改变场景和动作。",
		);
	}
	const chars = cards?.characters ?? [];
	if (chars.length) {
		parts.push(
			`故事角色（严格按此形象画，跨页保持外观一致，不要改动）：${chars
				.map((c) => `角色「${c.name}」${c.appearance ? `：${c.appearance}` : ""}`)
				.join("；")}。`,
		);
	}
	const settings = cards?.settings ?? [];
	if (settings.length) {
		parts.push(
			`故事场景（保持同一场景的风格一致）：${settings
				.map((s) => `场景「${s.name}」${s.appearance ? `：${s.appearance}` : ""}`)
				.join("；")}。`,
		);
	}
	if (prevPage) parts.push(`前一页讲的是：${prevPage}。`);
	parts.push(`本页按孩子讲的这句话来画：${childWords}`);
	parts.push("请完整保留孩子描述中的角色、场景和情节，不要新增孩子没有讲到的内容。");
	parts.push(RATIO_SUFFIX);
	return parts.filter(Boolean).join("");
}
