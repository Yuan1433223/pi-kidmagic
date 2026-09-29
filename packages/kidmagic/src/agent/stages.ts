/**
 * 引导状态机阶段定义（S0-S4）。
 *
 * 阶段机不在代码里，存在于运行态 + 分阶段提示词；
 * `finishTurn` 钩子负责出口判定与阶段切换。
 *
 * 阶段说明（见 AGENTS.md §3.4）：
 * - S0 见面：欢迎 + 引导逐个上传素材
 * - S1 倾听+魔法反馈：孩子一口气讲完 → 魔法棒轻量动效 → "我们听懂你的意思了"
 * - S2 缺口推理：check_skeleton 后台推理大框架缺什么
 * - S3 最少追问：只对缺口追问，上限 2 轮，控制轮次
 * - S4 概括确认：用孩子原话概括故事 → 最终确认 → 触发生成第一章
 */

/** 故事机引导阶段 */
export type StoryStage = "S0" | "S1" | "S2" | "S3" | "S4";

/** 人设：A=琪琪老师(知心姐姐) / B=动画伙伴(聪明友好卡通) */
export type Persona = "A" | "B";

/** 三级降级等级 */
export type FallbackLevel = "none" | "rephrase" | "choice" | "pause";

/** check_skeleton 返回的骨架缺口类型 */
export type SkeletonGap = "character" | "setting" | "conflict" | "resolution";

/** 运行期阶段状态（finishTurn 钩子读写） */
export interface StageState {
  stage: StoryStage;
  persona: Persona;
  /** 当前阶段三级降级等级：none→rephrase(换问法)→choice(给选项)→pause(今天就到这) */
  fallbackLevel: FallbackLevel;
  /** S3 缺口追问轮数（上限 MAX_GAP_ROUNDS） */
  gapRoundCount: number;
}

/**
 * 单次创作会话的进程内运行态（工具与 finishTurn 钩子共享）。
 *
 * P0 为单会话 demo，运行态存内存；会话产物（素材/元素/角色/绘本）落 SQLite。
 * 跨会话持久化运行态、账号化角色库属 P1/P2。
 */
export interface StoryRuntime extends StageState {
  sessionId: string;
  /** 最近一次 check_skeleton 推理出的缺口（finishTurn 据此裁决） */
  lastGaps: SkeletonGap[];
  /** 已上传待聚类确认的素材 id */
  pendingAssetIds: string[];
  /** 当前绘本 id（S4 生成前置位） */
  bookId?: string;
  /** 最新章节 id（生成后就位） */
  chapterId?: string;
}

export function createRuntime(sessionId: string, persona: Persona = "A"): StoryRuntime {
  return {
    sessionId,
    persona,
    stage: "S0",
    fallbackLevel: "none",
    gapRoundCount: 0,
    lastGaps: [],
    pendingAssetIds: [],
  };
}

/** S3 缺口追问轮数上限（控制交互轮次，不扯远不搞深） */
export const MAX_GAP_ROUNDS = 2;

/** 三级降级中"换问法/给选项"的最大重试次数，超过则保底暂停 */
export const MAX_FALLBACK_RETRIES = 2;
