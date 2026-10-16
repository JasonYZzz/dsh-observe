import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import { PREFIX } from '../types.js';
export function api(rpc: ClientConnectionRpc) {
  return async <T>(endpoint: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> => {
    const result = await rpc.call('/api', `${PREFIX}${endpoint}`, payload, signal);
    if (!result.ok) throw new Error(result.error.message);
    return result.value as T;
  };
}
export type Api = ReturnType<typeof api>;
