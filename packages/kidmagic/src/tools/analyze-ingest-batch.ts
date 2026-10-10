/**
 * analyze_ingest_batch：素材视觉理解工具（P1 半自动聚类）。
 *
 * 触发：孩子在前端确认一批上传后调用。
 * 逻辑已抽到 src/vision/ingest-cluster.ts（analyzeIngestBatch），server 上传确认 API 共用；
 * 本工具负责从会话定位当前书，再调用服务。
 */
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";
import { analyzeIngestBatch } from "../vision/ingest-cluster.ts";

const parameters = Type.Object({
	batchNo: Type.Number(),
});

type Params = Static<typeof parameters>;

export function createAnalyzeIngestBatchTool(deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "analyze_ingest_batch",
		description:
			"孩子确认上传素材后调用：理解这批图片里的角色/场景/道具，整理成素材库（聚类）。只在批次图片已确认时使用",
		label: "素材理解与聚类",
		parameters,
		execute: async (_toolCallId, params: Params) => {
			const { db, runtime } = deps;

			// 定位当前书（会话挂到书）
			const sess = (await db.query("SELECT current_book_id FROM sessions WHERE id = $1", [runtime.sessionId]))[0] as
				| { current_book_id: string | null }
				| undefined;
			const bookId = sess?.current_book_id;
			if (!bookId) return textResult("还没有关联到正在创作的书，先讲一个故事吧");

			const result = await analyzeIngestBatch(db, {
				sessionId: runtime.sessionId,
				bookId,
				batchNo: params.batchNo,
			});
			return textResult(result.message);
		},
	};
}
