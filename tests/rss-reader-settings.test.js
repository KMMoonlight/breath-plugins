"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadRSSView(supportsDialog = true) {
    let renderHandler;
    let eventHandler;
    const breath = {
        ui: {
            supports(componentType) {
                return supportsDialog && componentType === "dialog";
            },
            invalidate() { return Promise.resolve(); },
            registerView(_contribution, registeredRenderHandler, registeredEventHandler) {
                renderHandler = registeredRenderHandler;
                eventHandler = registeredEventHandler;
            }
        },
        commands: { register() {} },
        storage: {
            get() { return Promise.resolve(null); },
            set() { return Promise.resolve(); },
            delete() { return Promise.resolve(); }
        },
        dialogs: {
            alert() { return Promise.resolve(); },
            confirm() { return Promise.resolve(false); },
            prompt() { return Promise.resolve(null); }
        },
        notifications: { post() { return Promise.resolve(); } },
        fetch(url) {
            if (url === "https://example.com/feed.xml") {
                return Promise.resolve({
                    status: 200,
                    body: "<rss><channel><title>示例</title>"
                        + "<item><title>未读文章</title><link>https://example.com/1</link>"
                        + "<description>正文</description></item></channel></rss>"
                });
            }
            return Promise.reject(new Error("unexpected fetch"));
        }
    };
    const source = fs.readFileSync(
        path.join(__dirname, "../plugins/rss-reader/main.js"),
        "utf8"
    );
    vm.runInNewContext(source, { breath, Promise }, { filename: "main.js" });
    return { renderHandler, eventHandler };
}

function componentsOfType(component, type) {
    if (!component || typeof component !== "object") { return []; }
    const matches = component.type === type ? [component] : [];
    const nested = [];
    if (Array.isArray(component.children)) { nested.push(...component.children); }
    ["content", "leading", "trailing"].forEach((key) => {
        if (component[key] && typeof component[key] === "object") {
            nested.push(component[key]);
        }
    });
    return matches.concat(...nested.map((child) => componentsOfType(child, type)));
}

test("RSS settings opens a dialog rather than a sheet", async () => {
    const view = loadRSSView();
    const tree = await view.eventHandler({
        type: "button.press",
        payload: { action: "open-settings" }
    });

    assert.equal(componentsOfType(tree, "sheet").length, 0);
    const dialogs = componentsOfType(tree, "dialog");
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].width, 480);
    assert.equal(dialogs[0].height, 360);
});

test("RSS settings never silently downgrades to sheet", async () => {
    const view = loadRSSView(false);
    const tree = await view.eventHandler({
        type: "button.press",
        payload: { action: "open-settings" }
    });

    assert.equal(componentsOfType(tree, "dialog").length, 1);
    assert.equal(componentsOfType(tree, "sheet").length, 0);
});

test("RSS toolbar uses a refresh icon and unread rows use a green dot", async () => {
    const view = loadRSSView();
    const tree = await view.eventHandler({
        type: "textfield.submit",
        payload: { action: "add-feed", text: "https://example.com/feed.xml" }
    });

    const refresh = componentsOfType(tree, "button").find((button) => (
        button.title === "刷新"
    ));
    assert.equal(refresh.systemImage, "arrow.clockwise");
    assert.equal(refresh.style, "plain");

    const unreadDot = componentsOfType(tree, "text").find((node) => (
        node.content === "●"
    ));
    assert.equal(unreadDot.color, "green");
});
