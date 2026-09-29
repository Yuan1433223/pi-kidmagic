import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.ts";

export type { DatabaseSync } from "node:sqlite";

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
	return db;
}
