(function () {
  'use strict';

  var websocket = null;
  var context = null;
  var settings = { endpoint: 'ws://127.0.0.1:41921', appName: 'Discord', maxBodyChars: 48, historyLimit: 10, filter: '', senderFilter: '', senderMatchMode: 'contains', privacyMode: 'preview', persistHistory: true };
  var helperSocket = null;

  function update() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN || !context) {
      return;
    }
    settings.endpoint = document.getElementById('endpoint').value.trim();
    settings.appName = document.getElementById('appName').value.trim() || 'Discord';
    settings.maxBodyChars = Number(document.getElementById('maxBodyChars').value) || 48;
    settings.historyLimit = Number(document.getElementById('historyLimit').value) || 10;
    settings.filter = document.getElementById('filter').value.trim();
    settings.senderFilter = document.getElementById('senderFilter').value.trim();
    settings.senderMatchMode = document.getElementById('senderMatchMode').value;
    settings.privacyMode = document.getElementById('privacyMode').value;
    settings.persistHistory = document.getElementById('persistHistory').checked;
    websocket.send(JSON.stringify({ event: 'setGlobalSettings', context: context, payload: settings }));
  }

  function applySettings(next) {
    settings = Object.assign({}, settings, next || {});
    document.getElementById('endpoint').value = settings.endpoint;
    document.getElementById('appName').value = settings.appName || 'Discord';
    document.getElementById('maxBodyChars').value = settings.maxBodyChars;
    document.getElementById('historyLimit').value = settings.historyLimit;
    document.getElementById('filter').value = settings.filter;
    document.getElementById('senderFilter').value = settings.senderFilter || '';
    document.getElementById('senderMatchMode').value = settings.senderMatchMode || 'contains';
    document.getElementById('privacyMode').value = settings.privacyMode;
    document.getElementById('persistHistory').checked = settings.persistHistory !== false && settings.persistHistory !== 'false';
  }

  function exportSettings() {
    var blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
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
      applySettings(JSON.parse(text));
      update();
    });
  }

  function setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  function refreshSenders() {
    if (helperSocket && (helperSocket.readyState === WebSocket.OPEN || helperSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    update();
    setStatus('loading senders');
    helperSocket = new WebSocket(settings.endpoint || 'ws://127.0.0.1:41921');
    helperSocket.onopen = function () {
      helperSocket.send(JSON.stringify({ command: 'senders', app: settings.appName || 'Discord' }));
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

  window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent) {
    context = uuid;
    websocket = new WebSocket('ws://127.0.0.1:' + port);
    websocket.onopen = function () {
      websocket.send(JSON.stringify({ event: registerEvent, uuid: uuid }));
      websocket.send(JSON.stringify({ event: 'getGlobalSettings', context: uuid }));
    };
    websocket.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.event === 'didReceiveGlobalSettings') {
        applySettings(message.payload && message.payload.settings);
      }
    };
  };

  window.addEventListener('DOMContentLoaded', function () {
    document.getElementById('endpoint').addEventListener('input', update);
    document.getElementById('appName').addEventListener('input', update);
    document.getElementById('maxBodyChars').addEventListener('input', update);
    document.getElementById('historyLimit').addEventListener('input', update);
    document.getElementById('filter').addEventListener('input', update);
    document.getElementById('senderFilter').addEventListener('input', update);
    document.getElementById('senderMatchMode').addEventListener('change', update);
    document.getElementById('privacyMode').addEventListener('change', update);
    document.getElementById('persistHistory').addEventListener('change', update);
    document.getElementById('refreshSenders').addEventListener('click', refreshSenders);
    document.getElementById('exportSettings').addEventListener('click', exportSettings);
    document.getElementById('importSettings').addEventListener('change', importSettings);
  });
}());
