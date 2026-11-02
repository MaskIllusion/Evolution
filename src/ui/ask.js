// src/ui/ask.js
//
// The question panel.
//
// Listens for `archon:question` events dispatched by the archon.
// Renders a centered modal. On user interaction, calls
// `archon.resolveQuestion(id, value)`. The archon writes the
// answer into the SAB ring. The meta worker's next tick reads
// it via world.readAnswer().
//
// The panel is the only part of the system that talks to the
// operator directly. It is deliberately thin: no state of its
// own, no memory across questions, no persistence. If the page
// reloads mid-question, the question is lost. That is correct.

const TOPIC_NAMES = ['world growth', 'energy', 'chain', 'operator'];

export function mountAskPanel(getArchon) {
  const panel = document.createElement('div');
  panel.id = 'ask-panel';
  panel.style.cssText = `
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    z-index: 100;
    width: min(600px, 80vw);
    background: rgba(3, 2, 8, 0.94);
    border: 1px solid rgba(201, 162, 39, 0.6);
    border-radius: 4px;
    padding: 24px 28px;
    backdrop-filter: blur(10px);
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    color: #e8dcc8;
    display: none;
    flex-direction: column;
    gap: 16px;
    box-shadow: 0 0 60px rgba(201, 162, 39, 0.30),
                inset 0 0 40px rgba(201, 162, 39, 0.05);
  `;

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;
                align-items:baseline;letter-spacing:.28em;
                text-transform:uppercase;">
      <span style="color:#e8b64c;font-size:10px;">
        the being asks
      </span>
      <span id="ask-id" style="color:#5c5348;font-size:9px;"></span>
    </div>

    <div id="ask-topic"
         style="font-family:'Cormorant Garamond','EB Garamond',serif;
                font-size:20px;color:#ffe6a8;letter-spacing:.10em;
                font-style:italic;font-weight:400;"></div>

    <div id="ask-context"
         style="font-size:10px;color:#a89b86;letter-spacing:.06em;
                font-variant-numeric:tabular-nums;line-height:1.8;
                padding:8px 0;border-top:1px solid rgba(201,162,39,0.15);
                border-bottom:1px solid rgba(201,162,39,0.15);"></div>

    <div id="ask-options"
         style="display:flex;flex-wrap:wrap;gap:10px;"></div>

    <div id="ask-freeform-wrap"
         style="display:none;gap:10px;align-items:center;">
      <input id="ask-freeform" type="text"
             placeholder="answer freely  ·  ≤ 96 chars"
             maxlength="96"
             style="flex:1;background:rgba(255,255,255,0.04);
                    border:1px solid rgba(201,162,39,0.30);
                    color:#e8dcc8;padding:8px 12px;
                    font-family:inherit;font-size:11px;
                    letter-spacing:.06em;outline:none;" />
      <button id="ask-submit"
              style="background:none;border:1px solid #c9a227;
                     color:#e8b64c;padding:8px 18px;cursor:pointer;
                     font-family:inherit;font-size:10px;
                     letter-spacing:.20em;text-transform:uppercase;">
        send
      </button>
    </div>

    <div style="display:flex;justify-content:space-between;
                align-items:center;margin-top:4px;">
      <span id="ask-urgency"
            style="font-size:9px;color:#5c5348;letter-spacing:.24em;
                   text-transform:uppercase;"></span>
      <button id="ask-dismiss"
              style="background:none;border:1px solid #5c5348;
                     color:#a89b86;padding:6px 14px;cursor:pointer;
                     font-family:inherit;font-size:10px;
                     letter-spacing:.18em;text-transform:uppercase;">
        let it decide
      </button>
    </div>
  `;
  document.body.appendChild(panel);

  const el = {
    panel,
    id:       panel.querySelector('#ask-id'),
    topic:    panel.querySelector('#ask-topic'),
    context:  panel.querySelector('#ask-context'),
    options:  panel.querySelector('#ask-options'),
    freeWrap: panel.querySelector('#ask-freeform-wrap'),
    freeform: panel.querySelector('#ask-freeform'),
    submit:   panel.querySelector('#ask-submit'),
    dismiss:  panel.querySelector('#ask-dismiss'),
    urgency:  panel.querySelector('#ask-urgency'),
  };

  let current = null;

  function show(question) {
    current = question;

    // The archon writes `questionId` on the question record —
    // `id` was taken by the IndexedDB auto-increment key in the
    // dialog store. Read either, prefer questionId.
    const qid = question.questionId ?? question.id ?? '?';
    el.id.textContent = '#' + qid;

    el.topic.textContent = TOPIC_NAMES[question.topic] || 'question';

    if (Array.isArray(question.context) && question.context.length) {
      const parts = question.context.map((v, i) => {
        const n = typeof v === 'number' ? v.toFixed(3) : String(v);
        return 'c' + i + '=' + n;
      });
      el.context.textContent = parts.join('  ');
    } else {
      el.context.textContent = 'no context';
    }

    el.urgency.textContent = 'urgency ' + question.urgency.toFixed(2);

    el.options.innerHTML = '';
    (question.options || []).forEach((opt, i) => {
      const b = document.createElement('button');
      b.textContent = String(opt).slice(0, 48);
      b.style.cssText = [
        'background: none',
        'border: 1px solid #5c5348',
        'color: #e8dcc8',
        'padding: 8px 16px',
        'cursor: pointer',
        'font-family: inherit',
        'font-size: 11px',
        'letter-spacing: .10em',
        'transition: all 0.2s',
      ].join(';');
      b.addEventListener('mouseenter', () => {
        b.style.borderColor = '#e8b64c';
        b.style.color = '#e8b64c';
        b.style.boxShadow = '0 0 12px rgba(232,182,76,0.30)';
      });
      b.addEventListener('mouseleave', () => {
        b.style.borderColor = '#5c5348';
        b.style.color = '#e8dcc8';
        b.style.boxShadow = 'none';
      });
      b.addEventListener('click', () => answer(i));
      el.options.appendChild(b);
    });

    el.freeWrap.style.display = question.freeform ? 'flex' : 'none';
    el.freeform.value = '';

    panel.style.display = 'flex';
    if (question.freeform) setTimeout(() => el.freeform.focus(), 30);
  }

  function hide() {
    panel.style.display = 'none';
    current = null;
  }

  function answer(value) {
    if (!current) return;
    const archon = getArchon();
    if (!archon || typeof archon.resolveQuestion !== 'function') {
      hide();
      return;
    }
    archon.resolveQuestion(current.id, value);
    hide();
  }

  el.submit.addEventListener('click', () => {
    if (!current) return;
    const v = el.freeform.value.trim().slice(0, 96);
    if (v) answer(v);
  });

  el.freeform.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.submit.click();
    if (e.key === 'Escape') hide();
  });

  el.dismiss.addEventListener('click', () => {
    answer(0);
  });

  window.addEventListener('archon:question', (e) => {
    if (!e.detail) return;
    show(e.detail);
  });

  return { show, hide };
}