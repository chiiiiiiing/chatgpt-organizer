import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('release', { recursive: true });
const output = `chatgpt-organizer-${version}.zip`;
await rm(`release/${output}`, { force: true });
execFileSync('/usr/bin/zip', ['-qr', `../release/${output}`, '.'], { cwd: 'dist' });
const readme = await readFile('README.md', 'utf8');
const installation = readme.match(/^## 安装\n[\s\S]*?(?=^## 使用\n)/m)?.[0]
  .replace('(PRIVACY.md)', '(https://github.com/chiiiiiiing/chatgpt-organizer/blob/main/PRIVACY.md)')
  .replace('(docs/edge-publishing.md)', '(https://github.com/chiiiiiiing/chatgpt-organizer/blob/main/docs/edge-publishing.md)');
if (!installation) throw new Error('README 缺少完整的安装章节');
await writeFile('release/安装说明.md', `# ChatGPT 整理空间 ${version}\n\n${installation}\n## 使用边界\n\n- 本版本没有收藏功能。问答正文不保存、不上传。\n- 标题索引逐步收录；正文搜索只覆盖当前读取到的问答。\n- 浏览器账号同步在 Chrome / Edge 各自的账号体系内进行，跨浏览器使用 JSON 备份迁移。\n- 真实 ChatGPT 登录态页面和双设备账号同步尚未实测；完整源码与验证记录见源项目 README。\n- 卸载或清理插件数据前，请先导出 JSON 备份。\n`);
console.log(`release/${output}`);
