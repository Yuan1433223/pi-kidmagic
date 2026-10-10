/**
 * 真机冒烟：验证 Qwen-Image-3.0 DashScope 图生图链路（提交→轮询→取图）。
 * 用法：QWEN_BASE_URL+QWEN_API_KEY 配置好后 `npm run smoke:image`。
 */
import { dashscopeGenerateImage, resolveDashScopeImageConfig } from "../src/image/dashscope-image.ts";

const config = resolveDashScopeImageConfig();
if (!config) {
	console.error("缺少 QWEN_BASE_URL / 图像 key（QWEN_API_KEY | DASHSCOPE_API_KEY | QWEN_TOKEN_PLAN_CN_API_KEY）");
	process.exit(1);
}
console.log(`image base=${config.baseUrl} model=${config.modelId} size=${config.size}`);

const { url } = await dashscopeGenerateImage(
	{ prompt: "儿童绘本插画：一只住在森林里的小白兔，画面温暖明亮，色彩柔和。" },
	config,
);
console.log("生成成功：", url);
