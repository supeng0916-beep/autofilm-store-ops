import { http } from './http';

/** 全局搜索分区类型（V2.3a 契约；V2.3b 增补 assets 素材节，与后端 search.service 一致） */
export type SearchSectionType = 'leads' | 'knowledge' | 'workOrders' | 'appointments' | 'assets';

/** 单条命中：title 主行、sub 副行（状态/摘要），link 为前端路由（router.push 直达）；
 *  snippet=命中片段（knowledge 命中在 content 时由后端截取，前端高亮展示） */
export interface SearchItem {
  id: string;
  title: string;
  sub: string;
  link: string;
  snippet?: string | null;
}

export interface SearchSection {
  type: SearchSectionType;
  items: SearchItem[];
}

export interface SearchResponse {
  q: string;
  sections: SearchSection[];
}

export const searchApi = {
  /** 全店关键词搜索（结果按关联度排序：标题命中优先）；q 需 2-100 字符
   *  （<2 字由调用方直接不发请求，规避后端 422） */
  search(q: string) {
    return http.get<SearchResponse>('/search', { params: { q } }).then((r) => r.data);
  },
};
