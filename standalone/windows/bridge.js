(() => {
  if (window.top !== window || location.origin !== '__HUB_ORIGIN__') return;
  const native = chrome.webview.hostObjects.sync.fieldLink;
  let outputs = [], previous = [];
  const refresh = () => navigator.mediaDevices?.enumerateDevices().then(devices => {
    outputs = devices.filter(d => d.kind === 'audiooutput');
  }).catch(() => {});
  navigator.mediaDevices?.addEventListener('devicechange', refresh);
  window.addEventListener('focus', refresh);
  const tell = (kind, value) => chrome.webview.postMessage({kind, value});
  Object.defineProperty(window, 'FieldLinkNative', {value: Object.freeze({
    restoreSession: () => native.RestoreSession(),
    saveSession: (token, boot, cursor) => tell('session', {token, boot, cursor}),
    updateCursor: (boot, cursor) => tell('cursor', {boot, cursor}),
    useWebSettings: () => refresh(),
    openSettings: target => tell('settings', target),
    ringCall: on => tell('ring', Boolean(on)),
    speaker: on => {
      const players = ['remote', 'conference-audio'].map(id => document.getElementById(id));
      if (!players.every(p => typeof p?.setSinkId === 'function')) return false;
      if (on) previous = players.map(p => p.sinkId);
      const speakers = outputs.find(d => d.deviceId && d.deviceId !== 'default' && /speaker/i.test(d.label));
      Promise.all(players.map((p, i) => p.setSinkId(on ? speakers?.deviceId || 'default' : previous[i] || 'default')))
        .catch(() => window.notice?.('Windows could not switch the sound output.'));
      return true;
    }
  })});
})();
