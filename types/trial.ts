export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AgeBand = '18-44' | '45-64' | '65+';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'quota-blocked'
  | 'unblind-queued'
  | 'pending-invalidated'
  | 'pending-reconfirmed'
  | 'transfer-requested'
  | 'transfer-effective'
  | 'transfer-rejected'
  | 'transfer-failed'
  | 'transfer-retried';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  /** 首次入组中心，迁移后保留原记录 */
  originSite?: string;
  ageBand: AgeBand;
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  unblindedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export type PendingStatus = 'pending' | 'committed' | 'invalidated';

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: PendingStatus;
}

/** 旧中心离线提交、尚未入库的揭盲申请 */
export interface PendingUnblind {
  id: string;
  participantId: string;
  participantNo: string;
  site: string;
  reason: string;
  actor: string;
  createdAt: string;
  status: PendingStatus;
}

/** pending=待生效 failed=写入失败待重试（两者均预占目标分层名额） */
export type TransferStatus = 'pending' | 'effective' | 'rejected' | 'failed';

export interface SiteTransfer {
  /** 迁移编号，幂等键，重试时复用 */
  id: string;
  participantNo: string;
  fromSite: string;
  toSite: string;
  ageBand: AgeBand;
  /** YYYY-MM-DD */
  effectiveDate: string;
  status: TransferStatus;
  blockReason?: string;
  actor: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransferInput {
  participantNo: string;
  toSite: string;
  effectiveDate: string;
  actor: string;
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  actor: string;
}

/** 各中心 × 年龄分层的入组名额 */
export type StratumQuotas = Record<string, Record<AgeBand, number>>;
