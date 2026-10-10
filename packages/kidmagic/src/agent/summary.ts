/**
 * P1.0 前情提要摘要（recap_summary）生成。
 *
 * 目的：孩子第二次回来续写时，把上一章内容注入 agent 上下文。
 * 确定性实现（不额外调用模型）：用绘本标题 + 已归并去重的页文本（孩子原话）
 * 拼接成一段前情提要，天然保留孩子主导性。
 * 后续可升级为 agent 生成更自然的摘要（见 AGENTS.md §11 P1 项）。
 */
export function buildRecapSummary(title: string, pages: { text: string }[]): string {
	const body = pages
		.map((p) => p.text.trim())
		.filter(Boolean)
		.join(""); // 每段原话本身带句号，直接拼接避免"。，"
	const clean = body.replace(/[。！？]+$/, ""); // 去掉尾标点，统一由句号收尾
	if (title) return `《${title}》讲的是：${clean}。`;
	return clean ? `${clean}。` : "";
}
