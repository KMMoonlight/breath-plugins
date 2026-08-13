# Breath 插件开发指南

这份文档面向插件作者，覆盖从写出第一个插件到发布给其他人的完整流程。API 的字段级参考见 [README.md](README.md)；本文侧重流程、模型与排错。

## 快速开始：五分钟写一个插件

### 1. 创建目录

```
my-plugin/
├── plugin.json
└── main.js
```

```json
// plugin.json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "0.1.0",
  "description": "我的第一个 Breath 插件",
  "contributes": {
    "views": [
      { "id": "main", "title": "Hello", "icon": "hand.wave" }
    ]
  },
  "permissions": {
    "network": []
  }
}
```

```js
// main.js
var count = 0;

function render() {
    return {
        type: "vstack",
        spacing: 12,
        children: [
            { type: "text", content: "点击次数：" + count, style: "headline" },
            { type: "button", title: "点我", onPress: { action: "increment" } }
        ]
    };
}

breath.ui.registerView(
    { id: "main", title: "Hello", icon: "hand.wave" },
    function (props) { return render(); },
    function (event) {
        if (event.type === "button.press" && event.payload.action === "increment") {
            count += 1;
        }
        return render();
    }
);
```

### 2. 本地安装

打开 Breath「插件」页 → 右上角齿轮菜单 →「从本地添加插件…」→ 选择 `my-plugin` 文件夹。活动栏（侧边栏最下方）会出现插件图标，点击即打开你的视图。

### 3. 迭代循环

改代码 → 齿轮菜单重新选择同一个文件夹 → 覆盖安装。**同 id 的本地插件会被直接替换，运行中的旧会话自动销毁**，下次打开视图跑的就是新代码，无需重启 Breath。注意 bump `version` 可以让正打开的视图自动热刷新；同版本重装需要切换一次页面。

zip 包也可以直接选择安装（plugin.json 在 zip 根目录或唯一一级子目录下均可）。

## 运行模型

理解这五条，插件行为就不会有意外的部分：

1. **惰性激活**。Breath 启动时只读 `plugin.json`，不执行任何 JS。活动栏图标、菜单命令全部由清单驱动。插件的 `main.js` 在第一次被使用时（打开它的视图、触发它的命令）才求值。
2. **一个插件一个 JSContext**，跑在专用串行队列上。插件之间相互隔离，插件崩溃或抛异常不影响宿主和其他插件。
3. **看门狗**。单次 JS 求值上限 5 秒，超时强制终止。事件处理器里的耗时工作（网络、解析）请用 `await`，不要在 JS 里做同步死循环。
4. **全量重渲染**。交互事件到达后，事件处理器返回一棵**完整的新组件树**，宿主整体替换。没有局部更新、没有虚拟 DOM diff——树都很小，直接重建。状态放在 `main.js` 的闭包变量里（如上面的 `count`）。
5. **异步处理器**。render / event / command 处理器都可以是 `async` 函数或返回 Promise，宿主会等 Promise 落定后取结果。必须等结果才能继续的操作可以 `await breath.fetch(...)` 后返回新树；文章切换等高频交互应先返回当前树，在后台 Promise 完成后调用 `breath.ui.invalidate(viewID)` 请求宿主重新渲染。

运行时环境是 JavaScriptCore：**没有 DOM、没有 `console.log`、没有 `setTimeout`、没有浏览器 `fetch`**。XML/HTML 解析需要纯 JS（正则或手写 parser），参考 [RSS 阅读器](plugins/rss-reader/main.js) 的实现。

插件不能直接读取本地路径。需要导入 OPML 等文本时，调用 `breath.dialogs.openTextFile({ title, allowedExtensions })`，由用户在系统面板明确选择文件；宿主只返回文件名与最多 2 MB 的文本内容。

## 错误去哪了

- **manifest 不合法 / main.js 求值抛异常**：显示在「插件」页的「加载错误」区（文件夹名 + 原因）。
- **render / event 处理器抛异常**：视图区域显示错误文本和「重试」按钮，宿主不崩溃。
- **`breath.*` 调用失败**（如网络白名单拒绝）：Promise reject，用 `try/catch` 接住。

建议：处理器里捕获所有异常，把错误渲染进组件树（一条 caption 文本），永远不要让异常逃出处理器——这是用户能看到的最友好的形式。

## 权限模型

`permissions.network` 是 `breath.fetch` 的域名白名单，由宿主强制执行：

- 只允许 http/https；`"example.com"` 匹配自身及子域（`api.example.com`）；`"*"` 匹配任意域名。
- **重定向逐跳校验**：请求 302 到白名单外的域名会被拦截，不能靠跳转绕过。
- 空列表 = 禁止一切网络访问。
- 安装确认页会向用户如实展示这份清单，`"*"` 显示为「可访问任意网络地址」。按实际需要声明，只有确实无法枚举域名时才用 `"*"`。

`breath.storage` 按插件 id 隔离命名空间，插件之间互相看不到对方的存储。

## 组件树要点

完整 schema 见 [README.md](README.md#组件树-schema)。开发时容易踩的几处：

- **事件 payload 是声明式的**：`onPress` / `onSubmit` / `onSelect` / `onAppear` / `onChange` / `onDismiss` 上挂的任意 JSON，会在事件触发时原样回传。把"这是什么动作、作用于谁"编码进去（如 `{action: "delete", id: feed.url}`）。
- **事件类型**：`button.press`、`textfield.submit`（payload 并入 `text` 字段）、`list.select`、`list.rowAppear`、`segmented.change`（payload 并入 `value` 字段）、`dialog.dismiss`、`sheet.dismiss`。列表最后一行的 `onAppear` 可用作滚动到底加载下一批的哨兵。
- **没有 `onChange`**：独立的 `button` 拿不到相邻 `textfield` 的输入。需要"输入框 + 按钮"时，用 `textfield` 的 `submitTitle`，按钮和回车共用 `textfield.submit` 事件。
- **`dialog`** 是独立弹窗节点，适合设置、管理等需要自定义组件树的界面；关闭时回传 `dialog.dismiss`。
- **`sheet`** 是树内节点：出现在返回的树里就显示，从树里移除就关闭；系统侧关闭（Esc、点外面）会回传 `sheet.dismiss`，记得在处理器里把它从树里清掉，否则状态会不一致。
- **`webcontent`** 只读：无插件脚本桥，链接点击改由系统浏览器打开。渲染不可信 HTML（如 RSS 正文）前，剥掉 `<script>`/`<iframe>`/`<form>` 与 `on*` 属性。
- **`splitview` + `list` + `segmented`** 是搭建"列表-详情"式界面的主力组合；需要附加信息栏时，在详情侧组合普通 `hstack`。

## 发布：GitHub 插件源

任何公开 GitHub 仓库都可以成为插件源。仓库根放一个 `plugins.json` 索引（格式见 README），每个插件一个目录。用户在齿轮菜单 →「管理插件源…」里添加仓库地址即可浏览安装。

发布与更新流程：

1. 改代码，bump `plugin.json` 的 `version`（更新检测以它为准，**索引和清单两处要一起改**）。
2. push 到默认分支。Breath 的请求带缓存破除参数，用户点「检查更新」即可看到新版本；「可安装」列表也会同步刷新。
3. 用户点「更新」后旧会话自动销毁，下次使用跑新代码。

版本比较是逐段数字比较（`0.1.10` > `0.1.9`），相等或更旧不算更新；`-beta` / `+build` 后缀参与解析但不参与大小比较。

### 本地安装与源安装的边界

- 本地安装的插件**没有安装记录**，不参与更新检查。
- 同 id 冲突时：本地覆盖本地 → 直接替换（开发迭代）；本地覆盖**源管理**的插件 → 拒绝，需先卸载。这是为了防止本地副本和源的更新流互相打架。

## 测试与调试技巧

- 迭代优先走本地安装，秒级循环；发布只在你满意之后。
- 给 feed 解析、数据变换这类纯逻辑抽出纯函数，可以在 Node 里单测（`breath.*` 之外的代码就是普通 JS）。
- 处理器第一行可以先返回一棵只含错误兜底的树，确认链路通了再填真实逻辑。

## 示例

- [RSS 阅读器](plugins/rss-reader/)：视图 + 命令 + fetch + storage + 通知 + 自定义 dialog 的完整实战，建议通读。
