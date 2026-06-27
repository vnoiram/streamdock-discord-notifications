(function () {
  'use strict';

  var websocket = null;
  var context = null;
  var globalSettings = { endpoint: 'ws://127.0.0.1:41921', appName: 'Discord', maxBodyChars: 48, historyLimit: 10, historyStoreLimit: 50, historyFile: '', persistHistory: false, encryptHistory: true };
  var actionSettings = { filter: '', senderFilter: '', senderMatchMode: 'contains', privacyMode: '', previewSeconds: 0, visualAlert: true, alertSeconds: 8, imageBackground: '', imageFreshBackground: '', imageForeground: '', imageLabel: '', imageSub: '', titlePrefix: '', regexFilter: '', muteFilter: '', quietStart: '', quietEnd: '', autoReadSeconds: 0 };
  var helperSocket = null;

  function update() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN || !context) {
      return;
    }
    readForm();
    websocket.send(JSON.stringify({ event: 'setGlobalSettings', context: context, payload: globalSettings }));
    websocket.send(JSON.stringify({ event: 'setSettings', context: context, payload: actionSettings }));
    renderEndpointStatus();
  }

  function readForm() {
    globalSettings.endpoint = document.getElementById('endpoint').value.trim();
    globalSettings.appName = document.getElementById('appName').value.trim() || 'Discord';
    globalSettings.maxBodyChars = Number(document.getElementById('maxBodyChars').value) || 48;
    globalSettings.historyLimit = Number(document.getElementById('historyLimit').value) || 10;
    globalSettings.historyStoreLimit = Number(document.getElementById('historyStoreLimit').value) || 50;
    globalSettings.historyFile = document.getElementById('historyFile').value.trim();
    globalSettings.persistHistory = document.getElementById('persistHistory').checked;
    globalSettings.encryptHistory = document.getElementById('encryptHistory').checked;
    actionSettings.filter = document.getElementById('filter').value.trim();
    actionSettings.regexFilter = document.getElementById('regexFilter').value.trim();
    actionSettings.muteFilter = document.getElementById('muteFilter').value.trim();
    actionSettings.senderFilter = document.getElementById('senderFilter').value.trim();
    actionSettings.senderMatchMode = document.getElementById('senderMatchMode').value;
    actionSettings.privacyMode = document.getElementById('privacyMode').value;
    actionSettings.previewSeconds = Number(document.getElementById('previewSeconds').value) || 0;
    actionSettings.visualAlert = document.getElementById('visualAlert').checked;
    actionSettings.alertSeconds = Number(document.getElementById('alertSeconds').value) || 8;
    actionSettings.imageBackground = document.getElementById('imageBackground').value;
    actionSettings.imageFreshBackground = document.getElementById('imageFreshBackground').value;
    actionSettings.imageForeground = document.getElementById('imageForeground').value;
    actionSettings.imageLabel = document.getElementById('imageLabel').value.trim();
    actionSettings.imageSub = document.getElementById('imageSub').value.trim();
    actionSettings.titlePrefix = document.getElementById('titlePrefix').value.trim();
    actionSettings.quietStart = document.getElementById('quietStart').value.trim();
    actionSettings.quietEnd = document.getElementById('quietEnd').value.trim();
    actionSettings.autoReadSeconds = Number(document.getElementById('autoReadSeconds').value) || 0;
  }

  function applyGlobalSettings(next) {
    globalSettings = Object.assign({}, globalSettings, next || {});
    document.getElementById('endpoint').value = globalSettings.endpoint;
    document.getElementById('appName').value = globalSettings.appName || 'Discord';
    document.getElementById('maxBodyChars').value = globalSettings.maxBodyChars;
    document.getElementById('historyLimit').value = globalSettings.historyLimit;
    document.getElementById('historyStoreLimit').value = globalSettings.historyStoreLimit || 50;
    document.getElementById('historyFile').value = globalSettings.historyFile || '';
    document.getElementById('persistHistory').checked = globalSettings.persistHistory === true || globalSettings.persistHistory === 'true';
    document.getElementById('encryptHistory').checked = globalSettings.encryptHistory !== false && globalSettings.encryptHistory !== 'false';
    renderEndpointStatus();
  }

  function applyActionSettings(next) {
    actionSettings = Object.assign({}, actionSettings, next || {});
    document.getElementById('filter').value = actionSettings.filter || '';
    document.getElementById('regexFilter').value = actionSettings.regexFilter || '';
    document.getElementById('muteFilter').value = actionSettings.muteFilter || '';
    document.getElementById('senderFilter').value = actionSettings.senderFilter || '';
    document.getElementById('senderMatchMode').value = actionSettings.senderMatchMode || 'contains';
    document.getElementById('privacyMode').value = actionSettings.privacyMode || '';
    document.getElementById('previewSeconds').value = actionSettings.previewSeconds || 0;
    document.getElementById('visualAlert').checked = actionSettings.visualAlert !== false && actionSettings.visualAlert !== 'false';
    document.getElementById('alertSeconds').value = actionSettings.alertSeconds || 8;
    document.getElementById('imageBackground').value = normalizeColor(actionSettings.imageBackground, '#3f4cb8');
    document.getElementById('imageFreshBackground').value = normalizeColor(actionSettings.imageFreshBackground, '#5865f2');
    document.getElementById('imageForeground').value = normalizeColor(actionSettings.imageForeground, '#ffffff');
    document.getElementById('imageLabel').value = actionSettings.imageLabel || '';
    document.getElementById('imageSub').value = actionSettings.imageSub || '';
    document.getElementById('titlePrefix').value = actionSettings.titlePrefix || '';
    document.getElementById('quietStart').value = actionSettings.quietStart || '';
    document.getElementById('quietEnd').value = actionSettings.quietEnd || '';
    document.getElementById('autoReadSeconds').value = actionSettings.autoReadSeconds || 0;
  }

  function normalizeColor(value, fallback) {
    value = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function exportSettings() {
    readForm();
    var blob = new Blob([JSON.stringify({ globalSettings: globalSettings, actionSettings: actionSettings }, null, 2)], { type: 'application/json' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'streamdock-discord-settings.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function importSettings(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var imported = JSON.parse(text);
      if (imported.globalSettings || imported.actionSettings) {
        applyGlobalSettings(imported.globalSettings);
        applyActionSettings(imported.actionSettings);
      } else {
        applyGlobalSettings(imported);
        applyActionSettings(imported);
      }
      update();
    });
  }

  function copySettings() {
    readForm();
    navigator.clipboard.writeText(JSON.stringify({ globalSettings: globalSettings, actionSettings: actionSettings }, null, 2)).then(function () {
      setStatus('settings copied');
    }).catch(function () {
      setStatus('copy failed');
    });
  }

  function pasteSettings() {
    navigator.clipboard.readText().then(function (text) {
      var imported = JSON.parse(text);
      if (imported.globalSettings || imported.actionSettings) {
        applyGlobalSettings(imported.globalSettings);
        applyActionSettings(imported.actionSettings);
      } else {
        applyGlobalSettings(imported);
        applyActionSettings(imported);
      }
      update();
      setStatus('settings pasted');
    }).catch(function () {
      setStatus('paste failed');
    });
  }

  function setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  function renderEndpointStatus() {
    var status = document.getElementById('endpointStatus');
    if (!status) return;
    var endpoint = document.getElementById('endpoint').value.trim();
    if (!endpoint) {
      status.textContent = 'missing helper endpoint';
      return;
    }
    if (!/^wss?:\/\//i.test(endpoint)) {
      status.textContent = 'invalid WebSocket endpoint';
      return;
    }
    status.textContent = isLoopbackEndpoint(endpoint) ? 'localhost helper' : 'remote helper: notifications may leave this PC';
  }

  function isLoopbackEndpoint(endpoint) {
    try {
      var url = new URL(endpoint);
      return ['localhost', '127.0.0.1', '::1', '[::1]'].indexOf(url.hostname) !== -1;
    } catch (error) {
      return false;
    }
  }

  function refreshSenders() {
    if (helperSocket && (helperSocket.readyState === WebSocket.OPEN || helperSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    update();
    setStatus('loading senders');
    helperSocket = new WebSocket(globalSettings.endpoint || 'ws://127.0.0.1:41921');
    helperSocket.onopen = function () {
      helperSocket.send(JSON.stringify({ command: 'senders', app: globalSettings.appName || 'Discord' }));
    };
    helperSocket.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.event === 'senders') {
        renderSenders(message.senders || []);
        setStatus((message.senders || []).length + ' senders');
        helperSocket.close();
      }
    };
    helperSocket.onerror = function () {
      setStatus('helper offline');
    };
    helperSocket.onclose = function () {
      helperSocket = null;
    };
  }

  function renderSenders(senders) {
    var list = document.getElementById('senders');
    list.innerHTML = '';
    senders.forEach(function (sender) {
      var option = document.createElement('option');
      option.value = sender;
      list.appendChild(option);
    });
  }

  function diagnoseSettings() {
    readForm();
    var issues = [];
    if (!globalSettings.endpoint) issues.push('missing endpoint');
    if (!/^wss?:\/\//i.test(globalSettings.endpoint)) issues.push('invalid endpoint');
    if (globalSettings.persistHistory && !globalSettings.encryptHistory) issues.push('history not encrypted');
    if (actionSettings.regexFilter && actionSettings.regexFilter.length > 128) issues.push('regex too long');
    setStatus(issues.join(', ') || 'diagnostics ok');
  }

  function resetSettings() {
    applyGlobalSettings({ endpoint: 'ws://127.0.0.1:41921', appName: 'Discord', maxBodyChars: 48, historyLimit: 10, historyStoreLimit: 50, historyFile: '', persistHistory: false, encryptHistory: true });
    applyActionSettings({ filter: '', senderFilter: '', senderMatchMode: 'contains', privacyMode: '', previewSeconds: 0, visualAlert: true, alertSeconds: 8, imageBackground: '', imageFreshBackground: '', imageForeground: '', imageLabel: '', imageSub: '', titlePrefix: '', regexFilter: '', muteFilter: '', quietStart: '', quietEnd: '', autoReadSeconds: 0 });
    update();
    setStatus('settings reset');
  }

  window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent) {
    context = uuid;
    websocket = new WebSocket('ws://127.0.0.1:' + port);
    websocket.onopen = function () {
      websocket.send(JSON.stringify({ event: registerEvent, uuid: uuid }));
      websocket.send(JSON.stringify({ event: 'getGlobalSettings', context: uuid }));
      websocket.send(JSON.stringify({ event: 'getSettings', context: context }));
    };
    websocket.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.event === 'didReceiveGlobalSettings') {
        applyGlobalSettings(message.payload && message.payload.settings);
      }
      if (message.event === 'didReceiveSettings') {
        applyActionSettings(message.payload && message.payload.settings);
      }
    };
  };

  window.addEventListener('DOMContentLoaded', function () {
    document.getElementById('endpoint').addEventListener('input', update);
    document.getElementById('appName').addEventListener('input', update);
    document.getElementById('maxBodyChars').addEventListener('input', update);
    document.getElementById('historyLimit').addEventListener('input', update);
    document.getElementById('historyStoreLimit').addEventListener('input', update);
    document.getElementById('historyFile').addEventListener('input', update);
    document.getElementById('filter').addEventListener('input', update);
    document.getElementById('regexFilter').addEventListener('input', update);
    document.getElementById('muteFilter').addEventListener('input', update);
    document.getElementById('senderFilter').addEventListener('input', update);
    document.getElementById('senderMatchMode').addEventListener('change', update);
    document.getElementById('privacyMode').addEventListener('change', update);
    document.getElementById('visualAlert').addEventListener('change', update);
    document.getElementById('alertSeconds').addEventListener('input', update);
    document.getElementById('imageBackground').addEventListener('input', update);
    document.getElementById('imageFreshBackground').addEventListener('input', update);
    document.getElementById('imageForeground').addEventListener('input', update);
    document.getElementById('imageLabel').addEventListener('input', update);
    document.getElementById('imageSub').addEventListener('input', update);
    document.getElementById('titlePrefix').addEventListener('input', update);
    document.getElementById('quietStart').addEventListener('input', update);
    document.getElementById('quietEnd').addEventListener('input', update);
    document.getElementById('autoReadSeconds').addEventListener('input', update);
    document.getElementById('persistHistory').addEventListener('change', update);
    document.getElementById('encryptHistory').addEventListener('change', update);
    document.getElementById('refreshSenders').addEventListener('click', refreshSenders);
    document.getElementById('copySettings').addEventListener('click', copySettings);
    document.getElementById('diagnoseSettings').addEventListener('click', diagnoseSettings);
    document.getElementById('resetSettings').addEventListener('click', resetSettings);
    document.getElementById('pasteSettings').addEventListener('click', pasteSettings);
    document.getElementById('exportSettings').addEventListener('click', exportSettings);
    document.getElementById('importSettings').addEventListener('change', importSettings);
    renderEndpointStatus();
  });
}());
