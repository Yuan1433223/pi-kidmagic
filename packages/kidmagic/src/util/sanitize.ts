/** 去掉文本里的 markdown 加粗星号（模型在 label/content 里偶发输出 **xx**） */
export function stripMarkdown(s: string): string {
	return (s ?? "").replace(/\*\*/g, "").trim();
}
