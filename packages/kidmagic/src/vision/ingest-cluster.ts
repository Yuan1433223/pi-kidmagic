/**
 * 素材理解与聚类服务（P1）。被 analyze_ingest_batch 工具 与 server 上传确认 API 共用，
 * 避免同一逻辑两处维护。
 *
 * 对批次内每张已确认图片做视觉理解（qwen 专属端点）→ 结构化实体
 * → 每张图写 assets，每个实体写/合并 asset_clusters（confirmed=0，前端确认点按）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../storage/db-pg.ts";
import { insertAsset, upsertCluster, findCluster, appendClusterAssets, listIngestItemsByBatch } from "../storage/repo.ts";
import { visualUnderstand, type VisualEntity } from "./visual-understand.ts";
import { stripMarkdown } from "../util/sanitize.ts";

export interface AnalyzeResult {
	ok: boolean;
	labels: string[];
	failed: number;
	total: number;
	message: string;
}

/** 与 server 一致的上传目录（图片相对 uri 解析到本地文件） */
function uploadsDir(): string {
	return process.env.KIDMAGIC_UPLOADS ?? join(process.cwd(), "uploads");
}

/** 读批次确认图片为 base64（按相对 uri 解析到本地文件；读不到文件的跳过） */
function readBatchImages(items: { uri: string; mime_type: string }[]): { mimeType: string; base64: string }[] {
	const images: { mimeType: string; base64: string }[] = [];
	for (const it of items) {
		const p = join(uploadsDir(), it.uri.replace(/^uploads\//, ""));
		if (!existsSync(p)) continue;
		const buf = readFileSync(p);
		images.push({ mimeType: it.mime_type, base64: buf.toString("base64") });
	}
	return images;
}

/** 对一批已确认素材做视觉理解 + 聚类入库 */
export async function analyzeIngestBatch(
	db: Db,
	p: { sessionId: string; bookId: string; batchNo: number },
): Promise<AnalyzeResult> {
	const items = await listIngestItemsByBatch(db, p.bookId, p.batchNo).then((r) => r.filter((i) => i.status === "confirmed"));
	if (items.length === 0) {
		return { ok: false, labels: [], failed: 0, total: 0, message: "这批还没有已确认的图片，先让孩子确认一下素材吧" };
	}

	const images = readBatchImages(items);
	if (images.length === 0) {
		return { ok: false, labels: [], failed: 0, total: items.length, message: "图片文件读取失败，稍后再试" };
	}

	// 视觉理解配置（与 server resolveModel 一致的三级 key fallback）
	const baseUrl = process.env.QWEN_BASE_URL;
	const apiKey =
		process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
	const modelId = process.env.QWEN_MODEL ?? "qwen3.8-max";
	if (!baseUrl || !apiKey) {
		return { ok: false, labels: [], failed: 0, total: items.length, message: "视觉理解还没配置模型 key，先配置再试" };
	}

	// 逐张理解 + 落库 + 聚类（每张图一次 fetch，精确对应 asset↔entity）
	const labels: string[] = [];
	let failed = 0;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const img = images[i];
		if (!img) continue;
		let entities: VisualEntity[];
		try {
			entities = await visualUnderstand([img], { baseUrl, apiKey, modelId });
		} catch {
			failed += 1;
			continue;
		}
		const assetId = await insertAsset(db, {
			sessionId: item.session_id,
			kind: item.kind,
			mimeType: item.mime_type,
			uri: item.uri,
			nerEntities: entities,
		});
		for (const e of entities) {
			const label = stripMarkdown(e.label);
			const existing = await findCluster(db, { sessionId: item.session_id, clusterType: e.type, label });
			if (existing) {
				await appendClusterAssets(db, existing.id, [assetId]);
			} else {
				await upsertCluster(db, {
					sessionId: item.session_id,
					clusterType: e.type,
					label,
					assetIds: [assetId],
					appearance: e.appearance,
				});
			}
			if (!labels.includes(label)) labels.push(label);
		}
	}

	if (labels.length === 0) {
		const msg =
			failed > 0
				? `有 ${failed} 张图没认出内容，让孩子讲讲这些画了什么吧`
				: "我没认出图片里的角色或场景，让孩子再讲讲吧";
		return { ok: false, labels: [], failed, total: items.length, message: msg };
	}
	const names = labels.join("、");
	const tip = failed > 0 ? `（有 ${failed} 张图没认出）` : "";
	return {
		ok: true,
		labels,
		failed,
		total: items.length,
		message: `我认真看过了，在这些素材里认出了：${names}。${tip}我们一起来讲它们的故事吧！`,
	};
}
