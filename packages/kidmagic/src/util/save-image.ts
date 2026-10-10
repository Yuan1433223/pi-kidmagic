/**
 * 图生图结果落盘：qwen-image 返回的是临时外链（阿里云签名 URL，数小时~数天内过期），
 * 若直接存进 generated_image_uri，回看绘本时图片会 404 →「图片丢失」。
 * 本工具把远程图下载到本地 uploads 目录，返回相对 uri `uploads/xxx`，
 * 由 server `GET /uploads/:file` 永久提供（Cache-Control immutable）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";

const UPLOAD_DIR = process.env.KIDMAGIC_UPLOADS ?? join(process.cwd(), "uploads");

/** 本地日期（YYYY-MM-DD，非 UTC），用于给自动生成的图按天分子目录，避免 uploads 根目录堆积 */
function todayStr(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function extForMime(mime: string): string {
	const m = mime.toLowerCase();
	if (m.includes("png")) return ".png";
	if (m.includes("webp")) return ".webp";
	if (m.includes("gif")) return ".gif";
	return ".jpg";
}

/**
 * 下载远程图片到 uploads/gen/<YYYY-MM-DD>/ 子目录，返回相对 uri `uploads/gen/<date>/<file>`。
 * 图生图结果按用途+日期归档，避免大量自动生成页图在 uploads 根目录平铺成一片。
 * 由 server `GET /uploads/<date>/<file>` 永久提供（Cache-Control immutable）。
 */
export async function saveRemoteImage(url: string): Promise<string> {
	const day = todayStr();
	const dir = join(UPLOAD_DIR, "gen", day);
	mkdirSync(dir, { recursive: true });
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
	const buf = Buffer.from(await resp.arrayBuffer());
	const fromHeader = (resp.headers.get("content-type") ?? "").toLowerCase();
	const fromExt = (url.split("?")[0].split(".").pop() ?? "").toLowerCase();
	const mime = fromHeader || (fromExt === "png" || fromExt === "webp" || fromExt === "gif" ? "image/" + fromExt : "image/jpeg");
	const file = `${uuidv7()}${extForMime(mime)}`;
	writeFileSync(join(dir, file), buf);
	return `uploads/gen/${day}/${file}`;
}
