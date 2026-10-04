import { defineStore } from 'pinia';
import type { AgeBand, Arm, AuditEntry, CenterTransfer, Participant, PendingRandomization, RandomizeInput, TransferInput, UnblindPayload } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v1';

/** 各中心分层名额（中心 + 年龄分层）；未配置的中心用默认名额 */
const STRATUM_QUOTA: Record<string, number> = { '上海中心': 5, '广州中心': 2, '新加坡中心': 2 };
const DEFAULT_STRATUM_QUOTA = 2;
const quotaOf = (site: string): number => STRATUM_QUOTA[site] ?? DEFAULT_STRATUM_QUOTA;

const seed: { participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[]; transfers: CenterTransfer[] } = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A', version: 0 },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B', version: 0 }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
  ],
  pending: [],
  transfers: []
};

export const useTrialStore = defineStore('trial', {
  state: () => readLocal(STORAGE_KEY, seed),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    /** 某中心某分层当前已占用名额 */
    stratumOccupancy: (state) => (site: string, ageBand: AgeBand) =>
      state.participants.filter((item) => item.site === site && item.ageBand === ageBand).length,
    quotaOf: () => (site: string) => quotaOf(site)
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, { participants: this.participants, audits: this.audits, pending: this.pending, transfers: this.transfers });
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
        const queued: PendingRandomization = {
          id: crypto.randomUUID(),
          kind: 'randomize',
          site: input.site,
          participantNo: input.participantNo,
          payload: input,
          createdAt: new Date().toISOString(),
          status: 'pending'
        };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交入组申请进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.commitRandomization(input);
    },
    commitRandomization(input: RandomizeInput): { ok: boolean; message: string; arm: Arm } {
      const sequence = 1000 + this.participants.length + 1;
      const sameStratum = this.participants.filter((item) => item.site === input.site && item.ageBand === input.ageBand);
      const arm: Arm = sameStratum.filter((item) => item.arm === 'A').length <= sameStratum.filter((item) => item.arm === 'B').length ? 'A' : 'B';
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm, version: 0 };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机，序列号 ${sequence}`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央序列号 ${sequence}`, arm };
    },
    commitPending(id: string, actor: string) {
      const item = this.pending.find((pending) => pending.id === id && pending.status === 'pending');
      if (!item) return;
      if (item.kind === 'unblind') {
        const payload = item.payload as UnblindPayload;
        const participant = this.participants.find((p) => p.id === payload.participantId);
        if (participant && participant.status !== 'unblinded') {
          this.emergencyUnblind(payload.participantId, payload.reason, payload.actor || actor);
        }
      } else {
        this.commitRandomization(item.payload as RandomizeInput);
      }
      item.status = 'committed';
      item.invalidReason = undefined;
      this.addAudit('pending-committed', `待提交记录已确认入库：${item.participantNo}`, actor, item.participantNo);
      this.persist();
    },
    /** 揭盲申请：离线时进入待处理队列（未入库），联网后确认 */
    submitUnblind(id: string, reason: string, actor: string, offline: boolean) {
      if (offline) {
        const participant = this.participants.find((item) => item.id === id);
        if (!participant) return;
        this.pending.unshift({
          id: crypto.randomUUID(),
          kind: 'unblind',
          site: participant.site,
          participantNo: participant.participantNo,
          payload: { participantId: id, reason, actor },
          createdAt: new Date().toISOString(),
          status: 'pending'
        });
        this.addAudit('pending-queued', `离线提交揭盲申请进入待处理队列：${participant.participantNo}`, actor, participant.participantNo);
        return;
      }
      this.emergencyUnblind(id, reason, actor);
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
    },
    /**
     * 转中心迁移。
     * - 保留原受试者记录，随机号/治疗组/既往审计不变，仅追加迁移历史。
     * - 目标分层名额不足 → 拒绝（blocked）。
     * - 乐观并发：两个中心同时提交只让一方成功（版本不一致即拒绝）。
     * - 写入失败（failed）后按迁移编号重试：已生效则幂等返回，已占用则不重复占用名额。
     */
    commitTransfer(input: TransferInput, opts: { simulateFailure?: boolean } = {}): { ok: boolean; message: string; transfer?: CenterTransfer; retryable?: boolean } {
      const now = new Date().toISOString();
      const participant = this.participants.find((item) => item.id === input.participantId);
      if (!participant) return { ok: false, message: '受试者不存在' };

      const existing = this.transfers.find((item) => item.id === input.id);
      // 幂等：同一迁移编号已生效，直接返回，不重复占用名额
      if (existing && existing.status === 'committed') {
        return { ok: true, message: `迁移 ${existing.id} 已生效（幂等重试，未重复占用名额）`, transfer: existing };
      }
      if (existing && existing.status === 'blocked') {
        return { ok: false, message: existing.blockReason ?? '迁移已阻塞', transfer: existing };
      }
      const isRetry = existing?.status === 'failed';
      const fromSite = existing ? existing.fromSite : participant.site;

      if (input.toSite === fromSite) return { ok: false, message: '目标中心与当前中心相同' };
      if (!input.effectiveDate) return { ok: false, message: '请选择生效日' };

      // 乐观并发：两个中心同时提交时只让一方成功（重试同一迁移编号不做并发判定）
      if (!isRetry && participant.version !== input.expectedVersion) {
        const reason = `并发冲突：另一方已提交（期望版本 ${input.expectedVersion}，当前版本 ${participant.version}）`;
        const transfer = this.upsertTransfer(input, participant, fromSite, 'blocked', reason, now, participant.version);
        this.addAudit('transfer-blocked', `迁移 ${input.id} 阻塞：${reason}`, input.actor, participant.participantNo);
        return { ok: false, message: reason, transfer };
      }

      // 名额校验：目标分层名额不足则拒绝（已被本迁移占用则跳过，避免重试误判）
      const alreadyOccupied = participant.site === input.toSite;
      if (!alreadyOccupied) {
        const occupied = this.stratumOccupancy(input.toSite, participant.ageBand);
        const quota = quotaOf(input.toSite);
        if (occupied >= quota) {
          const reason = `目标分层名额不足：${input.toSite} ${participant.ageBand} 已占 ${occupied}/${quota}`;
          const transfer = this.upsertTransfer(input, participant, fromSite, 'blocked', reason, now, participant.version);
          this.addAudit('transfer-blocked', `迁移 ${input.id} 阻塞：${reason}`, input.actor, participant.participantNo);
          return { ok: false, message: reason, transfer };
        }
      }

      // 占用名额：仅在首次生效时递增版本；重试不重复占用
      if (!alreadyOccupied) {
        participant.site = input.toSite;
        participant.version += 1;
      }

      // 写入失败：落库为 failed，可按迁移编号重试
      if (opts.simulateFailure) {
        const transfer = this.upsertTransfer(input, participant, fromSite, 'failed', '写入失败，可按迁移编号重试', now, participant.version);
        this.addAudit('transfer-failed', `迁移 ${input.id} 写入失败，可按迁移编号 ${input.id} 重试`, input.actor, participant.participantNo);
        this.persist();
        return { ok: false, message: '写入失败，可按迁移编号重试', transfer, retryable: true };
      }

      const transfer = this.upsertTransfer(input, participant, fromSite, 'committed', undefined, now, participant.version);
      this.addAudit('transfer-committed', `迁移 ${input.id} 生效：${fromSite} → ${input.toSite}，生效日 ${input.effectiveDate}；随机号 ${participant.sequence}、治疗组 ${participant.arm ?? '未分配'}、既往审计均不变`, input.actor, participant.participantNo);

      // 迁移生效后，旧中心未入库的入组/揭盲申请失效，需重新确认
      this.invalidatePending(participant, fromSite);

      this.persist();
      return { ok: true, message: `迁移成功：已转至 ${input.toSite}（生效日 ${input.effectiveDate}）`, transfer };
    },
    upsertTransfer(input: TransferInput, participant: Participant, fromSite: string, status: CenterTransfer['status'], blockReason: string | undefined, now: string, version: number): CenterTransfer {
      const existing = this.transfers.find((item) => item.id === input.id);
      if (existing) {
        existing.toSite = input.toSite;
        existing.effectiveDate = input.effectiveDate;
        existing.status = status;
        existing.blockReason = blockReason;
        existing.version = version;
        existing.attempts += 1;
        existing.updatedAt = now;
        return existing;
      }
      const transfer: CenterTransfer = {
        id: input.id,
        participantId: participant.id,
        participantNo: participant.participantNo,
        fromSite,
        toSite: input.toSite,
        ageBand: participant.ageBand,
        effectiveDate: input.effectiveDate,
        status,
        blockReason,
        version,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
        actor: input.actor
      };
      this.transfers.unshift(transfer);
      return transfer;
    },
    /** 迁移生效后，旧中心未入库的入组/揭盲申请失效（保留记录），需重新确认 */
    invalidatePending(participant: Participant, fromSite: string) {
      for (const item of this.pending) {
        if (item.status !== 'pending' || item.site !== fromSite) continue;
        const relates = item.kind === 'unblind'
          ? (item.payload as UnblindPayload).participantId === participant.id
          : (item.payload as RandomizeInput).identityKey === participant.identityKey || (item.payload as RandomizeInput).participantNo === participant.participantNo;
        if (!relates) continue;
        item.status = 'invalid';
        item.invalidReason = `迁移生效（${fromSite} → ${participant.site}），原中心申请失效，请重新确认`;
        this.addAudit('pending-invalidated', `待提交${item.kind === 'unblind' ? '揭盲' : '入组'}申请失效：${item.participantNo}（${fromSite}）`, '系统', item.participantNo);
      }
    },
    /** 失效申请重新确认：重新校验并入库 */
    reconfirmPending(id: string, actor: string) {
      const item = this.pending.find((pending) => pending.id === id);
      if (!item || item.status !== 'invalid') return;
      if (item.kind === 'unblind') {
        const payload = item.payload as UnblindPayload;
        const participant = this.participants.find((p) => p.id === payload.participantId);
        if (participant && participant.status !== 'unblinded') {
          this.emergencyUnblind(payload.participantId, payload.reason, payload.actor || actor);
        }
      } else {
        const payload = item.payload as RandomizeInput;
        const duplicate = this.participants.some((p) => p.identityKey === payload.identityKey || p.participantNo === payload.participantNo);
        if (duplicate) {
          item.invalidReason = '重新确认仍被阻止：受试者已存在，迁移后请勿重复入组';
          this.persist();
          return;
        }
        this.commitRandomization(payload);
      }
      item.status = 'committed';
      item.invalidReason = undefined;
      this.addAudit('pending-reconfirmed', `失效申请已重新确认入库：${item.participantNo}`, actor, item.participantNo);
      this.persist();
    }
  }
});
