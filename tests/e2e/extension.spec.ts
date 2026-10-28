import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture } from './fixture';

let context: BrowserContext, profile: string, page: Page, extensionId: string;
let pageErrors: string[];
test.beforeEach(async () => {
  pageErrors = [];
  profile = await mkdtemp(path.join(tmpdir(), 'chatgpt-organizer-e2e-'));
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.E2E_BROWSER === 'edge' ? 'msedge' : 'chromium', headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.on('page', created => created.on('pageerror', error => pageErrors.push(error.message)));
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await writeFile(test.info().outputPath('runtime.json'), JSON.stringify({
    browser: process.env.E2E_BROWSER === 'edge' ? 'Microsoft Edge' : 'Chrome for Testing',
    version: context.browser()?.version(), extensionId, fixture: true,
  }, null, 2));
  await context.route('https://chatgpt.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  page = await context.newPage(); await page.goto('https://chatgpt.com/c/alpha');
  await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toBeVisible();
  await expect(page.locator('[data-cgo-root="timeline"] .node')).toHaveCount(4);
});
test.afterEach(async () => {
  try { expect(pageErrors).toEqual([]); }
  finally { await context?.close(); if (profile) await rm(profile, { recursive: true, force: true }); }
});

async function folder(name: string) {
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByLabel('文件夹名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 文件夹操作` })).toBeVisible();
}

test('folders, classification, title search, persistence, backup and safe deletion', async () => {
  await folder('课程学习');
  await page.getByRole('button', { name: '整理当前对话', exact: true }).click();
  await page.getByLabel('目标位置').selectOption({ label: '课程学习' });
  await page.getByRole('dialog').getByRole('button', { name: '移动对话', exact: true }).click();
  await expect(page.locator('.current-conversation')).toContainText('课程学习');
  await page.getByRole('searchbox', { name: '搜索已收录的对话标题' }).fill('研究');
  await expect(page.locator('.conversation-link')).toHaveCount(1);
  await expect(page.locator('.conversation-link')).toContainText('研究方法');
  await page.getByRole('searchbox', { name: '搜索已收录的对话标题' }).fill('');
  await page.reload();
  await expect(page.locator('.current-conversation')).toContainText('课程学习');

  const second = await context.newPage(); await second.goto('https://chatgpt.com/c/alpha');
  await expect(second.getByRole('button', { name: '课程学习 文件夹操作' })).toBeVisible();
  await page.getByRole('button', { name: '课程学习 文件夹操作' }).click();
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByLabel('文件夹名称', { exact: true }).fill('学习资料');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(second.getByRole('button', { name: '学习资料 文件夹操作' })).toBeVisible();

  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: '整理空间设置与备份', exact: true }).click();
  const settings = await opened;
  await expect(settings).toHaveURL(`chrome-extension://${extensionId}/settings.html`);
  await expect(settings.locator('#folder-count')).toHaveText('1');
  await expect(settings.locator('#filed-count')).toHaveText('1');
  const downloaded = settings.waitForEvent('download'); await settings.getByRole('button', { name: '导出备份' }).click();
  const file = await downloaded; const backupPath = test.info().outputPath('backup.json'); await file.saveAs(backupPath);
  await settings.locator('#import-file').setInputFiles(backupPath);
  await expect(settings.locator('#import-preview')).toBeVisible();
  await settings.getByRole('button', { name: '确认合并' }).click();
  await expect(settings.locator('#folder-count')).toHaveText('1');
  await settings.locator('#import-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":999}') });
  await expect(settings.locator('#toast')).toBeVisible();
  await expect(settings.locator('#folder-count')).toHaveText('1');

  await page.getByRole('button', { name: '学习资料 文件夹操作' }).click();
  await page.getByRole('button', { name: '删除文件夹…', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('1 条对话会回到「未分类」');
  await page.getByRole('button', { name: '删除文件夹', exact: true }).click();
  await expect(page.getByRole('button', { name: '学习资料 文件夹操作' })).toHaveCount(0);
  await expect(page.locator('#history > a[href="/c/alpha"]')).toBeVisible();
  await expect(page.locator('.current-conversation')).toContainText('将当前对话移入');
});

test('timeline previews, answer search, jump, streaming, branch and SPA navigation', async () => {
  const nodes = page.locator('[data-cgo-root="timeline"] .node');
  await nodes.nth(2).hover();
  await expect(page.locator('.preview')).toBeVisible();
  await expect(page.locator('.preview')).toContainText('状态压缩');
  await page.getByRole('button', { name: '展开问题目录', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索当前对话内容' }).fill('依赖关系');
  await expect(page.locator('.turn-list .turn')).toHaveCount(1);
  await expect(page.locator('.answer-match')).toContainText('依赖关系');
  await page.locator('.turn-list .turn').click();
  await expect.poll(() => page.locator('main').evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await page.getByRole('searchbox', { name: '搜索当前对话内容' }).fill('');
  await page.evaluate(() => { document.querySelector('[data-message-id="a4"]')!.append(' 这是流式更新的新内容。'); });
  await page.getByRole('searchbox', { name: '搜索当前对话内容' }).fill('流式更新');
  await expect(page.locator('.turn-list .turn')).toHaveCount(1);
  await page.evaluate(() => { document.querySelector('[data-message-id="u4"]')!.textContent = '编辑后重新提问'; });
  await page.getByRole('searchbox', { name: '搜索当前对话内容' }).fill('编辑后');
  await expect(page.locator('.turn-list .turn')).toHaveCount(1);
  await page.evaluate(() => {
    history.pushState({}, '', '/c/beta'); document.title = '研究方法与论文阅读 - ChatGPT';
    document.querySelector('.thread')!.innerHTML = '<article data-turn="user"><div data-message-author-role="user" data-message-id="b1">怎样阅读一篇论文？</div></article><article data-turn="assistant"><div data-message-author-role="assistant" data-message-id="b2">先识别研究问题和实验假设。</div></article>';
  });
  await expect(nodes).toHaveCount(1);
  await expect(page.locator('.turn-list .turn')).toContainText('怎样阅读一篇论文');
  await expect(page.getByRole('searchbox', { name: '搜索当前对话内容' })).toHaveValue('');
  await expect(page.locator('[data-cgo-root="timeline"]')).toHaveCount(1);
  await page.getByRole('textbox', { name: '原生消息输入框' }).fill('输入未被插件拦截');
  await expect(page.getByRole('textbox', { name: '原生消息输入框' })).toHaveValue('输入未被插件拦截');
});

test('native chat drag, nested folders, themes, narrow layout and visual artifacts', async () => {
  await folder('课程学习');
  await folder('研究项目');
  await page.getByRole('button', { name: '课程学习 文件夹操作' }).click();
  await page.getByRole('button', { name: '新建子文件夹', exact: true }).click();
  await page.getByLabel('文件夹名称', { exact: true }).fill('算法笔记');
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click();
  const target = page.locator('.folder-row').filter({ has: page.getByRole('button', { name: '算法笔记 文件夹操作' }) });
  const native = page.locator('#history > a[href="/c/alpha"]');
  await native.dragTo(target);
  await expect(page.locator('.current-conversation')).toContainText('算法笔记');
  await page.getByRole('button', { name: '展开问题目录', exact: true }).click();
  await expect.poll(() => page.locator('main').evaluate(el => getComputedStyle(el).paddingInlineEnd)).toBe('334px');
  await expect(page.locator('[data-cgo-root="utility"] .toast')).toBeHidden({ timeout: 8000 });
  await page.screenshot({ path: test.info().outputPath('light.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(page.locator('[data-cgo-root="organizer"]')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: test.info().outputPath('dark.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(() => page.locator('main').evaluate(el => el.style.paddingInlineEnd)).toBe('');
  await expect(page.getByRole('button', { name: '打开整理面板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开整理面板', exact: true }).click();
  await expect(page.getByRole('button', { name: '研究项目 文件夹操作' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭整理面板', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '原生消息输入框' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole('button', { name: '打开整理面板', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '研究项目 文件夹操作' })).toBeVisible();
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/settings.html`);
  await expect(settings.locator('#folder-count')).toHaveText('3');
  await settings.screenshot({ path: test.info().outputPath('settings.png'), fullPage: true });
});

test('collapsed native sidebar remains clickable beside the organizer launcher and floating panel', async () => {
  await folder('侧栏回归测试');
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
    const style = document.createElement('style');
    style.textContent = `
      body { --test-rail-width: 64px; }
      #stage-sidebar-tiny { display: none; }
      body.test-collapsed > aside { display: none; }
      body.test-collapsed #stage-sidebar-tiny {
        display: block; position: fixed; inset: 0 auto 0 0;
        width: var(--test-rail-width); transition: width 300ms linear;
        background: var(--sidebar-surface-primary); border-right: 1px solid var(--border-light);
      }
      #stage-sidebar-tiny button {
        position: absolute; left: calc(50% - 20px); width: 40px; height: 40px;
        padding: 0; border: 0; border-radius: 8px; color: var(--text-primary);
        background: var(--sidebar-surface-secondary); font-size: 20px;
      }
      body.test-collapsed > header { left: var(--test-rail-width); }
      body.test-collapsed > main { margin-left: var(--test-rail-width); }
      body.test-collapsed > .composer {
        left: calc(var(--test-rail-width) + (100vw - var(--test-rail-width)) / 2);
        width: min(640px, calc(100vw - var(--test-rail-width) - 40px));
      }
    `;
    document.head.append(style);
    const rail = document.createElement('nav');
    rail.id = 'stage-sidebar-tiny';
    rail.setAttribute('aria-label', '原生收起侧栏');
    for (const [index, label] of ['原生新聊天', '原生历史记录'].entries()) {
      const button = document.createElement('button');
      button.setAttribute('aria-label', label);
      button.textContent = index ? '◷' : '＋';
      button.style.top = `${76 + index * 48}px`;
      button.dataset.clicks = '0';
      button.addEventListener('click', () => { button.dataset.clicks = String(Number(button.dataset.clicks) + 1); });
      rail.append(button);
    }
    document.body.append(rail);
    document.body.classList.add('test-collapsed');
  });

  const launcher = page.getByRole('button', { name: /^(打开|关闭)整理面板$/ });
  const panel = page.locator('[data-cgo-root="organizer"]');
  let nativeClicks = 0;
  async function checkNativeButtons() {
    nativeClicks++;
    for (const name of ['原生新聊天', '原生历史记录']) {
      const control = page.getByRole('button', { name, exact: true });
      await control.click({ timeout: 5000 });
      await expect(control).toHaveAttribute('data-clicks', String(nativeClicks));
    }
  }
  async function checkFloatingGeometry() {
    await expect(panel).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const rail = document.querySelector('#stage-sidebar-tiny')!.getBoundingClientRect();
      const launcher = document.querySelector('[data-cgo-root="utility"]')!.shadowRoot!.querySelector('button')!.getBoundingClientRect();
      const panel = document.querySelector('[data-cgo-root="organizer"]')!.getBoundingClientRect();
      const composer = document.querySelector('.composer')!.getBoundingClientRect();
      return {
        launcherOutsideRail: launcher.left >= rail.right + 6,
        panelOutsideRail: panel.left >= rail.right + 6,
        aligned: Math.abs(launcher.left - panel.left) <= 1,
        launcherInViewport: launcher.left >= 0 && launcher.right <= innerWidth && launcher.top >= 0 && launcher.bottom <= innerHeight,
        panelInViewport: panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight,
        composerClear: panel.bottom <= composer.top - 4,
        noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    })).toEqual({
      launcherOutsideRail: true, panelOutsideRail: true, aligned: true,
      launcherInViewport: true, panelInViewport: true, composerClear: true, noHorizontalOverflow: true,
    });
  }

  await expect(page.getByRole('button', { name: '打开整理面板', exact: true })).toBeVisible();
  await checkNativeButtons();
  await launcher.click();
  await expect(page.getByRole('button', { name: '关闭整理面板', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '侧栏回归测试 文件夹操作' })).toBeVisible();
  await checkFloatingGeometry();
  await checkNativeButtons();
  await page.screenshot({ path: test.info().outputPath('collapsed-sidebar.png'), fullPage: true });

  // Width changes after the initial DOM mutation must be tracked through the transition.
  await page.evaluate(() => document.body.style.setProperty('--test-rail-width', '84px'));
  await expect.poll(() => page.locator('#stage-sidebar-tiny').evaluate(el => Math.abs(el.getBoundingClientRect().width - 84) < 0.1)).toBe(true);
  await checkFloatingGeometry();
  await launcher.click();
  await expect(panel).toBeHidden();
  await checkNativeButtons();

  await page.evaluate(() => { document.body.classList.remove('test-collapsed'); });
  await expect(launcher).toBeHidden();
  await expect(page.locator('#history > [data-cgo-root="organizer"]')).toBeVisible();
  await page.evaluate(() => { document.body.classList.add('test-collapsed'); });
  await expect(page.getByRole('button', { name: '打开整理面板', exact: true })).toBeVisible();
  await expect(panel).toBeHidden();
  await launcher.click();
  await checkFloatingGeometry();

  for (const viewport of [{ width: 800, height: 900 }, { width: 390, height: 600 }, { width: 390, height: 360 }]) {
    await page.setViewportSize(viewport);
    await checkFloatingGeometry();
    await checkNativeButtons();
    const composer = page.getByRole('textbox', { name: '原生消息输入框' });
    await composer.fill(`仍可输入 ${viewport.width} × ${viewport.height}`);
    await expect(composer).toHaveValue(`仍可输入 ${viewport.width} × ${viewport.height}`);
  }
  await page.screenshot({ path: test.info().outputPath('collapsed-sidebar-short.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: '打开整理面板', exact: true })).toBeVisible();
});

test('long timeline retains scroll and hover during streaming, unloaded turns disappear', async () => {
  await page.evaluate(() => {
    document.querySelector('.thread')!.innerHTML = Array.from({ length: 100 }, (_, i) => `<article data-turn="user"><div data-message-author-role="user" data-message-id="long-u${i}">第${i + 1}轮的重复问题</div></article><article data-turn="assistant"><div data-message-author-role="assistant" data-message-id="long-a${i}">这是第${i + 1}轮的回答。</div></article>`).join('');
  });
  const nodes = page.locator('[data-cgo-root="timeline"] .node');
  await expect(nodes).toHaveCount(100);
  await page.getByRole('button', { name: '展开问题目录', exact: true }).click();
  await page.locator('.turn-list').evaluate(el => { el.scrollTop = 1600; });
  await nodes.nth(70).hover();
  const scroll = await page.locator('.rail').evaluate(el => el.scrollTop);
  const listScroll = await page.locator('.turn-list').evaluate(el => el.scrollTop);
  await page.evaluate(() => { document.querySelector('[data-message-id="long-a70"]')!.append(' 持续流式内容'); });
  await expect(page.locator('.preview')).toContainText('持续流式内容');
  await expect.poll(() => page.locator('.rail').evaluate(el => el.scrollTop)).toBe(scroll);
  await expect.poll(() => page.locator('.turn-list').evaluate(el => el.scrollTop)).toBe(listScroll);
  await page.evaluate(() => {
    const main = document.querySelector('.thread')!;
    for (let i = 0; i < 20; i++) main.firstElementChild?.remove();
  });
  await expect(nodes).toHaveCount(90);
  await page.getByRole('searchbox', { name: '搜索当前对话内容' }).fill('第1轮的重复问题');
  await expect(page.locator('.turn-list .turn')).toHaveCount(0);
});
