<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { CenterTransfer, Participant, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, transfers } = storeToRefs(trial);
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
const actorName = computed(() => actor.value ?? '');

const SITES = ['上海中心', '广州中心', '新加坡中心'] as const;

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
    trial.submitUnblind(id, value, actorName.value, offline.value);
    ElMessage.warning(offline.value ? '揭盲申请已进入待提交队列（未入库）' : '已揭盲，审计记录已追加');
  } catch {}
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount,
  transfers: transfers.value.length
}));

// ---- 转中心迁移 ----
const dialogVisible = ref(false);
const transferTarget = ref<Participant | null>(null);
const transferForm = ref<{ toSite: string; effectiveDate: string; simulateFailure: boolean }>({ toSite: '广州中心', effectiveDate: '', simulateFailure: false });
const transferResult = ref<{ r1?: { ok: boolean; message: string }; r2?: { ok: boolean; message: string } }>({});

const today = () => new Date().toISOString().slice(0, 10);

const openTransfer = (row: Participant) => {
  transferTarget.value = row;
  const next = SITES.find((s) => s !== row.site) ?? '广州中心';
  transferForm.value = { toSite: next, effectiveDate: today(), simulateFailure: false };
  transferResult.value = {};
  dialogVisible.value = true;
};

const targetOccupancy = computed(() => {
  const p = transferTarget.value;
  if (!p) return { occupied: 0, quota: 0 };
  return { occupied: trial.stratumOccupancy(transferForm.value.toSite, p.ageBand), quota: trial.quotaOf(transferForm.value.toSite) };
});

const buildTransferInput = (id: string, expectedVersion: number) => ({
  id,
  participantId: transferTarget.value!.id,
  toSite: transferForm.value.toSite,
  effectiveDate: transferForm.value.effectiveDate,
  actor: actorName.value,
  expectedVersion
});

const submitTransfer = () => {
  if (!transferTarget.value) return;
  const id = `TR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const result = trial.commitTransfer(buildTransferInput(id, transferTarget.value.version), { simulateFailure: transferForm.value.simulateFailure });
  transferResult.value = { r1: result };
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
};

/** 模拟两个中心同时提交：同一版本号下只让一方成功 */
const submitConcurrent = () => {
  if (!transferTarget.value) return;
  const base = { participantId: transferTarget.value.id, toSite: transferForm.value.toSite, effectiveDate: transferForm.value.effectiveDate, actor: actorName.value, expectedVersion: transferTarget.value.version };
  const r1 = trial.commitTransfer({ ...base, id: `TR-${Date.now()}-A` });
  const r2 = trial.commitTransfer({ ...base, id: `TR-${Date.now()}-B` });
  transferResult.value = { r1, r2 };
  if (r1.ok && !r2.ok) ElMessage.success('并发提交完成：仅一方成功');
  else ElMessage.warning('并发提交结果异常');
};

const retryTransfer = (row: CenterTransfer) => {
  const result = trial.commitTransfer({
    id: row.id,
    participantId: row.participantId,
    toSite: row.toSite,
    effectiveDate: row.effectiveDate,
    actor: actorName.value,
    expectedVersion: row.version
  });
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
};

const transferStatusType = (status: CenterTransfer['status']) => (status === 'committed' ? 'success' : status === 'blocked' ? 'danger' : 'warning');
const pendingStatusType = (status: string) => (status === 'committed' ? 'success' : status === 'invalid' ? 'danger' : 'info');
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
      <div class="stat"><span>迁移记录</span><b>{{ counts.transfers }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b><el-switch v-model="offline" active-text="模拟离线" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option v-for="s in SITES" :key="s" :label="s" :value="s" /></el-select></el-form-item>
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
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="110" />
          <el-table-column prop="sequence" label="随机号" width="90" />
          <el-table-column label="治疗组" width="100"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="170"><template #default="{ row }">
            <el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button>
            <el-button size="small" type="primary" plain @click="openTransfer(row as Participant)">转中心</el-button>
          </template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column label="类型" width="90"><template #default="{ row }"><el-tag :type="row.kind === 'unblind' ? 'warning' : 'info'">{{ row.kind === 'unblind' ? '揭盲' : '入组' }}</el-tag></template></el-table-column>
          <el-table-column prop="site" label="受理中心" width="100" />
          <el-table-column label="状态" min-width="200"><template #default="{ row }">
            <el-tag :type="pendingStatusType(row.status)">{{ row.status === 'committed' ? '已入库' : row.status === 'invalid' ? '已失效' : '待提交' }}</el-tag>
            <div v-if="row.invalidReason" style="color:#c45656;font-size:12px;margin-top:4px">{{ row.invalidReason }}</div>
          </template></el-table-column>
          <el-table-column label="操作" width="110"><template #default="{ row }">
            <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="trial.commitPending(row.id, actorName)">确认入库</el-button>
            <el-button v-else-if="row.status === 'invalid'" size="small" type="warning" @click="trial.reconfirmPending(row.id, actorName)">重新确认</el-button>
          </template></el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>迁移记录</b><el-tag type="success" style="float:right">保留原记录 · 审计不改</el-tag></template>
        <el-empty v-if="transfers.length === 0" description="暂无迁移记录" />
        <el-table v-else :data="transfers">
          <el-table-column prop="id" label="迁移编号" min-width="150" />
          <el-table-column prop="participantNo" label="受试者" width="100" />
          <el-table-column label="方向" min-width="150"><template #default="{ row }">{{ row.fromSite }} → {{ row.toSite }}</template></el-table-column>
          <el-table-column prop="effectiveDate" label="生效日" width="110" />
          <el-table-column label="状态" min-width="220"><template #default="{ row }">
            <el-tag :type="transferStatusType(row.status)">{{ row.status === 'committed' ? '已生效' : row.status === 'blocked' ? '已阻塞' : '写入失败' }}</el-tag>
            <div v-if="row.blockReason" style="color:#c45656;font-size:12px;margin-top:4px">阻塞原因：{{ row.blockReason }}</div>
          </template></el-table-column>
          <el-table-column label="操作" width="120"><template #default="{ row }">
            <el-button v-if="row.status === 'failed'" size="small" type="warning" @click="retryTransfer(row as CenterTransfer)">按编号重试</el-button>
            <span v-else style="color:#909399;font-size:12px">尝试 {{ row.attempts }} 次</span>
          </template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <el-card shadow="never" style="margin-top:20px">
      <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加 · 迁移不改写</el-tag></template>
      <el-timeline>
        <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="entry.action === 'unblinded' || entry.action === 'transfer-failed' ? 'danger' : entry.action === 'duplicate-blocked' || entry.action === 'transfer-blocked' ? 'warning' : 'primary'">
          <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
        </el-timeline-item>
      </el-timeline>
    </el-card>

    <el-dialog v-model="dialogVisible" title="转中心（继续用药）" width="520px">
      <el-form label-position="top">
        <el-form-item label="受试者"><el-input :model-value="transferTarget?.participantNo" disabled /></el-form-item>
        <el-form-item label="当前中心 / 分层"><el-input :model-value="`${transferTarget?.site} · ${transferTarget?.ageBand}`" disabled /></el-form-item>
        <el-form-item label="目标中心">
          <el-select v-model="transferForm.toSite" style="width:100%"><el-option v-for="s in SITES" :key="s" :label="s" :value="s" :disabled="s === transferTarget?.site" /></el-select>
        </el-form-item>
        <el-form-item label="生效日"><el-date-picker v-model="transferForm.effectiveDate" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
        <el-form-item label="目标分层名额">
          <el-tag :type="targetOccupancy.occupied >= targetOccupancy.quota ? 'danger' : 'success'">{{ transferForm.toSite }} {{ transferTarget?.ageBand }}：已占 {{ targetOccupancy.occupied }} / 名额 {{ targetOccupancy.quota }}</el-tag>
        </el-form-item>
        <el-form-item label="模拟写入失败（用于按迁移编号重试演示）"><el-switch v-model="transferForm.simulateFailure" /></el-form-item>
      </el-form>
      <div v-if="transferResult.r1" style="margin-bottom:12px">
        <el-alert :title="`提交A：${transferResult.r1.message}`" :type="transferResult.r1.ok ? 'success' : 'error'" :closable="false" style="margin-bottom:6px" />
        <el-alert v-if="transferResult.r2" :title="`提交B：${transferResult.r2.message}`" :type="transferResult.r2.ok ? 'success' : 'error'" :closable="false" />
      </div>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitTransfer">提交迁移</el-button>
        <el-button type="warning" @click="submitConcurrent">模拟双方同时提交</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: repeat(2, 1fr) !important; } }
</style>
