import { defineStore } from 'pinia';
import type { AgeBand, Arm, AuditEntry, Participant, PendingRandomization, PendingUnblind, RandomizeInput, SiteTransfer, StratumQuotas, TransferInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v1';

interface TrialState {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  pendingUnblinds: PendingUnblind[];
  transfers: SiteTransfer[];
  stratumQuotas: StratumQuotas;
  transferSeq: number;
}

const seed: TrialState = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' },
    { id: 'p-3', participantNo: 'S02-001', identityKey: 'demo-c', site: '广州中心', ageBand: '65+', status: 'randomized', sequence: 1003, arm: 'B' },
    { id: 'p-4', participantNo: 'S03-001', identityKey: 'demo-d', site: '新加坡中心', ageBand: '65+', status: 'randomized', sequence: 1004, arm: 'A' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
  ],
  pending: [],
  pendingUnblinds: [],
  transfers: [],
  stratumQuotas: {
    上海中心: { '18-44': 2, '45-64': 4, '65+': 2 },
    广州中心: { '18-44': 2, '45-64': 2, '65+': 2 },
    新加坡中心: { '18-44': 2, '45-64': 2, '65+': 1 }
  },
  transferSeq: 0
};

// 同一受试者的迁移写入锁：并发提交时先登记者成功，其余被拒绝
const transferLocks = new Set<string>();

const todayStr = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

export const useTrialStore = defineStore('trial', {
  state: (): TrialState => ({ ...structuredClone(seed), ...readLocal<Partial<TrialState>>(STORAGE_KEY, {}) }) as TrialState,
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) =>
      state.pending.filter((item) => item.status === 'pending').length
      + state.pendingUnblinds.filter((item) => item.status === 'pending').length,
    /** 目标分层名额占用：在组受试者 + 待生效/写入失败的迁移预占 */
    stratumUsage: (state) => (site: string, ageBand: AgeBand) => {
      const held = state.participants.filter((item) => item.site === site && item.ageBand === ageBand).length;
      const reserved = state.transfers.filter((item) => item.toSite === site && item.ageBand === ageBand && (item.status === 'pending' || item.status === 'failed')).length;
      const quota = state.stratumQuotas[site]?.[ageBand] ?? 0;
      return { held, reserved, quota, available: quota - held - reserved };
    }
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        pendingUnblinds: this.pendingUnblinds,
        transfers: this.transfers,
        stratumQuotas: this.stratumQuotas,
        transferSeq: this.transferSeq
      });
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string; arm?: Arm } {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.commitRandomization(input);
    },
    commitRandomization(input: RandomizeInput): { ok: boolean; message: string; arm?: Arm } {
      const usage = this.stratumUsage(input.site, input.ageBand);
      if (usage.available <= 0) {
        this.addAudit('quota-blocked', `拒绝入组：${input.site} ${input.ageBand} 分层名额已满（${usage.held + usage.reserved}/${usage.quota}）`, input.actor, input.participantNo);
        return { ok: false, message: `${input.site} ${input.ageBand} 分层名额已满` };
      }
      const sequence = 1000 + this.participants.length + 1;
      const sameStratum = this.participants.filter((item) => item.site === input.site && item.ageBand === input.ageBand);
      const arm: Arm = sameStratum.filter((item) => item.arm === 'A').length <= sameStratum.filter((item) => item.arm === 'B').length ? 'A' : 'B';
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机，序列号 ${sequence}`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央序列号 ${sequence}`, arm };
    },
    commitPending(id: string, actor: string): { ok: boolean; message: string } {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return { ok: false, message: '记录不存在或已处理' };
      const usage = this.stratumUsage(pending.payload.site, pending.payload.ageBand);
      if (usage.available <= 0) {
        this.addAudit('quota-blocked', `待提交入库被拒绝：${pending.payload.site} ${pending.payload.ageBand} 分层名额已满`, actor, pending.payload.participantNo);
        return { ok: false, message: '目标分层名额已满，无法入库' };
      }
      pending.status = 'committed';
      this.commitRandomization(pending.payload);
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}`, actor, pending.payload.participantNo);
      this.persist();
      return { ok: true, message: '已确认入库' };
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
    },
    queueUnblind(participantId: string, reason: string, actor: string): { ok: boolean; message: string } {
      const participant = this.participants.find((item) => item.id === participantId);
      if (!participant || !reason.trim()) return { ok: false, message: '受试者不存在或揭盲原因为空' };
      if (participant.status === 'unblinded') return { ok: false, message: '该受试者已揭盲' };
      if (this.pendingUnblinds.some((entry) => entry.participantId === participantId && entry.status === 'pending')) return { ok: false, message: '已存在待确认的揭盲申请' };
      this.pendingUnblinds.unshift({ id: crypto.randomUUID(), participantId, participantNo: participant.participantNo, site: participant.site, reason, actor, createdAt: new Date().toISOString(), status: 'pending' });
      this.addAudit('unblind-queued', `揭盲申请进入待确认队列：${participant.participantNo}（${participant.site}）`, actor, participant.participantNo);
      this.persist();
      return { ok: true, message: '揭盲申请已排队，待确认入库' };
    },
    commitUnblind(id: string, actor: string): { ok: boolean; message: string } {
      const item = this.pendingUnblinds.find((entry) => entry.id === id && entry.status === 'pending');
      if (!item) return { ok: false, message: '记录不存在或已处理' };
      const participant = this.participants.find((entry) => entry.id === item.participantId);
      if (!participant || participant.status === 'unblinded') return { ok: false, message: '受试者不存在或已揭盲' };
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      item.status = 'committed';
      this.addAudit('unblinded', `紧急揭盲：${item.reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
      this.persist();
      return { ok: true, message: '揭盲申请已确认入库' };
    },
    async requestTransfer(input: TransferInput, opts: { simulateFailure?: boolean } = {}): Promise<{ ok: boolean; message: string; transfer?: SiteTransfer }> {
      const participant = this.participants.find((item) => item.participantNo === input.participantNo);
      if (!participant) return { ok: false, message: '受试者不存在' };
      if (participant.site === input.toSite) return { ok: false, message: '目标中心与当前中心相同' };
      if (!input.effectiveDate) return { ok: false, message: '请选择生效日期' };
      // 并发守卫：内存锁拦截同一 tick 的并发提交，已登记的活动迁移拦截跨会话重复提交
      const active = this.transfers.find((item) => item.participantNo === input.participantNo && (item.status === 'pending' || item.status === 'failed'));
      if (transferLocks.has(input.participantNo) || active) {
        const rejected = this.registerTransfer(input, participant, 'rejected', '并发冲突：另一中心已提交该受试者的迁移，仅一方成功');
        this.addAudit('transfer-rejected', `${rejected.id} 并发冲突：${input.participantNo} 已存在进行中的迁移，仅一方成功`, input.actor, input.participantNo);
        this.persist();
        return { ok: false, message: '另一中心已提交该受试者的迁移，仅一方成功', transfer: rejected };
      }
      transferLocks.add(input.participantNo);
      try {
        await new Promise((resolve) => setTimeout(resolve, 30)); // 模拟写库窗口，锁已持有
        const usage = this.stratumUsage(input.toSite, participant.ageBand);
        if (usage.available <= 0) {
          const reason = `目标分层名额不足：${input.toSite} ${participant.ageBand} 已占 ${usage.held + usage.reserved}/${usage.quota}`;
          const rejected = this.registerTransfer(input, participant, 'rejected', reason);
          this.addAudit('transfer-rejected', `${rejected.id} 拒绝：${reason}`, input.actor, input.participantNo);
          this.persist();
          return { ok: false, message: '目标分层名额不足，迁移被拒绝', transfer: rejected };
        }
        if (opts.simulateFailure) {
          const failed = this.registerTransfer(input, participant, 'failed', '写入失败：存储节点不可用（模拟），名额已预占，可按迁移编号重试');
          this.addAudit('transfer-failed', `${failed.id} 写入失败，目标分层名额已预占，待按迁移编号重试`, input.actor, input.participantNo);
          this.persist();
          return { ok: false, message: `写入失败，迁移编号 ${failed.id}，可重试且名额不会重复占用`, transfer: failed };
        }
        const transfer = this.registerTransfer(input, participant, 'pending');
        this.addAudit('transfer-requested', `${transfer.id} 迁移申请已登记：${transfer.fromSite} → ${transfer.toSite}，生效日 ${transfer.effectiveDate}，目标分层名额已预占`, input.actor, input.participantNo);
        if (transfer.effectiveDate <= todayStr()) this.applyTransfer(transfer, input.actor);
        this.persist();
        return { ok: true, message: transfer.status === 'effective' ? `迁移已生效，迁移编号 ${transfer.id}` : `迁移申请已登记，迁移编号 ${transfer.id}，待生效`, transfer };
      } finally {
        transferLocks.delete(input.participantNo);
      }
    },
    registerTransfer(input: TransferInput, participant: Participant, status: SiteTransfer['status'], blockReason?: string): SiteTransfer {
      const now = new Date().toISOString();
      const transfer: SiteTransfer = {
        id: `TR-${String(++this.transferSeq).padStart(4, '0')}`,
        participantNo: participant.participantNo,
        fromSite: participant.site,
        toSite: input.toSite,
        ageBand: participant.ageBand,
        effectiveDate: input.effectiveDate,
        status,
        blockReason,
        actor: input.actor,
        attempts: 1,
        createdAt: now,
        updatedAt: now
      };
      this.transfers.unshift(transfer);
      return transfer;
    },
    /** 迁移生效：仅变更所属中心，随机号、治疗组与既往审计保持不变 */
    applyTransfer(transfer: SiteTransfer, actor: string) {
      const participant = this.participants.find((item) => item.participantNo === transfer.participantNo);
      if (!participant || transfer.status === 'effective') return;
      participant.originSite ??= participant.site;
      participant.site = transfer.toSite;
      transfer.status = 'effective';
      transfer.blockReason = undefined;
      transfer.updatedAt = new Date().toISOString();
      // 旧中心未入库的入组/揭盲申请失效，需重新确认
      for (const item of this.pending) {
        if (item.status === 'pending' && item.payload.site === transfer.fromSite && item.payload.participantNo === transfer.participantNo) {
          item.status = 'invalidated';
          this.addAudit('pending-invalidated', `${transfer.id} 生效，旧中心未入库的入组申请失效：${item.payload.participantNo}，需重新确认`, actor, item.payload.participantNo);
        }
      }
      for (const item of this.pendingUnblinds) {
        if (item.status === 'pending' && item.site === transfer.fromSite && item.participantNo === transfer.participantNo) {
          item.status = 'invalidated';
          this.addAudit('pending-invalidated', `${transfer.id} 生效，旧中心未入库的揭盲申请失效：${item.participantNo}，需重新确认`, actor, item.participantNo);
        }
      }
      this.addAudit('transfer-effective', `${transfer.id} 迁移生效：${transfer.participantNo} 现属 ${transfer.toSite}，随机号 ${participant.sequence} 与治疗组保持不变`, actor, transfer.participantNo);
    },
    /** 按迁移编号重试：复用原记录与已预占名额，不重复占用 */
    async retryTransfer(id: string, actor: string, opts: { simulateFailure?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
      const transfer = this.transfers.find((item) => item.id === id);
      if (!transfer) return { ok: false, message: '迁移编号不存在' };
      if (transfer.status !== 'failed') return { ok: false, message: '仅写入失败的迁移可重试' };
      transfer.attempts += 1;
      transfer.updatedAt = new Date().toISOString();
      if (opts.simulateFailure) {
        this.addAudit('transfer-failed', `${id} 第 ${transfer.attempts} 次写入仍失败，名额继续保留`, actor, transfer.participantNo);
        this.persist();
        return { ok: false, message: '写入仍失败，名额保留，可再次重试' };
      }
      transfer.status = 'pending';
      transfer.blockReason = undefined;
      this.addAudit('transfer-retried', `${id} 按迁移编号重试成功（第 ${transfer.attempts} 次），名额未重复占用`, actor, transfer.participantNo);
      if (transfer.effectiveDate <= todayStr()) this.applyTransfer(transfer, actor);
      this.persist();
      return { ok: true, message: transfer.status === 'effective' ? '重试成功，迁移已生效' : '重试成功，待生效日生效' };
    },
    activateTransfer(id: string, actor: string) {
      const transfer = this.transfers.find((item) => item.id === id && item.status === 'pending');
      if (!transfer) return;
      this.applyTransfer(transfer, actor);
      this.persist();
    },
    activateDueTransfers() {
      for (const transfer of this.transfers.filter((item) => item.status === 'pending' && item.effectiveDate <= todayStr())) {
        this.applyTransfer(transfer, '系统');
      }
      this.persist();
    },
    /** 已失效的入组申请重新确认：重跑查重与名额校验 */
    reconfirmPendingEnrollment(id: string, actor: string): { ok: boolean; message: string } {
      const item = this.pending.find((entry) => entry.id === id && entry.status === 'invalidated');
      if (!item) return { ok: false, message: '记录不存在或不在已失效状态' };
      const exists = this.participants.some((entry) => entry.identityKey === item.payload.identityKey || entry.participantNo === item.payload.participantNo);
      if (exists) {
        this.addAudit('duplicate-blocked', `重新确认被拒绝：${item.payload.participantNo} 已入库，无需重复入组`, actor, item.payload.participantNo);
        return { ok: false, message: '受试者已入库，重新确认被拒绝' };
      }
      const usage = this.stratumUsage(item.payload.site, item.payload.ageBand);
      if (usage.available <= 0) {
        this.addAudit('quota-blocked', `重新确认被拒绝：${item.payload.site} ${item.payload.ageBand} 分层名额已满`, actor, item.payload.participantNo);
        return { ok: false, message: '目标分层名额已满，无法重新确认' };
      }
      item.status = 'committed';
      this.commitRandomization(item.payload);
      this.addAudit('pending-reconfirmed', `已失效的入组申请重新确认入库：${item.payload.participantNo}`, actor, item.payload.participantNo);
      this.persist();
      return { ok: true, message: '已重新确认入库' };
    },
    /** 已失效的揭盲申请重新确认：按受试者当前所属中心生效 */
    reconfirmUnblind(id: string, actor: string): { ok: boolean; message: string } {
      const item = this.pendingUnblinds.find((entry) => entry.id === id && entry.status === 'invalidated');
      if (!item) return { ok: false, message: '记录不存在或不在已失效状态' };
      const participant = this.participants.find((entry) => entry.id === item.participantId);
      if (!participant) return { ok: false, message: '受试者不存在' };
      if (participant.status === 'unblinded') {
        this.addAudit('duplicate-blocked', `重新确认被拒绝：${participant.participantNo} 已揭盲`, actor, participant.participantNo);
        return { ok: false, message: '受试者已揭盲，无需重复确认' };
      }
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      item.status = 'committed';
      this.addAudit('pending-reconfirmed', `已失效的揭盲申请重新确认生效：${participant.participantNo}（现属 ${participant.site}）`, actor, participant.participantNo);
      this.persist();
      return { ok: true, message: '揭盲申请已重新确认并生效' };
    }
  }
});
