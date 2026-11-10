/* =====================================================================
   VOZ — "Llamar a Ozio": llamada web con la asistente de reservas.

   Mismo flujo que el widget de asenix.es (next-generation-ai/useVoiceCall):
   1) micrófono, 2) token de un solo uso a ng-agent
   (POST /api/voice/web-call con el tenant del restaurante), 3) SDK oficial
   de Retell. El navegador nunca ve la API key de Retell.

   El agente puede pedir el correo en pantalla (herramienta
   pedir_contacto_en_pantalla); se envía a POST /api/voice/web-call/:callId/contact.

   Retell v3 (18/10/2026): la llamada se crea con /v3/create-web-call en el
   backend y el navegador entra con el SDK 3.x pasando callId, transport e
   iceServers a startCall(). Por el transporte nuevo el SDK ya no reenvía los
   eventos `metadata` ni `update`: el estado de herramienta, el correo
   recibido y el subtítulo llegan por el canal de interfaz del backend
   (GET /api/voice/web-call/:callId/events, Server-Sent Events).

   Además del subtítulo, por ese canal llegan (11/11/2026) las horas que la
   asistente acaba de ofrecer —se pintan como botones y tocar una vale lo
   mismo que decirla: POST /api/voice/web-call/:callId/choice— y la reserva
   recién creada, que se queda en una tarjeta con su enlace al calendario.

   Antes de la primera llamada de la visita se informa de que se graba y se
   pide aceptación; sin ella no se pide el micrófono ni se conecta nada.
   ===================================================================== */

const cfg = window.OZIO_VOZ || {};
const AGENT_URL = (cfg.agentUrl || '').replace(/\/$/, '');
const TENANT = cfg.tenant || '';
const TOKEN_TIMEOUT_MS = 60_000; // cold start de Render
// versión exacta: una publicación nueva del SDK no cambia la llamada sin probarla antes
const SDK_URLS = [
  'https://cdn.jsdelivr.net/npm/retell-client-js-sdk@3.0.4/+esm',
  'https://esm.sh/retell-client-js-sdk@3.0.4',
];
// "hablando" → "te escucho" se infiere del nivel de audio del agente (el SDK ya
// no emite agent_stop_talking): este silencio seguido, tras el margen que se
// concede a cada frase para que el TTS empiece a sonar.
const AGENT_SILENCE_MS = 600;
const AGENT_TEXT_GRACE_MS = 1500;
const AGENT_LOUD_LEVEL = 0.06;
const PHONE = cfg.phone || '';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// sin WhatsApp configurado, la alternativa real es el teléfono del restaurante o el chat
const OTHER = PHONE ? `Puedes llamarnos al ${PHONE} o escribirnos.` : 'Puedes escribirnos por el chat.';

const MSG = {
  consent: 'Antes de llamar',
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
    unconfigured: `La llamada no está disponible ahora mismo. ${OTHER}`,
    generic: 'Se ha cortado la llamada. ¿Lo intentamos otra vez?',
    unavailable: `No consigo conectar ahora mismo. ${OTHER}`,
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
const youEl = $('[data-voz-you]'); // opcional: lo que dice el cliente, en vivo
const setYou = (t) => { if (youEl) youEl.textContent = t || ''; };
const slotsEl = $('[data-voz-slots]');
const cardEl = $('[data-voz-card]');
const form = $('[data-voz-form]');
const emailIn = $('[data-voz-email]');
const formNote = $('[data-voz-form-note]');
const muteBtn = $('[data-voz-mute]');
const hangBtn = $('[data-voz-hang]');
const closeBtn = $('[data-voz-close]');
const retryBtn = $('[data-voz-retry]');
const acceptBtn = $('[data-voz-accept]');
const CONSENT_KEY = 'ozio.voz.acepta';
const accepted = () => { try { return sessionStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; } };

let state = 'idle';
let client = null;
let callId = null;
let events = null;      // EventSource del canal de interfaz
let agentTurn = null;   // { turn, text } de la respuesta en curso (subtítulo)
let spoken = '';        // lo que la asistente lleva dicho (para apagar lo ya oído)
let booking = null;     // la reserva hecha en esta llamada (tarjeta)
let icsUrl = '';
let wake = null;        // bloqueo de pantalla mientras dura la llamada
let actx = null;
let loudUntil = 0;      // último instante en que el agente sonó (o margen concedido)
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
  acceptBtn.hidden = next !== 'consent';
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

/* ---------- subtítulo palabra a palabra ---------- */
const paintSpoken = (text) => {
  const prev = text.startsWith(spoken) ? spoken : '';
  spoken = text;
  const wrap = document.createElement('span');
  if (prev) { const s = document.createElement('span'); s.className = 'said'; s.textContent = prev; wrap.append(s); }
  wrap.append(text.slice(prev.length));
  lineEl.replaceChildren(wrap);
};

/* ---------- horas tocables ---------- */
const showSlots = (slots) => {
  if (!slotsEl) return;
  slotsEl.replaceChildren();
  const list = Array.isArray(slots) ? slots.filter(s => s && typeof s.startUtc === 'string' && typeof s.label === 'string').slice(0, 4) : [];
  for (const s of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = s.label; b.dataset.start = s.startUtc;
    b.setAttribute('aria-label', `A las ${s.label}`);
    slotsEl.append(b);
  }
  slotsEl.hidden = list.length === 0;
};
async function pickSlot(e) {
  const b = e.target.closest('button[data-start]');
  if (!b || !callId || b.disabled) return;
  for (const x of slotsEl.children) x.disabled = true;
  b.setAttribute('aria-pressed', 'true');
  try {
    const res = await fetch(`${AGENT_URL}/api/voice/web-call/${encodeURIComponent(callId)}/choice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, startUtc: b.dataset.start, tenant: TENANT }),
    });
    if (!res.ok) throw new Error(String(res.status));
    setYou(`a las ${b.textContent}`);
    setTimeout(() => showSlots([]), 500);
  } catch {
    // No ha entrado: se quitan y la hora se dice de viva voz, como siempre.
    showSlots([]);
  }
}

/* ---------- tarjeta de la reserva ---------- */
const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const showBooking = (b) => {
  booking = b;
  if (icsUrl) { URL.revokeObjectURL(icsUrl); icsUrl = ''; }
  overlay.classList.toggle('has-card', !!b);
  if (!cardEl) return;
  cardEl.hidden = !b;
  if (!b) return;
  $('[data-voz-card-when]', cardEl).textContent = b.when;
  const who = [];
  if (b.people) who.push(b.people === 1 ? '1 persona' : `${b.people} personas`);
  if (b.name) who.push(`a nombre de ${b.name}`);
  $('[data-voz-card-who]', cardEl).textContent = who.join(' · ');
  const a = $('[data-voz-card-ics]', cardEl);
  const start = new Date(b.startUtc);
  if (Number.isNaN(start.getTime())) { a.hidden = true; return; }
  const end = new Date(start.getTime() + 2 * 3600_000);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ozio Gastronomico//Reserva//ES', 'BEGIN:VEVENT',
    `UID:${icsDate(start)}-${Math.random().toString(36).slice(2)}@ozio`,
    `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:Mesa en Ozio Gastronomico${b.people ? ` (${b.people})` : ''}`,
    'LOCATION:Ozio Gastronomico\\, Calle Aviador Zorita\\, 37\\, 28020 Madrid',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  icsUrl = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.href = icsUrl; a.hidden = false;
};

/* ---------- tonos de entrada y de salida ---------- */
const chime = (up) => {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime;
    (up ? [523.25, 783.99] : [659.25, 440]).forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = t0 + i * 0.13;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.07, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + 0.4);
    });
  } catch {}
};

/* ---------- pantalla encendida durante la llamada ---------- */
const liveNow = () => state === 'connecting' || state === 'listening' || state === 'thinking' || state === 'speaking' || state === 'tool';
const keepAwake = async () => {
  try { if (!wake && navigator.wakeLock && document.visibilityState === 'visible') { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch {}
};
const letSleep = () => { try { wake && wake.release(); } catch {} wake = null; };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && liveNow()) keepAwake(); });

/* Cierre de la llamada: los botones de hora se van; la tarjeta, si la hay, se queda. */
const finish = () => {
  const wasLive = liveNow();
  letSleep(); showSlots([]);
  if (!wasLive) return;
  chime(false);
  spoken = ''; setYou('');
  lineEl.textContent = booking ? 'Te esperamos. Gracias por reservar.' : 'Gracias por llamar.';
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
  const now = Date.now();
  if (level > AGENT_LOUD_LEVEL) loudUntil = Math.max(loudUntil, now);
  if (state === 'speaking' && now - loudUntil > AGENT_SILENCE_MS) setState('listening');
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

const closeEvents = () => { if (events) { events.close(); events = null; } };

/* Canal de interfaz del backend (SSE). Best-effort: si falla, la llamada sigue
   y solo se pierden subtítulo, etiqueta de herramienta y apertura del correo. */
const openEvents = (id, cancelled) => {
  if (typeof EventSource === 'undefined') return;
  closeEvents();
  agentTurn = null; loudUntil = 0; setYou(''); spoken = '';
  const es = new EventSource(`${AGENT_URL}/api/voice/web-call/${encodeURIComponent(id)}/events?sessionId=${encodeURIComponent(sessionId)}&tenant=${encodeURIComponent(TENANT)}`);
  events = es;
  const onUi = (raw) => {
    if (cancelled()) return;
    let ev; try { ev = JSON.parse(raw.data); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'state') {
      const m = readMeta(ev);
      if (m.state === 'contact_received') { formNote.textContent = 'Recibido ✓'; setTimeout(() => showForm(false), 1200); return; }
      if (m.state === 'tool') {
        const label = TOOL_LABELS[m.tool];
        setState('tool', label ? MSG[label] : MSG.thinking);
        if (label === 'contacto') showForm(true);
      } else if (m.state === 'answering' && state === 'tool') {
        setState('thinking');
      }
    } else if (ev.type === 'agent_text') {
      if (typeof ev.text !== 'string' || !ev.text.trim()) return;
      const text = agentTurn && agentTurn.turn === ev.turn ? `${agentTurn.text} ${ev.text.trim()}` : ev.text.trim();
      agentTurn = { turn: ev.turn, text };
      // La frase llega entera y antes de sonar: no se pinta. El subtítulo es
      // agent_spoken, palabra a palabra, al ritmo de la voz.
      loudUntil = Math.max(loudUntil, Date.now() + AGENT_TEXT_GRACE_MS);
      setState('speaking');
    } else if (ev.type === 'agent_spoken') {
      if (typeof ev.text !== 'string' || !ev.text.trim()) return;
      paintSpoken(ev.text.trim());
    } else if (ev.type === 'slots') {
      showSlots(ev.slots);
    } else if (ev.type === 'booking') {
      if (typeof ev.startUtc === 'string' && typeof ev.when === 'string') { showSlots([]); showBooking(ev); }
    } else if (ev.type === 'user_text') {
      // Lo que el cliente va diciendo, según lo transcribe Retell (parciales y final).
      if (typeof ev.text === 'string' && ev.text.trim()) setYou(ev.text.trim());
      // Habla el cliente: la frase anterior de la asistente ya no pinta nada.
      if (!ev.final && state === 'listening') { lineEl.textContent = ''; spoken = ''; }
      // Retell ya pidió respuesta: el cliente ha terminado de hablar.
      if (ev.final && state === 'listening') setState('thinking');
    } else if (ev.type === 'end') {
      es.close(); if (events === es) events = null;
    }
  };
  for (const t of ['state', 'agent_text', 'agent_spoken', 'slots', 'booking', 'user_text', 'end']) es.addEventListener(t, onUi);
  es.onerror = () => {}; // EventSource reintenta solo
};

function start() {
  if (state !== 'idle' && state !== 'ended' && state !== 'error' && state !== 'consent') return;
  if (accepted()) return call();
  // primero el aviso: qué es, que se graba y para qué, con la política a un clic
  open();
  showForm(false);
  lineEl.textContent = 'Te atenderá una asistente virtual. La llamada se graba y se transcribe para gestionar tu reserva.';
  setState('consent');
  setTimeout(() => acceptBtn.focus(), 60);
}

function accept() {
  try { sessionStorage.setItem(CONSENT_KEY, '1'); } catch {}
  call();
}

async function call() {
  open();
  lineEl.textContent = ''; setYou(''); spoken = '';
  showSlots([]); showBooking(null);
  showForm(false);
  muted = false; muteBtn.setAttribute('aria-pressed', 'false');
  callId = null;

  if (!AGENT_URL || !TENANT) return fail(MSG.err.unconfigured);
  if (!window.isSecureContext) return fail(MSG.err.insecure_context);

  const my = ++gen;
  const cancelled = () => my !== gen;
  setState('connecting');
  keepAwake();

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

    // Canal de interfaz ANTES de entrar: el saludo sale nada más conectar.
    if (callId) openEvents(callId, cancelled);

    const { RetellWebClient } = await sdkP;
    if (cancelled()) return;
    const c = new RetellWebClient();
    client = c;

    // Solo desde "conectando": el saludo puede haber llegado ya por el canal.
    c.on('call_ready', () => { if (!cancelled()) { startOrb(); chime(true); if (state === 'connecting') setState('listening'); } });
    c.on('agent_start_talking', () => { if (!cancelled()) setState('speaking'); });
    c.on('agent_stop_talking', () => { if (!cancelled() && state === 'speaking') setState('listening'); });
    c.on('audio', (samples) => { if (!cancelled()) pushSamples(samples); });
    // `update` y `metadata` ya no llegan por el SDK (transporte v3): ver openEvents.
    c.on('call_ended', () => {
      stopOrb(); closeEvents();
      if (cancelled()) return;
      client = null;
      finish();
      setState('ended');
    });
    c.on('error', () => {
      c.removeAllListeners();
      try { c.stopCall(); } catch {}
      stopOrb(); closeEvents();
      if (cancelled()) return;
      client = null;
      letSleep(); showSlots([]);
      fail(MSG.err.generic);
    });

    // callId, transport e iceServers: la respuesta v3 que startCall() necesita
    // para conectar por el gateway (sin ellos intentaría el transporte antiguo).
    await c.startCall({
      accessToken: data.accessToken,
      callId: data.callId,
      transport: data.transport === 'gateway' || data.transport === 'livekit' ? data.transport : undefined,
      iceServers: data.iceServers,
      emitRawAudioSamples: true,
    });
    if (cancelled()) { try { c.stopCall(); } catch {} return; }
    try { await c.startAudioPlayback(); } catch {}
  } catch (err) {
    if (cancelled()) return;
    client = null; closeEvents();
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
  closeEvents();
  stopOrb();
  showForm(false);
  finish();
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
// delegado en el documento: sirve también para los botones que la web crea después (el pie, por ejemplo)
document.addEventListener('click', e => {
  if (e.target.closest('[data-voz-open]')) { e.preventDefault(); start(); }
});
hangBtn.addEventListener('click', hangup);
retryBtn.addEventListener('click', start);
acceptBtn.addEventListener('click', accept);
closeBtn.addEventListener('click', close);
form.addEventListener('submit', submitEmail);
if (slotsEl) slotsEl.addEventListener('click', pickSlot);
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
