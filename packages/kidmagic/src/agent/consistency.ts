/**
 * P0-5 一致性：世界卡片与每页 prompt 的 schema 校验。
 *
 * 校验发生在图生图生成前（image-jobs.ts）：
 * - 卡片结构合法（name 非空、类型正确、无脏数据）才注入 prompt；
 * - 最终 prompt 自包含完整（含风格前缀 / 比例后缀 / 本页孩子原话）才提交生图；
 * 校验失败只降级该页（记日志、不阻塞整本），避免把坏 prompt 送去烧 token。
 */
import { STYLE_PREFIX, RATIO_SUFFIX, type WorldCards } from "./image-prompt.ts";

export interface CardCheckResult {
	ok: boolean;
	errors: string[];
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** 校验世界卡片结构（P0-5 #3a）：角色卡 / 场景卡字段合法 */
export function validateWorldCards(cards?: WorldCards): CardCheckResult {
	const errors: string[] = [];
	if (!cards) return { ok: true, errors }; // 无卡不判失败（允许纯文生图 / 素材未确认）
	for (const [key, label] of [
		["characters", "角色卡"],
		["settings", "场景卡"],
	] as const) {
		const list = cards[key];
		if (list === undefined || list === null) continue;
		if (!Array.isArray(list)) {
			errors.push(`${label}必须是数组`);
			continue;
		}
		list.forEach((item, i) => {
			if (!item || typeof item !== "object") {
				errors.push(`${label}[${i}] 不是对象`);
				return;
			}
			if (!isNonEmptyString(item.name)) errors.push(`${label}[${i}] name 缺失或为空`);
			if (item.appearance !== undefined && typeof item.appearance !== "string")
				errors.push(`${label}[${i}] appearance 必须是字符串`);
		});
	}
	return { ok: errors.length === 0, errors };
}

/** 校验单页 prompt 自包含完整（P0-5 #3b）：含风格前缀、比例后缀、本页孩子原话 */
export function validatePagePromptSelfContained(prompt: string, childWords: string): CardCheckResult {
	const errors: string[] = [];
	if (!isNonEmptyString(prompt)) {
		errors.push("prompt 为空");
		return { ok: false, errors };
	}
	if (!prompt.includes(STYLE_PREFIX)) errors.push("缺少固定风格前缀");
	if (!prompt.includes(RATIO_SUFFIX)) errors.push("缺少固定比例后缀");
	const words = childWords.trim();
	if (words && !prompt.includes(words)) errors.push("prompt 未包含本页孩子原话（自包含缺失）");
	return { ok: errors.length === 0, errors };
}

/** 组合校验：卡片 + 本页 prompt，返回是否可提交生图 */
export function validateChapterPage(
	cards: WorldCards | undefined,
	prompt: string,
	childWords: string,
): CardCheckResult {
	const cardCheck = validateWorldCards(cards);
	const promptCheck = validatePagePromptSelfContained(prompt, childWords);
	const errors = [...cardCheck.errors, ...promptCheck.errors];
	return { ok: errors.length === 0, errors };
}
