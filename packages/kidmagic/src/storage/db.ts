import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.ts";
import type { Db } from "./db-pg.ts";

export type { DatabaseSync } from "node:sqlite";

/**
 * 把 node:sqlite 的 DatabaseSync 适配成 Db 接口（内存/测试/演示脚本用）。
 * repo 的 SQL 用 $1/$2 占位符，SQLite 端按顺序替换为 ? 匿名参数。
 * 事务用同一 DatabaseSync 连接（BEGIN/COMMIT），保证原子性。
 */
export function sqliteDbAdapter(db: DatabaseSync): Db {
	const toAnon = (sql: string): string => sql.replace(/\$\d+/g, () => "?");
	const query = (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
		Promise.resolve(db.prepare(toAnon(sql)).all(...(params as never[]))) as Promise<Record<string, unknown>[]>;
	return {
		query,
		async tx(fn) {
			db.exec("BEGIN");
			try {
				const out = await fn(query);
				db.exec("COMMIT");
				return out;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
		async close() {
			db.close();
		},
	};
}

/**
 * 打开（必要时创建）Kidmagic 作品库并初始化表结构。
 *
 * @param path SQLite 文件路径；默认 ":memory:"（测试用）。
 * @returns 已建表的 DatabaseSync 句柄。
 *
 * 说明：Node 22.19+ 内置 node:sqlite（实验性，仅警告，无需 flag）。
 */
export function openDatabase(path: string = ":memory:"): DatabaseSync {
	const db = new DatabaseSync(path);
	if (path !== ":memory:") {
		db.exec("PRAGMA journal_mode=WAL;");
	}
	db.exec("PRAGMA foreign_keys=ON;");
	db.exec(SCHEMA_SQL);
	// 迁移：asset_clusters 增补 appearance 列（老库无此列时幂等补上，新库 CREATE 已含则跳过）
	const cols = db.prepare("PRAGMA table_info(asset_clusters)").all() as { name: string }[];
	if (!cols.some((c) => c.name === "appearance")) {
		db.exec("ALTER TABLE asset_clusters ADD COLUMN appearance TEXT NOT NULL DEFAULT ''");
	}
	return db;
}
