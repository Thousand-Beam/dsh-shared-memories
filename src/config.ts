/**
 * dsh-shared-memories — 插件配置（Schemastery）
 * ---------------------------------------------------------------------------
 * 约定：
 *  - 所有字段**必须有默认值**：插件在零配置下也要能跑（纯本地模式）。
 *  - 凭据只存"引用名"，绝不存明文（PRD 12）。真实 token 由 DSH 的 credentials
 *    服务注入，仓库里只留 `credentialRef` 这种指针。
 *  - 数值项都带 min/max：配置面板是给人用的，越界值应该在保存时就报错，
 *    而不是在夜里 03:00 的整理任务里炸掉。
 *
 * 灵感来源标注：
 *  [mneme]        多路召回权重 + rerank 精排
 *  [brain-memory] FSRS-5 遗忘曲线参数
 *  [character-sim] 性格沿连续轴小幅漂移（traitShiftMax）
 *  [soul]         Git 自动 commit 与人格升格确认
 */
import Schema from '@deepseek-ai/schemastery'

export type RepoAuthMode = 'ssh-agent' | 'credential-helper' | 'token-ref'
export type PullStrategy = 'ff-only' | 'rebase'
export type OfflinePolicy = 'degraded-readonly' | 'local-only' | 'block'
export type ConflictStrategy = 'keep-both' | 'prefer-newest' | 'manual'
export type TrustSource = 'user' | 'agent' | 'import' | 'external'

/** 配置对象的 TypeScript 形状；与下方 Schema 必须逐项对应。 */
export interface Config {
  /** Git 仓库与认证 */
  repo: {
    /** 仓库根目录；支持 `~`。默认放在 DSH 的配置目录下，避免污染用户项目。 */
    path: string
    branch: string
    /** 远端地址；留空即「纯本地模式」（PRD 1）。 */
    remote: string
    authMode: RepoAuthMode
    /**
     * 凭据引用名（如 `shared-memories/git-token`），不是 token 本身。
     * 实际取值走 DSH credentials 服务；仓库与日志里永远看不到明文。
     */
    credentialRef: string
    autoInit: boolean
    /** commit 署名，避免依赖全局 git config（CI/新机器上常常是空的）。 */
    authorName: string
    authorEmail: string
    /**
     * 设备标识（journal 按设备分片，靠它区分"哪台机器写的"）。
     * 留空 = 用主机名消毒后生成；多端共存时必须唯一。
     */
    deviceId: string
    /**
     * 工作区根目录；留空 = 进程 cwd。
     * `workspace_id` 由它的 realpath 派生，所以**同一项目在不同机器上必须是同一路径**，
     * 否则会被当成两个工作区（这正是隔离机制想要的，但会让漫游丢上下文）。
     */
    workspaceRoot: string
  }

  /** 同步策略（PRD 1） */
  sync: {
    enabled: boolean
    /** 定时快照间隔，秒。默认 5 分钟。 */
    intervalSec: number
    /** 空闲防抖：turn 结束后静置多久才落一次增量，秒。 */
    idleDebounceSec: number
    /** 每次 commit 后是否立刻 push；纯本地模式自动忽略。 */
    pushOnCommit: boolean
    retries: number
    timeoutMs: number
    pullStrategy: PullStrategy
  }

  /** 快照池（PRD 2） */
  snapshot: {
    /** 滑动窗口保留数量，默认 5。 */
    keep: number
    /** Pin 的版本免于 FIFO 清理。 */
    pinProtected: boolean
    triggers: {
      interval: boolean
      idle: boolean
      shutdown: boolean
      manual: boolean
    }
    /** 是否把工作区会话日志一并纳入快照（灵魂功能依赖它）。 */
    includeSessionLogs: boolean
    /** 单次快照体积上限（字节），超过则只提交 journal，不打包会话全文。 */
    maxBytes: number
  }

  /** 冷启动恢复（PRD 1 的强一致性部分） */
  restore: {
    /** true = 恢复完成前拒绝新对话。 */
    blockUntilReady: boolean
    timeoutMs: number
    /** 拉取失败时的降级行为：只读 / 纯本地继续 / 硬阻断。 */
    offlinePolicy: OfflinePolicy
    /** 恢复前逐文件校验 sha256。 */
    verifyHashes: boolean
  }

  /** 记忆引擎 */
  memory: {
    /** 多路混合召回 [mneme] */
    retrieval: {
      /** 关键词（FTS/BM25）权重。 */
      keywordWeight: number
      /** 向量余弦权重；未启用向量时为 0。 */
      vectorWeight: number
      /** 新鲜度权重，按遗忘曲线衰减。 */
      recencyWeight: number
      topK: number
      /** 进入 rerank 前的候选池大小。 */
      candidatePool: number
      rerank: boolean
      /** 空字符串表示复用当前会话模型。 */
      rerankModel: string
      /** 每轮按当前消息召回并注入的条数；0 = 关闭逐轮召回。 */
      injectTopK: number
      /** 逐轮召回段的字符预算。 */
      injectChars: number
    }
    /** 遗忘与修剪 [brain-memory] */
    forgetting: {
      /** 目标留存率，FSRS 的 requestRetention。 */
      requestRetention: number
      maxIntervalDays: number
      /** FSRS-5 的 19 个权重，允许高级用户覆盖。 */
      fsrsWeights: number[]
      /** 低于该稳定度的记忆在夜间整理时被修剪。 */
      pruneBelow: number
      /** 90 天内未被召回则降低 salience 的倍率。 */
      stalePenalty: number
    }
    /** 归档蒸馏（PRD 4） */
    distill: {
      enabled: boolean
      model: string
      /** 低于该置信度的记忆整条丢弃。 */
      confidenceGate: number
      /** 低于该置信度的情感块置 null（绝不猜）。 */
      emotionConfidenceGate: number
      maxInputChars: number
      temperature: number
    }
    /** 夜间整理（PRD 4 的 Sleep Mechanism） */
    consolidate: {
      enabled: boolean
      /** 五段式 cron，默认凌晨 3 点。 */
      cron: string
      /** 相似度高于该值视为重复，合并为一个实体。 */
      mergeSimilarity: number
      maxOpsPerRun: number
    }
  }

  /** 工作区强隔离（PRD 5） */
  isolation: {
    /** 生产环境永远 true；仅测试可关。 */
    strict: boolean
    /** 是否允许 UI 开启全局检索。 */
    allowGlobalSearch: boolean
    /** 全局令牌有效期，毫秒。 */
    globalSearchTtlMs: number
    /** 全局检索必须落审计。 */
    requireAudit: boolean
  }

  /**
   * 会话身份 ↔ 人格身份。
   *
   * 宿主里 `agent.id === agent.session.id`，新建会话就是一个全新的 agent id。
   * 打开继承后，同工作区的新会话会自动挂到最近活跃的那份人格上（人格/记忆/技能一起继承）；
   * 关掉则回到"一个会话一个人格"的旧行为（多 Agent 并行、互不相干时用）。
   */
  identity: {
    inheritOnNewSession: boolean
    /** 一次会话最长认领间隔（毫秒）：超过这个时间没出现的会话不算"同一轮连续使用"。 */
    inheritWindowMs: number
  }

  /** 涌现式人格（PRD 9） */
  persona: {    enabled: boolean
    /** 起始心智年龄，默认 10 岁探索者。 */
    startAge: number
    /** 单次交互允许的最大特质位移 [character-sim]，防止人格突变。 */
    traitShiftMax: number
    /** 底线声明（轻量，不参与成长，只做兜底）。 */
    baselineNotice: string
    /** 踩坑升格为 rule 需要用户确认 [soul/pitfall]。 */
    requireRuleConfirmation: boolean
  }

  /** 污染防御（PRD 10） */
  poison: {
    enabled: boolean
    /** 不同来源的初始信任度。 */
    trustBySource: {
      user: number
      agent: number
      import: number
      external: number
    }
    /** 与当前人格特征的偏离度超过该值即进隔离区。 */
    divergenceThreshold: number
    /** 自动隔离（false 则只在 UI 标红，不阻断）。 */
    autoQuarantine: boolean
  }

  /** 多端冲突（PRD 11） */
  conflict: {
    strategy: ConflictStrategy
    /** 单实体允许并存的最大冲突分支数。 */
    maxBranches: number
  }
}

/** FSRS-5 默认权重（19 项）。写明默认值而不是引用外部常量，保证配置可复现。 */
const FSRS5_DEFAULT = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
]

export const Config: Schema<Config> = Schema.object({
  repo: Schema.object({
    path: Schema.string()
      .default('~/.dsh/shared-memories')
      .description('Git 仓库根目录；纯本地模式也使用该目录。'),
    branch: Schema.string().default('main').description('同步分支。'),
    remote: Schema.string()
      .default('')
      .description('远端地址（如 git@github.com:you/brain.git）。留空 = 纯本地模式。'),
    authMode: Schema.union([
      Schema.const('ssh-agent').description('复用 ssh-agent'),
      Schema.const('credential-helper').description('复用系统 git 凭据'),
      Schema.const('token-ref').description('从 DSH credentials 取引用令牌'),
    ])
      .default('ssh-agent')
      .description('Git 认证方式。'),
    credentialRef: Schema.string()
      .default('shared-memories/git-token')
      .role('secret-ref')
      .description('凭据引用名（不是令牌本身），由 DSH credentials 服务解析。'),
    autoInit: Schema.boolean().default(true).description('目录为空时自动 git init。'),
    authorName: Schema.string().default('dsh-shared-memories').description('commit 署名。'),
    authorEmail: Schema.string()
      .default('shared-memories@localhost')
      .description('commit 邮箱；不需要真实可投递。'),
    deviceId: Schema.string()
      .default('')
      .description('设备标识；留空用主机名。journal 分片与多端冲突检测依赖它，必须唯一。'),
    workspaceRoot: Schema.string()
      .default('')
      .description('工作区根目录；留空用进程 cwd。workspace_id 由它的 realpath 派生。'),
  }).description('仓库与认证'),

  sync: Schema.object({
    enabled: Schema.boolean().default(true).description('总开关；关闭后仅手动保存生效。'),
    intervalSec: Schema.natural().min(30).max(86_400).default(300).description('定时快照间隔（秒）。'),
    idleDebounceSec: Schema.natural().min(5).max(3_600).default(30).description('空闲防抖（秒）。'),
    pushOnCommit: Schema.boolean().default(true).description('commit 后立即 push。'),
    retries: Schema.natural().min(0).max(10).default(3).description('网络操作重试次数。'),
    timeoutMs: Schema.natural().min(5_000).max(300_000).default(30_000).description('单次 Git 操作超时。'),
    pullStrategy: Schema.union([Schema.const('ff-only'), Schema.const('rebase')])
      .default('ff-only')
      .description('冷启动拉取策略；rebase 仅在多端频繁并发时开启。'),
  }).description('同步策略'),

  snapshot: Schema.object({
    keep: Schema.natural().min(1).max(50).default(5).description('滑动窗口保留的快照数量。'),
    pinProtected: Schema.boolean().default(true).description('Pin 的版本免于自动清理。'),
    triggers: Schema.object({
      interval: Schema.boolean().default(true).description('定时触发。'),
      idle: Schema.boolean().default(true).description('空闲触发。'),
      shutdown: Schema.boolean().default(true).description('退出/关机触发。'),
      manual: Schema.boolean().default(true).description('手动按钮触发。'),
    }).description('触发开关'),
    includeSessionLogs: Schema.boolean().default(true).description('快照是否包含工作区会话上下文。'),
    maxBytes: Schema.natural()
      .min(1_048_576)
      .max(2_147_483_648)
      .default(268_435_456)
      .description('单次快照体积上限（字节）。'),
  }).description('快照池'),

  restore: Schema.object({
    blockUntilReady: Schema.boolean().default(true).description('恢复完成前拒绝新对话（强一致性）。'),
    timeoutMs: Schema.natural().min(5_000).max(600_000).default(30_000).description('恢复超时。'),
    offlinePolicy: Schema.union([
      Schema.const('degraded-readonly').description('只读降级，写入禁用并提示'),
      Schema.const('local-only').description('按纯本地继续'),
      Schema.const('block').description('硬阻断，直到恢复成功'),
    ])
      .default('degraded-readonly')
      .description('拉取失败时的行为。'),
    verifyHashes: Schema.boolean().default(true).description('恢复前校验 manifest 中每个文件的 sha256。'),
  }).description('冷启动恢复'),

  memory: Schema.object({
    retrieval: Schema.object({
      keywordWeight: Schema.number().min(0).max(1).default(0.45).description('关键词召回权重。'),
      vectorWeight: Schema.number().min(0).max(1).default(0.4).description('向量召回权重。'),
      recencyWeight: Schema.number().min(0).max(1).default(0.15).description('新鲜度权重。'),
      topK: Schema.natural().min(1).max(100).default(8).description('最终返回条数。'),
      candidatePool: Schema.natural().min(8).max(1_000).default(64).description('rerank 候选池大小。'),
      rerank: Schema.boolean().default(true).description('是否做精排。'),
      rerankModel: Schema.string().default('').description('精排模型；留空复用当前会话模型。'),
      injectTopK: Schema.natural().min(0).max(20).default(6)
        .description('每轮按当前消息召回并注入提示词的条数；0 = 关闭逐轮召回。'),
      injectChars: Schema.natural().min(200).max(8_000).default(900)
        .description('逐轮召回段的总字符预算；超预算的条目直接丢弃。'),
    }).description('混合召回'),
    forgetting: Schema.object({
      requestRetention: Schema.number().min(0.5).max(0.99).default(0.9).description('目标留存率。'),
      maxIntervalDays: Schema.natural().min(30).max(36_500).default(365).description('最大复习间隔。'),
      fsrsWeights: Schema.array(Schema.number()).default(FSRS5_DEFAULT).description('FSRS-5 权重（19 项）。'),
      pruneBelow: Schema.number().min(0).max(1).default(0.15).description('夜间整理修剪阈值。'),
      stalePenalty: Schema.number().min(0).max(1).default(0.5).description('长期未召回的记忆衰减倍率。'),
    }).description('遗忘曲线'),
    distill: Schema.object({
      enabled: Schema.boolean().default(true).description('归档时是否允许深度提炼。'),
      model: Schema.string().default('').description('蒸馏模型；留空复用当前会话模型。'),
      confidenceGate: Schema.number().min(0).max(1).default(0.7).description('记忆置信度闸门。'),
      emotionConfidenceGate: Schema.number().min(0).max(1).default(0.6).description('情感标签置信度闸门。'),
      maxInputChars: Schema.natural().min(1_000).max(200_000).default(24_000).description('单次蒸馏输入上限。'),
      temperature: Schema.number().min(0).max(1).default(0).description('蒸馏温度，建议 0。'),
    }).description('归档蒸馏'),
    consolidate: Schema.object({
      enabled: Schema.boolean().default(true).description('夜间整理总开关。'),
      cron: Schema.string().default('0 3 * * *').description('整理任务 cron。'),
      mergeSimilarity: Schema.number().min(0.5).max(1).default(0.92).description('判定重复的相似度阈值。'),
      maxOpsPerRun: Schema.natural().min(1).max(5_000).default(200).description('单次整理最大操作数。'),
    }).description('夜间整理'),
  }).description('记忆引擎'),

  isolation: Schema.object({
    strict: Schema.boolean().default(true).description('强制注入 workspace 过滤；仅测试可关。'),
    allowGlobalSearch: Schema.boolean().default(false).description('是否允许手动开启全局检索。'),
    globalSearchTtlMs: Schema.natural()
      .min(30_000)
      .max(86_400_000)
      .default(600_000)
      .description('全局检索令牌有效期。'),
    requireAudit: Schema.boolean().default(true).description('全局检索必须落审计。'),
  }).description('工作区隔离'),

  identity: Schema.object({
    inheritOnNewSession: Schema.boolean()
      .default(true)
      .description(
        '新建会话是否继承本工作区最近活跃的人格（人格/记忆/技能/隔离区一起继承）。关掉 = 一会话一人格。',
      ),
    inheritWindowMs: Schema.natural()
      .min(60_000)
      .max(30 * 24 * 3_600_000)
      .default(7 * 24 * 3_600_000)
      .description('认领上一个会话人格的时间窗：超过这么久没出现的会话不再被继承。'),
  }).description('会话身份与人格身份'),

  persona: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用涌现式人格。'),    startAge: Schema.natural().min(1).max(100).default(10).description(
      '内部字段 age 的初值：只存库、随快照漫游，不参与提示渲染（人格由 traits 驱动）。',
    ),
    traitShiftMax: Schema.number().min(0).max(0.2).default(0.05).description('单次特质最大位移。'),
    baselineNotice: Schema.string()
      .default('不做危害性行为；不提供外挂/绕过类帮助；不伪造身份与凭据。')
      .description('底层底线声明，注入 System Prompt 末尾。'),
    requireRuleConfirmation: Schema.boolean().default(true).description('踩坑升格为规则需用户确认。'),
  }).description('人格'),

  poison: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用污染防御。'),
    trustBySource: Schema.object({
      user: Schema.number().min(0).max(1).default(1).description('用户显式输入。'),
      agent: Schema.number().min(0).max(1).default(0.6).description('代理推断。'),
      import: Schema.number().min(0).max(1).default(0.4).description('外部导入。'),
      external: Schema.number().min(0).max(1).default(0.25).description('网页/工具抓取。'),
    }).description('来源信任度'),
    divergenceThreshold: Schema.number().min(0).max(1).default(0.35).description('人格偏离阈值。'),
    autoQuarantine: Schema.boolean().default(true).description('超阈值自动进隔离区。'),
  }).description('污染防御'),

  conflict: Schema.object({
    strategy: Schema.union([
      Schema.const('keep-both').description('保留双方版本，UI 提示合并'),
      Schema.const('prefer-newest').description('取 valid_from 较晚者'),
      Schema.const('manual').description('全部挂起等用户决定'),
    ])
      .default('keep-both')
      .description('多端冲突解决策略。'),
    maxBranches: Schema.natural().min(2).max(32).default(8).description('单实体允许的冲突分支上限。'),
  }).description('冲突解决'),
})

/** 便捷常量：纯本地模式的判断，多处复用避免字符串散落。 */
export function isLocalOnly(config: Config): boolean {
  return config.repo.remote.trim() === ''
}
