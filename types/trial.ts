export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'transfer-committed'
  | 'transfer-blocked'
  | 'transfer-failed'
  | 'pending-invalidated'
  | 'pending-reconfirmed';

export type AgeBand = '18-44' | '45-64' | '65+';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  unblindedAt?: string;
  /** 乐观并发版本号：迁移生效时递增，随机号/治疗组/既往审计均不因此改变 */
  version: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export type PendingKind = 'randomize' | 'unblind';
export type PendingStatus = 'pending' | 'committed' | 'invalid';

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  actor: string;
}

export interface UnblindPayload {
  participantId: string;
  reason: string;
  actor: string;
}

/** 未入库申请：入组申请或揭盲申请 */
export interface PendingRandomization {
  id: string;
  kind: PendingKind;
  /** 申请受理中心（旧中心） */
  site: string;
  participantNo: string;
  payload: RandomizeInput | UnblindPayload;
  createdAt: string;
  status: PendingStatus;
  invalidReason?: string;
}

export type TransferStatus = 'committed' | 'blocked' | 'failed';

/**
 * 转中心迁移记录。保留原受试者记录，仅追加迁移历史。
 * 迁移编号 id 为幂等键：写入失败后按同一编号重试，名额不重复占用。
 */
export interface CenterTransfer {
  id: string;
  participantId: string;
  participantNo: string;
  fromSite: string;
  toSite: string;
  ageBand: AgeBand;
  effectiveDate: string;
  status: TransferStatus;
  blockReason?: string;
  /** 提交时读取的参与方版本（乐观并发判定依据） */
  version: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  actor: string;
}

export interface TransferInput {
  /** 迁移编号（幂等键） */
  id: string;
  participantId: string;
  toSite: string;
  effectiveDate: string;
  actor: string;
  /** 表单打开时的版本号，用于两个中心同时提交的并发判定 */
  expectedVersion: number;
}
