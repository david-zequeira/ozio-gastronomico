/* =====================================================================
   VOZ — "Llamar a Ozio": llamada web con la asistente de reservas.

   Mismo flujo que el widget de asenix.es (next-generation-ai/useVoiceCall):
   1) micrófono, 2) token de un solo uso a ng-agent
   (POST /api/voice/web-call con el tenant del restaurante), 3) SDK oficial
   de Retell. El navegador nunca ve la API key de Retell.

   El agente puede pedir el correo en pantalla (herramienta
   pedir_contacto_en_pantalla → metadata {state:"tool", tool:...}); se envía a
   POST /api/voice/web-call/:callId/contact.
   ===================================================================== */

const cfg = window.OZIO_VOZ || {};
const AGENT_URL = (cfg.agentUrl || '').replace(/\/$/, '');
const TENANT = cfg.tenant || '';
const TOKEN_TIMEOUT_MS = 60_000; // cold start de Render
const SDK_URLS = [
  'https://cdn.jsdelivr.net/npm/retell-client-js-sdk@2/+esm',
  'https://esm.sh/retell-client-js-sdk@2',
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MSG = {
  connecting: 'Conectando con Ozio…',
  listening: 'Te escucho',
  thinking: 'Un momento…',
  speaking: 'Ozio',
  agenda: 'Mirando las mesas libres…',
  reserva: 'Apuntando tu reserva…',
  contacto: 'Escribe tu correo aquí abajo',
  ended: 'Llamada terminada',
  err: {
    mic_denied: 'Necesito permiso para el micrófono. Actívalo en el navegador y vuelve a intentarlo.',
    insecure_context: 'La llamada solo funciona en una página segura (https).',
    rate_limited: 'Demasiadas llamadas seguidas. Prueba en un minuto.',
    unconfigured: 'La llamada no está disponible ahora mismo. Puedes reservar por WhatsApp.',
    generic: 'Se ha cortado la llamada. ¿Lo intentamos otra vez?',
    unavailable: 'No consigo conectar ahora mismo. Puedes reservar por WhatsApp.',
  },
};

const TOOL_LABELS = {
  consultar_disponibilidad: 'agenda',
  crear_reserva: 'reserva',
  pedir_contacto_en_pantalla: 'contacto',
};

const sessionId = (() => {
  try {
    let id = sessionStorage.getItem('ozio.session');
    if (!id) { id = 'web-' + crypto.randomUUID(); sessionStorage.setItem('ozio.session', id); }
    return id;
  } catch { return 'web-' + Math.random().toString(36).slice(2); }
})();

/* ---------- interfaz ---------- */
const $ = (s, c = document) => c.querySelector(s);
const overlay = $('[data-voz]');
const orb = $('[data-voz-orb]');
const statusEl = $('[data-voz-status]');
const lineEl = $('[data-voz-line]');
const form = $('[data-voz-form]');
const emailIn = $('[data-voz-email]');
const formNote = $('[data-voz-form-note]');
const muteBtn = $('[data-voz-mute]');
const hangBtn = $('[data-voz-hang]');
const closeBtn = $('[data-voz-close]');
const retryBtn = $('[data-voz-retry]');

let state = 'idle';
let client = null;
let callId = null;
let gen = 0;
let muted = false;
let abort = null;
let sdk = null;
let level = 0;
let raf = 0;

const setState = (next, text) => {
  state = next;
  overlay.dataset.state = next;
  statusEl.textContent = text ?? MSG[next] ?? '';
  const live = next === 'listening' || next === 'thinking' || next === 'speaking' || next === 'tool' || next === 'connecting';
  hangBtn.hidden = !live;
  muteBtn.hidden = !live || next === 'connecting';
  closeBtn.hidden = live;
  retryBtn.hidden = !(next === 'ended' || next === 'error');
};

const open = () => {
  overlay.hidden = false;
  document.documentElement.classList.add('voz-open');
  requestAnimationFrame(() => overlay.classList.add('on'));
};
const close = () => {
  hangup();
  overlay.classList.remove('on');
  document.documentElement.classList.remove('voz-open');
  setTimeout(() => { if (!overlay.classList.contains('on')) overlay.hidden = true; }, 500);
};

const fail = (text) => {
  stopOrb();
  setState('error', text);
};

const showForm = (on) => {
  form.hidden = !on;
  if (on) { formNote.textContent = ''; emailIn.value = ''; setTimeout(() => emailIn.focus(), 60); }
};

/* ---------- orbe: nivel del agente ---------- */
const pushSamples = (samples) => {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / (samples.length / 4));
  level = Math.max(level * 0.82, Math.min(1, rms * 4));
};
const loop = () => {
  level *= 0.94;
  orb.style.setProperty('--lv', level.toFixed(3));
  raf = requestAnimationFrame(loop);
};
const startOrb = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); };
const stopOrb = () => { cancelAnimationFrame(raf); level = 0; orb.style.setProperty('--lv', '0'); };

/* ---------- llamada ---------- */
const loadSdk = () => {
  sdk ??= (async () => {
    let last;
    for (const url of SDK_URLS) {
      try { return await import(url); } catch (e) { last = e; }
    }
    throw last;
  })();
  return sdk;
};

const readMeta = (payload) => {
  const outer = payload && typeof payload === 'object' ? payload : null;
  if (!outer) return null;
  const inner = (outer.metadata && typeof outer.metadata === 'object') ? outer.metadata : outer;
  return inner;
};

const lastAgentLine = (payload) => {
  const turns = payload && Array.isArray(payload.transcript) ? payload.transcript : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && (t.role === 'agent' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim()) return t.content.trim();
  }
  return null;
};

async function start() {
  if (state !== 'idle' && state !== 'ended' && state !== 'error') return;
  open();
  lineEl.textContent = '';
  showForm(false);
  muted = false; muteBtn.setAttribute('aria-pressed', 'false');
  callId = null;

  if (!AGENT_URL || !TENANT) return fail(MSG.err.unconfigured);
  if (!window.isSecureContext) return fail(MSG.err.insecure_context);

  const my = ++gen;
  const cancelled = () => my !== gen;
  setState('connecting');

  const sdkP = loadSdk();
  sdkP.catch(() => {}); // se espera más abajo

  // Micrófono ANTES del token: el permiso lo contesta una persona y el token caduca en 30 s.
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch (err) {
    if (cancelled()) return;
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) return fail(MSG.err.mic_denied);
  }
  if (cancelled()) return;

  abort = new AbortController();
  const timer = setTimeout(() => abort && abort.abort(), TOKEN_TIMEOUT_MS);
  try {
    const res = await fetch(`${AGENT_URL}/api/voice/web-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, tenant: TENANT }),
      signal: abort.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (cancelled()) return;
    callId = data.callId || null;
    if (!res.ok || !data.accessToken) {
      if (data.reply) return fail(data.reply);
      if (res.status === 429) return fail(MSG.err.rate_limited);
      if (data.error === 'voice_unconfigured' || data.error === 'voice_not_in_plan') return fail(MSG.err.unconfigured);
      return fail(MSG.err.unavailable);
    }

    const { RetellWebClient } = await sdkP;
    if (cancelled()) return;
    const c = new RetellWebClient();
    client = c;

    c.on('call_ready', () => { if (!cancelled()) { startOrb(); setState('listening'); } });
    c.on('agent_start_talking', () => { if (!cancelled()) setState('speaking'); });
    c.on('agent_stop_talking', () => { if (!cancelled() && state === 'speaking') setState('listening'); });
    c.on('audio', (samples) => { if (!cancelled()) pushSamples(samples); });
    c.on('update', (payload) => {
      if (cancelled()) return;
      const line = lastAgentLine(payload);
      if (line) lineEl.textContent = line;
    });
    c.on('metadata', (payload) => {
      if (cancelled()) return;
      const m = readMeta(payload);
      if (!m) return;
      if (m.state === 'contact_received') { formNote.textContent = 'Recibido ✓'; setTimeout(() => showForm(false), 1200); return; }
      if (m.state === 'tool') {
        const label = TOOL_LABELS[m.tool];
        setState('tool', label ? MSG[label] : MSG.thinking);
        if (label === 'contacto') showForm(true);
      } else if (m.state === 'answering' && state === 'tool') {
        setState('thinking');
      }
    });
    c.on('call_ended', () => {
      stopOrb();
      if (cancelled()) return;
      client = null;
      setState('ended');
    });
    c.on('error', () => {
      c.removeAllListeners();
      try { c.stopCall(); } catch {}
      if (cancelled()) return;
      client = null;
      fail(MSG.err.generic);
    });

    await c.startCall({ accessToken: data.accessToken, emitRawAudioSamples: true });
    if (cancelled()) { try { c.stopCall(); } catch {} return; }
    try { await c.startAudioPlayback(); } catch {}
  } catch (err) {
    if (cancelled()) return;
    client = null;
    fail(err && err.name === 'AbortError' ? MSG.err.unavailable : MSG.err.unavailable);
  } finally {
    clearTimeout(timer);
    abort = null;
  }
}

function hangup() {
  gen++;
  if (abort) { abort.abort(); abort = null; }
  const c = client; client = null;
  if (c) { c.removeAllListeners(); try { c.stopCall(); } catch {} }
  stopOrb();
  showForm(false);
  if (state !== 'idle' && state !== 'error') setState('ended');
}

async function submitEmail(e) {
  e.preventDefault();
  const email = emailIn.value.trim();
  if (!callId || !EMAIL_RE.test(email)) { formNote.textContent = 'Revisa el correo, parece incompleto.'; return; }
  formNote.textContent = 'Enviando…';
  try {
    const res = await fetch(`${AGENT_URL}/api/voice/web-call/${encodeURIComponent(callId)}/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, email, tenant: TENANT }),
    });
    if (!res.ok) throw new Error(String(res.status));
    formNote.textContent = 'Recibido ✓';
    setTimeout(() => showForm(false), 1200);
  } catch {
    formNote.textContent = 'No se ha podido enviar. Prueba otra vez.';
  }
}

/* ---------- cableado ---------- */
document.querySelectorAll('[data-voz-open]').forEach(b => b.addEventListener('click', start));
hangBtn.addEventListener('click', hangup);
retryBtn.addEventListener('click', start);
closeBtn.addEventListener('click', close);
form.addEventListener('submit', submitEmail);
muteBtn.addEventListener('click', () => {
  if (!client) return;
  muted = !muted;
  try { muted ? client.mute() : client.unmute(); } catch { muted = !muted; return; }
  muteBtn.setAttribute('aria-pressed', String(muted));
  muteBtn.querySelector('span').textContent = muted ? 'Activar micro' : 'Silenciar';
});
addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) close(); });
addEventListener('pagehide', hangup);
setState('idle', '');
