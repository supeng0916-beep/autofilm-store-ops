<script setup lang="ts">
/* global Blob, URL, document */
// 客资导入（P3-01）：三 Tab——CSV/Excel 文件导入（预览→确认）、总部派发文本、金山反馈表。
// 上传走 el-upload :auto-upload=false 手动 on-change；模板/错误行导出走带 token 的 blob 下载
// （裸 <a href> 不带 Authorization 会被后端 401——鉴权文件服务口径，2026-08-21 门店实测修复）。
// 错误提示由 http 响应拦截器统一 toApiMessage 弹出（与审批中心/AI 通道管理同模式，避免重复弹窗）。
import { ref } from 'vue';
import { ElMessage, type UploadFile } from 'element-plus';
import { leadsApi, type ImportPreview, type ImportResult } from '../api/leads';

const tab = ref('file');
const preview = ref<ImportPreview | null>(null);
const uploading = ref(false);
const result = ref<ImportResult | null>(null);
const dispatchText = ref('');
const dispatchWarnings = ref<string[]>([]);

/** blob 存为文件（objectURL + 隐形 <a download>） */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function onDownloadTemplate(): Promise<void> {
  try {
    saveBlob(await leadsApi.downloadTemplate(), 'AutoFilm Demo客资导入模板.xlsx');
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}

async function onExportErrors(): Promise<void> {
  if (!preview.value) return;
  try {
    saveBlob(
      await leadsApi.downloadErrorExport(preview.value.previewToken),
      `导入错误行-${new Date().toISOString().slice(0, 10)}.xlsx`,
    );
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}

async function onFileSelected(file: UploadFile) {
  if (!file.raw) return;
  uploading.value = true;
  result.value = null;
  try {
    preview.value = await leadsApi.previewImport(file.raw);
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  } finally {
    uploading.value = false;
  }
}
async function confirmFile() {
  if (!preview.value) return;
  try {
    result.value = await leadsApi.confirmImport(preview.value.previewToken);
    preview.value = null;
    ElMessage.success(`导入成功 ${result.value.created} 条`);
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}
async function submitDispatch() {
  const texts = dispatchText.value
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!texts.length) {
    ElMessage.warning('请先粘贴派发文本（多条以空行分隔）');
    return;
  }
  try {
    result.value = await leadsApi.importDispatch(texts);
    dispatchWarnings.value = result.value.warnings;
    ElMessage.success(`派发入库 ${result.value.created} 条`);
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}

async function onKingsoftFile(file: UploadFile) {
  if (!file.raw) return;
  try {
    result.value = await leadsApi.importKingsoft(file.raw);
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}
</script>

<template>
  <div class="lead-import">
    <el-tabs v-model="tab">
      <el-tab-pane label="CSV/Excel 导入" name="file">
        <p>
          <a data-test="download-template" @click="onDownloadTemplate">下载导入模板</a>
          （字段口径见客资表字段字典；电话与微信至少填一项）
        </p>
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          accept=".csv,.xlsx"
          :on-change="onFileSelected"
        >
          <el-button type="primary" :loading="uploading">选择文件并预览</el-button>
        </el-upload>
        <div v-if="preview">
          <p>
            可导入 {{ preview.rowCount }} 条，错误
            {{ preview.errorRows.length }} 行（修正错误行后可重新上传，已导入的不受影响）
          </p>
          <el-table v-if="preview.errorRows.length" :data="preview.errorRows" max-height="240">
            <el-table-column prop="row" label="行号" width="80" />
            <el-table-column prop="message" label="错误原因" />
          </el-table>
          <el-button type="success" @click="confirmFile">确认导入</el-button>
          <a data-test="export-errors" @click="onExportErrors">导出错误行</a>
        </div>
      </el-tab-pane>
      <el-tab-pane label="总部派发文本" name="dispatch">
        <el-input
          v-model="dispatchText"
          type="textarea"
          :rows="10"
          placeholder="粘贴机器人派发文本，多条以空行分隔"
        />
        <el-button type="primary" @click="submitDispatch">解析并入库</el-button>
        <el-alert
          v-for="(w, i) in dispatchWarnings"
          :key="i"
          :title="w"
          type="warning"
          :closable="false"
        />
      </el-tab-pane>
      <el-tab-pane label="金山反馈表" name="kingsoft">
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          accept=".xlsx"
          :on-change="onKingsoftFile"
        >
          <el-button type="primary">上传金山反馈表</el-button>
        </el-upload>
      </el-tab-pane>
    </el-tabs>
    <el-alert
      v-if="result"
      :title="`批次 ${result.batchId}：入库 ${result.created} 条，重复 ${result.dupCount} 条`"
      type="success"
      :closable="false"
    />
  </div>
</template>
