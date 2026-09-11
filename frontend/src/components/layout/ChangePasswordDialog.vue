<script setup lang="ts">
// 自行改密对话框（任务书 #11）：顶栏齿轮入口唤起，原密码/新密码/确认新密码三项。
// 前端校验：必填 + 新密 6~64 位 + 确认与新密一致（不一致不发请求）。
// 错误提示：常驻 el-alert（与登录页同模式）；http 拦截器的全局 toast 仍会弹一次，内容以本框更精确。
import { ElMessage } from 'element-plus';
import { ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';

import { changePassword } from '../../api/auth';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const formRef = ref<FormInstance>();
const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const loading = ref(false);
/** 常驻错误提示（比 toast 更持久）：旧密错误/服务端校验失败 */
const errorMsg = ref('');

const rules: FormRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, max: 64, message: '新密码长度需 6~64 位', trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        if (value !== newPassword.value) callback(new Error('两次输入的新密码不一致'));
        else callback();
      },
      trigger: 'blur',
    },
  ],
};

/** 每次打开重置（不含旧错误与旧输入） */
watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    oldPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    errorMsg.value = '';
    formRef.value?.clearValidate();
  },
);

/** 错误码 → 本框精确文案（改密语境下 AUTH_INVALID_CREDENTIALS=原密码错，与登录文案区分） */
function toErrorMsg(err: unknown): string {
  const body = (err as { response?: { data?: { code?: string } } }).response?.data;
  if (body?.code === 'AUTH_INVALID_CREDENTIALS') return '原密码错误，请重试';
  if (body?.code === 'VALIDATION_FAILED') return '新密码长度需 6~64 位';
  return '修改失败，请稍后重试';
}

async function onSubmit(): Promise<void> {
  if (loading.value) return;
  const valid = await formRef.value?.validate().then(
    () => true,
    () => false,
  );
  if (!valid) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    await changePassword(oldPassword.value, newPassword.value);
    emit('update:visible', false);
    ElMessage.success('密码修改成功');
  } catch (err) {
    errorMsg.value = toErrorMsg(err);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="修改密码"
    width="420px"
    destroy-on-close
    append-to-body
    @update:model-value="emit('update:visible', $event)"
  >
    <el-alert
      v-if="errorMsg"
      :title="errorMsg"
      type="error"
      show-icon
      :closable="false"
      class="change-password__alert"
    />
    <el-form
      ref="formRef"
      :model="{ oldPassword, newPassword, confirmPassword }"
      :rules="rules"
      label-width="auto"
    >
      <el-form-item label="原密码" prop="oldPassword">
        <el-input
          v-model="oldPassword"
          type="password"
          show-password
          autocomplete="current-password"
        />
      </el-form-item>
      <el-form-item label="新密码" prop="newPassword">
        <el-input
          v-model="newPassword"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="6~64 位"
        />
      </el-form-item>
      <el-form-item label="确认新密码" prop="confirmPassword">
        <el-input
          v-model="confirmPassword"
          type="password"
          show-password
          autocomplete="new-password"
          @keyup.enter="onSubmit"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="loading" @click="onSubmit">确认修改</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.change-password__alert {
  margin-bottom: 12px;
}
/* 标签单行不折行（2026-08-24 修复「确认新密码」折行/错位），各行输入框统一左对齐 */
:deep(.el-form-item__label) {
  white-space: nowrap;
  padding-right: 14px;
}
</style>
