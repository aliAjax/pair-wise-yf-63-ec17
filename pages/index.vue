<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { PendingStatus, TransferStatus, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, pendingUnblinds, transfers } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({ validationSchema: schema, initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' } });
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

const SITES = ['上海中心', '广州中心', '新加坡中心'];
const AGE_BANDS = ['18-44', '45-64', '65+'] as const;
const todayStr = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const transferForm = reactive({ participantNo: '', toSite: '', effectiveDate: todayStr(), actor: '协调员李敏' });
const failWrite = ref(false);
const selectedParticipant = computed(() => participants.value.find((item) => item.participantNo === transferForm.participantNo));
const targetSites = computed(() => SITES.filter((item) => item !== selectedParticipant.value?.site));
const targetUsage = computed(() => (selectedParticipant.value && transferForm.toSite ? trial.stratumUsage(transferForm.toSite, selectedParticipant.value.ageBand) : null));
const quotaBoard = computed(() => SITES.map((siteName) => {
  const row: Record<string, string> = { site: siteName };
  for (const band of AGE_BANDS) {
    const usage = trial.stratumUsage(siteName, band);
    row[band] = `${usage.held + usage.reserved}/${usage.quota}`;
  }
  return row;
}));

const transferStatusMeta: Record<TransferStatus, { label: string; type: 'success' | 'info' | 'warning' | 'danger' }> = {
  pending: { label: '待生效', type: 'warning' },
  effective: { label: '已生效', type: 'success' },
  rejected: { label: '已拒绝', type: 'info' },
  failed: { label: '写入失败', type: 'danger' }
};
const pendingStatusMeta: Record<PendingStatus, { label: string; type: 'success' | 'info' | 'warning' | 'danger' }> = {
  pending: { label: '待提交', type: 'warning' },
  committed: { label: '已入库', type: 'success' },
  invalidated: { label: '已失效', type: 'danger' }
};
const auditType = (action: string) => {
  if (action === 'unblinded' || action === 'transfer-failed') return 'danger';
  if (['duplicate-blocked', 'quota-blocked', 'transfer-rejected', 'pending-invalidated'].includes(action)) return 'warning';
  if (['transfer-effective', 'transfer-retried', 'pending-reconfirmed'].includes(action)) return 'success';
  return 'primary';
};

const visibleArm = (arm?: 'A' | 'B', status?: string) => {
  if (role.value === 'pharmacist') return arm ?? '待分配';
  if (role.value === 'monitor' && status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};

const submit = handleSubmit((values) => {
  const result = trial.randomize(values, offline.value);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
});

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空', confirmButtonText: '确认并审计' });
    trial.emergencyUnblind(id, value, actor.value);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

const queueUnblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写揭盲申请原因（进入待确认队列）`, '申请揭盲', { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空', confirmButtonText: '提交申请' });
    const result = trial.queueUnblind(id, value, actor.value);
    result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
  } catch {}
};

const commitPending = (id: string) => {
  const result = trial.commitPending(id, actor.value);
  result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
};
const commitUnblind = (id: string) => {
  const result = trial.commitUnblind(id, actor.value);
  result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
};
const reconfirmEnrollment = (id: string) => {
  const result = trial.reconfirmPendingEnrollment(id, actor.value);
  result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
};
const reconfirmUnblind = (id: string) => {
  const result = trial.reconfirmUnblind(id, actor.value);
  result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
};

const submitTransfer = async () => {
  if (!transferForm.participantNo) { ElMessage.warning('请选择受试者'); return; }
  if (!transferForm.toSite) { ElMessage.warning('请选择目标中心'); return; }
  if (!transferForm.effectiveDate) { ElMessage.warning('请选择生效日期'); return; }
  const result = await trial.requestTransfer({ ...transferForm }, { simulateFailure: failWrite.value });
  result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
};

const simulateConcurrent = async () => {
  const participant = selectedParticipant.value;
  if (!participant) { ElMessage.warning('请先选择受试者'); return; }
  const targets = SITES.filter((item) => item !== participant.site);
  const [first, second] = await Promise.all([
    trial.requestTransfer({ participantNo: participant.participantNo, toSite: targets[0], effectiveDate: transferForm.effectiveDate || todayStr(), actor: '中心A协调员' }, { simulateFailure: failWrite.value }),
    trial.requestTransfer({ participantNo: participant.participantNo, toSite: targets[1] ?? targets[0], effectiveDate: transferForm.effectiveDate || todayStr(), actor: '中心B协调员' }, { simulateFailure: failWrite.value })
  ]);
  ElMessage.info(`中心A：${first.ok ? '登记成功' : '被拦截'}；中心B：${second.ok ? '登记成功' : '被拦截'}（仅一方成功）`);
};

const retryTransfer = async (id: string) => {
  const result = await trial.retryTransfer(id, transferForm.actor, { simulateFailure: failWrite.value });
  result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
};
const activateTransfer = (id: string) => {
  trial.activateTransfer(id, transferForm.actor);
  ElMessage.success('迁移已生效，旧中心未入库申请已失效');
};

onMounted(() => trial.activateDueTransfers());

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount
}));
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
      <div class="stat"><span>迁移记录</span><b>{{ transfers.length }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b><el-switch v-model="offline" active-text="模拟离线" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand"><el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%">执行分层区组随机</el-button>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ role }}</el-tag></div></template>
        <el-table :data="participants" max-height="480">
          <el-table-column prop="participantNo" label="受试者" min-width="100" />
          <el-table-column label="中心" min-width="140">
            <template #default="{ row }">
              {{ row.site }}
              <el-tag v-if="row.originSite && row.originSite !== row.site" size="small" type="warning" effect="plain">原 {{ row.originSite }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="sequence" label="随机号" width="80" />
          <el-table-column label="治疗组" width="90"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="160">
            <template #default="{ row }">
              <template v-if="role === 'investigator'">
                <el-button size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button>
                <el-button size="small" type="warning" plain @click="queueUnblind(row.id, row.participantNo)">申请揭盲</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('transfer') }}</b><el-switch v-model="failWrite" active-text="模拟写入失败" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submitTransfer">
          <el-form-item label="受试者">
            <el-select v-model="transferForm.participantNo" style="width:100%" placeholder="选择受试者" @change="transferForm.toSite = ''">
              <el-option v-for="item in participants" :key="item.participantNo" :label="`${item.participantNo} · ${item.site} · ${item.ageBand}`" :value="item.participantNo" />
            </el-select>
          </el-form-item>
          <el-form-item label="目标中心">
            <el-select v-model="transferForm.toSite" style="width:100%" placeholder="选择目标中心" :disabled="!selectedParticipant">
              <el-option v-for="item in targetSites" :key="item" :label="item" :value="item" />
            </el-select>
          </el-form-item>
          <el-form-item label="生效日期"><el-date-picker v-model="transferForm.effectiveDate" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
          <el-form-item label="操作人"><el-input v-model="transferForm.actor" /></el-form-item>
          <el-alert
            v-if="targetUsage && selectedParticipant"
            :type="targetUsage.available > 0 ? 'success' : 'error'"
            :closable="false"
            style="margin-bottom:12px"
            :title="`目标分层 ${selectedParticipant.ageBand}：已占 ${targetUsage.held + targetUsage.reserved} / 名额 ${targetUsage.quota}（含迁移预占 ${targetUsage.reserved}）`"
          />
          <div style="display:flex;gap:8px">
            <el-button type="primary" native-type="submit" style="flex:1">提交迁移申请</el-button>
            <el-button type="warning" plain @click="simulateConcurrent">模拟双中心并发提交</el-button>
          </div>
        </el-form>
        <el-divider>分层名额看板（已占/名额，含迁移预占）</el-divider>
        <el-table :data="quotaBoard" size="small">
          <el-table-column prop="site" label="中心" min-width="100" />
          <el-table-column prop="18-44" label="18-44" width="70" />
          <el-table-column prop="45-64" label="45-64" width="70" />
          <el-table-column prop="65+" label="65+" width="70" />
        </el-table>
      </el-card>

      <el-card shadow="never">
        <template #header><b>{{ t('transfers') }}</b><el-tag type="info" style="float:right">随机号与治疗组不变</el-tag></template>
        <el-empty v-if="transfers.length === 0" description="暂无迁移记录" />
        <el-table v-else :data="transfers" max-height="480">
          <el-table-column prop="id" label="迁移编号" width="90" />
          <el-table-column prop="participantNo" label="受试者" width="90" />
          <el-table-column label="迁移" min-width="140"><template #default="{ row }">{{ row.fromSite }} → {{ row.toSite }}</template></el-table-column>
          <el-table-column prop="ageBand" label="分层" width="70" />
          <el-table-column prop="effectiveDate" label="生效日" width="105" />
          <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="transferStatusMeta[row.status].type">{{ transferStatusMeta[row.status].label }}</el-tag></template></el-table-column>
          <el-table-column label="阻塞原因" min-width="170"><template #default="{ row }">{{ row.blockReason ?? '—' }}</template></el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button v-if="row.status === 'failed'" size="small" type="danger" plain @click="retryTransfer(row.id)">重试</el-button>
              <el-button v-else-if="row.status === 'pending'" size="small" type="primary" plain @click="activateTransfer(row.id)">立即生效</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0 && pendingUnblinds.length === 0" description="暂无待提交记录" />
        <template v-else>
          <el-table v-if="pending.length" :data="pending">
            <el-table-column prop="payload.participantNo" label="受试者" width="100" />
            <el-table-column label="类型" width="70"><template #default>入组</template></el-table-column>
            <el-table-column prop="payload.site" label="中心" width="100" />
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="pendingStatusMeta[row.status].type">{{ pendingStatusMeta[row.status].label }}</el-tag></template></el-table-column>
            <el-table-column label="操作" min-width="110">
              <template #default="{ row }">
                <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="commitPending(row.id)">确认入库</el-button>
                <el-button v-else-if="row.status === 'invalidated'" size="small" type="warning" @click="reconfirmEnrollment(row.id)">重新确认</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-table v-if="pendingUnblinds.length" :data="pendingUnblinds" style="margin-top:8px">
            <el-table-column prop="participantNo" label="受试者" width="100" />
            <el-table-column label="类型" width="70"><template #default>揭盲</template></el-table-column>
            <el-table-column prop="site" label="中心" width="100" />
            <el-table-column prop="reason" label="原因" min-width="120" show-overflow-tooltip />
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="pendingStatusMeta[row.status].type">{{ pendingStatusMeta[row.status].label }}</el-tag></template></el-table-column>
            <el-table-column label="操作" min-width="110">
              <template #default="{ row }">
                <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="commitUnblind(row.id)">确认入库</el-button>
                <el-button v-else-if="row.status === 'invalidated'" size="small" type="warning" @click="reconfirmUnblind(row.id)">重新确认</el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="auditType(entry.action)">
            <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
</style>
