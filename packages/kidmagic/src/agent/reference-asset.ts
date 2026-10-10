/**
 * P2 主角一致性参考图解析：从孩子的角色素材聚类里选一张原画作参考锚。
 *
 * 来源优先级：
 * 1. asset_clusters 中 confirmed=1 的 character 组第一张（孩子确认过的角色，最可信）；
 * 2. 任意 character 组第一张（未确认也作锚——至少是孩子的画，主导性红线贴合）；
 * 3. 无 → 返回 undefined（回退 P1 纯文生图世界状态注入，不阻塞绘本生成）。
 *
 * 返回 data URI（qwen-image-3.0 I2I 的 image 输入），供 dashscopeGenerateImage.referenceImageDataUri。
 * 复用与 server/ingest-cluster 一致的 uploads 目录解析（相对 uri → 本地文件）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { Db } from "../storage/db-pg.ts";

function uploadsDir(): string {
	return process.env.KIDMAGIC_UPLOADS ?? join(process.cwd(), "uploads");
}

export async function resolveReferenceImage(db: Db, sessionId: string): Promise<string | undefined> {
	// 优先已确认的角色聚类，其次未确认的；最多看 5 组（防一次拿太多锚）
	const rows = (await db.query(
		`SELECT asset_ids FROM asset_clusters
		 WHERE session_id = $1 AND cluster_type = 'character'
		 ORDER BY confirmed DESC, created_at
		 LIMIT 5`,
		[sessionId],
	)) as unknown as { asset_ids: string }[];
	if (rows.length === 0) return undefined;

	for (const row of rows) {
		let ids: string[];
		try {
			ids = JSON.parse(row.asset_ids) as string[];
		} catch {
			continue;
		}
		if (!ids.length) continue;
		const asset = (await db.query("SELECT uri, mime_type FROM assets WHERE id = $1", [ids[0]]))[0] as
			| { uri: string | null; mime_type: string | null }
			| undefined;
		if (!asset?.uri || !asset.mime_type) continue;
		const p = join(uploadsDir(), basename(asset.uri));
		if (!existsSync(p)) continue;
		const buf = readFileSync(p);
		return `data:${asset.mime_type};base64,${buf.toString("base64")}`;
	}
	return undefined;
}
