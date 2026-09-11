<script lang="ts">
/* global File */
// 分批纯函数随 SFC 具名导出（独立 script 块），供组件与单测共用。

/** 分批参数（T11 评审遗留跟进项）：后端 multer 内存存储，最坏 50×1GB 驻留内存，
 * 前端必须压小单请求体量——每批 ≤5 个文件且单批总大小 ≤200MB（先到为准）。 */
export const ASSET_BATCH_MAX_COUNT = 5;
export const ASSET_BATCH_MAX_BYTES = 200 * 1024 * 1024;

export interface AssetUploadBatch {
  files: File[];
  totalBytes: number;
}

/** 将待传文件切分为串行批次：每批 ≤maxCount 个且总大小 ≤maxBytes（两个条件先到为准）。
 * 单个超大文件（>maxBytes）独占一批，不因切分卡死。 */
export function chunkAssetFiles(
  files: File[],
  maxCount: number = ASSET_BATCH_MAX_COUNT,
  maxBytes: number = ASSET_BATCH_MAX_BYTES,
): AssetUploadBatch[] {
  const batches: AssetUploadBatch[] = [];
  let current: File[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length > 0) {
      batches.push({ files: current, totalBytes: currentBytes });
      current = [];
      currentBytes = 0;
    }
  };
  for (const file of files) {
    // 装入前判断：当前批非空且（数量已满 或 装入后超字节上限）→ 先切批
    if (current.length > 0 && (current.length >= maxCount || currentBytes + file.size > maxBytes)) {
      flush();
    }
    current.push(file);
    currentBytes += file.size;
  }
  flush();
  return batches;
}
</script>

<script setup lang="ts">
/* global document */
// 素材批量上传对话框（v1.5 T11/T14，M06）：多选文件 → 分批串行 POST /assets/batch。
// kind 必选；元数据不在批量通道逐文件携带（后端 title 一律取原文件名去扩展名）。
// 分批口径见 chunkAssetFiles（≤5 个且 ≤200MB/批，先到为准），批间 await 串行，
// 进度以「第 X/Y 批」文本汇报——把后端内存放大风险压到 200MB/请求级（T11 评审跟进项）。
// 入口按钮由父页按 m06:edit ∪ m06:approve 控制，后端仍同点位校验（前端门禁仅为体验）。
import { ElMessage } from 'element-plus';
import { computed, ref, watch } from 'vue';

import { ASSET_KIND_LABEL, assetApi, type AssetKind, type BatchUploadReport } from '../api/asset';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  uploaded: [];
}>();

const kindOptions = Object.entries(ASSET_KIND_LABEL).map(([value, label]) => ({ value, label }));

// 默认完工案例（2026-08-25 老板口径：门店上传主力是完工案例照，报价图入库走种子脚本）
const kind = ref<AssetKind>('finished');
/** 本批共用车型（2026-08-28，可选）：填了就应用到本批全部文件——网页批量上传也能按车型分组；
 * 不填则不分组（也可改用收件箱子文件夹导入：文件夹名=车型） */
const carModel = ref('');
const chosenFiles = ref<File[]>([]);
const uploading = ref(false);
const progressText = ref('');
const report = ref<BatchUploadReport | null>(null);

// 每次打开重置（成功路径不自动关闭——报告留在对话框内供核对，重开时兜底清空）
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      kind.value = 'finished';
      carModel.value = '';
      chosenFiles.value = [];
      progressText.value = '';
      report.value = null;
    }
  },
);

const totalBytesText = computed(() => {
  const bytes = chosenFiles.value.reduce((sum, f) => sum + f.size, 0);
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
});

/** 多选文件（沿单文件版动态 input 先例；accept 对齐批量通道 MIME 白名单） */
function chooseFiles(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime';
  input.onchange = () => {
    chosenFiles.value = Array.from(input.files ?? []);
  };
  input.click();
}

/** 汇总多批报告为单份（created/skippedDuplicate/failed 三段拼接） */
function mergeReports(reports: BatchUploadReport[]): BatchUploadReport {
  return reports.reduce<BatchUploadReport>(
    (acc, r) => ({
      created: [...acc.created, ...r.created],
      skippedDuplicate: [...acc.skippedDuplicate, ...r.skippedDuplicate],
      failed: [...acc.failed, ...r.failed],
    }),
    { created: [], skippedDuplicate: [], failed: [] },
  );
}

async function submitUpload(): Promise<void> {
  if (chosenFiles.value.length === 0) {
    ElMessage.warning('请先选择素材文件');
    return;
  }
  if (chosenFiles.value.length > 50) {
    // 后端单次上限 50；超过直接拒收，避免无效分批
    ElMessage.warning('单次最多选择 50 个文件');
    return;
  }
  const batches = chunkAssetFiles(chosenFiles.value);
  const model = carModel.value.trim() || undefined;
  uploading.value = true;
  report.value = null;
  const reports: BatchUploadReport[] = [];
  try {
    // 批间串行：await 上一批完成再发下一批（内存放大风险压到单批 200MB 级）
    for (let i = 0; i < batches.length; i += 1) {
      progressText.value = `第 ${i + 1}/${batches.length} 批上传中…`;
      reports.push(await assetApi.uploadBatch(batches[i].files, kind.value, model));
    }
    report.value = mergeReports(reports);
    const { created, skippedDuplicate, failed } = report.value;
    progressText.value = `完成：新增 ${created.length}、跳过重复 ${skippedDuplicate.length}、失败 ${failed.length}`;
    if (failed.length === 0 && skippedDuplicate.length === 0) {
      ElMessage.success(`素材已上传（新增 ${created.length} 个）`);
    } else if (created.length > 0) {
      ElMessage.warning(progressText.value);
    } else {
      ElMessage.error('本批未新增素材（全部跳过或失败），详见报告');
    }
    emit('uploaded');
  } catch {
    // http 拦截器已 toast（400 空批/403 越权/413 超限）；已完成批次不回滚，重开可续传
    progressText.value = '';
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="上传素材"
    width="560px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form :model="{ kind }" label-width="80px">
      <el-form-item label="类型" required>
        <el-select v-model="kind" style="width: 100%">
          <el-option v-for="o in kindOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="车型">
        <el-input
          v-model="carModel"
          placeholder="选填，本批共用（如：问界M9），用于素材库按车型分组"
          maxlength="100"
          data-testid="batch-car-model"
        />
      </el-form-item>
      <el-form-item label="文件" required>
        <el-button @click="chooseFiles">{{
          chosenFiles.length ? '重新选择' : '选择文件'
        }}</el-button>
        <span v-if="chosenFiles.length" class="upload-hint">
          已选 {{ chosenFiles.length }} 个（{{ totalBytesText }}）
        </span>
        <span v-else class="upload-hint">jpg/png/webp/mp4/mov，可多选；≤50 个</span>
      </el-form-item>
      <el-form-item v-if="chosenFiles.length" label="清单">
        <div class="upload-list">
          <div v-for="f in chosenFiles" :key="f.name" class="upload-list__item">
            {{ f.name }}
          </div>
        </div>
      </el-form-item>
      <el-form-item v-if="progressText" label="进度">
        <span class="upload-hint upload-hint--progress" data-testid="batch-progress">{{
          progressText
        }}</span>
      </el-form-item>
      <el-form-item v-if="report" label="结果报告">
        <div class="upload-report" data-testid="batch-report">
          <div v-if="report.created.length" class="upload-report__ok">
            新增 {{ report.created.length }}：{{ report.created.map((c) => c.title).join('、') }}
          </div>
          <div v-if="report.skippedDuplicate.length" class="upload-report__skip">
            跳过重复 {{ report.skippedDuplicate.length }}：{{ report.skippedDuplicate.join('、') }}
          </div>
          <div v-if="report.failed.length" class="upload-report__fail">
            失败 {{ report.failed.length }}：{{
              report.failed.map((f) => `${f.name}（${f.reason}）`).join('、')
            }}
          </div>
        </div>
      </el-form-item>
      <div class="upload-hint upload-hint--batch">
        每批最多 5 个文件且不超过 200MB，超出自动分批串行提交。
      </div>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{
        report ? '关闭' : '取消'
      }}</el-button>
      <el-button v-if="!report" type="primary" :loading="uploading" @click="submitUpload">
        上传
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.upload-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.upload-hint--batch {
  margin: 0 0 0 80px;
}
.upload-hint--progress {
  color: var(--el-color-primary);
}
.upload-list {
  max-height: 120px;
  overflow-y: auto;
  width: 100%;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.upload-report {
  font-size: 12px;
  line-height: 1.8;
}
.upload-report__ok {
  color: var(--el-color-success);
}
.upload-report__skip {
  color: var(--el-color-warning);
}
.upload-report__fail {
  color: var(--el-color-danger);
}
</style>
