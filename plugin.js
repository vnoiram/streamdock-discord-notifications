(function () {
  'use strict';

  var DEFAULT_ENDPOINT = 'ws://127.0.0.1:41921';
  var streamDockSocket = null;
  var pluginUuid = null;
  var helperSocket = null;
  var reconnectTimer = null;
  var globalSettings = { endpoint: DEFAULT_ENDPOINT, maxBodyChars: 48, historyLimit: 10, filter: '', privacyMode: 'preview' };
  var contexts = {};
  var state = { connected: false, permission: 'unknown', sender: '', body: '', history: [], index: 0 };

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
    var action = contexts[context] && contexts[context].action;
    if (!state.connected) {
      return 'Discord\noffline';
    }
    if (action === 'local.streamdock.discord.diagnostics') {
      return 'Discord\n' + state.permission + '\n' + state.history.length + ' items';
    }
    if (action === 'local.streamdock.discord.clear') {
      return 'Clear\n' + state.history.length;
    }
    if (state.permission === 'denied') {
      return 'Allow\nnotifications';
    }
    if (state.preview === false) {
      return state.sender ? state.sender + '\npreview off' : 'Preview\noff';
    }
    var item = state.history[state.index] || { sender: state.sender, body: state.body };
    if (globalSettings.privacyMode === 'count') {
      return 'Discord\n' + state.history.length + ' new';
    }
    if (item.sender || item.body) {
      if (globalSettings.privacyMode === 'sender') {
        return truncate(item.sender || 'Discord', 20) + '\nDM';
      }
      return truncate(item.sender || 'Discord', 20) + '\n' + truncate(item.body || 'New DM', Number(globalSettings.maxBodyChars) || 48);
    }
    return 'Discord\nwaiting';
  }

  function refreshTitles() {
    Object.keys(contexts).forEach(function (context) {
      setTitle(context, titleText(context));
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
      refreshTitles();
      helperSend({ command: 'subscribe', app: 'Discord' });
    };

    helperSocket.onmessage = function (event) {
      var message = parseJson(event.data, {});
      if (message.event === 'permission') {
        state.permission = message.status || 'unknown';
      }
      if (message.event === 'notification') {
        state.permission = 'granted';
        var item = { sender: message.sender || message.title || '', body: message.body || message.text || '', time: message.time || Date.now() };
        if (!globalSettings.filter || (item.sender + ' ' + item.body).toLowerCase().indexOf(globalSettings.filter.toLowerCase()) !== -1) {
          state.history.unshift(item);
          state.history = state.history.slice(0, Number(globalSettings.historyLimit) || 10);
          state.index = 0;
        }
        state.sender = item.sender;
        state.body = item.body;
        state.preview = message.preview !== false;
      }
      if (message.event === 'history') {
        state.history = (message.items || []).filter(function (item) {
          return !globalSettings.filter || ((item.sender || '') + ' ' + (item.body || '')).toLowerCase().indexOf(globalSettings.filter.toLowerCase()) !== -1;
        }).slice(0, Number(globalSettings.historyLimit) || 10);
        state.index = 0;
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
      reconnectTimer = setTimeout(connectHelper, 2000);
    };

    helperSocket.onerror = function () {
      state.connected = false;
      logMessage('helper connection error');
      refreshTitles();
    };
  }

  function rememberContext(message) {
    if (message.context) {
      contexts[message.context] = { action: message.action };
      setTitle(message.context, titleText(message.context));
    }
  }

  function handleMessage(event) {
    var message = parseJson(event.data, {});
    if (message.event === 'willAppear') {
      rememberContext(message);
    } else if (message.event === 'willDisappear') {
      delete contexts[message.context];
    } else if (message.event === 'keyDown') {
      if (message.action === 'local.streamdock.discord.clear') {
        state.history = [];
        state.sender = '';
        state.body = '';
        helperSend({ command: 'clear', app: 'Discord' });
        refreshTitles();
      } else if (!helperSend({ command: 'latest', app: 'Discord' })) {
        showAlert(message.context);
      }
    } else if (message.event === 'dialRotate') {
      var ticks = Number(message.payload && (message.payload.ticks || message.payload.delta || message.payload.rotation)) || 0;
      if (state.history.length > 0 && ticks !== 0) {
        state.index = Math.max(0, Math.min(state.history.length - 1, state.index + (ticks > 0 ? 1 : -1)));
        refreshTitles();
      }
    } else if (message.event === 'didReceiveGlobalSettings') {
      globalSettings = Object.assign({}, globalSettings, message.payload && message.payload.settings || {});
      connectHelper();
      helperSend({ command: 'history', app: 'Discord', limit: Number(globalSettings.historyLimit) || 10 });
    }
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
