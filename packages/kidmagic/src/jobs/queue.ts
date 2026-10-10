/**
 * BullMQ 队列装配（P0-2）：绘本配图异步化。
 *
 * 只负责把"章节配图"任务入队/消费，业务逻辑在 `image-jobs.ts`。
 * 连接约定：默认 redis://localhost:6379（本地用 Memurai 提供 Redis 兼容服务），
 * 可通过 REDIS_HOST / REDIS_PORT 覆盖（云上容器用 docker compose 注入）。
 *
 * 健壮性：Queue/Worker 构造为懒连接，不立刻断 Redis；真正连接失败在入队时暴露，
 * 由调用方（start_book_generation）捕获并降级为同步图生图——server 永不因队列不可用而崩。
 */
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Db } from "../storage/db-pg.ts";
import { chapterImageProcessor, type ChapterImageJobData } from "./image-jobs.ts";

export const IMAGE_QUEUE_NAME = "kidmagic-chapter-images";

/** Redis 连接选项（本地 Memurai 默认，云上覆盖） */
export function redisConnection(): ConnectionOptions {
	return {
		host: process.env.REDIS_HOST ?? "localhost",
		port: Number(process.env.REDIS_PORT ?? 6379),
	};
}

/** 创建"章节配图"队列（用于入队） */
export function createImageQueue(connection: ConnectionOptions): Queue<ChapterImageJobData> {
	return new Queue<ChapterImageJobData>(IMAGE_QUEUE_NAME, { connection });
}

/** 创建"章节配图"Worker（用于消费；processor 完成后自动把书标 done） */
export function createImageWorker(db: Db, connection: ConnectionOptions): Worker<ChapterImageJobData> {
	return new Worker<ChapterImageJobData>(
		IMAGE_QUEUE_NAME,
		async (job) => chapterImageProcessor(db, job.data),
		{ connection },
	);
}
