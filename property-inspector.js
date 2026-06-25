(function () {
  'use strict';

  var websocket = null;
  var context = null;
  var settings = { endpoint: 'ws://127.0.0.1:41921', maxBodyChars: 48, historyLimit: 10, filter: '', privacyMode: 'preview' };

  function update() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN || !context) {
      return;
    }
    settings.endpoint = document.getElementById('endpoint').value.trim();
    settings.maxBodyChars = Number(document.getElementById('maxBodyChars').value) || 48;
    settings.historyLimit = Number(document.getElementById('historyLimit').value) || 10;
    settings.filter = document.getElementById('filter').value.trim();
    settings.privacyMode = document.getElementById('privacyMode').value;
    websocket.send(JSON.stringify({ event: 'setGlobalSettings', context: context, payload: settings }));
  }

  function applySettings(next) {
    settings = Object.assign({}, settings, next || {});
    document.getElementById('endpoint').value = settings.endpoint;
    document.getElementById('maxBodyChars').value = settings.maxBodyChars;
    document.getElementById('historyLimit').value = settings.historyLimit;
    document.getElementById('filter').value = settings.filter;
    document.getElementById('privacyMode').value = settings.privacyMode;
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
    document.getElementById('maxBodyChars').addEventListener('input', update);
    document.getElementById('historyLimit').addEventListener('input', update);
    document.getElementById('filter').addEventListener('input', update);
    document.getElementById('privacyMode').addEventListener('change', update);
    document.getElementById('exportSettings').addEventListener('click', exportSettings);
    document.getElementById('importSettings').addEventListener('change', importSettings);
  });
}());
