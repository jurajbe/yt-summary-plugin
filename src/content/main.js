// Content script entry: follows YouTube's single-page navigation and keeps
// the panel attached to whichever video is open.

import { Panel } from './panel.js';

const panel = new Panel();
let currentId;

function currentVideoId() {
  if (location.pathname !== '/watch') return null;
  return new URLSearchParams(location.search).get('v');
}

function check() {
  const id = currentVideoId();
  if (id !== currentId) {
    currentId = id;
    panel.setVideo(id);
  }
  if (id) panel.mount();
}

document.addEventListener('yt-navigate-finish', check);
window.addEventListener('popstate', check);
// YouTube re-renders its layout at will (theater mode, resizing); re-check periodically.
setInterval(check, 1000);
check();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'shortcut-summarize') panel.shortcut();
});
