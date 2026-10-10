/**
 * Kidmagic PG 连接抽象（P0-1 存储迁移）。
 *
 * 取代 node:sqlite 的 DatabaseSync：提供异步 query / exec / tx。
 * repo.ts 不再依赖 DatabaseSync，改依赖本文件的 Db 接口；
 * 调用点只需持有 Db 对象并把 repo 调用 await 化，不感知底层是 PG 还是 SQLite。
 *
 * tx() 用单个 client 包裹 BEGIN/COMMIT，保证跨多条 SQL 的原子性
 * （deleteBook 级联删除依赖它，Pool.query 多连接下不能保证同事务）。
 */
import pg from "pg";

/** 单条查询函数签名（事务内部使用） */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** repo 层依赖的最小数据库接口（异步） */
export interface Db {
  /** 执行 SQL，返回行数组（SELECT 用）；INSERT/UPDATE/DELETE 忽略返回 */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** 在单连接事务内执行多个查询，提交成功 / 任一失败回滚 */
  tx<T>(fn: (q: QueryFn) => Promise<T>): Promise<T>;
  /** 关闭连接池 */
  close(): Promise<void>;
}

/**
 * 打开 PG 数据库连接池并返回 Db 适配。
 * @param connectionString postgres://user:pass@host:port/db
 */
export function openPgDatabase(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });

  const q = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const r = await pool.query(sql, params as never[]);
    return r.rows as Record<string, unknown>[];
  };

  return {
    async query(sql, params = []) {
      return q(sql, params);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(async (sql, params = []) => {
          const r = await client.query(sql, params as never[]);
          return r.rows as Record<string, unknown>[];
        });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* 回滚失败不掩盖原错误 */
        }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
