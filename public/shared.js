// shared.js - common utilities for all pages

function $(sel) { return document.querySelector(sel); }

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Multi-keyword fuzzy match: space-separated tokens, all must appear in text (order-independent). */
function matchKeywords(text, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = (text || '').toLowerCase();
  return q.split(/[\s\u3000]+/).filter(Boolean).every(t => hay.includes(t));
}

/** Formats browsers can usually play + seek via /stream. Others may play but seek poorly. */
const BROWSER_NATIVE_VIDEO = new Set(['.mp4', '.webm', '.m4v', '.mov', '.ogg', '.ogv']);
function mediaPlayUrl(filePath) {
  if (!filePath) return '';
  return '/api/local/stream?path=' + encodeURIComponent(filePath);
}
function isMkvPath(filePath) {
  return !!filePath && filePath.slice(filePath.lastIndexOf('.')).toLowerCase() === '.mkv';
}
/** Non-native containers: skip hover preview (unreliable / heavy). */
function needsRemuxPlay(filePath) {
  if (!filePath) return false;
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return !BROWSER_NATIVE_VIDEO.has(ext);
}

// Setup draggable file icon for detail view (move file to sidebar folder)
function setupDetailDrag(iconEl, getFile) {
  iconEl.draggable = true;
  iconEl.addEventListener('dragstart', e => {
    const file = getFile();
    if (!file) return;
    e.dataTransfer.effectAllowed = 'move';
    const path = file.relPath || file.path;
    e.dataTransfer.setData('text/plain', path);
    window._detailDragPaths = [path];
    window._detailDragObjs = [file];
    iconEl.style.opacity = '0.4';
  });
  iconEl.addEventListener('dragend', () => {
    iconEl.style.opacity = '';
    window._detailDragPaths = null;
    window._detailDragObjs = null;
  });
}
