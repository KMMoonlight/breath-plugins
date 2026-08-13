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
    feeds: [],              // [{url,title,siteURL,iconURL}]，持久化到 storage
    articles: {},           // url -> [{title, link, html, date}]，仅会话内存
    selectedFeed: null,     // 当前选中订阅的 url
    selectedArticle: -1,    // 当前打开的文章在 articles[selectedFeed] 里的下标，-1 表示未打开
    readArticleIDs: {},     // 文章稳定 id -> true，持久化到 storage
    articleFilter: "all",   // all / unread / read，仅会话内筛选偏好
    visibleArticleCount: 40,// 时间线按批次渐进渲染，滚动到底继续加载
    visibleSourceCount: 20, // 订阅源设置同样渐进渲染，避免弹窗叠加过多节点
    managingSources: false, // 是否正在显示订阅源设置
    importingOPML: false,   // 是否正在后台导入 OPML 中的订阅源
    message: null           // 展示给用户的错误/提示文本
};

var STORAGE_KEY = "feeds";
var READ_STORAGE_KEY = "readArticleIDs";
var ARTICLE_BATCH_SIZE = 40;
var SOURCE_BATCH_SIZE = 20;

// 首次使用时的恢复 Promise，保证只加载一次（并发调用共享同一个 Promise）。
var loadPromise = null;
var initialArticleLoadPromise = null;

function ensureLoaded() {
    if (!loadPromise) {
        loadPromise = Promise.all([
            breath.storage.get(STORAGE_KEY),
            breath.storage.get(READ_STORAGE_KEY)
        ]).then(function (savedValues) {
            var raw = savedValues[0];
            if (typeof raw === "string" && raw) {
                try {
                    var saved = JSON.parse(raw);
                    if (Array.isArray(saved)) {
                        state.feeds = saved.filter(function (f) {
                            return f && typeof f.url === "string";
                        }).map(function (f) {
                            return {
                                url: f.url,
                                title: String(f.title || f.url),
                                siteURL: String(f.siteURL || ""),
                                iconURL: String(f.iconURL || "")
                            };
                        });
                    }
                } catch (ignored) {
                    // 存储内容损坏时按空列表处理，不影响插件可用性。
                }
            }
            var rawReadIDs = savedValues[1];
            if (typeof rawReadIDs === "string" && rawReadIDs) {
                try {
                    var savedReadIDs = JSON.parse(rawReadIDs);
                    if (Array.isArray(savedReadIDs)) {
                        savedReadIDs.forEach(function (id) {
                            if (typeof id === "string" && id) {
                                state.readArticleIDs[id] = true;
                            }
                        });
                    }
                } catch (ignoredReadState) {}
            }
            state.loaded = true;
        });
    }
    return loadPromise;
}

function ensureArticlesLoaded() {
    return ensureLoaded().then(function () {
        if (state.feeds.length === 0) { return; }
        var missingArticles = state.feeds.some(function (feed) {
            return !Array.isArray(state.articles[feed.url]);
        });
        if (!missingArticles) { return; }
        if (!initialArticleLoadPromise) {
            initialArticleLoadPromise = refreshAllFeeds().then(function (failures) {
                state.message = failures === 0
                    ? null
                    : "自动刷新时有 " + failures + " 个订阅源失败。";
            });
        }
        return initialArticleLoadPromise;
    });
}

function saveFeeds() {
    return breath.storage.set(STORAGE_KEY, JSON.stringify(state.feeds));
}

function saveReadState() {
    return breath.storage.set(
        READ_STORAGE_KEY,
        JSON.stringify(Object.keys(state.readArticleIDs))
    );
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

function absoluteURL(value, base) {
    value = String(value || "").trim();
    if (!value) { return ""; }
    if (/^https?:\/\//i.test(value)) { return value; }
    if (/^\/\//.test(value)) {
        var scheme = /^(https?):/i.exec(base || "");
        return scheme ? scheme[1] + ":" + value : "";
    }
    var origin = /^https?:\/\/[^/]+/i.exec(base || "");
    if (!origin) { return ""; }
    if (value.charAt(0) === "/") { return origin[0] + value; }
    var baseWithoutQuery = String(base).replace(/[?#][\s\S]*$/, "");
    var baseDirectory = baseWithoutQuery === origin[0]
        ? origin[0] + "/"
        : /\/$/.test(baseWithoutQuery)
        ? baseWithoutQuery
        : baseWithoutQuery.replace(/\/[^/]*$/, "/");
    var joined = baseDirectory + value.replace(/^\.\//, "");
    var path = joined.slice(origin[0].length).split("/");
    var normalized = [];
    path.forEach(function (part) {
        if (!part || part === ".") { return; }
        if (part === "..") { normalized.pop(); }
        else { normalized.push(part); }
    });
    return origin[0] + "/" + normalized.join("/");
}

function siteOrigin(url) {
    var match = /^https?:\/\/[^/]+/i.exec(url || "");
    return match ? match[0] : "";
}

function rssImage(head) {
    var block = /<image\b[\s\S]*?<\/image\s*>/i.exec(head);
    return block ? textOf(block[0], "url") : "";
}

function atomIcon(head) {
    var icon = textOf(head, "icon") || textOf(head, "logo");
    if (icon) { return icon; }
    var links = /<link\b[^>]*>/gi;
    var match;
    while ((match = links.exec(head))) {
        var rel = attrOf(match[0], "rel");
        if (rel === "icon" || rel === "shortcut icon") {
            return attrOf(match[0], "href");
        }
    }
    return "";
}

function htmlIcon(documentHTML, siteURL) {
    var links = /<link\b[^>]*>/gi;
    var match;
    while ((match = links.exec(documentHTML))) {
        var rel = attrOf(match[0], "rel").toLowerCase();
        if (/(^|\s)(shortcut\s+icon|icon|apple-touch-icon)(\s|$)/.test(rel)) {
            var icon = absoluteURL(attrOf(match[0], "href"), siteURL);
            if (icon) { return icon; }
        }
    }
    return "";
}

function formatDate(raw) {
    if (!raw) { return ""; }
    var t = Date.parse(raw);
    if (isNaN(t)) { return raw; }
    var d = new Date(t);
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function publicationTime(raw) {
    var value = Date.parse(raw || "");
    return isNaN(value) ? 0 : value;
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
    var siteURL = textOf(head, "link");
    var result = {
        title: textOf(head, "title"),
        siteURL: siteURL,
        iconURL: absoluteURL(rssImage(head), siteURL),
        items: []
    };
    var re = /<item\b[\s\S]*?<\/item\s*>/gi;
    var m;
    while ((m = re.exec(xml))) {
        var block = m[0];
        var rawDate = textOf(block, "pubDate") || textOf(block, "date");
        result.items.push({
            title: textOf(block, "title") || "（无标题）",
            link: textOf(block, "link"),
            // <content:encoded> 优先于 <description>
            html: textOf(block, "encoded") || textOf(block, "description"),
            date: formatDate(rawDate),
            publishedAt: publicationTime(rawDate)
        });
    }
    return result;
}

function parseAtom(xml) {
    var firstEntry = xml.search(/<entry\b/i);
    var head = firstEntry >= 0 ? xml.slice(0, firstEntry) : xml;
    var siteURL = atomLink(head);
    var result = {
        title: textOf(head, "title"),
        siteURL: siteURL,
        iconURL: absoluteURL(atomIcon(head), siteURL),
        items: []
    };
    var re = /<entry\b[\s\S]*?<\/entry\s*>/gi;
    var m;
    while ((m = re.exec(xml))) {
        var block = m[0];
        var rawDate = textOf(block, "published") || textOf(block, "updated");
        result.items.push({
            title: textOf(block, "title") || "（无标题）",
            link: atomLink(block),
            html: textOf(block, "content") || textOf(block, "summary"),
            date: formatDate(rawDate),
            publishedAt: publicationTime(rawDate)
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
        .replace(/\sstyle\s*=\s*"[^"]*"/gi, "")
        .replace(/\sstyle\s*=\s*'[^']*'/gi, "")
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
        .replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
}

function articleImageTag(tag) {
    var classAttribute = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    var tagged;
    if (!classAttribute) {
        tagged = tag.replace(/^<img\b/i, '<img class="breath-article-image"');
    } else {
        var classes = classAttribute[1] || classAttribute[2] || classAttribute[3] || "";
        if (!/(^|\s)breath-article-image(?:\s|$)/.test(classes)) {
            classes += (classes ? " " : "") + "breath-article-image";
        }
        tagged = tag.replace(classAttribute[0], ' class="' + escapeHTML(classes) + '"');
    }
    return tagged.replace(
        /^<img\b/i,
        '<img role="button" tabindex="0" title="点击放大图片"'
    );
}

// 兼容常见的图片懒加载写法，并把资源地址变成绝对 URL。
function normalizeArticleImages(html, articleURL) {
    return html.replace(/<img\b[^>]*>/gi, function (tag) {
        tag = articleImageTag(tag);
        var src = attrOf(tag, "src");
        var lazy = attrOf(tag, "data-original")
            || attrOf(tag, "data-src")
            || attrOf(tag, "data-lazy-src")
            || attrOf(tag, "data-url");
        var unusable = !src
            || /^data:/i.test(src)
            || /(?:placeholder|transparent|blank)(?:\.|\/)/i.test(src);
        var resolved = absoluteURL(unusable && lazy ? lazy : src, articleURL);
        if (!resolved && lazy) { resolved = absoluteURL(lazy, articleURL); }
        if (!resolved) { return tag; }
        // 少数派正文 CDN 要求 Referer，about:blank 中会返回 403；其官方
        // rssfile 镜像使用相同路径且允许 RSS 阅读器直接加载。
        resolved = resolved.replace(
            /^https?:\/\/cdnfile\.sspai\.com\//i,
            "https://rssfile.sspai.com/"
        );
        var withoutSrc = tag.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "");
        return withoutSrc.replace(/^<img\b/i, '<img src="' + escapeHTML(resolved) + '"');
    });
}

// Feed 只给摘要时，从文章页面提取常见正文容器。这里不执行脚本，
// 仅处理宿主 fetch 返回的 HTML；失败时继续显示原摘要。
function extractArticleBody(documentHTML) {
    var patterns = [
        /<div\b[^>]*class=(?:"[^"]*\barticle__main__content\b[^"]*"|'[^']*\barticle__main__content\b[^']*')[^>]*>([\s\S]*?)<\/div>\s*(?:<!---->\s*)*<\/div>\s*<\/div>/i,
        /<div\b[^>]*class=(?:"[^"]*\barticle-content\b[^"]*"|'[^']*\barticle-content\b[^']*')[^>]*>([\s\S]*?)<\/div>/i,
        /<div\b[^>]*class=(?:"[^"]*\bpost-content\b[^"]*"|'[^']*\bpost-content\b[^']*')[^>]*>([\s\S]*?)<\/div>/i,
        /<article\b[^>]*>([\s\S]*?)<\/article>/i,
        /<main\b[^>]*>([\s\S]*?)<\/main>/i
    ];
    for (var i = 0; i < patterns.length; i++) {
        var match = patterns[i].exec(documentHTML);
        if (match && stripHTML(match[1]).length >= 20) {
            return sanitizeHTML(match[1]);
        }
    }
    return "";
}

function isSummaryOnly(article) {
    if (!article || !article.link) { return false; }
    var html = article.html || "";
    return /查看全文|阅读全文|read\s*(the\s*)?(full|more)/i.test(stripHTML(html));
}

function loadFullArticle(article) {
    if (!isSummaryOnly(article) || article.fullArticleRequested) {
        return Promise.resolve();
    }
    article.fullArticleRequested = true;
    return breath.fetch(article.link).then(function (res) {
        if (res.status < 200 || res.status >= 300) {
            article.fullArticleRequested = false;
            return;
        }
        var fullBody = extractArticleBody(res.body || "");
        if (fullBody) {
            article.html = fullBody;
            article.fullArticleLoaded = true;
            article.presentationSource = null;
            article.presentation = null;
        } else {
            article.fullArticleRequested = false;
        }
    }, function () {
        // 原文抓取失败不影响阅读器：继续展示 Feed 摘要及原站链接。
        article.fullArticleRequested = false;
    });
}

function loadFullArticleInBackground(article) {
    if (!isSummaryOnly(article) || article.fullArticleRequested) { return; }
    loadFullArticle(article).then(function () {
        return breath.ui.invalidate("main");
    }).catch(function () {
        // 后台刷新失败时保留 Feed 摘要，下一次选择仍可重试。
    });
}

function articlePresentation(article) {
    if (article.presentationSource === article.html && article.presentation) {
        return article.presentation;
    }
    var body = normalizeArticleImages(
        sanitizeHTML(article.html || ""),
        article.link || ""
    );
    if (!stripHTML(body)) {
        body = "<p>这篇文章没有正文。</p>";
    }
    var headings = [];
    var headingIndex = 0;
    body = body.replace(
        /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi,
        function (match, level, attributes, content) {
            var title = stripHTML(content);
            if (!title) { return match; }
            headingIndex += 1;
            var id = "breath-outline-" + headingIndex;
            headings.push({ id: id, level: Number(level), title: title });
            var withoutID = attributes.replace(
                /\sid\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i,
                ""
            );
            return "<h" + level + withoutID + ' id="' + id + '">'
                + content + "</h" + level + ">";
        }
    );
    // 只返回正文片段。字体、颜色和深浅模式由 Breath 的 webcontent 宿主统一处理，
    // 避免 Feed 自带的黑色文字在深色主题下不可见。
    var presentation = {
        html: articleMediaStyles() + body + articleLightboxHTML()
            + articleOutlineHTML(headings),
        headings: headings
    };
    article.presentationSource = article.html;
    article.presentation = presentation;
    return presentation;
}

// 正文图片保持原始比例：小图不放大，大图受阅读栏宽度和视口高度双重约束。
// !important 用来覆盖源站遗留的尺寸属性和宿主的通用媒体样式。
function articleMediaStyles() {
    return '<style>'
        + '.breath-article-image{display:block!important;width:auto!important;'
        + 'max-width:min(100%,680px)!important;max-height:68vh!important;'
        + 'height:auto!important;object-fit:contain!important;'
        + 'box-sizing:border-box!important;margin:24px auto!important;cursor:zoom-in;}'
        + '.breath-article-image:focus-visible{outline:2px solid LinkText;outline-offset:4px;}'
        + '.breath-image-lightbox{display:none;position:fixed;z-index:1000;inset:0;'
        + 'place-items:center;padding:32px;background:rgba(18,18,20,.94);cursor:zoom-out;}'
        + '.breath-image-lightbox.is-open{display:grid;}'
        + '.breath-image-lightbox__preview{display:block;width:auto!important;'
        + 'max-width:calc(100vw - 64px)!important;max-height:calc(100vh - 64px)!important;'
        + 'height:auto!important;object-fit:contain!important;margin:0!important;'
        + 'border-radius:8px;box-shadow:0 16px 48px rgba(0,0,0,.48);cursor:default;}'
        + '.breath-image-lightbox__close{position:fixed;z-index:1;top:18px;right:18px;'
        + 'display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;'
        + 'border-radius:50%;background:rgb(54,54,57);color:rgb(245,245,247)!important;'
        + 'font:24px/1 -apple-system,sans-serif;cursor:pointer;}'
        + '.breath-image-lightbox__close:hover{background:rgb(72,72,76);}'
        + '.breath-image-lightbox__close:focus-visible{outline:2px solid rgb(245,245,247);'
        + 'outline-offset:2px;}'
        + '</style>';
}

function articleLightboxHTML() {
    return '<div id="breath-image-lightbox" class="breath-image-lightbox" '
        + 'role="dialog" aria-modal="true" aria-label="图片预览" aria-hidden="true" '
        + 'tabindex="-1">'
        + '<button class="breath-image-lightbox__close" type="button" '
        + 'aria-label="关闭图片预览">&times;</button>'
        + '<img class="breath-image-lightbox__preview" alt="">'
        + '</div>';
}

// 0.1.7 没有固定宽度容器或浮动面板组件。大纲因此放进既有的
// webcontent，用 CSS 悬浮预览避免 SwiftUI HStack 把它分配成半屏。
// 收起状态每个标题对应一条线，并由浏览器按标题实际排版宽度测量。
function articleOutlineHTML(headings) {
    if (headings.length === 0) { return ""; }
    var rows = headings.map(function (heading) {
        var depth = Math.max(0, Math.min(heading.level - 2, 3));
        return '<button class="breath-outline__row" type="button" '
            + 'style="--outline-depth:' + depth + '" '
            + 'data-breath-outline-target="' + escapeHTML(heading.id) + '">'
            + '<span class="breath-outline__title">' + escapeHTML(heading.title) + '</span>'
            + '</button>';
    }).join("");
    var lines = headings.map(function (heading) {
        return '<i class="breath-outline__line">' + escapeHTML(heading.title) + '</i>';
    }).join("");
    return '<style>'
        + '.breath-outline{position:fixed;z-index:20;right:16px;top:50%;'
        + 'transform:translateY(-50%);box-sizing:border-box;width:46px;'
        + 'max-width:calc(100vw - 32px);overflow:hidden;'
        + 'border:1px solid rgba(120,120,128,.24);border-radius:12px;'
        + 'background:rgb(248,248,250);color:rgb(45,45,48);'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.16);'
        + 'font:13px/1.35 -apple-system,sans-serif;'
        + 'transition:width 140ms ease,box-shadow 140ms ease;}'
        + '.breath-outline:hover,.breath-outline:focus-within{'
        + 'width:min(232px,calc(100vw - 32px));max-height:min(420px,64vh);'
        + 'overflow:auto;outline:none;box-shadow:0 12px 32px rgba(0,0,0,.22);}'
        + '.breath-outline__grip{display:flex;width:46px;box-sizing:border-box;'
        + 'flex-direction:column;align-items:flex-start;gap:5px;padding:11px 10px;}'
        + '.breath-outline__line{display:block;width:24px;height:2px;overflow:hidden;'
        + 'text-indent:-9999px;border-radius:999px;background:rgba(142,142,147,.42);}'
        + '.breath-outline__line:nth-child(3n+2){width:18px;}'
        + '.breath-outline__line:nth-child(3n+3){width:21px;}'
        + '.breath-outline__header{display:none;padding:10px 12px 7px;'
        + 'border-bottom:1px solid rgba(120,120,128,.14);font-size:11px;'
        + 'font-weight:600;letter-spacing:.02em;opacity:.58;}'
        + '.breath-outline__items{display:none;padding:6px;}'
        + '.breath-outline:hover .breath-outline__grip,'
        + '.breath-outline:focus-within .breath-outline__grip{display:none;}'
        + '.breath-outline:hover .breath-outline__header,'
        + '.breath-outline:focus-within .breath-outline__header,'
        + '.breath-outline:hover .breath-outline__items,'
        + '.breath-outline:focus-within .breath-outline__items{display:block;}'
        + '.breath-outline__row{-webkit-appearance:none;appearance:none;display:block;'
        + 'width:100%;max-width:100%;padding:7px 8px 7px '
        + 'calc(8px + var(--outline-depth)*12px);border:0;border-radius:7px;'
        + 'background:transparent!important;font:500 13px/1.35 -apple-system,sans-serif;'
        + 'text-align:left;cursor:pointer;}'
        + '.breath-outline__row+.breath-outline__row{margin-top:2px;}'
        + '.breath-outline__row:hover{background:rgba(120,120,128,.12)!important;}'
        + '.breath-outline__row:focus-visible{outline:2px solid LinkText;outline-offset:-2px;}'
        + '.breath-outline__title{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;'
        + 'white-space:nowrap;}'
        + '@media(prefers-color-scheme:dark){.breath-outline{'
        + 'color:rgb(235,235,240);background:rgb(39,39,42);'
        + 'border-color:rgba(235,235,245,.16);box-shadow:0 10px 28px rgba(0,0,0,.38);}'
        + '.breath-outline__header{border-bottom-color:rgba(235,235,245,.1);}'
        + '.breath-outline__row:hover{background:rgba(235,235,245,.09)!important;}}'
        + '</style>'
        + '<aside class="breath-outline" tabindex="0" aria-label="文章大纲">'
        + '<span class="breath-outline__grip" aria-hidden="true">' + lines + '</span>'
        + '<span class="breath-outline__header">文章大纲</span>'
        + '<nav class="breath-outline__items" aria-label="文章大纲">' + rows + '</nav>'
        + '</aside>';
}

// MARK: - 数据加载

// 拉取并解析一个 Feed。失败一律抛 Error，由调用方转成界面上的提示文本。
function fetchFeed(url, knownIconURL) {
    return breath.fetch(url).then(function (res) {
        if (res.status < 200 || res.status >= 300) {
            throw new Error("请求失败（HTTP " + res.status + "）");
        }
        var parsed = parseFeed(res.body || "");
        if (!parsed.title && parsed.items.length === 0) {
            throw new Error("无法解析该地址的内容（不是有效的 RSS/Atom？）");
        }
        var origin = siteOrigin(parsed.siteURL || url);
        if (parsed.iconURL || knownIconURL) {
            parsed.iconURL = parsed.iconURL || knownIconURL;
            return parsed;
        }
        if (!parsed.siteURL || !origin) {
            parsed.iconURL = origin ? origin + "/favicon.ico" : "";
            return parsed;
        }
        return breath.fetch(parsed.siteURL).then(function (siteResponse) {
            if (siteResponse.status >= 200 && siteResponse.status < 300) {
                parsed.iconURL = htmlIcon(siteResponse.body || "", parsed.siteURL);
            }
            parsed.iconURL = parsed.iconURL || origin + "/favicon.ico";
            return parsed;
        }, function () {
            parsed.iconURL = origin + "/favicon.ico";
            return parsed;
        });
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
                    type: "button", title: "导入 OPML", style: "bordered",
                    enabled: !state.importingOPML,
                    onPress: { action: "import-opml" }
                },
                {
                    type: "button", title: "刷新", style: "bordered",
                    systemImage: "arrow.clockwise",
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

    var visibleFeeds = state.feeds.slice(0, state.visibleSourceCount);
    children.push({
        type: "list", style: "plain",
        children: visibleFeeds.map(function (feed, visibleIndex) {
            var articles = state.articles[feed.url];
            var status = articles
                ? articles.length + " 篇文章"
                : "未加载";
            var row = {
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
            if (visibleIndex === visibleFeeds.length - 1
                    && visibleFeeds.length < state.feeds.length) {
                row.onAppear = {
                    action: "load-more-sources",
                    visibleCount: visibleFeeds.length
                };
            }
            return row;
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
        var byTime = Number(b.article.publishedAt || 0)
            - Number(a.article.publishedAt || 0);
        if (byTime !== 0) { return byTime; }
        return articleID(b.article).localeCompare(articleID(a.article));
    });
    return rows;
}

function articleID(article) {
    return String(article.link || article.title + "|" + article.date);
}

function isRead(article) {
    return state.readArticleIDs[articleID(article)] === true;
}

// 阅读主页只呈现文章，订阅源管理收进右上角设置按钮。
function mainTree() {
    var allRows = allArticleRows();
    var unreadCount = allRows.filter(function (item) {
        return !isRead(item.article);
    }).length;
    var articleRows = allRows.filter(function (item) {
        if (state.articleFilter === "unread") { return !isRead(item.article); }
        if (state.articleFilter === "read") { return isRead(item.article); }
        return true;
    });
    var visibleArticleRows = articleRows.slice(0, state.visibleArticleCount);
    var leadingChildren = [
        {
            type: "hstack", spacing: 8, children: [
                text("文章", "headline"),
                allRows.length > 0
                    ? text(unreadCount + " 篇未读", "caption", "secondary")
                    : { type: "spacer", length: 0 }
            ]
        },
        {
            type: "segmented",
            options: [
                { value: "all", title: "全部" },
                { value: "unread", title: "未读" },
                { value: "read", title: "已读" }
            ],
            selection: state.articleFilter,
            onChange: { action: "set-filter" }
        }
    ];

    if (state.message) {
        leadingChildren.push(text(state.message, "caption", "secondary"));
    }

    if (state.feeds.length === 0) {
        leadingChildren.push(text("还没有订阅", "body", "secondary"));
        leadingChildren.push(text("点右上角设置按钮添加订阅源。", "caption", "secondary"));
    } else if (articleRows.length === 0) {
        leadingChildren.push(text("暂时没有文章，点「刷新」试试。", "body", "secondary"));
    } else {
        leadingChildren.push({
            type: "list",
            children: visibleArticleRows.map(function (item, visibleIndex) {
                var metadata = [text(item.feed.title, "caption", "secondary")];
                if (item.article.date) {
                    metadata.push({ type: "spacer" });
                    metadata.push(text(item.article.date, "caption", "secondary"));
                }
                var read = isRead(item.article);
                var titleChildren = [
                    text(item.article.title, "body", read ? "secondary" : null)
                ];
                if (!read) {
                    metadata.splice(1, 0, text("●", "caption", "green"));
                }
                var row = {
                    type: "hstack", spacing: 8, children: [
                        item.feed.iconURL
                            ? {
                                type: "image", url: item.feed.iconURL,
                                width: 28, height: 28, style: "sourceIcon"
                            }
                            : text("▦", "body", "secondary"),
                        {
                            type: "vstack", spacing: 3, children: [
                                {
                                    type: "hstack", spacing: 6, children: titleChildren
                                },
                                { type: "hstack", spacing: 8, children: metadata }
                            ]
                        }
                    ],
                    selected: state.selectedFeed === item.feed.url
                        && state.selectedArticle === item.index,
                    onSelect: {
                        action: "select-article",
                        feed: item.feed.url,
                        index: item.index
                    }
                };
                if (visibleIndex === visibleArticleRows.length - 1
                        && visibleArticleRows.length < articleRows.length) {
                    row.onAppear = {
                        action: "load-more-articles",
                        visibleCount: visibleArticleRows.length
                    };
                }
                return row;
            })
        });
    }

    return {
        type: "vstack", spacing: 10, children: [
            {
                type: "hstack", spacing: 8, children: [
                    { type: "spacer" },
                    {
                        type: "button", title: "刷新", systemImage: "arrow.clockwise",
                        style: "plain",
                        enabled: state.feeds.length > 0,
                        onPress: { action: "refresh-all" }
                    },
                    {
                        type: "button", title: "订阅源设置",
                        systemImage: "gearshape", style: "plain",
                        onPress: { action: "open-settings" }
                    }
                ]
            },
            {
                type: "splitview",
                leadingWidth: 300,
                leading: { type: "vstack", spacing: 12, children: leadingChildren },
                trailing: articleDetailLayoutTree()
            }
        ]
    };
}

// 未选择文章时只渲染一个可伸展的正文空状态，不能让正文与大纲按固有
// 宽度缩成两条窄栏。选中文章后，再把折叠大纲作为正文右侧的浮动工具。
function articleDetailLayoutTree() {
    var articles = state.articles[state.selectedFeed] || [];
    var article = articles[state.selectedArticle];
    if (!article) {
        return {
            type: "hstack", spacing: 0,
            children: [articleTree(), { type: "spacer" }]
        };
    }
    return articleTree();
}

// 文章详情始终放在右栏，选择列表项只更新本栏，不再离开文章列表。
function articleTree() {
    var articles = state.articles[state.selectedFeed] || [];
    var article = articles[state.selectedArticle];
    if (!article) {
        state.selectedArticle = -1;
        return {
            type: "vstack", spacing: 6, children: [
                text("选择一篇文章", "headline", "secondary"),
                text("文章内容会显示在这里。", "caption", "secondary")
            ]
        };
    }
    var feed = findFeed(state.selectedFeed);
    var metadata = [];
    if (feed) {
        metadata.push(text(feed.title, "caption", "secondary"));
    }
    if (article.date) {
        if (metadata.length > 0) { metadata.push({ type: "spacer", length: 8 }); }
        metadata.push(text(article.date, "caption", "secondary"));
    }
    var children = [text(article.title, "headline")];
    if (metadata.length > 0) {
        children.push({ type: "hstack", spacing: 4, children: metadata });
    }
    if (isSummaryOnly(article) && article.fullArticleRequested) {
        children.push(text("正在后台加载全文…", "caption", "secondary"));
    }
    children.push({ type: "divider" });
    var presentation = articlePresentation(article);
    children.push({
        type: "webcontent",
        html: presentation.html
    });
    return { type: "vstack", spacing: 8, children: children };
}

function tree() {
    var children = [mainTree()];
    if (state.managingSources) {
        children.push({
            type: "dialog",
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
    return fetchFeed(url, "").then(function (parsed) {
        state.feeds.push({
            url: url,
            title: parsed.title || url,
            siteURL: parsed.siteURL || "",
            iconURL: parsed.iconURL || ""
        });
        state.articles[url] = parsed.items;
        state.selectedFeed = url;
        state.selectedArticle = -1;
        state.message = null;
        return saveFeeds();
    }).catch(function (error) {
        state.message = "添加失败：" + errorMessage(error);
    });
}

function parseOPML(xml) {
    var urls = [];
    var seen = {};
    var outlines = /<outline\b[^>]*>/gi;
    var match;
    while ((match = outlines.exec(String(xml || "")))) {
        var url = attrOf(match[0], "xmlUrl").trim();
        if (!/^https?:\/\/[^\s]+$/i.test(url) || seen[url]) { continue; }
        seen[url] = true;
        urls.push(url);
    }
    return urls;
}

function importOPMLFeeds(urls) {
    var existing = {};
    state.feeds.forEach(function (feed) { existing[feed.url] = true; });
    var imported = 0;
    var skipped = 0;
    var chain = Promise.resolve();
    urls.forEach(function (url) {
        chain = chain.then(function () {
            if (existing[url]) {
                skipped += 1;
                return;
            }
            return fetchFeed(url, "").then(function (parsed) {
                existing[url] = true;
                state.feeds.push({
                    url: url,
                    title: parsed.title || url,
                    siteURL: parsed.siteURL || "",
                    iconURL: parsed.iconURL || ""
                });
                state.articles[url] = parsed.items;
                imported += 1;
            }, function () {
                skipped += 1;
            });
        });
    });
    return chain.then(function () {
        return saveFeeds();
    }).then(function () {
        return { imported: imported, skipped: skipped };
    });
}

function chooseAndImportOPML() {
    if (state.importingOPML) { return Promise.resolve(); }
    if (!breath.dialogs || typeof breath.dialogs.openTextFile !== "function") {
        state.message = "当前 Breath 版本不支持 OPML 文件选择。";
        return Promise.resolve();
    }
    return breath.dialogs.openTextFile({
        title: "导入 OPML",
        allowedExtensions: ["opml", "xml"]
    }).then(function (file) {
        if (!file) { return; }
        var urls = parseOPML(file.contents);
        if (urls.length === 0) {
            state.message = "这个 OPML 文件里没有有效的订阅地址。";
            return;
        }
        state.importingOPML = true;
        state.message = "正在导入 " + urls.length + " 个订阅源…";
        importOPMLFeeds(urls).then(function (result) {
            state.importingOPML = false;
            state.message = "已导入 " + result.imported + " 个订阅源"
                + (result.skipped > 0 ? "，跳过 " + result.skipped + " 个。" : "。");
            return breath.ui.invalidate("main");
        }).catch(function (error) {
            state.importingOPML = false;
            state.message = "OPML 导入失败：" + errorMessage(error);
            return breath.ui.invalidate("main");
        });
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
    var existingFeed = findFeed(url);
    return fetchFeed(url, existingFeed ? existingFeed.iconURL : "").then(function (parsed) {
        state.articles[url] = parsed.items;
        var feed = findFeed(url);
        if (feed && parsed.title) {
            feed.title = parsed.title;
            feed.siteURL = parsed.siteURL || feed.siteURL || "";
            feed.iconURL = parsed.iconURL || feed.iconURL || "";
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
            return fetchFeed(feed.url, feed.iconURL).then(function (parsed) {
                feed.title = parsed.title || feed.title;
                feed.siteURL = parsed.siteURL || feed.siteURL || "";
                feed.iconURL = parsed.iconURL || feed.iconURL || "";
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
    } else if (action === "import-opml") {
        work = chooseAndImportOPML();
    } else if (action === "open-settings") {
        state.managingSources = true;
        state.visibleSourceCount = SOURCE_BATCH_SIZE;
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
        var selectedArticles = state.articles[state.selectedFeed] || [];
        var selectedArticle = selectedArticles[state.selectedArticle];
        if (selectedArticle) {
            state.readArticleIDs[articleID(selectedArticle)] = true;
            loadFullArticleInBackground(selectedArticle);
        }
        work = selectedArticle ? saveReadState() : Promise.resolve();
    } else if (action === "set-filter"
               && (payload.value === "all"
                   || payload.value === "unread"
                   || payload.value === "read")) {
        state.articleFilter = payload.value;
        state.visibleArticleCount = ARTICLE_BATCH_SIZE;
        work = Promise.resolve();
    } else if (action === "load-more-articles"
               && typeof payload.visibleCount === "number") {
        if (payload.visibleCount === state.visibleArticleCount) {
            state.visibleArticleCount += ARTICLE_BATCH_SIZE;
        }
        work = Promise.resolve();
    } else if (action === "load-more-sources"
               && typeof payload.visibleCount === "number") {
        if (payload.visibleCount === state.visibleSourceCount) {
            state.visibleSourceCount += SOURCE_BATCH_SIZE;
        }
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
        return ensureArticlesLoaded().then(function () { return tree(); });
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
