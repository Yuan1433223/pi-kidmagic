/**
 * 阿里云百炼「专属实例」OpenAI 兼容端点 provider（kidmagic 二开自建，上游无此 provider）。
 *
 * 与内置 qwen-token-plan-cn 的区别：
 * - 内置 qwen-token-plan-cn 指向公共套餐网关 https://token-plan.cn-beijing.maas.aliyuncs.com/...
 * - 百炼专属实例的端点形如 https://llm-<instanceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1，
 *   host 随实例变化，必须可配置，因此在此自建 provider。
 *
 * 协议仍是 OpenAI Chat Completions（openai-completions），复用 openAICompletionsApi，
 * 模型规格（多模态输入、qwen thinking 适配、工具严格模式、上下文长度）直接继承内置 qwen catalog，
 * 仅覆盖 baseUrl 与 provider id，不手写模型字段，避免与官方规格漂移。
 *
 * 全部通过环境变量 / 配置注入，密钥不进代码。
 */
import {
	createModels,
	createProvider,
	envApiKeyAuth,
	type Model,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { QWEN_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn.models";

export const QWEN_DEDICATED_PROVIDER_ID = "qwen-dedicated";

/** 读取专属实例 key 时依次尝试的环境变量名（兼容百炼官方示例的 DASHSCOPE_API_KEY 命名）。 */
const DEFAULT_API_KEY_ENV = ["QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY"];

export interface QwenDedicatedConfig {
	/** 必填：专属实例的 /compatible-mode/v1 完整端点。 */
	baseUrl: string;
	/** 模型 id，默认 qwen3.8-max；需在内置 qwen catalog 中存在。 */
	modelId?: string;
	/** 读取 key 的环境变量名，按顺序取第一个存在的。 */
	apiKeyEnv?: readonly string[];
}

/** 构造指向百炼专属实例的 provider（复用内置 qwen 模型规格，仅覆盖端点）。 */
export function createQwenDedicatedProvider(config: QwenDedicatedConfig): Provider<"openai-completions"> {
	const modelId = config.modelId ?? "qwen3.8-max";
	// QWEN_TOKEN_PLAN_CN_MODELS 是按 modelId 索引的扁平 catalog，Object.values 得到模型数组
	const catalog = Object.values(QWEN_TOKEN_PLAN_CN_MODELS) as Model<"openai-completions">[];
	const base = catalog.find((m) => m.id === modelId);
	if (!base) {
		const available = catalog.map((m) => m.id).join(", ");
		throw new Error(`专属实例模型「${modelId}」不在内置 qwen catalog，可选：${available}`);
	}

	// 继承官方模型规格（reasoning/input/compat/thinkingLevelMap/contextWindow…），仅改归属与端点
	const model: Model<"openai-completions"> = {
		...base,
		provider: QWEN_DEDICATED_PROVIDER_ID,
		baseUrl: config.baseUrl,
	};

	return createProvider<"openai-completions">({
		id: QWEN_DEDICATED_PROVIDER_ID,
		name: "Qwen Dedicated Instance",
		baseUrl: config.baseUrl,
		auth: {
			apiKey: envApiKeyAuth("Qwen dedicated instance API key", config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
		},
		models: [model],
		api: openAICompletionsApi(),
	});
}

/** 便捷方法：返回一个只注册了专属实例 provider 的 Models 集合。 */
export function createQwenDedicatedModels(config: QwenDedicatedConfig): MutableModels {
	const models = createModels();
	models.setProvider(createQwenDedicatedProvider(config));
	return models;
}
