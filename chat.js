/* =====================================================================
   CHAT — "Escribir a Ozio": la misma asistente de reservas, por escrito.

   Es el plan B de la llamada: sin micrófono, en una sala con ruido o
   cuando simplemente apetece escribir. Habla con el canal web de ng-agent:
   POST /api/chat { sessionId, message, tenant, widgetKey? } → { reply }.
   La respuesta llega entera (sin streaming) y ya en texto plano: el backend
   quita el markdown antes de contestar al canal web.

   La conversación vive en el backend por sessionId (web:<id>); aquí solo se
   guarda una copia en sessionStorage para repintarla si se cierra y se abre.
   ===================================================================== */

const cfg = window.OZIO_VOZ || {};
const AGENT_URL = (cfg.agentUrl || '').replace(/\/$/, '');
const TENANT = cfg.tenant || '';
const WIDGET_KEY = cfg.widgetKey || '';
const REPLY_TIMEOUT_MS = 45_000; // el LLM tiene 20 s de techo en el backend; margen para la red
const MAX_LEN = 2000; // lo que acepta /api/chat
const LOG_KEY = 'ozio.chat.log';
const LOG_MAX = 60;

const MSG = {
  hello: '¡Hola! Soy la asistente de Ozio. Puedo buscarte mesa, contarte la carta o resolver cualquier duda. ¿En qué te ayudo?',
  typing: 'Ozio está escribiendo…',
  err: {
    rate_limited: 'Vas muy rápido. Espera un momento y vuelve a escribir.',
    unconfigured: 'El chat no está disponible ahora mismo. Puedes llamarnos o reservar por WhatsApp.',
    timeout: 'Está tardando más de la cuenta. ¿Lo intentamos otra vez?',
    unavailable: 'No consigo conectar ahora mismo. ¿Lo intentamos otra vez?',
    too_long: 'El mensaje es demasiado largo. Resúmelo un poco, por favor.',
  },
};

const sessionId = (() => {
  try {
    let id = sessionStorage.getItem('ozio.chat.session');
    if (!id) { id = 'chat-' + crypto.randomUUID(); sessionStorage.setItem('ozio.chat.session', id); }
    return id;
  } catch { return 'chat-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
})();

/* ---------- interfaz ---------- */
const $ = (s, c = document) => c.querySelector(s);
const panel = $('[data-chat]');
const list = $('[data-chat-list]');
const chips = $('[data-chat-chips]');
const form = $('[data-chat-form]');
const input = $('[data-chat-input]');
const sendBtn = $('[data-chat-send]');
const closeBtn = $('[data-chat-close]');
const live = $('[data-chat-live]');

let log = [];
let busy = false;
let returnFocus = null;
let abort = null;

const loadLog = () => {
  try { const v = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
const saveLog = () => {
  try { sessionStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-LOG_MAX))); } catch {}
};

const scrollDown = () => {
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
};

/* Burbuja de mensaje. Solo textContent: la respuesta del agente nunca se pinta como HTML. */
const bubble = (role, text, { announce = false } = {}) => {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}`;
  const p = document.createElement('p');
  p.textContent = text;
  el.append(p);
  list.append(el);
  if (announce) live.textContent = text;
  scrollDown();
  return el;
};

const typing = (on) => {
  let el = $('.chat-typing', list);
  if (on && !el) {
    el = document.createElement('div');
    el.className = 'chat-msg agent chat-typing';
    el.setAttribute('aria-label', MSG.typing);
    el.innerHTML = '<p><i></i><i></i><i></i></p>';
    list.append(el);
    live.textContent = MSG.typing;
    scrollDown();
  } else if (!on && el) el.remove();
};

const showError = (text, retry) => {
  const el = document.createElement('div');
  el.className = 'chat-note';
  const p = document.createElement('p');
  p.textContent = text;
  el.append(p);
  if (retry) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Reintentar';
    b.addEventListener('click', () => { el.remove(); send(retry, { again: true }); });
    el.append(b);
  }
  list.append(el);
  live.textContent = text;
  scrollDown();
};

const setBusy = (on) => {
  busy = on;
  panel.dataset.busy = String(on);
  sendBtn.disabled = on || !input.value.trim();
};

const render = () => {
  list.textContent = '';
  bubble('agent', MSG.hello);
  log.forEach(m => bubble(m.role, m.text));
  chips.hidden = log.length > 0;
};

/* ---------- abrir / cerrar ---------- */
const isOpen = () => !panel.hidden && panel.classList.contains('on');

function open(e) {
  // Si viene de la llamada (sin micro, error…), se cierra la llamada primero.
  const voz = $('[data-voz]');
  if (voz && !voz.hidden) $('[data-voz-close]')?.click();
  returnFocus = (e && e.currentTarget instanceof HTMLElement && !e.currentTarget.closest('[data-voz]')) ? e.currentTarget : $('.chat-fab');
  if (isOpen()) { input.focus(); return; }
  panel.hidden = false;
  document.documentElement.classList.add('chat-open');
  requestAnimationFrame(() => {
    panel.classList.add('on');
    list.scrollTop = list.scrollHeight;
    // En móvil el foco abre el teclado y tapa el saludo: solo se enfoca con ratón/teclado.
    if (matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true });
    else closeBtn.focus({ preventScroll: true });
  });
}

function close() {
  if (panel.hidden) return;
  panel.classList.remove('on');
  document.documentElement.classList.remove('chat-open');
  const done = () => { if (!panel.classList.contains('on')) panel.hidden = true; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 450);
  returnFocus?.focus({ preventScroll: true });
}

/* ---------- enviar ---------- */
async function send(text, { again = false } = {}) {
  text = (text || '').trim();
  if (!text || busy) return;
  if (text.length > MAX_LEN) { showError(MSG.err.too_long); return; }

  chips.hidden = true;
  if (!again) {
    bubble('user', text);
    log.push({ role: 'user', text }); saveLog();
  }
  if (!AGENT_URL || !TENANT) { showError(MSG.err.unconfigured); return; }

  setBusy(true);
  typing(true);
  abort = new AbortController();
  const timer = setTimeout(() => abort && abort.abort(), REPLY_TIMEOUT_MS);
  try {
    const body = { sessionId, message: text, tenant: TENANT };
    if (WIDGET_KEY) body.widgetKey = WIDGET_KEY;
    const res = await fetch(`${AGENT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    const data = await res.json().catch(() => ({}));
    typing(false);

    if (res.ok && typeof data.reply === 'string' && data.reply.trim()) {
      const reply = data.reply.trim();
      bubble('agent', reply, { announce: true });
      log.push({ role: 'agent', text: reply }); saveLog();
      return;
    }
    // 429/503 del guardarraíl traen un texto humano en `reply`: se usa tal cual.
    if (data.reply) { showError(data.reply, res.status === 429 ? null : text); return; }
    if (res.status === 429) { showError(MSG.err.rate_limited); return; }
    if (res.status === 401 || res.status === 404) { showError(MSG.err.unconfigured); return; }
    showError(MSG.err.unavailable, text);
  } catch (err) {
    typing(false);
    showError(err && err.name === 'AbortError' ? MSG.err.timeout : MSG.err.unavailable, text);
  } finally {
    clearTimeout(timer);
    abort = null;
    setBusy(false);
  }
}

/* ---------- cableado ---------- */
log = loadLog();
render();

document.querySelectorAll('[data-chat-open]').forEach(b => b.addEventListener('click', open));
closeBtn.addEventListener('click', close);

chips.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) send(b.textContent);
});

form.addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value;
  if (!text.trim() || busy) return;
  input.value = '';
  autosize();
  send(text);
});

// Intro envía; Mayús+Intro hace salto de línea. No se envía mientras se compone (IME).
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
const autosize = () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
  sendBtn.disabled = busy || !input.value.trim();
};
input.addEventListener('input', autosize);

addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(); } });

// Tab no se escapa del panel en móvil (pantalla completa, aria-modal).
panel.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || !matchMedia('(max-width: 560px)').matches) return;
  const f = [...panel.querySelectorAll('button:not([disabled]):not([hidden]),textarea')].filter(el => el.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

addEventListener('pagehide', () => abort && abort.abort());
setBusy(false);
