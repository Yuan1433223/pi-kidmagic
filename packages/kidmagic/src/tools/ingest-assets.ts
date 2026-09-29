import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { confirmCluster } from "../storage/repo.ts";
import type { ToolDeps } from "./types.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object({
	assetIds: Type.Array(Type.String()),
	/** true 表示孩子已确认聚类分组（半自动确认） */
	clusterConfirmed: Type.Optional(Type.Boolean()),
});

type Params = Static<typeof parameters>;

/**
 * 素材入库确认 + 半自动聚类确认。
 * 素材原始记录由上传通道写入 assets；本工具负责"我看到了这些素材，对吗？"的确认闭环。
 * P0 不做真实多模态 NER（留 P1），聚类组由上传/角色卡流程产生。
 */
export function createIngestAssetsTool(deps: ToolDeps): AgentTool<typeof parameters, undefined> {
	return {
		name: "ingest_assets",
		description:
			"孩子上传素材后调用：告诉孩子你看到了哪些素材并请他确认；clusterConfirmed=true 表示孩子已确认分组",
		label: "素材入库与聚类",
		parameters,
		execute: async (_toolCallId, params: Params) => {
			const { db, runtime } = deps;
			for (const id of params.assetIds) {
				if (!runtime.pendingAssetIds.includes(id)) runtime.pendingAssetIds.push(id);
			}
			if (params.clusterConfirmed === true) {
				const rows = db
					.prepare("SELECT id FROM asset_clusters WHERE session_id = ? AND confirmed = 0")
					.all(runtime.sessionId) as { id: string }[];
				for (const row of rows) confirmCluster(db, row.id);
				return textResult("好嘞，这些角色、场景和道具都整理好啦！");
			}
			return textResult(
				`我看到你带来了 ${params.assetIds.length} 份素材，我们一起来看看都有什么，好吗？`,
			);
		},
	};
}
