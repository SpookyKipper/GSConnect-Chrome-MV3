// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const browser = chrome;

const _ABOUT = /^chrome:|^about:/;
const _CONTEXTS = [
    'audio',
    'page',
    'frame',
    'link',
    'image',
    'video'
];

const _MUTE = [
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
];

const State = {
    connected: false,
    devices: [],
    port: null,
};

let reconnectDelay = 100;
let reconnectTimer = null;
let reconnectResetTimer = null;

// Error logging
function logError(error) {
    if (!_MUTE.includes(error.message))
        console.error(error.message);
}

// Toolbar icon activation
function toggleAction(tab = null) {
    try {
        if (_ABOUT.test(tab.url))
            browser.action.disable(tab.id);
        else
            browser.action.enable(tab.id);
    } catch {
        browser.action.disable();
    }   
}

// Send message to native-messaging-host
async function postMessage(message) {
    try {
        if (!State.port || !message || !message.type) {
            console.warn('Missing message parameters');
            return;
        }
        await State.port.postMessage(message);
    } catch (e) {
        logError(e);
    }
}

// Forward message from popup to NMH
async function onPopupMessage(message, sender) {
    try {
        if (sender.url && sender.url.includes('/popup.html'))
            await postMessage(message);
    } catch (e) {
        logError(e);
    }
}

// Forward message from NMH to popup
async function forwardPortMessage(message) {
    try {
        await browser.runtime.sendMessage(message);
    } catch (e) {
        logError(e);
    }
}

chrome.contextMenus.onClicked.addListener(onContextItem);
// Context menu item callback
async function onContextItem(info) {
    try {
        const [id, action] = info.menuItemId.split(':');
        await postMessage({
            type: 'share',
            data: {
                device: id,
                url: info.linkUrl || info.srcUrl || info.frameUrl || info.pageUrl,
                action: action,
            },
        });
    } catch (e) {
        logError(e);
    }
}

// Populate context menu
async function createContextMenu(tab) {
    try {
        await browser.contextMenus.removeAll();
        if (_ABOUT.test(tab.url) || State.devices.length === 0)
            return;

        if (State.devices.length > 1) {
            await browser.contextMenus.create({
                id: 'contextMenuMultipleDevices',
                title: browser.i18n.getMessage('contextMenuMultipleDevices'),
                contexts: _CONTEXTS,
            });
            for (const device of State.devices) {
                if (device.share && device.telephony) {
                    await browser.contextMenus.create({
                        id: device.id,
                        title: device.name,
                        parentId: 'contextMenuMultipleDevices',
                    });
                    await browser.contextMenus.create({
                        id: `${device.id}:share`,
                        title: browser.i18n.getMessage('shareMessage'),
                        parentId: device.id,
                        contexts: _CONTEXTS,
                        // onclick: onContextItem,
                    });
                    await browser.contextMenus.create({
                        id: `${device.id}:telephony`,
                        title: browser.i18n.getMessage('smsMessage'),
                        parentId: device.id,
                        contexts: _CONTEXTS,
                        // onclick: onContextItem,
                    });
                } else {
                    let pluginAction, pluginName;
                    if (device.share) {
                        pluginAction = 'share';
                        pluginName = browser.i18n.getMessage('shareMessage');
                    } else {
                        pluginAction = 'telephony';
                        pluginName = browser.i18n.getMessage('smsMessage');
                    }
                    await browser.contextMenus.create({
                        id: `${device.id}:${pluginAction}`,
                        title: browser.i18n.getMessage(
                            'contextMenuSinglePlugin',
                            [device.name, pluginName]
                        ),
                        parentId: 'contextMenuMultipleDevices',
                        contexts: _CONTEXTS,
                        // onclick: onContextItem,
                    });
                }
            }
        } else {
            const device = State.devices[0];
            if (device.share && device.telephony) {
                await browser.contextMenus.create({
                    id: device.id,
                    title: device.name,
                    contexts: _CONTEXTS,
                });
                await browser.contextMenus.create({
                    id: `${device.id}:share`,
                    title: browser.i18n.getMessage('shareMessage'),
                    parentId: device.id,
                    contexts: _CONTEXTS,
                    // onclick: onContextItem,
                });
                await browser.contextMenus.create({
                    id: `${device.id}:telephony`,
                    title: browser.i18n.getMessage('smsMessage'),
                    parentId: device.id,
                    contexts: _CONTEXTS,
                    // onclick: onContextItem,
                });
            } else {
                let pluginAction, pluginName;
                if (device.share) {
                    pluginAction = 'share';
                    pluginName = browser.i18n.getMessage('shareMessage');
                } else {
                    pluginAction = 'telephony';
                    pluginName = browser.i18n.getMessage('smsMessage');
                }
                await browser.contextMenus.create({
                    id: `${device.id}:${pluginAction}`,
                    title: browser.i18n.getMessage(
                        'contextMenuSinglePlugin',
                        [device.name, pluginName]
                    ),
                    contexts: _CONTEXTS,
                    // onclick: onContextItem,
                });
            }
        }
    } catch (e) {
        logError(e);
    }
}

// Message handling from NMH
async function onPortMessage(message) {
    try {
        if (message.type === 'connected') {
            State.connected = message.data;
            if (State.connected)
                postMessage({type: 'devices'});
            else
                State.devices = [];
        } else if (message.type === 'devices') {
            State.connected = true;
            State.devices = message.data;
        }
        forwardPortMessage(message);
        const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true,
        });
        createContextMenu(tabs[0]);
    } catch (e) {
        logError(e);
    }
}

// Disconnection callback
async function onDisconnect() {
    try {
        State.connected = false;
        State.port = null;
        browser.action.setBadgeText({text: '\u26D4'});
        browser.action.setBadgeBackgroundColor({color: [198, 40, 40, 255]});
        forwardPortMessage({type: 'connected', data: false});
        await browser.contextMenus.removeAll();
        if (typeof reconnectResetTimer === 'number') {
            clearTimeout(reconnectResetTimer);
            reconnectResetTimer = null;
        }
        if (typeof reconnectTimer === 'number') {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (browser.runtime.lastError) {
            const message = browser.runtime.lastError.message;
            console.warn(`Disconnected: ${message}`);
        }
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay *= 2;
    } catch (e) {
        logError(e);
    }
}

// Connect to native-messaging-host
async function connect() {
    try {
        State.port = browser.runtime.connectNative('org.gnome.shell.extensions.gsconnect');
        browser.action.setBadgeText({text: ''});
        browser.action.setBadgeBackgroundColor({color: [0, 0, 0, 0]});
        reconnectResetTimer = setTimeout(() => {
            reconnectDelay = 100;
        }, reconnectDelay * 0.9);
        State.port.onDisconnect.addListener(onDisconnect);
        State.port.onMessage.addListener(onPortMessage);
        await State.port.postMessage({type: 'devices'});
    } catch (e) {
        logError(e);
    }
}

// Register listeners (MV3: must be in service worker scope)
browser.runtime.onMessage.addListener(onPopupMessage);
browser.tabs.onActivated.addListener((info) => {
    browser.tabs.get(info.tabId).then(toggleAction);
    browser.tabs.get(info.tabId).then(createContextMenu);
});
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        toggleAction(tab);
        createContextMenu(tab);
    }
});

// Service worker startup
browser.runtime.onStartup.addListener(() => {
    toggleAction();
    connect();
});
browser.runtime.onInstalled.addListener(() => {
    toggleAction();
    connect();
});
