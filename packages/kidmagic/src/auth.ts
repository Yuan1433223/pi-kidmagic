/**
 * P0-3 账号鉴权（零第三方依赖，node:crypto 实现）：
 * - 密码：scrypt + 随机 salt + timingSafeEqual 校验（本地可测，无需短信/外部服务）
 * - Token：HMAC-SHA256 JWT（含 exp 过期；secret 读 KIDMAGIC_JWT_SECRET，未设置时用内置 dev 密钥，仅限本地 demo）
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const JWT_SECRET = process.env.KIDMAGIC_JWT_SECRET ?? "";
const DEV_SECRET = "kidmagic-dev-jwt-secret";
const IS_PROD = process.env.KIDMAGIC_ENV === "production";
if (!JWT_SECRET) {
	if (IS_PROD) throw new Error("[auth] 生产环境必须配置 KIDMAGIC_JWT_SECRET，否则拒绝启动");
	console.warn("[auth] 未设置 KIDMAGIC_JWT_SECRET，token 使用内置 dev 密钥（仅限本地 demo，上线前必须配置）");
}
function secret(): string {
	return JWT_SECRET || DEV_SECRET;
}

// ── 密码哈希 ──
/** 生成 `<salt>:<hash>`（scrypt 64 字节）；存储进 users.password_hash */
export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString("hex");
	const hash = scryptSync(password, salt, 64).toString("hex");
	return `${salt}:${hash}`;
}

/** 校验密码与存储哈希是否一致（timingSafeEqual 防时序攻击） */
export function verifyPassword(password: string, stored: string): boolean {
	const [salt, hex] = stored.split(":");
	if (!salt || !hex) return false;
	const calc = scryptSync(password, salt, 64);
	return timingSafeEqual(Buffer.from(hex, "hex"), calc);
}

// ── JWT（HMAC-SHA256，base64url）──
function b64url(buf: Buffer): string {
	return buf.toString("base64url");
}

export interface JwtPayload {
	sub: string; // user_id
	iat: number;
	exp: number;
}

/** 签发 token（ttlSeconds 后过期） */
export function signToken(subject: string, ttlSeconds: number): string {
	const iat = Math.floor(Date.now() / 1000);
	const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
	const body = b64url(Buffer.from(JSON.stringify({ sub: subject, iat, exp: iat + ttlSeconds })));
	const sig = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
	return `${header}.${body}.${sig}`;
}

/** 校验 token：签名 + 过期，返回 payload；无效返回 null */
export function verifyToken(token: string): JwtPayload | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [header, body, sig] = parts;
	const expect = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
	const a = Buffer.from(sig);
	const b = Buffer.from(expect);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	try {
		const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JwtPayload;
		if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
		return payload;
	} catch {
		return null;
	}
}
