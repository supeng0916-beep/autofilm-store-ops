<script setup lang="ts">
/* global setTimeout, clearTimeout */
// 手工登记客资对话框（2026-08-25 老板需求）：字段=客资字段字典 17 列导入子集。
// 口径（老板确认）：负责人可选指定、默认分派池自动路由；电话/微信失焦实时查重，
// 命中提示主客资概要，由人确认是否仍登记（重复不阻断，落库后自动挂链——与导入同款）。
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, reactive, ref, watch } from 'vue';

import { leadsApi, type AssignableUser, type DupCheckResult, type Lead } from '../../api/leads';
import { useAuthStore } from '../../stores/auth';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  created: [lead: Lead];
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

// —— 表单（默认值对齐字典必填项的最小可用集） ——
const form = reactive({
  sourceCategory: 'online' as 'online' | 'offline',
  sourcePlatform: '',
  operatorEntity: '',
  acquisitionMethod: '',
  upstreamDispatchNo: '',
  adPlanText: '',
  contentId: '',
  chatLink: '',
  customerName: '',
  phone: '',
  wechat: '',
  wechatType: 'real' as 'real' | 'virtual_ewm' | 'unknown',
  businessType: 'auto_film' as 'auto_film' | 'home_film',
  target: '',
  productNeed: '',
  rawNeed: '',
  remark: '',
  ownerUserId: '', // 空=自动分派（老板口径：可选指定、默认自动）
});

/** 当前登录人 id（容错：无 pinia 的测试环境返回空 → 负责人回落自动分派） */
function currentUserId(): string {
  try {
    return useAuthStore().user?.id ?? '';
  } catch {
    return '';
  }
}

const formRef = ref();
const submitting = ref(false);

const WECHAT_TYPE_LABEL: Record<'real' | 'virtual_ewm' | 'unknown', string> = {
  real: '真实微信号',
  virtual_ewm: '虚拟二维码微信号',
  unknown: '未知',
};
const OPERATOR_ENTITY_OPTIONS = ['品牌总部代运营', '门店自营', '第三方代运营', '线下关系渠道'];

/** 线下来源必须记录脱敏介绍人（字段字典 G 列条件必填口径） */
const rules = computed(() => ({
  sourcePlatform: [{ required: true, message: '来源平台必填', trigger: 'blur' }],
  upstreamDispatchNo:
    form.sourceCategory === 'offline'
      ? [{ required: true, message: '线下来源须填写介绍人/机构（脱敏）', trigger: 'blur' }]
      : [],
  productNeed: [{ required: true, message: '需求产品必填', trigger: 'blur' }],
  rawNeed: [{ required: true, message: '客户原始需求必填（保留原话或忠实摘要）', trigger: 'blur' }],
}));

// —— 实时查重（电话/微信输入 500ms 防抖；命中展示主客资概要，不阻断提交） ——
const dupWarning = ref<DupCheckResult | null>(null);
let dupTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => [form.phone, form.wechat],
  () => {
    if (dupTimer) clearTimeout(dupTimer);
    dupTimer = setTimeout(async () => {
      const phone = form.phone.trim();
      const wechat = form.wechat.trim();
      if (!phone && !wechat) {
        dupWarning.value = null;
        return;
      }
      try {
        dupWarning.value = await leadsApi.dupCheck({
          ...(phone ? { phone } : {}),
          ...(wechat ? { wechat } : {}),
        });
      } catch {
        dupWarning.value = null; // 查重失败不阻断登记（http 拦截器已 toast）
      }
    }, 500);
  },
);

// —— 负责人（打开时拉取在职可跟单人；空值=自动；immediate 兜底「挂载即打开」场景） ——
const ownerOptions = ref<AssignableUser[]>([]);
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    resetForm();
    if (ownerOptions.value.length === 0) {
      try {
        ownerOptions.value = await leadsApi.assignableUsers();
      } catch {
        // 拉取失败不阻断：下拉空时仍可默认自动分派
      }
    }
  },
  { immediate: true },
);

function resetForm(): void {
  Object.assign(form, {
    sourceCategory: 'online',
    sourcePlatform: '',
    operatorEntity: '',
    acquisitionMethod: '',
    upstreamDispatchNo: '',
    adPlanText: '',
    contentId: '',
    chatLink: '',
    customerName: '',
    phone: '',
    wechat: '',
    wechatType: 'real',
    businessType: 'auto_film',
    target: '',
    productNeed: '',
    rawNeed: '',
    remark: '',
    // 2026-08-27 全流程测试 #5：默认负责人=当前登录人（谁登记谁跟进）；清空则自动分派
    ownerUserId: currentUserId(),
  });
  dupWarning.value = null;
  formRef.value?.clearValidate?.();
}

const dupSummary = computed(() => {
  if (!dupWarning.value?.duplicate || !dupWarning.value.lead) return '';
  const l = dupWarning.value.lead;
  const when = new Date(l.receivedAt).toLocaleDateString('zh-CN');
  return `${l.leadNo}${l.customerName ? ` · ${l.customerName}` : ''} · ${when}`;
});

async function submit(): Promise<void> {
  if (submitting.value) return; // 防双击/超时重发（2026-08-27 #1）
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!form.phone.trim() && !form.wechat.trim()) {
    ElMessage.warning('电话与微信至少填一项');
    return;
  }
  if (dupWarning.value?.duplicate) {
    try {
      await ElMessageBox.confirm(
        `该联系方式疑似已有客资（${dupSummary.value}），仍要登记吗？重复客资会自动挂链到主客资。`,
        '疑似重复',
        { type: 'warning', confirmButtonText: '仍要登记', cancelButtonText: '返回检查' },
      );
    } catch {
      return; // 返回检查
    }
  }
  submitting.value = true;
  try {
    const created = await leadsApi.register({
      sourceCategory: form.sourceCategory,
      sourcePlatform: form.sourcePlatform.trim(),
      ...(form.operatorEntity.trim() ? { operatorEntity: form.operatorEntity.trim() } : {}),
      ...(form.acquisitionMethod.trim()
        ? { acquisitionMethod: form.acquisitionMethod.trim() }
        : {}),
      ...(form.upstreamDispatchNo.trim()
        ? { upstreamDispatchNo: form.upstreamDispatchNo.trim() }
        : {}),
      ...(form.adPlanText.trim() ? { adPlanText: form.adPlanText.trim() } : {}),
      ...(form.contentId.trim() ? { contentId: form.contentId.trim() } : {}),
      ...(form.chatLink.trim() ? { chatLink: form.chatLink.trim() } : {}),
      ...(form.customerName.trim() ? { customerName: form.customerName.trim() } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      ...(form.wechat.trim() ? { wechat: form.wechat.trim() } : {}),
      wechatType: form.wechatType,
      businessType: form.businessType,
      ...(form.target.trim() ? { target: form.target.trim() } : {}),
      productNeed: form.productNeed.trim(),
      rawNeed: form.rawNeed.trim(),
      ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
      ...(form.ownerUserId ? { ownerUserId: form.ownerUserId } : {}),
    });
    ElMessage.success(`已登记 ${created.leadNo}`);
    emit('created', created);
    visible.value = false;
  } catch {
    // http 拦截器已 toast；保留表单供修正重交
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="手工登记客资" width="720px" data-testid="manual-lead-dialog">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
      <div class="manual-lead__section">来源</div>
      <div class="manual-lead__row">
        <el-form-item label="来源大类" prop="sourceCategory">
          <el-radio-group v-model="form.sourceCategory" data-testid="source-category">
            <el-radio-button value="online">线上</el-radio-button>
            <el-radio-button value="offline">线下</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="来源平台" prop="sourcePlatform">
          <el-input
            v-model="form.sourcePlatform"
            placeholder="如：抖音 / 小红书 / 4S店 / 老客户转介绍 / 门店上门"
            data-testid="source-platform"
          />
        </el-form-item>
        <el-form-item label="运营主体">
          <el-select v-model="form.operatorEntity" clearable placeholder="可选">
            <el-option v-for="o in OPERATOR_ENTITY_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
      </div>
      <div class="manual-lead__row">
        <el-form-item label="获客方式">
          <el-input v-model="form.acquisitionMethod" placeholder="如：广告私信 / 直播 / 4S店介绍" />
        </el-form-item>
        <el-form-item label="介绍人/派发NO" prop="upstreamDispatchNo">
          <el-input
            v-model="form.upstreamDispatchNo"
            :placeholder="
              form.sourceCategory === 'offline' ? '线下来源必填（脱敏）' : '总部线索填派发NO'
            "
          />
        </el-form-item>
        <el-form-item label="广告计划">
          <el-input v-model="form.adPlanText" placeholder="有则填，保留原文" />
        </el-form-item>
      </div>

      <div class="manual-lead__section">客户与联系方式</div>
      <div class="manual-lead__row">
        <el-form-item label="客户称呼">
          <el-input v-model="form.customerName" placeholder="未确认身份可不填" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="form.phone" placeholder="与微信至少填一项" data-testid="phone-input" />
        </el-form-item>
        <el-form-item label="微信号">
          <el-input
            v-model="form.wechat"
            placeholder="与电话至少填一项"
            data-testid="wechat-input"
          />
        </el-form-item>
      </div>
      <div class="manual-lead__row">
        <el-form-item label="微信号类型">
          <el-select v-model="form.wechatType">
            <el-option
              v-for="(label, value) in WECHAT_TYPE_LABEL"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="form.wechatType === 'virtual_ewm'"
          class="manual-lead__hint"
          type="warning"
          :closable="false"
          show-icon
          title="虚拟二维码微信号不能当作真实客户微信号：需扫码添加后再继续沟通"
        />
      </div>
      <el-alert
        v-if="dupWarning?.duplicate"
        class="manual-lead__dup"
        type="warning"
        :closable="false"
        show-icon
        :data-testid="'dup-warning'"
        :title="`疑似重复客资：${dupSummary}`"
        description="同一联系方式已有在跟客资；仍要登记会自动挂链到主客资，请确认。"
      />

      <div class="manual-lead__section">需求</div>
      <div class="manual-lead__row">
        <el-form-item label="业务类型">
          <el-radio-group v-model="form.businessType">
            <el-radio-button value="auto_film">汽车膜</el-radio-button>
            <el-radio-button value="home_film">住宅与家具膜</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="form.businessType === 'auto_film' ? '车型' : '住宅对象'">
          <el-input v-model="form.target" placeholder="如 Model Y / 别墅落地玻璃" />
        </el-form-item>
        <el-form-item label="需求产品" prop="productNeed">
          <el-input v-model="form.productNeed" placeholder="客户明确询问的产品/服务" />
        </el-form-item>
      </div>
      <el-form-item label="原始需求" prop="rawNeed">
        <el-input
          v-model="form.rawNeed"
          type="textarea"
          :rows="2"
          placeholder="尽量保留客户原话或忠实摘要"
        />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" placeholder="可选" />
      </el-form-item>

      <div class="manual-lead__section">负责人</div>
      <el-form-item label="跟进人">
        <el-select
          v-model="form.ownerUserId"
          clearable
          placeholder="默认本人；清空则系统自动分派"
          data-testid="owner-select"
        >
          <el-option
            v-for="u in ownerOptions"
            :key="u.id"
            :label="`${u.displayName}（${u.username}）`"
            :value="u.id"
          />
        </el-select>
        <span class="manual-lead__owner-hint"
          >不指定则沿用分派池规则（4S→店长池、线上→轮询、转介绍→原关系人）</span
        >
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" data-testid="submit-manual" @click="submit"
        >登记</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.manual-lead__section {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin: 4px 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.manual-lead__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
}
.manual-lead__row > .el-form-item {
  flex: 1 1 200px;
  min-width: 180px;
}
.manual-lead__dup {
  margin-bottom: 16px;
}
.manual-lead__hint {
  flex: 1 1 100%;
}
.manual-lead__owner-hint {
  display: block;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
  margin-top: 2px;
}
</style>
