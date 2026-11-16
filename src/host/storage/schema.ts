/**
 * dsh-shared-memories — SQLite 物化视图 Schema
 * ---------------------------------------------------------------------------
 * 三条铁律：
 *   1. 这里是**唯一**的 DDL 出处；测试与生产共用它，避免"测试库和真库不一致"。
 *   2. 库文件永远不进 git（见 .gitignore）；真相源是 journal/*.jsonl。
 *   3. 迁移只增不改：`SCHEMA_VERSION` 单调递增，`migrate()` 只跑幂等的
 *      `CREATE ... IF NOT EXISTS`，老库直接就地升级，不做破坏性 ALTER。
 */

import type { SqlDriver } from '../../shared/types.js'

/**
 * 当前 schema 版本；恢复流程会把 `PRAGMA user_version` 与它比对。
 *
 * v1 → v2：`memory_entity.last_recalled_at`（夜间整理判断"90 天没被用到"的依据）。
 * v2 → v3：`agent_skill`（技能挂载关系随 (workspace, agent) 隔离，并跟着快照漫游）。
 * 因为 v1 从未发布，这里用"建表时就带列 + 老库补一列"的双保险写法。
 */
export const SCHEMA_VERSION = 3

/**
 * 全量 DDL。全部 `IF NOT EXISTS`，可以在任何状态下重复执行。
 *
 * 关于 `uq_version_active`：SQLite 的**部分唯一索引**（partial index）让我们
 * 在数据库层面保证"一个实体最多只有一个活跃版本"，这比在应用层写断言可靠得多。
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 记忆实体：跨时间稳定的"这条记忆在说什么"
CREATE TABLE IF NOT EXISTS memory_entity (
  entity_id     TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  subject_key   TEXT NOT NULL,
  canonical     TEXT NOT NULL DEFAULT '',
  salience      REAL NOT NULL DEFAULT 0.5,
  trust         REAL NOT NULL DEFAULT 0.6,
  status        TEXT NOT NULL DEFAULT 'active',
  -- 实体身份指纹 = hash(workspace|agent|kind|subject_key)，**不含正文**
  content_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- 最近一次被召回的时间（0 = 从未）。夜间整理用它判断"90 天没被用到"。
  last_recalled_at INTEGER NOT NULL DEFAULT 0,
  device_id     TEXT NOT NULL DEFAULT 'local'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_identity
  ON memory_entity(workspace_id, agent_id, content_hash);
CREATE INDEX IF NOT EXISTS ix_entity_scope
  ON memory_entity(workspace_id, agent_id, status);
CREATE INDEX IF NOT EXISTS ix_entity_subject
  ON memory_entity(workspace_id, agent_id, subject_key);

-- 时间树版本：区间 [valid_from, valid_until)，valid_until = NULL 即活跃版本
CREATE TABLE IF NOT EXISTS memory_version (
  version_id         TEXT PRIMARY KEY,
  entity_id          TEXT NOT NULL REFERENCES memory_entity(entity_id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  valid_from         INTEGER NOT NULL,
  valid_until        INTEGER,
  text               TEXT NOT NULL,
  emo_subject        TEXT,
  emo_trigger        TEXT,
  emo_label          TEXT,
  emo_intensity      REAL,
  emo_confidence     REAL,
  source_session_id  TEXT,
  source_seq_start   INTEGER,
  source_seq_end     INTEGER,
  distill_status     TEXT NOT NULL DEFAULT 'raw',
  distill_model      TEXT,
  supersedes         TEXT,
  author             TEXT NOT NULL DEFAULT 'agent',
  device_id          TEXT NOT NULL DEFAULT 'local',
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_version_active
  ON memory_version(entity_id) WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS ix_version_entity_time
  ON memory_version(entity_id, valid_from);

-- 踩坑四段收敛：observation -> lesson -> pattern -> rule（PRD 7）
CREATE TABLE IF NOT EXISTS pitfall (
  pitfall_id     TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  observation    TEXT NOT NULL,
  lesson         TEXT NOT NULL DEFAULT '',
  pattern        TEXT NOT NULL DEFAULT '',
  rule           TEXT NOT NULL DEFAULT '',
  stage          TEXT NOT NULL DEFAULT 'observation',
  confirmed      INTEGER NOT NULL DEFAULT 0,
  occurrences    INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pitfall_scope ON pitfall(workspace_id, agent_id, stage);

-- 快照池索引：git tag 是真相，这张表只是本地缓存（供 UI 秒开）
CREATE TABLE IF NOT EXISTS snapshot_index (
  snapshot_id    TEXT PRIMARY KEY,
  commit_sha     TEXT,
  tag            TEXT,
  device_id      TEXT NOT NULL,
  trigger        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  files          INTEGER NOT NULL DEFAULT 0,
  bytes          INTEGER NOT NULL DEFAULT 0,
  pinned         INTEGER NOT NULL DEFAULT 0,
  summary        TEXT NOT NULL DEFAULT ''
);

-- 隔离区：被污染防御拦下的记忆（PRD 10）
CREATE TABLE IF NOT EXISTS quarantine (
  quarantine_id  TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  reason         TEXT NOT NULL,
  score          REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_quarantine_scope ON quarantine(workspace_id, agent_id, status);

-- 多端冲突记录（PRD 11）
CREATE TABLE IF NOT EXISTS conflict_log (
  conflict_id    TEXT PRIMARY KEY,
  entity_id      TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  local_version  TEXT,
  remote_version TEXT,
  resolution     TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- 人格状态：每个 agent 一份，随快照上行（PRD 9 / 多智能体）
CREATE TABLE IF NOT EXISTS persona_state (
  agent_id       TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  age            INTEGER NOT NULL DEFAULT 10,
  traits         TEXT NOT NULL DEFAULT '{}',
  baseline_hash  TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (agent_id, workspace_id)
);

-- 技能绑定：Agent 挂了哪些工具。
-- 存的是**绑定关系**（谁、什么版本、开着吗、参数），不是技能本体；
-- 作用域与记忆同构 (workspace_id, agent_id)，所以 A 的工具表在库里对 B 不可见。
CREATE TABLE IF NOT EXISTS agent_skill (
  agent_id       TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  skill_id       TEXT NOT NULL,
  version        TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  config         TEXT NOT NULL DEFAULT '{}',
  granted_by     TEXT NOT NULL DEFAULT 'user',
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (agent_id, workspace_id, skill_id)
);
CREATE INDEX IF NOT EXISTS ix_agent_skill_scope ON agent_skill(workspace_id, agent_id);

-- 审计：全局检索、记忆修正、隔离区操作都必须留痕
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id       TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  action         TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_scope ON audit_log(workspace_id, agent_id, created_at);

-- 设备注册表
CREATE TABLE IF NOT EXISTS device (
  device_id      TEXT PRIMARY KEY,
  hostname       TEXT NOT NULL DEFAULT '',
  last_seen_at   INTEGER NOT NULL DEFAULT 0,
  last_seq       INTEGER NOT NULL DEFAULT 0
);

-- 同步游标：记录本机已经回放到 journal 的什么位置
CREATE TABLE IF NOT EXISTS sync_state (
  device_id      TEXT PRIMARY KEY,
  last_seq       INTEGER NOT NULL DEFAULT 0,
  last_pull_at   INTEGER NOT NULL DEFAULT 0,
  last_push_at   INTEGER NOT NULL DEFAULT 0
);
`

/** 读取 `PRAGMA user_version`；驱动不支持 PRAGMA 时返回 0（视为空库）。 */
export function readSchemaVersion(db: SqlDriver): number {
  try {
    const rows = db.all<{ user_version?: number }>('PRAGMA user_version')
    const value = rows[0]?.user_version
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

/**
 * 幂等迁移：建表 → 写版本号。
 *
 * 不做 `DROP`、不做列重命名；后续版本新增字段时用 `ALTER TABLE ... ADD COLUMN`
 * 追加到这里，并由 `from` 版本号决定是否需要执行（当前只有 v1，所以无条件执行）。
 */
export function migrate(db: SqlDriver, target = SCHEMA_VERSION): { from: number; to: number } {
  const from = readSchemaVersion(db)
  db.exec(SCHEMA_SQL)
  if (from > 0 && from < 2) {
    // v1 的库已经在用：补列。重复补列会抛 "duplicate column name"，直接忽略。
    try {
      db.exec(`ALTER TABLE memory_entity ADD COLUMN last_recalled_at INTEGER NOT NULL DEFAULT 0`)
    } catch {
      /* 已经有这列了 */
    }
  }
  if (from > 0 && from < 3) {
    // v2 → v3：agent_skill 表由上面的 SCHEMA_SQL（IF NOT EXISTS）建好，没有数据要搬。
    // 这里显式留一段，是为了让"加表"也走迁移路径，而不是靠"反正每次都执行全量 DDL"。
  }
  try {
    db.exec(`PRAGMA user_version = ${target}`)
  } catch {
    // JsonDriver 等不支持 PRAGMA 的后端：版本号由文件元数据接管，这里静默跳过。
  }
  return { from, to: target }
}
