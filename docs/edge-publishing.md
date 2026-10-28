# 安装与发布到 Microsoft Edge 加载项商店

本文针对 **ChatGPT 整理空间 0.1.1 预发布版**，官方说明核查日期：2026-10-28。GitHub 源码发布、开发者模式安装、Edge 商店上架是三个独立步骤；推送 GitHub 不会自动上架商店。

## 先在自己的 Edge 安装

1. 从 [GitHub Releases](https://github.com/chiiiiiiing/chatgpt-organizer/releases) 下载 `chatgpt-organizer-0.1.1.zip` 并解压。选择这个构建附件，GitHub 自动生成的 `Source code.zip` 是源码，需要先构建。
2. 在 Edge 地址栏输入 `edge://extensions`，打开“开发人员模式”。
3. 点击“加载解压缩的扩展”，选择**直接包含 `manifest.json` 的文件夹**。不要选择 ZIP 文件，也不要选择外面多套的一层目录。
4. 打开或刷新 `https://chatgpt.com/`，登录自己的 ChatGPT 账号。通过左侧“整理空间”管理文件夹，通过右侧时间轴回到问答。
5. 点击浏览器工具栏中的插件图标，进入“设置与备份”。开始使用前了解同步范围；积累分类后定期导出 JSON 备份。

本地已有源码时，执行 `npm ci`、`npm run package`，得到 `dist/` 和 `release/chatgpt-organizer-0.1.1.zip`。可以直接加载 `dist/`。更新开发者版时替换原位置的构建文件，在扩展管理页点击重新加载，再刷新 ChatGPT 页面。

界面沿用 ChatGPT 的浅色、深色配色，只增加整理功能。每个浏览器配置文件默认用于一个 ChatGPT 账号。更完整的使用与备份说明见 [README](../README.md)。

## 提交前准备

当前源码有自动化验证，但真实登录态 ChatGPT 页面及 Edge 同账号双设备同步仍须实际验证，不能把测试夹具结果写成商店环境已经通过。按 [手动验证清单](manual-testing.md) 完成分类、刷新保存、长对话定位、流式回答、分支切换、深浅主题及窄窗口检查，再准备提交。

- **扩展包**：上传 `release/chatgpt-organizer-0.1.1.zip`。ZIP 根目录应直接包含 `manifest.json`、`background.js`、`content.js`、`settings.html` 等构建文件，不上传源码包、`node_modules`、个人备份或密钥文件。
- **公开隐私政策**：先确认 [PRIVACY.md](https://github.com/chiiiiiiing/chatgpt-organizer/blob/main/PRIVACY.md) 已推送且无须登录即可访问。仓库如为私有，需要把隐私政策另行放在公开网址。
- **商店图片**：可使用 [logo128.png](store-assets/logo128.png)。Logo 必填，正方形，最低 128 × 128，推荐 300 × 300；截图可选，最多 6 张，尺寸为 640 × 480 或 1280 × 800；可选推广图为 440 × 280 和 1400 × 560。不要拉伸图片。[微软图片要求](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension#step-7-enter-store-listing-details-for-each-language)
- **真实演示截图**：用自己创建的无隐私示例对话展示文件夹、时间轴、搜索和备份。`docs/screenshots/` 是测试夹具页面的截图，不能直接当成真实 ChatGPT 使用效果或实测证据。使用本项目图标，不冒充 OpenAI 官方扩展。

微软要求功能和商店描述相符、产品可供审核测试。依赖第三方登录时，需要提供测试方式；不能提供测试凭据的，应在审核备注中给出合理解释。不要把个人常用账号密码写入材料。[开发者政策](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)

## 注册开发者账号

打开 [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)，使用个人 Microsoft 账号（MSA）注册 Microsoft Edge 开发者计划，**该计划没有注册费**。仅有学校或工作账号不能直接作为这个计划的注册账号。没有出现注册表时，在 Account settings → Programs 中找到 Microsoft Edge → Get started。

个人开发一般选择 Individual，填写真实所在地区、发布者名称和联系方式，由本人阅读并接受协议，完成账号验证。地区和账号类型注册后不能更改，填写时确认准确。[微软注册说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)

## 上传和填写

在 Partner Center 的 Microsoft Edge 页面创建新扩展，上传构建 ZIP。随后依次填写 **Availability、Properties、Privacy、Store listings**，最后填写 **Notes for certification** 并提交审核。公开分发选择 Public；Hidden 用于通过直接链接分发。审核通过后才会上架，提交成功不等于已发布。[微软发布流程](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)

以下文本依据当前代码准备。提交前再次核对上传的版本；功能或数据处理变化时同步修改这些说明。

### Properties 与商店信息

| 字段 | 建议填写 |
| --- | --- |
| 扩展名称 | ChatGPT 整理空间 |
| 分类 | 选择最接近“生产力 / Productivity”的可用分类 |
| Website | `https://github.com/chiiiiiiing/chatgpt-organizer` |
| Support contact | `https://github.com/chiiiiiiing/chatgpt-organizer/issues` |
| Privacy Policy URL | `https://github.com/chiiiiiiing/chatgpt-organizer/blob/main/PRIVACY.md` |
| 主要语言 | 简体中文；检查商店预览的语言是否正确 |
| 搜索词 | ChatGPT、对话整理、文件夹、问答时间轴、对话搜索 |

短描述由上传包的 `manifest.json` 提供；当前值为：

> 用文件夹整理对话，用问答时间轴回到重点。中文、本地优先，支持分类同步与备份。

长描述可复制下文：

```text
ChatGPT 整理空间帮助你在 ChatGPT 网页整理对话并快速回到重要问答。界面使用中文，沿用网页原有配色，适合在一个浏览器配置文件中管理一个 ChatGPT 账号的对话。

你可以创建最多三级文件夹，对文件夹重命名、折叠和排序，通过拖放或“移入文件夹”整理已收录的对话。每条对话只归属一个文件夹；删除文件夹后，对话回到未分类，不会删除 ChatGPT 原始聊天。

右侧问答时间轴支持预览片段、展开目录、定位和短暂高亮。你还可以搜索已收录的对话标题，或搜索当前页面已读取的问题与回答。收录随原侧栏加载和用户打开对话逐步进行；尚未加载的历史内容需要继续滚动，插件不会自动抓取全部聊天记录。

分类信息在本机保存，分类同步默认开启，可在设置中关闭。开启时，文件夹、归类关系以及归类记录中的对话标题和地址交给浏览器原生同步服务处理。未分类标题索引留在本机，问答正文只用于当前页面的导航和搜索，不持久保存、不上传。插件没有自建服务器、广告或分析服务，并支持用户手动导出和导入 JSON 备份。

同步能否到达其他设备取决于浏览器账号及其同步设置；Edge 双设备同步尚未完成实际验收，目前不作跨设备可用性保证。插件不提供收藏、提示词库、笔记或 AI 自动分类功能。使用需要能够正常访问并登录 ChatGPT；网页结构变化可能影响适配。

这是独立开发的第三方扩展，与 OpenAI 无隶属或官方合作关系。
```

### Privacy：单一用途和权限

**Single Purpose Description：**

```text
帮助用户在 ChatGPT 网页整理和回看自己的对话：通过文件夹归类、标题搜索和当前对话的问答导航与搜索，快速找到已收录对话及已加载的问答。
```

**storage 权限理由：**

```text
用于保存用户的本机界面设置，以及在用户启用分类同步时，通过浏览器原生 storage.sync 保存和同步文件夹、归类关系、相关对话标题和地址。核心本机目录数据保存在扩展自身的 IndexedDB。问答正文不进入持久化存储或同步存储。
```

**alarms 权限理由：**

```text
用于安排分类同步失败后的重试，并在后台 Service Worker 停止后恢复处理待同步队列。任务只处理用户已有的分类元数据，不定时抓取聊天正文或浏览历史。
```

**网站访问 / content script 匹配范围理由（如表单要求）：**

```text
扩展只在 https://chatgpt.com/* 注入内容脚本，读取页面已加载的对话标题、对话链接和当前展示的问答节点，用于目录、搜索、滚动定位和界面挂载。问答文本仅在当前页面内存中处理；不访问其他网站，不读取 Cookie 或登录令牌，不调用 ChatGPT 私有接口。
```

当前 manifest 没有单独的 `host_permissions`，站点范围来自 `content_scripts.matches`。不要为了填表额外加入 `tabs`、`history` 或全站权限。

**Are you using remote code?：** 当前版本选择 **No, I am not using remote code**。执行脚本随扩展包提供，没有运行时远程代码加载。后续若修改构建或增加依赖，应重新核查。

### Privacy：数据处理披露

不要因为没有自建服务器，就勾选成“完全不读取或处理用户数据”。根据当前表单的类别定义，披露所涉及的网页内容、对话标题和地址；如存在 Website content、Web history 等类别，按其说明对应本扩展的实际处理范围。这里只涉及 ChatGPT 对话索引，不读取整个浏览器历史。遇到表单术语不一致时，以当前表单定义和实际代码为准。

| 数据 | 当前版本的处理方式 |
| --- | --- |
| 文件夹、归类关系 | 本机 IndexedDB 保存；开启同步时交给浏览器原生同步服务；包含合并用版本和删除标记 |
| 已收录的对话 ID、标题、地址、最近收录时间 | 本机保存，用于列表和标题搜索；归类记录的标题和地址随分类同步，未分类标题索引不作为独立索引上传 |
| 当前页面的问题与回答 | 页面内存中用于时间轴和内容搜索；不保存到 IndexedDB、浏览器同步或备份文件 |
| 界面设置和同步开关 | 本机保存；包含在用户手动导出的 JSON 备份中 |
| JSON 备份 | 用户主动下载到本机，主动选择文件时读取；是否分享文件由用户决定 |
| Cookie、登录令牌、账号密码 | 插件不读取、不存储 |

数据说明可填写：

```text
扩展在用户浏览 ChatGPT 时，渐进收录页面已经加载的对话标题和地址，并在本机保存目录和归类数据。当前页面的问答文本仅在页面内存中用于导航和搜索，不持久保存或上传。

分类同步默认开启，用户可以在设置中关闭。开启时，文件夹和归类记录（含相关对话标题、地址、版本与删除标记）通过浏览器自身的同步服务处理。本扩展没有自建服务器，不向开发者传送聊天或目录数据，不用于广告、分析或出售数据。未分类标题索引和界面偏好留在本机。

用户可以主动导出 JSON 文件进行备份或迁移。备份包含目录、归类、已收录标题地址及设置，不含聊天正文、Cookie 或登录令牌。详细数据范围、同步边界及数据删除说明见隐私政策。
```

### Notes for certification

可复制下面的测试说明；将你实测后的差异、已知限制补充进去。若审核要求测试账号，应使用专用测试账号或向审核方解释第三方登录限制，不能提供个人常用账号凭据。

```text
This is an independent third-party extension for organizing conversations on https://chatgpt.com/. It is not affiliated with OpenAI. The extension has no separate account system, server, subscription, or paid feature. It operates on the ChatGPT page that the tester can normally access. ChatGPT authentication is managed by the third-party service, not this extension; no developer-owned ChatGPT account credentials are included.

Suggested test steps:
1. Sign in to ChatGPT using an authorized test account and create a few non-sensitive sample conversations.
2. Refresh the ChatGPT page. In the organizer above the original chat list, create folders and a child folder, move a conversation into a folder, rename a folder, and reload the page.
3. Delete a folder after reviewing the impact count. Its conversations should return to the unclassified list; the original ChatGPT chats should remain intact.
4. Open a conversation with multiple question/answer turns. Use the right-side timeline to preview and jump to a turn, then search the loaded conversation text. Scroll to load more content when needed.
5. Search the collected conversation titles. Collection is progressive and only covers sidebar entries already loaded and conversations opened by the user.
6. Click the extension toolbar icon to open settings. Export a JSON backup, preview and import it, and check the synchronization status. Synchronization can be disabled here.

Conversation bodies are used only in page memory and are not persisted or uploaded. Folder metadata and classified conversation titles/URLs use the browser's native synchronization service when enabled. Real two-device Edge synchronization has not yet been validated and is not advertised as verified. The interface is in Simplified Chinese and follows the website's light/dark appearance.
```

## 开发者版迁移、商店更新

项目中的固定 `manifest.key` 用于保持开发者模式安装的扩展 ID。微软的 [manifest 格式说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/manifest-format) 将 `key` 列为支持的可选字段；本次核查未发现发布指南要求统一删除它，因此无需仅凭猜测修改源文件。若 Partner Center 实际校验报错，再按具体错误处理单独的商店构建。

不要把开发者版固定 ID 视为商店版 ID 的保证。商店安装后在 `edge://extensions` 核对身份和数据。**安装商店版或卸载开发者版之前，先导出 JSON 备份**；用商店版导入、检查目录和归类后再清理旧版。开发者版与商店版若具有不同 ID，其本机存储和同步空间不能假定自动继承。迁移时暂时只启用一个版本，避免同一页面出现两套面板。

后续更新应递增 `manifest.json` 与 `package.json` 的版本，重新构建、验证、打包，在 Partner Center 原扩展条目中上传更新。商店版本通过商店更新流程分发。保持隐私政策、权限理由、商店描述和实际功能一致；不要在 Edge 双设备实测完成前，把同步写成“已完整验证”。

## 官方参考

- [注册 Microsoft Edge 开发者账号](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
- [发布扩展、填写隐私信息与商店素材要求](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- [Microsoft Edge Add-ons 开发者政策](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [Microsoft Edge manifest 格式](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/manifest-format)

本指南提供当前版本的操作步骤和申报草稿；实际注册资料、协议确认、表单认证和最终提交由发布者完成，审核结果以微软通知为准。
