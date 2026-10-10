import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, signToken, verifyToken } from "../src/auth.ts";

describe("auth（P0-3，node:crypto 零依赖）", () => {
	it("密码哈希：正确密码通过，错误密码 / 损坏哈希拒绝", () => {
		const h = hashPassword("123456");
		expect(verifyPassword("123456", h)).toBe(true);
		expect(verifyPassword("wrong", h)).toBe(false);
		expect(verifyPassword("123456", "not-a-hash")).toBe(false);
	});

	it("JWT：签发后可校验出 sub，篡改 / 过期 / 畸形拒绝", () => {
		const t = signToken("user_1", 3600);
		const p = verifyToken(t);
		expect(p?.sub).toBe("user_1");

		// 过期（ttl<=0）
		expect(verifyToken(signToken("user_1", -1))).toBeNull();
		// 篡改 payload
		const [h, b, s] = t.split(".");
		const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: "evil", iat: 0, exp: 9999999999 })).toString("base64url")}.${s}`;
		expect(verifyToken(tampered)).toBeNull();
		// 畸形
		expect(verifyToken("a.b.c")).toBeNull();
		expect(verifyToken("")).toBeNull();
	});
});
