(function () {
  'use strict';

  var DEFAULT_ENDPOINT = 'ws://127.0.0.1:41921';
  var streamDockSocket = null;
  var pluginUuid = null;
  var helperSocket = null;
  var reconnectTimer = null;
  var reconnectDelay = 2000;
  var DEFAULT_ACTION_SETTINGS = {
    filter: '',
    senderFilter: '',
    senderMatchMode: 'contains',
    privacyMode: '',
    previewSeconds: 0,
    visualAlert: true,
    alertSeconds: 8,
    imageBackground: '',
    imageFreshBackground: '',
    imageForeground: '',
    imageLabel: '',
    imageSub: '',
    titlePrefix: '',
    regexFilter: '',
    muteFilter: '',
    quietStart: '',
    quietEnd: '',
    autoReadSeconds: 0,
    rulePresetsJson: '',
    rulePresetName: ''
  };
  var globalSettings = { endpoint: DEFAULT_ENDPOINT, appName: 'Discord', maxBodyChars: 48, historyLimit: 10, historyStoreLimit: 50, historyFile: '', filter: '', senderFilter: '', senderMatchMode: 'contains', privacyMode: 'preview', persistHistory: false, encryptHistory: true, previewSeconds: 0 };
  var contexts = {};
  var state = { connected: false, permission: 'unknown', sender: '', body: '', history: [], index: 0, unread: {} };

  function parseJson(value, fallback) {
    try {
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (error) {
      return fallback;
    }
  }

  function sendToStreamDock(message) {
    if (streamDockSocket && streamDockSocket.readyState === WebSocket.OPEN) {
      streamDockSocket.send(JSON.stringify(message));
    }
  }

  function setTitle(context, title) {
    sendToStreamDock({
      event: 'setTitle',
      context: context,
      payload: { title: title }
    });
  }

  function setImage(context, image) {
    sendToStreamDock({ event: 'setImage', context: context, payload: { image: image } });
  }

  function showAlert(context) {
    sendToStreamDock({ event: 'showAlert', context: context });
  }

  function logMessage(message) {
    sendToStreamDock({ event: 'logMessage', payload: { message: '[streamdock-discord] ' + message } });
  }

  function truncate(value, max) {
    value = String(value || '').replace(/\s+/g, ' ').trim();
    if (value.length <= max) {
      return value;
    }
    return value.slice(0, Math.max(0, max - 1)) + '…';
  }

  function titleText(context) {
    var ctx = contexts[context] || {};
    var action = ctx.action;
    var settings = settingsFor(context);
    var history = historyFor(context);
    var index = Math.max(0, Math.min(history.length - 1, ctx.index || 0));
    if (!state.connected) {
      return 'Discord\noffline';
    }
    if (action === 'local.streamdock.discord.diagnostics') {
      return 'Discord\n' + state.permission + '\n' + state.history.length + ' items';
    }
    if (action === 'local.streamdock.discord.clear') {
      return 'Clear\n' + history.length;
    }
    if (state.permission === 'denied') {
      return 'Allow\nnotifications';
    }
    if (state.preview === false) {
      return state.sender ? state.sender + '\npreview off' : 'Preview\noff';
    }
    var item = history[index] || { sender: state.sender, body: state.body };
    if (action === 'local.streamdock.discord.sender' && settings.senderFilter && !item.sender && !item.body) {
      return truncate(settings.senderFilter, 20) + '\nwaiting';
    }
    var privacyMode = effectivePrivacyMode(context, item);
    if (privacyMode === 'count') {
      return titlePrefix(settings) + (settings.senderFilter || globalSettings.appName || 'Notify') + '\n' + unreadFor(context) + ' new';
    }
    if (item.sender || item.body) {
      if (privacyMode === 'sender') {
        return titlePrefix(settings) + truncate(item.sender || 'Discord', 20) + '\nDM';
      }
      return titlePrefix(settings) + truncate(item.sender || 'Discord', 20) + '\n' + truncate(item.body || 'New DM', Number(globalSettings.maxBodyChars) || 48);
    }
    return titlePrefix(settings) + (globalSettings.appName || 'Notify') + '\nwaiting';
  }

  function titlePrefix(settings) {
    return settings.titlePrefix ? truncate(settings.titlePrefix, 12) + ' ' : '';
  }

  function settingsFor(context) {
    var actionSettings = Object.assign({}, DEFAULT_ACTION_SETTINGS, contexts[context] && contexts[context].settings || {});
    return Object.assign({}, globalSettings, actionSettings, {
      privacyMode: actionSettings.privacyMode || globalSettings.privacyMode || 'preview'
    });
  }

  function effectivePrivacyMode(context, item) {
    var settings = settingsFor(context);
    var previewSeconds = Number(settings.previewSeconds) || 0;
    if (previewSeconds > 0 && item && item.time && Date.now() - Number(item.time) <= previewSeconds * 1000) {
      return 'preview';
    }
    return settings.privacyMode || 'preview';
  }

  function unreadKey(settings) {
    return [settings.appName || 'Discord', settings.senderMatchMode || 'contains', settings.senderFilter || '', settings.filter || ''].join('\u001f');
  }

  function unreadFor(context) {
    return state.unread[unreadKey(settingsFor(context))] || 0;
  }

  function setUnread(context, value) {
    var key = unreadKey(settingsFor(context));
    state.unread[key] = Math.max(0, Number(value) || 0);
    var keys = Object.keys(state.unread);
    if (keys.length > 200) {
      var toDelete = keys.slice(0, keys.length - 200);
      toDelete.forEach(function (k) { delete state.unread[k]; });
    }
  }

  function historyFor(context) {
    var settings = settingsFor(context);
    return state.history.filter(function (item) {
      return matchesFilters(item, settings);
    }).slice(0, Number(globalSettings.historyLimit) || 10);
  }

  function matchesFilters(item, settings) {
    settings = settings || globalSettings;
    var haystack = ((item.sender || '') + ' ' + (item.body || '')).toLowerCase();
    var filter = String(settings.filter || '').toLowerCase();
    var senderFilter = String(settings.senderFilter || '').toLowerCase();
    var sender = String(item.sender || '').toLowerCase();
    var senderMatched = !senderFilter || (settings.senderMatchMode === 'exact' ? sender === senderFilter : sender.indexOf(senderFilter) !== -1);
    var muteFilter = String(settings.muteFilter || '').toLowerCase();
    if (muteFilter && haystack.indexOf(muteFilter) !== -1) {
      return false;
    }
    var regexMatched = true;
    if (settings.regexFilter) {
      try {
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
        regexMatched = safeRegexPattern(settings.regexFilter) && new RegExp(String(settings.regexFilter), 'i').test((item.sender || '') + '\n' + (item.body || ''));
      } catch (error) {
        regexMatched = false;
      }
    }
    return (!filter || haystack.indexOf(filter) !== -1) &&
      regexMatched &&
      senderMatched;
  }

  function safeRegexPattern(pattern) {
    var text = String(pattern || '');
    if (!text || text.length > 64) {
      return false;
    }
    if (/(\([^)]*[+*][^)]*\)|\[[^\]]+\])[+*{]/.test(text)) return false;
    if (/([+*{][^)]*){2,}/.test(text)) return false;
    if (/\([^)]+\|[^)]+\)[+*{?]/.test(text)) return false;
    if (/\([^)]*\.[*+][^)]*\)[+*{]/.test(text)) return false;
    return true;
  }

  function refreshTitles() {
    Object.keys(contexts).forEach(function (context) {
      setTitle(context, titleText(context));
      setImage(context, imageFor(context));
    });
  }

  function imageFor(context) {
    var ctx = contexts[context] || {};
    var settings = settingsFor(context);
    var unread = unreadFor(context);
    var freshMs = (Number(settings.alertSeconds) || 8) * 1000;
    var isFresh = ctx.lastMatchTime && Date.now() - ctx.lastMatchTime <= freshMs;
    if (!state.connected) {
      return svgImage('#363b44', '#9aa4b2', 'OFF', '');
    }
    if (state.permission === 'denied') {
      return svgImage('#4a2f32', '#ff8a80', '!', 'PERM');
    }
    if (ctx.action === 'local.streamdock.discord.clear') {
      return svgImage(imageColor(settings, 'clearBackground', '#3b3b3b'), imageColor(settings, 'imageForeground', '#d5d5d5'), 'CLR', String(historyFor(context).length || ''));
    }
    if (settings.visualAlert !== false && unread > 0) {
      return svgImage(
        imageColor(settings, isFresh ? 'imageFreshBackground' : 'imageBackground', isFresh ? '#5865f2' : '#3f4cb8'),
        imageColor(settings, 'imageForeground', '#ffffff'),
        settings.imageLabel || String(Math.min(unread, 99)),
        settings.imageSub || 'NEW'
      );
    }
    return svgImage(
      imageColor(settings, 'imageBackground', '#2f3136'),
      imageColor(settings, 'imageForeground', '#b9bbbe'),
      settings.imageLabel || 'DM',
      settings.imageSub || (settings.senderFilter ? 'ONE' : 'ALL')
    );
  }

  function imageColor(settings, key, fallback) {
    var value = String(settings[key] || '').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function svgImage(background, foreground, main, sub) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">' +
      '<rect width="144" height="144" rx="22" fill="' + background + '"/>' +
      '<circle cx="72" cy="57" r="34" fill="' + foreground + '" opacity="0.18"/>' +
      '<text x="72" y="69" text-anchor="middle" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="' + foreground + '">' + escapeSvg(main) + '</text>' +
      '<text x="72" y="104" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="' + foreground + '" opacity="0.9">' + escapeSvg(sub || '') + '</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
  }

  function escapeSvg(value) {
    return String(value || '').replace(/[&<>"]/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
    });
  }

  function helperSend(payload) {
    if (helperSocket && helperSocket.readyState === WebSocket.OPEN) {
      helperSocket.send(JSON.stringify(payload));
      return true;
    }
    connectHelper();
    return false;
  }

  function connectHelper() {
    if (helperSocket && (helperSocket.readyState === WebSocket.OPEN || helperSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    clearTimeout(reconnectTimer);
    helperSocket = new WebSocket(globalSettings.endpoint || DEFAULT_ENDPOINT);

    helperSocket.onopen = function () {
      state.connected = true;
      reconnectDelay = 2000;
      refreshTitles();
      configureHelper();
      helperSend({ command: 'subscribe', app: globalSettings.appName || 'Discord', persist: globalSettings.persistHistory === true });
    };

    helperSocket.onmessage = function (event) {
      var message = parseJson(event.data, {});
      if (message.event === 'permission') {
        state.permission = message.status || 'unknown';
      }
      if (message.event === 'notification') {
        if (message.app && globalSettings.appName && String(message.app).toLowerCase().indexOf(String(globalSettings.appName).toLowerCase()) === -1) {
          return;
        }
        state.permission = 'granted';
        var item = { sender: message.sender || message.title || '', body: message.body || message.text || '', time: message.time || Date.now() };
        state.history.unshift(item);
        state.history = state.history.slice(0, Math.max(1, Math.max(Number(globalSettings.historyStoreLimit) || 50, Number(globalSettings.historyLimit) || 10)));
        Object.keys(contexts).forEach(function (context) {
          if (matchesFilters(item, settingsFor(context))) {
            contexts[context].index = 0;
            contexts[context].lastMatchTime = Date.now();
            if (!quietNow(settingsFor(context))) {
              setUnread(context, unreadFor(context) + 1);
              scheduleVisualRefresh(context);
              scheduleAutoRead(context);
            }
          }
        });
        state.sender = item.sender;
        state.body = item.body;
        state.preview = message.preview !== false;
      }
      if (message.event === 'history') {
        state.history = (message.items || []).slice(0, Math.max(1, Math.max(Number(globalSettings.historyStoreLimit) || 50, Number(globalSettings.historyLimit) || 10)));
        Object.keys(contexts).forEach(function (context) {
          contexts[context].index = 0;
        });
      }
      if (message.event === 'preview_unavailable') {
        state.preview = false;
        state.sender = message.sender || state.sender || '';
        state.body = '';
      }
      refreshTitles();
    };

    helperSocket.onclose = function () {
      state.connected = false;
      logMessage('helper connection closed');
      refreshTitles();
      clearTimeout(reconnectTimer);
      var delay = reconnectDelay;
      reconnectDelay = Math.min(30000, reconnectDelay * 2);
      reconnectTimer = setTimeout(connectHelper, delay);
    };

    helperSocket.onerror = function () {
      state.connected = false;
      logMessage('helper connection error');
      refreshTitles();
    };
  }

  function rememberContext(message) {
    if (message.context) {
      var previous = contexts[message.context] || {};
      contexts[message.context] = {
        action: message.action || previous.action,
        settings: Object.assign({}, DEFAULT_ACTION_SETTINGS, previous.settings || {}, message.payload && message.payload.settings || {}),
        index: previous.index || 0
      };
      setTitle(message.context, titleText(message.context));
    }
  }

  function handleMessage(event) {
    var message = parseJson(event.data, {});
    if (message.event === 'willAppear') {
      rememberContext(message);
    } else if (message.event === 'willDisappear') {
      if (contexts[message.context] && contexts[message.context].visualTimer) {
        clearTimeout(contexts[message.context].visualTimer);
      }
      if (contexts[message.context] && contexts[message.context].autoReadTimer) {
        clearTimeout(contexts[message.context].autoReadTimer);
      }
      delete contexts[message.context];
    } else if (message.event === 'keyDown') {
      var action = message.action || contexts[message.context] && contexts[message.context].action;
      if (action === 'local.streamdock.discord.clear') {
        var clearHistory = historyFor(message.context);
        if (clearHistory.length) {
          var clearSet = {};
          clearHistory.forEach(function (item) {
            clearSet[String(item.time) + '\u001f' + item.sender] = true;
          });
          state.history = state.history.filter(function (item) {
            return !clearSet[String(item.time) + '\u001f' + item.sender];
          });
        } else {
          state.history = [];
        }
        state.sender = '';
        state.body = '';
        setUnread(message.context, 0);
        if (settingsFor(message.context).senderFilter || settingsFor(message.context).filter) {
          helperSend({ command: 'mark_read', app: globalSettings.appName || 'Discord', sender: settingsFor(message.context).senderFilter, senderMatchMode: settingsFor(message.context).senderMatchMode, limit: Number(globalSettings.historyLimit) || 10 });
        } else {
          helperSend({ command: 'clear', app: globalSettings.appName || 'Discord' });
        }
        refreshTitles();
      } else if (!helperSend({ command: 'latest', app: globalSettings.appName || 'Discord' })) {
        showAlert(message.context);
      } else {
        setUnread(message.context, 0);
      }
    } else if (message.event === 'dialRotate') {
      var ticks = Number(message.payload && (message.payload.ticks || message.payload.delta || message.payload.rotation)) || 0;
      var filtered = historyFor(message.context);
      if (filtered.length > 0 && ticks !== 0) {
        contexts[message.context].index = Math.max(0, Math.min(filtered.length - 1, (contexts[message.context].index || 0) + (ticks > 0 ? 1 : -1)));
        refreshTitles();
      }
    } else if (message.event === 'didReceiveGlobalSettings') {
      globalSettings = Object.assign({}, globalSettings, message.payload && message.payload.settings || {});
      connectHelper();
      configureHelper();
      helperSend({ command: 'history', app: globalSettings.appName || 'Discord', limit: Number(globalSettings.historyLimit) || 10 });
    } else if (message.event === 'didReceiveSettings') {
      rememberContext(message);
    }
  }

  function configureHelper() {
    helperSend({
      command: 'configure',
      historyFile: globalSettings.historyFile || '',
      maxHistory: Number(globalSettings.historyStoreLimit) || 50,
      persistHistory: globalSettings.persistHistory === true || globalSettings.persistHistory === 'true',
      encryptHistory: globalSettings.encryptHistory !== false && globalSettings.encryptHistory !== 'false'
    });
  }

  function scheduleVisualRefresh(context) {
    var settings = settingsFor(context);
    var delay = Math.max(1, Number(settings.alertSeconds) || 8) * 1000;
    clearTimeout(contexts[context] && contexts[context].visualTimer);
    if (contexts[context]) {
      contexts[context].visualTimer = setTimeout(function () {
        if (contexts[context]) {
          setImage(context, imageFor(context));
        }
      }, delay + 100);
    }
  }

  function quietNow(settings) {
    if (!settings.quietStart || !settings.quietEnd) {
      return false;
    }
    var start = minutesOfDay(settings.quietStart);
    var end = minutesOfDay(settings.quietEnd);
    if (start < 0 || end < 0 || start === end) {
      return false;
    }
    var now = new Date();
    var current = now.getHours() * 60 + now.getMinutes();
    return start < end ? current >= start && current < end : current >= start || current < end;
  }

  function minutesOfDay(value) {
    var match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return -1;
    var hours = Number(match[1]);
    var minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return -1;
    return hours * 60 + minutes;
  }

  function scheduleAutoRead(context) {
    var seconds = Number(settingsFor(context).autoReadSeconds) || 0;
    if (seconds <= 0 || !contexts[context]) {
      return;
    }
    clearTimeout(contexts[context].autoReadTimer);
    contexts[context].autoReadTimer = setTimeout(function () {
      if (contexts[context]) {
        setUnread(context, 0);
        refreshTitles();
      }
    }, seconds * 1000);
  }

  window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent) {
    pluginUuid = uuid;
    streamDockSocket = new WebSocket('ws://127.0.0.1:' + port);
    streamDockSocket.onopen = function () {
      sendToStreamDock({ event: registerEvent, uuid: pluginUuid });
      sendToStreamDock({ event: 'getGlobalSettings', context: pluginUuid });
      connectHelper();
    };
    streamDockSocket.onmessage = handleMessage;
  };
}());
