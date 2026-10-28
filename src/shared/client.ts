import type { Command, Reply, Request } from './types';
export const request: Request = async <T>(command: Command): Promise<T> => {
  const response: Reply<T> = await chrome.runtime.sendMessage(command);
  if (!response) throw new Error('插件后台暂时不可用，请刷新页面后重试。');
  if (!response.ok) throw new Error(response.error);
  return response.data;
};
