# breath-plugins

Breath 的官方插件仓库。用户在 Breath 的「插件」页添加本仓库地址后，即可浏览并安装这里收录的插件。

插件开发流程、运行模型与排错指南见 [DEVELOPMENT.md](DEVELOPMENT.md)；本文件是契约与字段级参考。

## 什么是 Breath 插件

Breath 插件是一个运行在 JavaScriptCore 沙盒里的 JavaScript 包。宿主注入全局 `breath` 对象作为唯一 API 入口；插件通过它注册视图与命令、发起网络请求、读写键值存储、发送系统通知。

运行时约束：

- 每个插件一个独立的 JSContext，相互隔离；单次求值有执行时间上限（看门狗）。
- 没有 DOM、没有 `XMLHttpRequest`/`fetch`、没有 `setTimeout`。网络只能走 `breath.fetch`，XML 等格式需用纯 JS 解析。
- 渲染是全量重渲染模型：事件处理器返回一棵完整的新组件树，宿主整体替换。
- 渲染与事件处理器可以是 `async` 函数（返回 Promise 的组件树），`await breath.*` 调用是推荐写法。
- 网络请求受清单里 `permissions.network` 域名白名单约束，`["*"]` 表示任意域名（安装时会如实展示给用户）。

## 仓库结构

```
breath-plugins/
├── plugins.json              # 插件源索引（宿主读取的入口）
└── plugins/
    └── rss-reader/           # 一个插件一个目录
        ├── plugin.json       # 插件清单
        └── main.js           # 入口脚本
```

### plugins.json（源索引）

仓库根目录的索引文件，列出本仓库可安装的插件：

```json
{
  "plugins": [
    {
      "id": "app.breath.plugins.rss",
      "name": "RSS 阅读器",
      "version": "0.1.24",
      "description": "订阅 RSS/Atom Feed，在 Breath 里阅读文章。",
      "path": "plugins/rss-reader"
    }
  ]
}
```

`path` 是插件目录相对仓库根的路径，目录内必须包含 `plugin.json` 与入口 JS。索引里的 `id` 必须与插件清单的 `id` 一致。

### plugin.json（插件清单）

```json
{
  "id": "app.breath.plugins.rss",
  "name": "RSS 阅读器",
  "version": "0.1.24",
  "description": "订阅 RSS/Atom Feed，在 Breath 里阅读文章。",
  "main": "main.js",
  "contributes": {
    "views": [
      { "id": "main", "title": "RSS", "icon": "dot.radiowaves.up.forward" }
    ],
    "commands": [
      { "id": "refresh", "title": "刷新所有订阅" }
    ]
  },
  "permissions": {
    "network": ["*"]
  }
}
```

字段说明：

- `id`（必填）：反域名形式的全局唯一标识，安装后作为目录名与存储命名空间。
- `name` / `version`（必填）：展示名与版本号。版本号允许 `1.0` / `1.0.0`，可带 `-prerelease`、`+build` 后缀。
- `main`（可选）：入口脚本文件名，默认 `main.js`。
- `description`（可选）：一句话介绍。
- `contributes.views`：插件提供的视图。`id` 插件内唯一；`title` 展示名；`icon` 可选，SF Symbols 名称。
- `contributes.commands`：插件提供的命令，出现在菜单栏的「插件」菜单里。
- `permissions.network`：允许 `breath.fetch` 访问的域名列表，`"*"` 表示任意域名。

## breath.* API

### 注册视图

```js
breath.ui.registerView(
    { id: "main", title: "RSS", icon: "dot.radiowaves.up.forward" },
    function (props) { return tree; },          // renderHandler
    async function (event) { return newTree; }  // eventHandler（可选）
);
```

可用 `breath.ui.supports("dialog")` 探测宿主是否支持某个组件类型。需要 `dialog` 的插件应明确要求支持它的宿主版本，不应静默降级成语义不同的 `sheet`。

`renderHandler(props)` 返回组件树 JSON；`eventHandler({type, payload})` 处理交互事件并返回更新后的整棵树。两者都可以是 async 函数。

如果事件应当立即返回，但仍需在后台完成网络请求或其他异步工作，可以在状态更新后调用 `breath.ui.invalidate(viewID)`。宿主收到通知后会再次调用对应视图的 `renderHandler`：

```js
breath.fetch(articleURL).then(function (response) {
    articleHTML = response.body;
    return breath.ui.invalidate("main");
});
```

不要为了等待后台请求而阻塞文章选择等高频交互。`invalidate` 只请求重新渲染，不会产生组件事件。

### 注册命令

```js
breath.commands.register({ id: "refresh", title: "刷新所有订阅" }, async function (payload) {
    // …
    return null; // 返回值序列化为 JSON 回传给调用方
});
```

### 网络

```js
var res = await breath.fetch("https://example.com/feed.xml");
// res = { status: 200, headers: {...}, body: "..." }
// 可选：breath.fetch(url, { method, headers, body })
```

### 键值存储（仅字符串，按插件隔离）

```js
await breath.storage.set("feeds", JSON.stringify(feeds));
var raw = await breath.storage.get("feeds"); // 不存在时为 null
await breath.storage.delete("feeds");
```

### 系统通知

```js
await breath.notifications.post({ title: "RSS 阅读器", body: "所有订阅已刷新。" });
```

### 对话框

```js
// 纯通知（一个「好」按钮）
await breath.dialogs.alert({ title: "注意", message: "出错了" });

// 确认弹窗：用户点确认为 true，取消为 false
var ok = await breath.dialogs.confirm({
    title: "删除订阅",
    message: "确定要删除吗？",
    confirmTitle: "删除",   // 可选，默认「确认」
    destructive: true       // 可选，确认按钮呈破坏性样式
});

// 输入弹窗：返回输入的字符串，用户取消时为 null
var name = await breath.dialogs.prompt({
    title: "重命名",
    message: "输入新名称",   // 以下字段均可选
    placeholder: "名称",
    initialValue: "旧名"
});

// 由用户通过系统文件面板选择 UTF-8/UTF-16 文本文件。
// 插件只能收到文件名与内容，不能访问本地路径；文件最大 2 MB。
var file = await breath.dialogs.openTextFile({
    title: "导入 OPML",
    allowedExtensions: ["opml", "xml"]
});
if (file) {
    // file = { name: "subscriptions.opml", contents: "..." }
}
```

RSS 示例用 `dialog` 弹出订阅源列表，并用 `prompt` 添加地址、用 `confirm` 确认删除；阅读主页只保留订阅源设置入口。

## 组件树 schema

每个节点是一个 JSON 对象，`type` 必填，其余属性平铺：

- `vstack` / `hstack`：`spacing?`、`children`（必填）
- `text`：`content`（必填）、`style?: "title"|"headline"|"body"|"caption"`、`color?: "primary"|"secondary"|"green"`、`lineLimit?`
- `button`：`title`（必填，同时作为无障碍标签）、`systemImage?`（SF Symbol）、`onPress?`（任意 JSON，点按时以 `button.press` 事件原样回传）、`style?: "bordered"|"plain"`、`enabled?`
- `textfield`：`placeholder?`、`value`（必填）、`onSubmit?`、`submitTitle?`。回车或点击可选的提交按钮时以 `textfield.submit` 事件回传，提交文本并入 payload 的 `text` 字段
- `image`：`url`（必填，http/https）、`width?`、`height?`、`style?: "sourceIcon"`。站点小图标会按更小尺寸解码，并与正文图片采用不同的资源限额
- `list`：`children`（必填）、`style?: "plain"|"cards"`。每个子节点是一行，可携带 `onSelect?`（点按行时以 `list.select` 事件回传）、`onAppear?`（该行进入滚动视口时以 `list.rowAppear` 事件回传）、`selected?`。把 `onAppear` 放在当前最后一行可实现滚动到底追加下一批
- `segmented`：`options: [{value, title}]`（必填）、`selection`（必填）、`onChange?`（选择变化时以 `segmented.change` 事件回传，payload 并入 `value` 字段）
- `splitview`：`leading`、`trailing`（必填）、`leadingWidth?`。渲染为可拖动的原生左右分栏
- `webcontent`：`html`（必填，HTML 片段，在沙盒 WebView 里只读渲染，链接由系统浏览器打开）
- `dialog`：`content`（必填）、`width?`、`height?`、`onDismiss?`（关闭弹窗时以 `dialog.dismiss` 事件回传）
- `sheet`：`content`（必填）、`width?`、`height?`、`onDismiss?`（系统关闭时以 `sheet.dismiss` 事件回传）
- `divider`、`spacer`（`length?`）

事件类型：`button.press`、`textfield.submit`、`list.select`、`list.rowAppear`、`segmented.change`、`dialog.dismiss`、`sheet.dismiss`。事件 payload 就是组件上声明的 `onPress` / `onSubmit` / `onSelect` / `onAppear` / `onChange` / `onDismiss` JSON（`textfield.submit` 额外并入 `text`，`segmented.change` 额外并入 `value`）。

注意：`textfield` 没有 `onChange`，独立的 `button` 拿不到相邻输入框里的文本。需要“输入框 + 提交按钮”时，在 `textfield` 上设置 `submitTitle`；宿主会让按钮和回车共用 `textfield.submit` 事件。

## 用户如何安装

**从插件源安装**：

1. 打开 Breath 的「插件」页，点右上角齿轮菜单 →「管理插件源…」。
2. 填入插件源仓库地址（如 `https://github.com/<owner>/breath-plugins`），点「添加」。
3. 回到「可安装」列表选择插件安装；安装确认页会展示来源与插件声明的权限（如网络访问范围）。

**从本地安装**：齿轮菜单 →「从本地添加插件…」，选择插件文件夹或 zip 包即可，适合插件开发者本地迭代（同 id 直接覆盖替换，无需重启）。

## 如何发布自己的插件仓库

1. 新建一个公开 GitHub 仓库，按上面的结构放 `plugins.json` 与插件目录。
2. 在 Breath 的「插件」页添加你的仓库地址，验证能列出并安装插件。
3. 把地址分享给其他用户即可。发布新版本时修改 `plugin.json` 与 `plugins.json` 里的 `version`，已安装用户会在「插件」页看到更新提示。

写作建议：

- 处理器里捕获所有异常，失败时把错误展示在组件树里，不要让异常逃出处理器。
- 需要持久化的状态走 `breath.storage`（仅存字符串，复杂数据用 `JSON.stringify`）。
- `permissions.network` 按实际需要声明域名；只有确实无法枚举域名时才用 `"*"`。

## 示例插件

- [RSS 阅读器](plugins/rss-reader/)：订阅 RSS/Atom Feed，列表浏览文章，正文用 webcontent 渲染。演示了视图 + 命令 + fetch + storage + 通知 + 删除确认对话框的完整用法。
