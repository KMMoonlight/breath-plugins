// RSS 阅读器 —— Breath 锚点插件。
//
// 只使用 v1 插件 API。JavaScriptCore 没有 DOM/XML 解析器、没有 setTimeout，
// 因此 RSS/Atom 用纯正则提取；所有异步都走 breath.* 返回的 Promise。
//
// 状态模型：全部状态保存在本文件的闭包变量里（每个插件一个独立 JSContext）。
// 渲染是全量重渲染：任何事件处理后都返回一棵完整的新组件树。

"use strict";

// MARK: - 状态

var state = {
    loaded: false,          // 是否已从 breath.storage 恢复订阅列表
    feeds: [],              // [{url, title}]，持久化到 storage（key: "feeds"）
    articles: {},           // url -> [{title, link, html, date}]，仅会话内存
    selectedFeed: null,     // 当前选中订阅的 url
    selectedArticle: -1,    // 当前打开的文章在 articles[selectedFeed] 里的下标，-1 表示未打开
    managingSources: false, // 是否正在显示订阅源设置
    message: null           // 展示给用户的错误/提示文本
};

var STORAGE_KEY = "feeds";

// 首次使用时的恢复 Promise，保证只加载一次（并发调用共享同一个 Promise）。
var loadPromise = null;

function ensureLoaded() {
    if (!loadPromise) {
        loadPromise = breath.storage.get(STORAGE_KEY).then(function (raw) {
            if (typeof raw === "string" && raw) {
                try {
                    var saved = JSON.parse(raw);
                    if (Array.isArray(saved)) {
                        state.feeds = saved.filter(function (f) {
                            return f && typeof f.url === "string";
                        }).map(function (f) {
                            return { url: f.url, title: String(f.title || f.url) };
                        });
                    }
                } catch (ignored) {
                    // 存储内容损坏时按空列表处理，不影响插件可用性。
                }
            }
            state.loaded = true;
        });
    }
    return loadPromise;
}

function saveFeeds() {
    return breath.storage.set(STORAGE_KEY, JSON.stringify(state.feeds));
}

// MARK: - 容错 XML 提取（RSS 2.0 + Atom）

// 提取 <tag>…</tag> 的文本，兼容命名空间写法（<content:encoded>、<dc:date>）。
function textOf(xml, tag) {
    var re = new RegExp(
        "<(?:\\w+:)?" + tag + "(\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?" + tag + "\\s*>", "i");
    var m = re.exec(xml);
    if (!m) { return ""; }
    return decodeEntities(stripCDATA(m[2])).trim();
}

function stripCDATA(s) {
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (match, entity) {
        switch (entity) {
        case "amp": return "&";
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return "\"";
        case "apos": return "'";
        case "nbsp": return " ";
        default:
            if (entity.charAt(0) === "#") {
                var code = entity.charAt(1).toLowerCase() === "x"
                    ? parseInt(entity.slice(2), 16)
                    : parseInt(entity.slice(1), 10);
                if (!isNaN(code)) {
                    try { return String.fromCodePoint(code); } catch (ignored) {}
                }
            }
            return match;
        }
    });
}

function attrOf(tag, name) {
    var re = new RegExp(name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i");
    var m = re.exec(tag);
    return m ? decodeEntities(m[2] || m[3] || "") : "";
}

// Atom 的 <link> 是自闭合标签，优先取 rel="alternate"（或缺省 rel）的 href。
function atomLink(xml) {
    var re = /<link\b[^>]*>/gi;
    var fallback = "";
    var m;
    while ((m = re.exec(xml))) {
        var href = attrOf(m[0], "href");
        if (!href) { continue; }
        var rel = attrOf(m[0], "rel");
        if (!rel || rel === "alternate") { return href; }
        if (!fallback) { fallback = href; }
    }
    return fallback;
}

function formatDate(raw) {
    if (!raw) { return ""; }
    var t = Date.parse(raw);
    if (isNaN(t)) { return raw; }
    var d = new Date(t);
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// 解析入口：按是否包含 <item>/<entry> 区分 RSS 2.0 与 Atom。
function parseFeed(xml) {
    if (/<item\b/i.test(xml)) { return parseRSS(xml); }
    if (/<entry\b/i.test(xml)) { return parseAtom(xml); }
    return { title: "", items: [] };
}

function parseRSS(xml) {
    var firstItem = xml.search(/<item\b/i);
    var head = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
    var result = { title: textOf(head, "title"), items: [] };
    var re = /<item\b[\s\S]*?<\/item\s*>/gi;
    var m;
    while ((m = re.exec(xml))) {
        var block = m[0];
        result.items.push({
            title: textOf(block, "title") || "（无标题）",
            link: textOf(block, "link"),
            // <content:encoded> 优先于 <description>
            html: textOf(block, "encoded") || textOf(block, "description"),
            date: formatDate(textOf(block, "pubDate") || textOf(block, "date"))
        });
    }
    return result;
}

function parseAtom(xml) {
    var firstEntry = xml.search(/<entry\b/i);
    var head = firstEntry >= 0 ? xml.slice(0, firstEntry) : xml;
    var result = { title: textOf(head, "title"), items: [] };
    var re = /<entry\b[\s\S]*?<\/entry\s*>/gi;
    var m;
    while ((m = re.exec(xml))) {
        var block = m[0];
        result.items.push({
            title: textOf(block, "title") || "（无标题）",
            link: atomLink(block),
            html: textOf(block, "content") || textOf(block, "summary"),
            date: formatDate(textOf(block, "published") || textOf(block, "updated"))
        });
    }
    return result;
}

// MARK: - HTML 处理

function stripHTML(html) {
    return decodeEntities(
        html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function escapeHTML(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// webcontent 在沙盒 WKWebView 里加载原始 HTML。剥掉脚本/表单类标签与
// 内联事件处理器，剩下排版标签原样保留。
function sanitizeHTML(html) {
    return html
        .replace(/<\s*(script|iframe|object|embed|form|link|meta)\b[\s\S]*?(<\/\s*(script|iframe|object|embed|form|link|meta)\s*>|\/?>)/gi, "")
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
        .replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
}

function articleDocument(article) {
    var body = sanitizeHTML(article.html || "");
    if (!stripHTML(body)) {
        body = "<p>这篇文章没有正文。</p>";
    }
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        + "<style>body{font-family:-apple-system,sans-serif;font-size:15px;"
        + "line-height:1.65;margin:16px;color:#222;}"
        + "img{max-width:100%;height:auto;}a{color:#0a6dff;}</style>"
        + "</head><body>" + body + "</body></html>";
}

// MARK: - 数据加载

// 拉取并解析一个 Feed。失败一律抛 Error，由调用方转成界面上的提示文本。
function fetchFeed(url) {
    return breath.fetch(url).then(function (res) {
        if (res.status < 200 || res.status >= 300) {
            throw new Error("请求失败（HTTP " + res.status + "）");
        }
        var parsed = parseFeed(res.body || "");
        if (!parsed.title && parsed.items.length === 0) {
            throw new Error("无法解析该地址的内容（不是有效的 RSS/Atom？）");
        }
        return parsed;
    });
}

// MARK: - 组件树

function text(content, style, color) {
    var node = { type: "text", content: String(content) };
    if (style) { node.style = style; }
    if (color) { node.color = color; }
    return node;
}

// 订阅源管理窗口：主视图只保留入口，添加与删除分别交给宿主原生
// prompt / confirm 对话框，交互结构与 IDEA 的插件源管理一致。
function sourceSettingsTree() {
    var children = [
        {
            type: "hstack", spacing: 8, children: [
                text("订阅源", "headline"),
                { type: "spacer" },
                {
                    type: "button", title: "添加订阅源", style: "bordered",
                    onPress: { action: "add-feed-dialog" }
                },
                {
                    type: "button", title: "刷新", style: "bordered",
                    enabled: state.feeds.length > 0,
                    onPress: { action: "refresh-all" }
                },
                {
                    type: "button", title: "完成", style: "bordered",
                    onPress: { action: "close-settings" }
                }
            ]
        }
    ];

    if (state.message) {
        children.push(text(state.message, "caption", "secondary"));
    }

    if (state.feeds.length === 0) {
        children.push(text("还没有订阅源", "body", "secondary"));
        children.push(text("点「添加订阅源」输入 RSS 或 Atom 地址。", "caption", "secondary"));
        return { type: "vstack", spacing: 12, children: children };
    }

    children.push({
        type: "list", style: "plain",
        children: state.feeds.map(function (feed) {
            var articles = state.articles[feed.url];
            var status = articles
                ? articles.length + " 篇文章"
                : "未加载";
            return {
                type: "vstack", spacing: 4, children: [
                    {
                        type: "hstack", spacing: 8, children: [
                            text(feed.title, "body"),
                            { type: "spacer" },
                            text(status, "caption", "secondary"),
                            {
                                type: "button", title: "移除", style: "bordered",
                                onPress: { action: "remove-feed", url: feed.url }
                            }
                        ]
                    },
                    text(feed.url, "caption", "secondary")
                ]
            };
        })
    });

    return { type: "vstack", spacing: 12, children: children };
}

function allArticleRows() {
    var rows = [];
    state.feeds.forEach(function (feed) {
        var articles = state.articles[feed.url] || [];
        articles.forEach(function (article, index) {
            rows.push({
                feed: feed,
                article: article,
                index: index
            });
        });
    });
    rows.sort(function (a, b) {
        return String(b.article.date || "").localeCompare(String(a.article.date || ""));
    });
    return rows;
}

// 阅读主页只呈现文章，订阅源管理收进右上角设置按钮。
function mainTree() {
    var articleRows = allArticleRows();
    var children = [
        {
            type: "hstack", spacing: 8, children: [
                text("文章", "headline"),
                articleRows.length > 0
                    ? text(articleRows.length + " 篇", "caption", "secondary")
                    : { type: "spacer", length: 0 },
                { type: "spacer" },
                {
                    type: "button", title: "刷新", style: "bordered",
                    enabled: state.feeds.length > 0,
                    onPress: { action: "refresh-all" }
                },
                {
                    type: "button", title: "订阅源设置",
                    systemImage: "gearshape", style: "plain",
                    onPress: { action: "open-settings" }
                }
            ]
        }
    ];

    if (state.message) {
        children.push(text(state.message, "caption", "secondary"));
    }

    if (state.feeds.length === 0) {
        children.push(text("还没有订阅", "body", "secondary"));
        children.push(text("点右上角设置按钮添加订阅源。", "caption", "secondary"));
        return { type: "vstack", spacing: 12, children: children };
    }

    if (articleRows.length === 0) {
        children.push(text("暂时没有文章，点「刷新」试试。", "body", "secondary"));
        return { type: "vstack", spacing: 12, children: children };
    }

    children.push({
        type: "list",
        children: articleRows.map(function (item) {
            var metadata = [text(item.feed.title, "caption", "secondary")];
            if (item.article.date) {
                metadata.push({ type: "spacer" });
                metadata.push(text(item.article.date, "caption", "secondary"));
            }
            return {
                type: "vstack", spacing: 3, children: [
                    text(item.article.title, "body"),
                    { type: "hstack", spacing: 8, children: metadata }
                ],
                onSelect: {
                    action: "select-article",
                    feed: item.feed.url,
                    index: item.index
                }
            };
        })
    });

    return { type: "vstack", spacing: 12, children: children };
}

// 文章详情：标题 + 日期 + 正文（webcontent）+ 返回。
function articleTree() {
    var articles = state.articles[state.selectedFeed] || [];
    var article = articles[state.selectedArticle];
    if (!article) {
        state.selectedArticle = -1;
        return mainTree();
    }
    var children = [text(article.title, "headline")];
    if (article.date) {
        children.push(text(article.date, "caption", "secondary"));
    }
    children.push({ type: "webcontent", html: articleDocument(article) });
    children.push({
        type: "button", title: "返回", style: "plain",
        onPress: { action: "back" }
    });
    return { type: "vstack", spacing: 8, children: children };
}

function tree() {
    var page = state.selectedArticle >= 0 && state.selectedFeed
        ? articleTree()
        : mainTree();
    var children = [page];
    if (state.managingSources) {
        children.push({
            type: "sheet",
            content: sourceSettingsTree(),
            width: 480,
            height: 360,
            onDismiss: { action: "close-settings" }
        });
    }
    return { type: "vstack", spacing: 0, children: children };
}

function findFeed(url) {
    for (var i = 0; i < state.feeds.length; i++) {
        if (state.feeds[i].url === url) { return state.feeds[i]; }
    }
    return null;
}

// MARK: - 事件处理

function addFeed(url) {
    url = (url || "").trim();
    if (!url) {
        state.message = "请在输入框中输入 Feed 地址后按回车添加。";
        return Promise.resolve();
    }
    if (!/^https?:\/\//i.test(url)) {
        state.message = "地址需要以 http:// 或 https:// 开头。";
        return Promise.resolve();
    }
    if (findFeed(url)) {
        state.message = "这个订阅已经添加过了。";
        return Promise.resolve();
    }
    return fetchFeed(url).then(function (parsed) {
        state.feeds.push({ url: url, title: parsed.title || url });
        state.articles[url] = parsed.items;
        state.selectedFeed = url;
        state.selectedArticle = -1;
        state.message = null;
        return saveFeeds();
    }).catch(function (error) {
        state.message = "添加失败：" + errorMessage(error);
    });
}

// IDEA 风格的“添加仓库”流程：管理窗口保持列表上下文，地址输入由
// Breath 的原生 prompt 承载，取消时不修改任何状态。
function promptAndAddFeed() {
    state.message = null;
    return breath.dialogs.prompt({
        title: "添加订阅源",
        message: "输入 RSS 或 Atom Feed 地址",
        placeholder: "https://example.com/feed.xml",
        initialValue: ""
    }).then(function (url) {
        if (url === null) { return; }
        return addFeed(url);
    });
}

// 删除订阅是破坏性操作，先经宿主确认弹窗；取消则原样返回当前树。
function removeFeed(url) {
    var feed = findFeed(url);
    var name = feed ? feed.title : url;
    return breath.dialogs.confirm({
        title: "删除订阅",
        message: "确定要删除「" + name + "」吗？已加载的文章列表会一并移除。",
        confirmTitle: "删除",
        destructive: true
    }).then(function (confirmed) {
        if (!confirmed) { return; }
        state.feeds = state.feeds.filter(function (feed) { return feed.url !== url; });
        delete state.articles[url];
        if (state.selectedFeed === url) {
            state.selectedFeed = null;
            state.selectedArticle = -1;
        }
        state.message = null;
        return saveFeeds();
    });
}

function refreshSelected() {
    if (!state.selectedFeed) {
        state.message = "请先选择一个订阅。";
        return Promise.resolve();
    }
    var url = state.selectedFeed;
    return fetchFeed(url).then(function (parsed) {
        state.articles[url] = parsed.items;
        var feed = findFeed(url);
        if (feed && parsed.title) {
            feed.title = parsed.title;
            return saveFeeds();
        }
        state.message = null;
    }).catch(function (error) {
        state.message = "刷新失败：" + errorMessage(error);
    });
}

// 刷新全部订阅源，供页面标题栏与命令面板复用。
function refreshAllFeeds() {
    var failures = 0;
    var chain = Promise.resolve();
    state.feeds.forEach(function (feed) {
        chain = chain.then(function () {
            return fetchFeed(feed.url).then(function (parsed) {
                feed.title = parsed.title || feed.title;
                state.articles[feed.url] = parsed.items;
            }, function () {
                failures += 1;
            });
        });
    });
    return chain.then(function () {
        return saveFeeds();
    }).then(function () {
        return failures;
    });
}

function errorMessage(error) {
    return (error && error.message) ? error.message : String(error);
}

function onEvent(event) {
    var payload = event.payload || {};
    var action = payload.action;
    var work;
    if (action === "add-feed") {
        work = addFeed(typeof payload.text === "string" ? payload.text : "");
    } else if (action === "add-feed-dialog") {
        work = promptAndAddFeed();
    } else if (action === "open-settings") {
        state.managingSources = true;
        state.message = null;
        work = Promise.resolve();
    } else if (action === "close-settings") {
        state.managingSources = false;
        state.message = null;
        work = Promise.resolve();
    } else if (action === "select-article") {
        state.selectedFeed = typeof payload.feed === "string" ? payload.feed : state.selectedFeed;
        state.selectedArticle = typeof payload.index === "number" ? payload.index : -1;
        state.message = null;
        work = Promise.resolve();
    } else if (action === "remove-feed" && typeof payload.url === "string") {
        work = removeFeed(payload.url);
    } else if (action === "refresh") {
        work = refreshSelected();
    } else if (action === "refresh-all") {
        work = refreshAllFeeds().then(function (failures) {
            state.message = failures === 0
                ? null
                : "刷新完成，" + failures + " 个订阅源失败。";
        });
    } else if (action === "back") {
        state.selectedArticle = -1;
        work = Promise.resolve();
    } else {
        work = Promise.resolve();
    }
    // 任何失败都不许逃出处理器：转成界面上的提示文本，照常返回新树。
    return work.then(function () {
        return tree();
    }, function (error) {
        state.message = "操作失败：" + errorMessage(error);
        return tree();
    });
}

// MARK: - 注册贡献

breath.ui.registerView(
    { id: "main", title: "RSS", icon: "dot.radiowaves.up.forward" },
    function (props) {
        return ensureLoaded().then(function () { return tree(); });
    },
    onEvent
);

breath.commands.register(
    { id: "refresh", title: "刷新所有订阅" },
    function (payload) {
        return ensureLoaded().then(function () {
            return refreshAllFeeds().then(function (failures) {
                return breath.notifications.post({
                    title: "RSS 阅读器",
                    body: failures === 0
                        ? "所有订阅已刷新。"
                        : "刷新完成，" + failures + " 个订阅失败。"
                });
            }).catch(function () {
                // 通知服务不可用等收尾失败不影响命令结果。
            }).then(function () {
                return null;
            });
        });
    }
);
