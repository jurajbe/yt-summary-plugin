// Tiny Markdown → DOM renderer. Builds nodes with createElement/textContent
// only: YouTube enforces Trusted Types, and model output must never become HTML.
// Timestamps like [4:05] or [1:02:17] become buttons that seek the video.

const TIME_RE = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;

export function renderMarkdown(md, { onSeek } = {}) {
  const frag = document.createDocumentFragment();
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let list = null; // { el, ordered, indent }
  let para = null;

  const closeBlocks = () => {
    list = null;
    para = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    if (/^\s*(```|~~~)/.test(line)) continue; // drop fences, keep their content as text

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      closeBlocks();
      const level = Math.min(6, heading[1].length + 2); // # → h3, ## → h4 …
      const h = document.createElement(`h${Math.max(3, level)}`);
      appendInline(h, heading[2].replace(/\s*#+\s*$/, ''), onSeek);
      frag.appendChild(h);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeBlocks();
      frag.appendChild(document.createElement('hr'));
      continue;
    }

    const bullet = line.match(/^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/);
    if (bullet) {
      para = null;
      const indent = bullet[1].replace(/\t/g, '  ').length;
      const ordered = /\d/.test(bullet[2]);
      if (!list || list.ordered !== ordered || (indent >= 2) !== (list.indent >= 2)) {
        const el = document.createElement(ordered ? 'ol' : 'ul');
        if (indent >= 2) el.className = 'nested';
        frag.appendChild(el);
        list = { el, ordered, indent };
      }
      const li = document.createElement('li');
      appendInline(li, bullet[3], onSeek);
      list.el.appendChild(li);
      continue;
    }

    // Continuation of a list item (indented, non-bullet line)
    if (list && /^\s{2,}\S/.test(raw) && list.el.lastElementChild) {
      list.el.lastElementChild.appendChild(document.createTextNode(' '));
      appendInline(list.el.lastElementChild, line.trim(), onSeek);
      continue;
    }

    list = null;
    if (!para) {
      para = document.createElement('p');
      frag.appendChild(para);
    } else {
      para.appendChild(document.createElement('br'));
    }
    appendInline(para, line.trim().replace(/^>\s?/, ''), onSeek);
  }

  return frag;
}

/** Inline: **bold**, *italic* / _italic_, `code`, [m:ss] timestamps, [text](url) → text. */
function appendInline(parent, text, onSeek) {
  const re = /(\*\*|__)(.+?)\1|`([^`]+)`|(?<![\w*])[*_](?![\s*_])(.+?)(?<![\s*_])[*_](?![\w*])|\[([^\]\n]*\d:\d{2}[^\]\n]*)\](?!\()|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) appendTimes(parent, text.slice(last, m.index), onSeek, false);
    if (m[2] !== undefined) {
      const b = document.createElement('strong');
      appendInline(b, m[2], onSeek);
      parent.appendChild(b);
    } else if (m[3] !== undefined) {
      const c = document.createElement('code');
      c.textContent = m[3];
      parent.appendChild(c);
    } else if (m[4] !== undefined) {
      const i = document.createElement('em');
      appendInline(i, m[4], onSeek);
      parent.appendChild(i);
    } else if (m[5] !== undefined) {
      appendTimes(parent, m[5], onSeek, true);
    } else if (m[6] !== undefined) {
      appendInline(parent, m[6], onSeek);
    }
    last = re.lastIndex;
  }
  if (last < text.length) appendTimes(parent, text.slice(last), onSeek, false);
}

/** Inside [...] brackets every m:ss becomes a seek button; elsewhere plain text. */
function appendTimes(parent, text, onSeek, linkify) {
  if (!linkify || !onSeek) {
    parent.appendChild(document.createTextNode(linkify ? `[${text}]` : text));
    return;
  }
  let last = 0;
  let m;
  TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const btn = document.createElement('button');
    btn.className = 'ts';
    btn.type = 'button';
    btn.textContent = m[1];
    btn.title = `Jump to ${m[1]}`;
    const seconds = m[1].split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
    btn.addEventListener('click', () => onSeek(seconds));
    parent.appendChild(btn);
    last = TIME_RE.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
