<script setup lang="ts">
// 录入记录对话框（V2.4 Task 3 拆件）：考勤/奖励/处罚/备注四类，只增不改（后端无更新端点）。
// V1 对象限技师（subjectType 后端固定 technician；店员/Agent 名单留扩展点）。
// occurredAt el-date-picker 选 Date，提交时 toISOString()（Z 格式，后端 z.string().datetime()）。
import { ref, watch } from 'vue';

import { STAFF_RECORD_KIND_LABEL, type StaffRecordKind, type TechnicianCard } from '../api/team';

const props = defineProps<{
  visible: boolean;
  technicians: TechnicianCard[];
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  /** 提交载荷（occurredAt 已是 ISO Z 格式字符串） */
  submit: [
    payload: { subjectId: string; kind: StaffRecordKind; content: string; occurredAt: string },
  ];
}>();

const subjectId = ref('');
const kind = ref<StaffRecordKind>('attendance');
const content = ref('');
const occurredAt = ref<Date>(new Date());

/** 每次打开重置（默认发生时间=当前，补录可改） */
watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    subjectId.value = '';
    kind.value = 'attendance';
    content.value = '';
    occurredAt.value = new Date();
  },
);

const canSubmit = () => Boolean(subjectId.value && content.value.trim() && occurredAt.value);

const submit = () => {
  if (!canSubmit()) return;
  emit('submit', {
    subjectId: subjectId.value,
    kind: kind.value,
    content: content.value.trim(),
    occurredAt: occurredAt.value.toISOString(),
  });
};
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="录入记录"
    width="480px"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-form label-width="80px">
      <el-form-item label="对象" required>
        <!-- V1 对象限技师（后端 subjectType 固定 technician）；店员/Agent 名单留扩展 -->
        <el-select v-model="subjectId" placeholder="选择技师" style="width: 100%">
          <el-option v-for="t in technicians" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="类型" required>
        <el-select v-model="kind" style="width: 100%">
          <el-option
            v-for="(label, k) in STAFF_RECORD_KIND_LABEL"
            :key="k"
            :label="label"
            :value="k"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="内容" required>
        <el-input
          v-model="content"
          type="textarea"
          :rows="3"
          maxlength="1000"
          placeholder="考勤 / 奖励 / 处罚 / 备注内容（必填）"
        />
      </el-form-item>
      <el-form-item label="发生日期" required>
        <el-date-picker v-model="occurredAt" type="datetime" style="width: 100%" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit()" @click="submit">提交</el-button>
    </template>
  </el-dialog>
</template>
