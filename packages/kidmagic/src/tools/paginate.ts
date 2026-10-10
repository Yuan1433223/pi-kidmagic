/**
 * P0.1 分页归并：把已记录的故事元素整理成绘本页。
 *
 * 背景：原先"每个 story_element 一页"，导致同一句被模型拆成多个元素时，
 * 页面出现碎片化与重复（典型：P1"我今天画了一只小兔子，它住在大森林里。"
 * 与 P2"它住在大森林里。"，P6 与 P7 各自重复"爬到一棵很高很高的树上…"）。
 *
 * 规则（确定性、无外部依赖、保留孩子主导性）：
 * - 页文本优先用孩子原话 child_words；为空时退回元素 content 并标记 connector；
 * - 相邻元素若原话存在"子串包含关系"（同一句的重复片段），合并去重，不新开页：
 *   · 新句是上一页文本的子串 → 丢弃（重复，不新开页）；
 *   · 上一页文本是新句的子串且新句更长 → 用更完整的新句替换该页；
 * - 仍保证每页文本来自孩子原话（child_raw），不影响主导性验收。
 */
export interface PageInput {
	childWords: string;
	content: string;
}

export interface PageOutput {
	text: string;
	textSource: "child_raw" | "connector";
}

/** 归一化：小写、去空白与常见标点，用于文本包含比较 */
function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[\s。，、！？；：""''《》【】…·~\-—()（）.,!?;:'"`]/g, "");
}

/** shorter 是否作为连续子串出现在 longer 中 */
function containsNorm(longer: string, shorter: string): boolean {
	return shorter.length > 0 && longer.includes(shorter);
}

/** 重复判定的最小长度阈值：低于此长度的子串不视为"重复页"（避免误吞短句） */
const DUP_MIN_LEN = 4;

export function mergeChildPages(inputs: PageInput[]): PageOutput[] {
	const pages: { raw: string; norm: string; source: "child_raw" | "connector" }[] = [];

	for (const el of inputs) {
		const raw = el.childWords.trim() || el.content;
		if (!raw) continue; // 空元素跳过
		const source: "child_raw" | "connector" = el.childWords.trim() ? "child_raw" : "connector";
		const norm = normalize(raw);

		const last = pages.at(-1);
		if (last) {
			// 新句是上一页的子串 → 重复，丢弃（不新开页）
			if (norm.length >= DUP_MIN_LEN && containsNorm(last.norm, norm)) continue;
			// 上一页是新句的子串且新句更完整 → 用新句替换该页
			if (last.norm.length >= DUP_MIN_LEN && containsNorm(norm, last.norm) && norm.length > last.norm.length) {
				last.raw = raw;
				last.norm = norm;
				last.source = source;
				continue;
			}
		}
		pages.push({ raw, norm, source });
	}

	return pages.map((p) => ({ text: p.raw, textSource: p.source }));
}

/**
 * 无 story_elements 时的兜底分页：孩子一口气讲完一整段（模型漏调 save_story_element），
 * 不能把整段塞进一页。按中文句读切成页，每页保持完整语义，页数上限可配（产物暂定 ~5 页）。
 * 无标点的连续长句（口语）无法更细切分时，回退为整段一页。
 */
export function splitRawStory(text: string, maxPages = 6): PageOutput[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	// 按句读切分（句号/感叹/问号/分号 + 换行）；lookbehind 保留标点在句尾
	const parts = trimmed.split(/(?<=[。！？!?；;])|\n+/).map((s) => s.trim()).filter(Boolean);
	if (parts.length <= 1) return [{ text: trimmed, textSource: "child_raw" }];
	// 页数超上限时每页合并多句，保证不超 maxPages 页
	const per = Math.max(1, Math.ceil(parts.length / maxPages));
	const pages: PageOutput[] = [];
	for (let i = 0; i < parts.length; i += per) {
		const chunk = parts.slice(i, i + per).join("");
		if (chunk.trim()) pages.push({ text: chunk, textSource: "child_raw" });
	}
	return pages;
}
