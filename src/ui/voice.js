// src/ui/voice.js
//
// The Immortal's voice panel. Reads the monologue ring from the
// SAB (drained by ChaosCell.html), and renders each message as a
// popup window that fades in, holds, then fades out. Multiple
// messages queue and stack vertically. Loud messages (urgency >
// 0.65) halt gameplay and require a click.

const VOICE_POSITIONS = [
  { x: '14%', y: '18%' },   // top-left
  { x: '68%', y: '22%' },   // top-right
  { x: '20%', y: '66%' },   // bottom-left
  { x: '62%', y: '58%' },   // bottom-right
];

export function mountVoiceChannel() {
  const layer = document.createElement('div');
  layer.id = 'voice-layer';
  layer.style.cssText = `
    position: fixed; inset: 0; z-index: 65;
    pointer-events: none;
  `;
  document.body.appendChild(layer);

  const active = [];

  function makeWindow(text, urgency, cls, posIndex) {
    const pos = VOICE_POSITIONS[posIndex % VOICE_POSITIONS.length];

    const win = document.createElement('div');
    win.className = 'voice-window';
    win.style.cssText = `
      position: absolute;
      left: ${pos.x};
      top: ${pos.y};
      transform: translate(-50%, -50%) scale(0.92);
      min-width: 280px;
      max-width: 420px;
      padding: 18px 22px 16px;
      background: rgba(3, 2, 8, 0.92);
      border: 1px solid rgba(201, 162, 39, 0.55);
      box-shadow:
        0 0 60px rgba(201, 162, 39, 0.22),
        inset 0 0 40px rgba(201, 162, 39, 0.05);
      border-radius: 3px;
      font-family: 'Cormorant Garamond', 'EB Garamond', serif;
      font-size: 16px;
      line-height: 1.65;
      color: #ffe6a8;
      letter-spacing: 0.02em;
      opacity: 0;
      transition: opacity 0.5s ease, transform 0.5s ease;
      pointer-events: ${urgency > 0.65 ? 'auto' : 'none'};
      backdrop-filter: blur(8px);
    `;

    if (cls === 'whisper') {
      win.style.color = '#c8a0d0';
      win.style.fontStyle = 'italic';
      win.style.borderColor = 'rgba(176, 124, 255, 0.55)';
    } else if (cls === 'dim') {
      win.style.color = '#a89b86';
      win.style.fontSize = '14px';
      win.style.borderColor = 'rgba(92, 83, 72, 0.55)';
    }

    // Header line: "the immortal speaks" in small caps.
    const header = document.createElement('div');
    header.textContent = 'the immortal';
    header.style.cssText = `
      font-family: 'Iosevka', 'Fira Code', ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.32em;
      text-transform: uppercase;
      color: #5c5348;
      margin-bottom: 10px;
    `;
    win.appendChild(header);

    // Body: the actual message.
    const body = document.createElement('div');
    body.textContent = text;
    win.appendChild(body);

    if (urgency > 0.65) {
      const note = document.createElement('div');
      note.textContent = 'click to dismiss';
      note.style.cssText = `
        font-family: ui-monospace, monospace;
        font-size: 8.5px;
        letter-spacing: 0.22em;
        color: #5c5348;
        margin-top: 12px;
        text-align: right;
      `;
      win.appendChild(note);
      win.addEventListener('click', () => dismiss(win));
    }

    layer.appendChild(win);
    active.push({ win, urgency });

    // Defer opacity toggle so the transition runs.
    requestAnimationFrame(() => {
      win.style.opacity = '1';
      win.style.transform = 'translate(-50%, -50%) scale(1)';
    });

    // Auto-dismiss. Loud messages persist until clicked.
    if (urgency <= 0.65) {
      const ttl = 4000 + urgency * 4000;
      setTimeout(() => dismiss(win), ttl);
    }
  }

  function dismiss(win) {
    const idx = active.findIndex(a => a.win === win);
    if (idx >= 0) active.splice(idx, 1);
    win.style.opacity = '0';
    win.style.transform = 'translate(-50%, -50%) scale(0.94)';
    setTimeout(() => win.remove(), 600);
  }

  function speak(text, urgency = 0.3, cls = 'gold') {
    // Cap concurrent windows at 4. Oldest yields.
    if (active.length >= 4) dismiss(active[0].win);
    makeWindow(text, urgency, cls, active.length);
  }

  return { speak };
}