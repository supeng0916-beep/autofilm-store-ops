import { http } from './http';

export interface TakeoverCandidate {
  leadId: string;
  leadNo: string;
  customerName: string | null;
  sourcePlatform: string;
  stage: string;
  intentLevel: string;
  ownerName: string | null;
  lastFollowUpAt: string | null;
  reasons: string[];
  priority: number;
}

export const takeoverApi = {
  getCandidates() {
    return http.get<TakeoverCandidate[]>('/leads/takeover').then((r) => r.data);
  },
};
