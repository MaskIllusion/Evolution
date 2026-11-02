// src/ui/oracle.js
//
// The god's voice channel.
//
// Two modes:
//   speak(text, cls, urgency)  — a statement. Fades in, holds,
//                                fades out on its own. No input.
//   ask({ text, options, freeform, salient })
//                              — a question. Waits for input.
//                                Resolves a promise with the
//                                watcher's answer. Never times out.
//
// Statements come from the Bus (`deity/utter`). Questions are
// initiated by the caller (currently the presence driver) and
// resolve on the caller's side. The two channels share the same
// layer, palette, and typography — they are the same voice.
//
// The god's voice is *outside* the world. The immortal's popups
// (voice.js) are corner-anchored, gold-bordered, and fast. These
// are centered, silver-bordered, and slow. The distinction is
// the whole point.

const ORACLE_STYLE = {
  silver: { border: 'rgba(200, 214, 240, 0.55)', text: '#e0e6f0', glow: 'rgba(160, 190, 255, 0.22)' },
  violet: { border: 'rgba(176, 124, 255, 0.60)', text: '#c8a0d0', glow: 'rgba(176, 124, 255, 0.30)' },
  pale:   { border: 'rgba(255, 255, 255, 0.55)', text: '#ffffff', glow: 'rgba(255, 255, 255, 0.20)' },
};

export function mountOracleChannel() {
  const layer = document.createElement('div');
  layer.id = 'oracle-layer';
  layer.style.cssText = `
    position: fixed; inset: 0; z-index: 66;
    pointer-events: none;
    display: flex; align-items: flex-start; justify-content: center;
    padding-top: 16vh;
  `;
  document.body.appendChild(layer);

  const active = [];
  const MAX_ACTIVE = 2;

  let questionPending = false;

  function makeWindow(text, cls, urgency, salient) {
    const style = ORACLE_STYLE[cls] || ORACLE_STYLE.silver;

    const win = document.createElement('div');
    win.className = 'oracle-window';
    // A salient statement (like the first acknowledgement) sits
    // a little lower, has a heavier border, and glows more. The
    // "salient" flag is the god's way of saying: this one
    // matters.
    const weight = salient ? 1.0 : 0.6;
    win.style.cssText = `
      position: absolute;
      top: ${18 + active.length * 8}vh;
      left: 50%;
      transform: translate(-50%, -12px) scale(0.96);
      min-width: min(620px, 78vw);
      max-width: min(720px, 84vw);
      padding: ${salient ? '34px 42px 30px' : '26px 34px 22px'};
      background: rgba(2, 3, 12, 0.94);
      border: 1px solid ${style.border};
      box-shadow:
        0 0 ${60 + weight * 60}px ${style.glow},
        inset 0 0 ${40 + weight * 40}px rgba(180, 200, 255, 0.04);
      border-radius: 1px;
      font-family: 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
      font-size: ${salient ? '26px' : '22px'};
      line-height: 1.62;
      font-style: italic;
      letter-spacing: 0.018em;
      color: ${style.text};
      opacity: 0;
      transition: opacity 1.4s cubic-bezier(0.16, 1, 0.3, 1),
                  transform 1.4s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      backdrop-filter: blur(10px);
    `;

    const header = document.createElement('div');
    header.textContent = 'the ground speaks';
    header.style.cssText = `
      font-family: 'Iosevka', 'Fira Code', ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.42em;
      text-transform: uppercase;
      color: #5c5348;
      margin-bottom: 14px;
      text-align: center;
    `;
    win.appendChild(header);

    const body = document.createElement('div');
    body.textContent = text;
    body.style.textAlign = 'center';
    win.appendChild(body);

    layer.appendChild(win);
    active.push({ win });

    requestAnimationFrame(() => {
      win.style.opacity = '1';
      win.style.transform = 'translate(-50%, 0) scale(1)';
    });

    // Hold duration scales with length and salience. A salient
    // statement lingers much longer than a passing one.
    const baseHold = salient ? 12000 : 6000 + text.length * 120;
    const urgencyBonus = 4000 * (urgency || 0.4);
    const ttl = baseHold + urgencyBonus;
    setTimeout(() => dismiss(win), ttl);
  }

  function dismiss(win) {
    const idx = active.findIndex(a => a.win === win);
    if (idx >= 0) active.splice(idx, 1);
    win.style.opacity = '0';
    win.style.transform = 'translate(-50%, -18px) scale(0.97)';
    setTimeout(() => win.remove(), 1500);
  }

  function speak(text, cls = 'silver', urgency = 0.5, salient = false) {
    // If the god is currently asking a question, statements are
    // suppressed. A god does not talk over itself.
    if (questionPending) return;
    if (active.length >= MAX_ACTIVE) dismiss(active[0].win);
    makeWindow(text, cls, urgency, salient);
  }

  // ── ask() ───────────────────────────────────────────────────
  // Renders a modal that waits for input. Resolves with:
  //   number  — index of the chosen option (0-based)
  //   string  — free-form answer, if the input was used
  //   null    — dismissed without answering
  //
  // Never times out. The god is patient.
  function ask({ text, options = [], freeform = false, cls = 'silver', salient = true }) {
    return new Promise((resolve) => {
      questionPending = true;
      const style = ORACLE_STYLE[cls] || ORACLE_STYLE.silver;

      const modal = document.createElement('div');
      modal.className = 'oracle-ask';
      modal.style.cssText = `
        position: absolute;
        top: 22vh;
        left: 50%;
        transform: translate(-50%, 0) scale(0.96);
        min-width: min(720px, 84vw);
        max-width: min(820px, 90vw);
        padding: ${salient ? '40px 48px 34px' : '32px 40px 28px'};
        background: rgba(2, 3, 12, 0.96);
        border: 1px solid ${style.border};
        box-shadow:
          0 0 140px ${style.glow},
          inset 0 0 80px rgba(180, 200, 255, 0.06);
        border-radius: 1px;
        font-family: 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
        font-size: 24px;
        line-height: 1.62;
        font-style: italic;
        letter-spacing: 0.018em;
        color: ${style.text};
        opacity: 0;
        transition: opacity 1.8s cubic-bezier(0.16, 1, 0.3, 1),
                    transform 1.8s cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: auto;
        backdrop-filter: blur(14px);
        z-index: 200;
      `;

      const header = document.createElement('div');
      header.textContent = 'the ground asks';
      header.style.cssText = `
        font-family: 'Iosevka', 'Fira Code', ui-monospace, monospace;
        font-size: 9px;
        letter-spacing: 0.48em;
        text-transform: uppercase;
        color: #5c5348;
        margin-bottom: 18px;
        text-align: center;
      `;
      modal.appendChild(header);

      const body = document.createElement('div');
      body.textContent = text;
      body.style.textAlign = 'center';
      body.style.marginBottom = '28px';
      modal.appendChild(body);

      // ── Options row ────────────────────────────────────
      if (options.length > 0) {
        const row = document.createElement('div');
        row.style.cssText = `
          display: flex; flex-wrap: wrap; gap: 12px;
          justify-content: center;
          margin-bottom: ${freeform ? '20px' : '24px'};
        `;
        options.forEach((opt, i) => {
          const b = document.createElement('button');
          b.textContent = String(opt);
          b.style.cssText = `
            background: none;
            border: 1px solid rgba(160, 190, 255, 0.35);
            color: #d0dae8;
            padding: 10px 22px;
            cursor: pointer;
            font-family: 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
            font-style: italic;
            font-size: 16px;
            letter-spacing: 0.06em;
            transition: all 0.35s;
          `;
          b.addEventListener('mouseenter', () => {
            b.style.borderColor = 'rgba(200, 214, 240, 0.85)';
            b.style.color = '#ffffff';
            b.style.boxShadow = '0 0 20px rgba(160, 190, 255, 0.35)';
          });
          b.addEventListener('mouseleave', () => {
            b.style.borderColor = 'rgba(160, 190, 255, 0.35)';
            b.style.color = '#d0dae8';
            b.style.boxShadow = 'none';
          });
          b.addEventListener('click', () => {
            close(i);
          });
          row.appendChild(b);
        });
        modal.appendChild(row);
      }

      // ── Freeform row ───────────────────────────────────
      if (freeform) {
        const wrap = document.createElement('div');
        wrap.style.cssText = `
          display: flex; gap: 12px; align-items: stretch;
          margin-bottom: 24px;
        `;
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'answer in your own words  ·  ≤ 200 chars';
        input.maxLength = 200;
        input.style.cssText = `
          flex: 1;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(160, 190, 255, 0.30);
          color: #e0e6f0;
          padding: 12px 16px;
          font-family: 'Iosevka', 'Fira Code', ui-monospace, monospace;
          font-size: 12px;
          letter-spacing: 0.06em;
          outline: none;
          transition: border-color 0.35s;
        `;
        input.addEventListener('focus', () => {
          input.style.borderColor = 'rgba(200, 214, 240, 0.75)';
        });
        input.addEventListener('blur', () => {
          input.style.borderColor = 'rgba(160, 190, 255, 0.30)';
        });
        const send = document.createElement('button');
        send.textContent = 'send';
        send.style.cssText = `
          background: none;
          border: 1px solid rgba(160, 190, 255, 0.55);
          color: #d0dae8;
          padding: 0 26px;
          cursor: pointer;
          font-family: 'Iosevka', 'Fira Code', ui-monospace, monospace;
          font-size: 11px;
          letter-spacing: 0.24em;
          text-transform: uppercase;
          transition: all 0.35s;
        `;
        send.addEventListener('mouseenter', () => {
          send.style.borderColor = 'rgba(200, 214, 240, 0.95)';
          send.style.color = '#ffffff';
        });
        send.addEventListener('mouseleave', () => {
          send.style.borderColor = 'rgba(160, 190, 255, 0.55)';
          send.style.color = '#d0dae8';
        });
        const submit = () => {
          const v = input.value.trim().slice(0, 200);
          if (v.length > 0) close(v);
        };
        send.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submit();
        });
        wrap.appendChild(input);
        wrap.appendChild(send);
        modal.appendChild(wrap);
        // Focus after fade-in so the cursor doesn't jump around
        setTimeout(() => input.focus(), 400);
      }

      // ── Dismiss row ────────────────────────────────────
      const foot = document.createElement('div');
      foot.style.cssText = `
        display: flex; justify-content: center;
        padding-top: 8px;
      `;
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'let the silence answer';
      dismissBtn.style.cssText = `
        background: none;
        border: none;
        color: #5c5348;
        padding: 8px 16px;
        cursor: pointer;
        font-family: 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
        font-style: italic;
        font-size: 14px;
        letter-spacing: 0.04em;
        transition: color 0.35s;
      `;
      dismissBtn.addEventListener('mouseenter', () => {
        dismissBtn.style.color = '#a0aab8';
      });
      dismissBtn.addEventListener('mouseleave', () => {
        dismissBtn.style.color = '#5c5348';
      });
      dismissBtn.addEventListener('click', () => close(null));
      foot.appendChild(dismissBtn);
      modal.appendChild(foot);

      layer.appendChild(modal);

      requestAnimationFrame(() => {
        modal.style.opacity = '1';
        modal.style.transform = 'translate(-50%, 0) scale(1)';
      });

      let closed = false;
      function close(value) {
        if (closed) return;
        closed = true;
        questionPending = false;
        modal.style.opacity = '0';
        modal.style.transform = 'translate(-50%, -22px) scale(0.97)';
        setTimeout(() => modal.remove(), 1800);
        resolve(value);
      }
    });
  }

  // Bus wiring for statements. Questions are initiated by the
  // caller and resolved on the caller's side.
  if (window.World && window.World.Bus) {
    window.World.Bus.on('deity/utter', ({ text, cls, urgency, salient }) => {
      speak(text, cls, urgency, salient);
    });
  }

  return {
    speak,
    ask,
    get isQuestionPending() { return questionPending; },
  };
}