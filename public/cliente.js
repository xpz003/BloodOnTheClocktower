'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ═════════ estado del cliente ═════════
let ws, yo = null, S = null, ROLES = {}, FICHAS = {}, DIST = {}, MIN = 3, soyNar = false;
let sel = null, armada = null, elegidos = [], despertar = null, eleccionEnviada = false;
let infos = [], borradores = {}, abiertos = new Set(['asiento', 'fichas', 'noche']), silenciado = false, cazadorUsado = false;
let espia = null, angMan = 0, yoHabla = false, ultimoVoz = 0;
let hablandoSet = new Set();
const peers = new Map();
let audioCtx, micStream = null, micTrack = null, localAn = null, localBuf = null;

const pj = id => S.jugadores.find(p => p.id === id);
const nom = id => { const p = pj(id); return p ? p.nombre : (S.narrador.id === id ? S.narrador.nombre : '?'); };
const tiene = (p, f) => !!(p && p.fichas && p.fichas.includes(f));
const icono = k => (k && ROLES[k] ? ROLES[k].icono : '❔');
const rolTxt = k => (k && ROLES[k] ? `${ROLES[k].icono} ${ROLES[k].nombre}` : '—');
const TIPO = { pueblerino: 'Pueblerino', forastero: 'Forastero', esbirro: 'Esbirro', diablo: 'Diablo' };
const ETIQ_FASE = {
  lobby: () => 'Preparación', noche: s => `Noche ${s.n}`, dia: s => `Día ${s.dia}`,
  nominaciones: s => `Día ${s.dia} · Nominaciones`, defensa: s => `Día ${s.dia} · Defensa`,
  votando: s => `Día ${s.dia} · Votación`, fin: () => 'Fin de la partida'
};

// ═════════ entrada / conexión ═════════
$('#btnCrear').onclick = () => entrar({ t: 'crear' });
$('#btnUnir').onclick = () => entrar({ t: 'unirse', codigo: $('#codigo').value });
$('#nombre').value = localStorage.getItem('nombre') || '';
if (location.hash.length === 5) $('#codigo').value = location.hash.slice(1);

async function entrar(msg) {
  const nombre = $('#nombre').value.trim();
  if (!nombre) return ($('#errorInicio').textContent = 'Escribe tu nombre.');
  if (msg.t === 'unirse' && $('#codigo').value.trim().length < 4) return ($('#errorInicio').textContent = 'Escribe el código de 4 letras.');
  localStorage.setItem('nombre', nombre);
  msg.nombre = nombre; $('#errorInicio').textContent = '';
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  await pedirMic();
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => ws.send(JSON.stringify(msg));
  ws.onmessage = e => alMensaje(JSON.parse(e.data));
  ws.onclose = () => { if (yo != null) toast('Conexión perdida. Recarga la página.'); };
}
const enviar = o => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

async function pedirMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    micTrack = micStream.getAudioTracks()[0];
    const src = audioCtx.createMediaStreamSource(micStream);
    localAn = audioCtx.createAnalyser(); localAn.fftSize = 512; localBuf = new Uint8Array(localAn.fftSize);
    src.connect(localAn);
  } catch (e) {
    micStream = micTrack = null;
    $('#mic').textContent = '🚫'; $('#mic').disabled = true; $('#mic').title = 'Sin micrófono (solo escuchas)';
  }
}

function alMensaje(m) {
  switch (m.t) {
    case 'error': $('#errorInicio').textContent = m.texto; toast(m.texto); if (yo == null && ws) ws.close(); break;
    case 'bienvenida':
      yo = m.id; ROLES = m.roles; FICHAS = m.fichas; DIST = m.dist; MIN = m.min;
      $('#cod').textContent = m.codigo; $('#inicio').hidden = true; $('#juego').hidden = false;
      history.replaceState(null, '', '#' + m.codigo);
      break;
    case 'estado': alEstado(m); break;
    case 'msg': log(m.texto, m.privado); break;
    case 'info': infos.unshift({ momento: m.momento, texto: m.texto }); log('✉️ ' + m.texto, true); toast('✉️ El Narrador te ha enviado información'); render(); break;
    case 'despertar': despertar = m; elegidos = []; eleccionEnviada = false; toast('🌙 El Narrador te ha despertado'); aplicarMic(); render(); break;
    case 'dormir': despertar = null; elegidos = []; eleccionEnviada = false; aplicarMic(); render(); break;
    case 'ack': eleccionEnviada = true; toast('✔ Elección enviada'); render(); break;
    case 'sugerencia': borradores['info:' + m.id] = m.texto; render(); break;
    case 'grimorioEspia': espia = m.filas; render(); break;
    case 'habla': if (m.on) hablandoSet.add(m.id); else hablandoSet.delete(m.id); pintarHabla(); break;
    case 'rtc': señal(m.from, m.data); break;
    case 'cerrada': alert(m.texto); location.hash = ''; location.reload(); break;
  }
}

function alEstado(m) {
  const prev = S; S = m; m._rx = performance.now();
  hablandoSet = new Set(m.hablando || []);
  soyNar = m.yo.nar;
  if (sel && !pj(sel)) sel = null;
  if (!prev || prev.fase !== m.fase) {
    elegidos = []; armada = null; yoHabla = false;
    if (m.fase !== 'noche') { despertar = null; eleccionEnviada = false; }
    if (m.fase === 'lobby') { infos = []; cazadorUsado = false; }
    if (m.fase === 'fin' && soyNar) espia = null;
  }
  if (!m.yo.despierto && despertar && m.fase === 'noche') { /* el Narrador aún no lo ha dormido */ }
  gestionarPeers(); aplicarMic(); actualizarEmision(); render();
}

// ═════════ utilidades de interfaz ═════════
function log(texto, privado) {
  const d = document.createElement('div'); d.textContent = texto; if (privado) d.className = 'priv';
  const l = $('#log'); l.appendChild(d);
  while (l.children.length > 5) l.firstChild.remove();
  setTimeout(() => d.remove(), privado ? 14000 : 8000);
}
let toastT;
function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => e.hidden = true, 3500); }

// ═════════ render general ═════════
function render() {
  if (!S) return;
  document.body.classList.toggle('noche', S.fase === 'noche');
  $('#fase').textContent = ETIQ_FASE[S.fase](S);
  renderMesa(); renderLateral(); renderBarra(); renderModal(); pintarHabla();
}

// ───────── círculo de fichas ─────────
function renderMesa() {
  const ps = S.asientos.map(pj).filter(Boolean), N = Math.max(1, ps.length);
  const r = $('#mesa').getBoundingClientRect();
  const size = Math.max(280, Math.min(r.width, r.height - 56) - 16);
  const R = size * 0.37, d = Math.max(40, Math.min(size * 0.15, (2 * Math.PI * R / N) * 0.8));
  const c = $('#circulo'); c.style.width = c.style.height = size + 'px';
  const reloj = $('#relojMesa'), rd = Math.max(120, (R - d / 2) * 2 * 0.9);
  reloj.style.width = reloj.style.height = rd + 'px';
  $('#manecilla').style.height = (rd * 0.40) + 'px';
  reloj.style.setProperty('--dy', (rd * 0.2) + 'px');

  const v = S.voto, apunta = v ? v.orden[v.idx % v.orden.length] : null;
  const awake = soyNar ? S.grim.despiertos : [];
  const opcionesNoche = despertar && despertar.n > 0 ? despertar.opciones.map(o => o.id) : null;

  $('#asientos').innerHTML = ps.map((p, i) => {
    const a = (i / N) * 2 * Math.PI, x = size / 2 + R * Math.sin(a), y = size / 2 - R * Math.cos(a);
    const real = (soyNar || S.fase === 'fin' || p.id === yo) ? p.rol : null;
    const ico = real ? icono(real) : (p.id === yo && S.fase === 'lobby' ? '🪑' : '?');
    const cls = ['asiento'];
    if (p.id === yo) cls.push('mio'); if (!p.vivo) cls.push('muerto'); if (sel === p.id) cls.push('sel');
    if (elegidos.includes(p.id)) cls.push('elegido');
    if (opcionesNoche && !opcionesNoche.includes(p.id)) cls.push('atenuado');
    if (S.bloque && S.bloque.id === p.id) cls.push('bloque');
    if (S.actual && S.actual.a === p.id && ['defensa', 'votando'].includes(S.fase)) cls.push('nominado');
    if (apunta === p.id) cls.push('apunta');
    if (hablando(p.id)) cls.push('habla');
    const tipoCls = real && ROLES[real] ? 't-' + ROLES[real].tipo : (real ? '' : 'oculta');
    const marcas = [];
    if (p.mano) marcas.push('✋'); if (!p.vivo && p.votoFantasma) marcas.push('🗳️');
    if (S.bloque && S.bloque.id === p.id) marcas.push(S.bloque.empate ? '⚖️❓' : '⚖️');
    const izq = []; if (p.off) izq.push('📴'); if (awake.includes(p.id)) izq.push('🌙');
    const fp = soyNar && p.fichas ? p.fichas.filter(f => f !== 'muerto' || p.vivo).map(f => `<span title="${esc(FICHAS[f].nombre)}">${FICHAS[f].icono}</span>`).join('') : '';
    const sub = soyNar && p.rol ? `${esc(ROLES[p.rol].nombre)}${p.cree ? ' · cree ' + esc(ROLES[p.cree].nombre) : ''}` : (S.fase === 'fin' && p.rol ? esc(ROLES[p.rol].nombre) : '');
    return `<div class="${cls.join(' ')}" data-id="${p.id}" tabindex="0" role="button" aria-label="${esc(p.nombre)}" style="--d:${d}px;left:${x}px;top:${y}px">
      <div class="ficha ${tipoCls}">${ico}</div>
      <div class="marcas">${marcas.join('')}</div><div class="marcas izq">${izq.join('')}</div>
      <div class="nom">${esc(p.nombre)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}
      ${fp ? `<div class="fichasP">${fp}</div>` : ''}
    </div>`;
  }).join('');
  renderCentro(N, v);
}

function renderCentro(N, v) {
  const m = $('#manecilla');
  let idx = null;
  if (v) idx = S.asientos.indexOf(v.orden[v.idx % v.orden.length]);
  else if (S.fase === 'defensa' && S.actual) idx = S.asientos.indexOf(S.actual.a);
  if (idx == null || idx < 0) m.classList.remove('activa');
  else {
    m.classList.add('activa');
    const target = idx * 360 / N, delta = (((target - angMan) % 360) + 360) % 360;
    if (delta > 0.01 && delta < 359.99) angMan += delta;
    m.style.transform = `rotate(${angMan}deg)`;
  }
  let t = '';
  const nb = S.bloque && !S.bloque.empate ? `<br><small>A punto de morir: <b>${esc(nom(S.bloque.id))}</b> (${S.bloque.votos})</small>` : (S.bloque ? '<br><small>Empate a punto de morir</small>' : '');
  switch (S.fase) {
    case 'lobby': t = `Sala de espera<br><small>${S.asientos.length} jugador${S.asientos.length === 1 ? '' : 'es'}</small>`; break;
    case 'noche': t = `🌙 <b>Noche ${S.n}</b>`; break;
    case 'dia': t = `☀️ <b>Día ${S.dia}</b>${nb}`; break;
    case 'nominaciones': t = `📣 <b>Nominaciones</b>${nb}`; break;
    case 'defensa': t = S.actual ? `🗣️ <b>${esc(nom(S.actual.a))}</b> se defiende<br><small>nominado por ${esc(nom(S.actual.por))}</small>` : '🗣️ Defensa'; break;
    case 'votando': t = `<b>${esc(nom(v.nominado))}</b><br>Votos: <b>${v.contados.length}</b> / ${v.umbral}`; break;
    case 'fin': t = S.ganador === 'bien' ? '🏆 <b>Ganan los buenos</b>' : '💀 <b>Ganan los malos</b>'; break;
  }
  $('#centroTxt').innerHTML = t;
}

// clic en asientos
$('#asientos').addEventListener('click', e => { const a = e.target.closest('.asiento'); if (a) clickAsiento(+a.dataset.id); });
$('#asientos').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.id) { e.preventDefault(); clickAsiento(+e.target.dataset.id); } });
function clickAsiento(id) {
  if (soyNar) {
    if (armada) { enviar({ t: 'ficha', id, ficha: armada, accion: 'poner' }); armada = null; }
    else sel = sel === id ? null : id;
    return render();
  }
  if (despertar && despertar.n > 0) {
    if (!despertar.opciones.some(o => o.id === id)) return;
    const i = elegidos.indexOf(id);
    if (i >= 0) elegidos.splice(i, 1); else if (elegidos.length < despertar.n) elegidos.push(id); else { elegidos.shift(); elegidos.push(id); }
    eleccionEnviada = false;
    return render();
  }
  sel = sel === id ? null : id; render();
}

// ───────── panel lateral ─────────
$('#lateral').addEventListener('input', e => { const k = e.target.dataset && e.target.dataset.draft; if (k) borradores[k] = e.target.value; });
$('#lateral').addEventListener('toggle', e => { const k = e.target.dataset && e.target.dataset.k; if (k) { if (e.target.open) abiertos.add(k); else abiertos.delete(k); } }, true);
$('#lateral').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) ACT[b.dataset.act] && ACT[b.dataset.act](b.dataset, b); });
$('#lateral').addEventListener('change', e => { const k = e.target.dataset && e.target.dataset.chg; if (k && CHG[k]) CHG[k](e.target.dataset, e.target); });
$('#barra').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) ACT[b.dataset.act] && ACT[b.dataset.act](b.dataset, b); });

function renderLateral() {
  const L = $('#lateral'), f = document.activeElement;
  let key = null, pos = 0;
  if (f && f.dataset && f.dataset.draft && L.contains(f)) { key = f.dataset.draft; pos = f.selectionStart; }
  const sc = L.scrollTop;
  L.innerHTML = soyNar ? htmlNarrador() : htmlJugador();
  L.scrollTop = sc;
  if (key) { const e = L.querySelector(`[data-draft="${key}"]`); if (e) { e.focus(); try { e.setSelectionRange(pos, pos); } catch (_) { /* select */ } } }
}
const det = (k, titulo, cuerpo, abierto) => `<details data-k="${k}" ${abiertos.has(k) || abierto ? 'open' : ''}><summary>${titulo}</summary>${cuerpo}</details>`;
const btn = (act, txt, data = '', cls = '') => `<button class="${cls}" data-act="${act}" ${data}>${txt}</button>`;

// ═════ composición de la partida y salas de voz ═════
const PLURAL = { pueblerino: ['Pueblerino', 'Pueblerinos'], forastero: ['Forastero', 'Forasteros'], esbirro: ['Esbirro', 'Esbirros'], diablo: ['Diablo', 'Diablos'] };
const COLOR = { pueblerino: '#5aa9ff', forastero: '#4fd1c5', esbirro: '#ff9f43', diablo: '#ff5c64' };
function htmlComposicion() {
  const n = S.asientos.length;
  let c = S.composicion, tit;
  if (c) tit = `En esta partida (${n} jugadores) hay`;
  else { const d = DIST[Math.max(3, Math.min(15, n))] || [0, 0, 0, 0]; c = { pueblerino: d[0], forastero: d[1], esbirro: d[2], diablo: d[3] }; tit = `Con ${n} jugadores se juega con`; }
  const chips = Object.keys(PLURAL).map(tp => `<span class="chip" style="border:1px solid ${COLOR[tp]}88"><b style="color:${COLOR[tp]}">${c[tp]}</b> ${PLURAL[tp][c[tp] === 1 ? 0 : 1]}</span>`).join('');
  const filas = Object.keys(DIST).filter(k => +k >= 5).map(k => { const d = DIST[k]; return `<tr class="${+k === n ? 'actual' : ''}"><td><b>${k}</b></td><td>${d[0]}</td><td>${d[1]}</td><td>${d[2]}</td><td>${d[3]}</td></tr>`; }).join('');
  const tabla = `<table class="grim"><tr><th>Jugadores</th><th>Pueblerinos</th><th>Forasteros</th><th>Esbirros</th><th>Diablo</th></tr>${filas}</table><small>Si hay Barón en juego: 2 Pueblerinos menos y 2 Forasteros más.</small>`;
  return `<div class="comp"><small>${tit}</small><div>${chips}</div>${det('tabla', '📋 Tabla de jugadores', tabla)}</div>`;
}

function htmlSalas() {
  const nar = S.narrador, noche = S.fase === 'noche';
  const yoSala = soyNar ? nar.sala : (pj(yo) || {}).sala;
  const ocupantes = id => {
    const l = [];
    if (nar.sala === id) l.push({ id: nar.id, nombre: nar.nombre, nar: true });
    S.jugadores.filter(p => !p.off && p.sala === id).forEach(p => l.push({ id: p.id, nombre: p.nombre, vivo: p.vivo }));
    return l;
  };
  let h = '';
  if (noche) h += '<div class="aviso">🌙 De noche nadie habla: solo el Narrador con quien despierta.</div>';
  else if (!S.salasActivas) h += '<div class="aviso">📣 Salas en pausa: ahora todos se oyen.</div>';
  if (S.megafono && !noche) h += '<div class="aviso">📢 El Narrador está hablando a todos.</div>';
  if (S.silencio && !noche) h += '<div class="aviso">🤫 Silencio: solo habla el Narrador.</div>';
  h += S.salas.map(sa => {
    const oc = ocupantes(sa.id), aqui = yoSala === sa.id;
    const bloq = noche || (sa.id !== 'plaza' && !S.ajustes.salasAbiertas && !soyNar);
    return `<div class="sala ${aqui ? 'aqui' : ''}"><div class="fila"><b>${sa.id === 'plaza' ? '🏛️' : '🔊'} ${esc(sa.nombre)}</b> <small>(${oc.length})</small><span style="flex:1"></span>
      ${aqui ? '<small class="ok">✔ estás aquí</small>' : btn('unirSala', 'Entrar', `data-id="${sa.id}" ${bloq ? 'disabled' : ''}`, 'mini')}
      ${soyNar && sa.id !== 'plaza' ? btn('salaRen', '✏️', `data-id="${sa.id}" title="Renombrar"`, 'mini') + btn('salaBorrar', '🗑️', `data-id="${sa.id}" title="Borrar sala"`, 'mini') : ''}</div>
      <div>${oc.map(o => `<span class="chip ocu" data-hab="${o.id}">${o.nar ? '🎭' : '🎙️'} ${esc(o.nombre)}${o.id === yo ? ' (tú)' : ''}${o.vivo === false ? ' 💀' : ''}</span>`).join('') || '<small>vacía</small>'}</div></div>`;
  }).join('');
  if (soyNar) h += `<div class="btns">${btn('salaCrear', '➕ Nueva sala')}${btn('megafono', S.megafono ? '📢 Hablar a todos: SÍ' : '📢 Hablar a todos: NO', '', S.megafono ? 'on' : '')}</div>`;
  h += '<small>Aunque no oigas una sala, ves quién está hablando en ella.</small>';
  return det('salas', '🔊 Salas de voz', h, true);
}

// ═════ panel del Narrador ═════
function htmlNarrador() {
  const G = S.grim;
  let h = '<h3>🎭 Grimorio del Narrador</h3>' + htmlComposicion();
  h += S.fase === 'lobby' ? htmlPreparacion(G) : htmlFase(G);
  h += htmlAsiento(G);
  if (S.fase !== 'lobby') h += htmlFichas(G);
  h += htmlSalas();
  h += htmlExtras();
  h += htmlAjustes();
  h += det('registro', '📖 Registro del Grimorio', `<div style="font-size:.8rem;line-height:1.5">${G.eventos.slice().reverse().map(esc).join('<br>') || '<small>Vacío.</small>'}</div>`);
  return h;
}

function htmlPreparacion(G) {
  const n = S.asientos.length, set = new Set(G.rolesElegidos);
  let [T, O, M, D] = DIST[Math.max(3, Math.min(15, n))] || [0, 0, 0, 0];
  if (set.has('baron')) { T -= 2; O += 2; }
  const cuenta = tp => [...set].filter(r => ROLES[r].tipo === tp).length;
  const col = (tp, esp) => `<span class="${cuenta(tp) === esp ? 'ok' : 'aviso'}">${cuenta(tp)}/${esp}</span>`;
  const grupo = (tp, tit) => `<div style="margin:.4rem 0 .1rem"><small>${tit}</small></div>` +
    Object.entries(ROLES).filter(([, r]) => r.tipo === tp).map(([k, r]) =>
      `<label class="chk t-${tp}" title="${esc(r.desc)}"><input type="checkbox" data-chg="rol" value="${k}" ${set.has(k) ? 'checked' : ''}>${r.icono} ${r.nombre}</label>`).join('');
  const asignados = S.jugadores.filter(p => p.rol).length;
  return `<div class="it">Jugadores sentados: <b>${n}</b> <small>(el Narrador no cuenta)</small><br><small>Código de sala: <b>${esc($('#cod').textContent)}</b></small></div>
    <div class="it"><b>1. Elige los roles de la partida</b><br>
      <small>Pueblerinos ${col('pueblerino', T)} · Forasteros ${col('forastero', O)} · Esbirros ${col('esbirro', M)} · Diablos ${col('diablo', D)}${set.has('baron') ? ' <small>(Barón: −2 Pueblerinos, +2 Forasteros)</small>' : ''}</small><br>
      <small>Total elegido: <b class="${set.size === n ? 'ok' : 'aviso'}">${set.size}</b> de ${n} jugadores</small>
      ${grupo('pueblerino', 'Pueblerinos (buenos)')}${grupo('forastero', 'Forasteros (buenos)')}${grupo('esbirro', 'Esbirros (malos)')}${grupo('diablo', 'Diablos (malos)')}
      <div class="btns">${btn('sugerirRoles', '🎲 Sugerir roles', '', '')}</div></div>
    <div class="it"><b>2. Reparte las fichas</b><br><small>Se asignan al azar a los jugadores. Después puedes cambiar el rol de cada asiento tocándolo.</small>
      <div class="btns">${btn('sortear', '🃏 Repartir fichas', set.size === n && n >= 1 ? '' : 'disabled', 'primario')}${btn('barajar', '🔀 Barajar asientos')}</div>
      ${asignados ? `<small class="ok">${asignados}/${n} jugadores con rol.</small>` : ''}</div>
    <div class="it"><b>3. Empieza</b>
      <div class="btns">${btn('iniciar', '🌙 Empezar partida (Noche 1)', n >= MIN && asignados === n ? '' : 'disabled', 'primario')}</div>
      ${n < MIN ? `<small class="aviso">Hacen falta al menos ${MIN} jugadores.</small>` : n < 5 ? '<small class="aviso">Con menos de 5 jugadores la partida no está equilibrada.</small>' : ''}</div>`;
}

function htmlFase(G) {
  let h = '';
  const cz = G.cazador;
  if (cz) {
    h += `<div class="it"><b>🏹 Disparo del Cazador</b><br>${esc(cz.nombre)} dispara a <b>${esc(cz.objetivoNombre)}</b>. ${cz.esDiablo ? '<span class="ok">Es el Diablo.</span>' : '<span class="tenue">No es el Diablo.</span>'}${cz.emborrachado ? '<br><span class="aviso">⚠️ El Cazador está borracho: su habilidad falla.</span>' : ''}
      <div class="btns">${btn('cazador', '💥 Matar', 'data-v="1"', 'peligro')}${btn('cazador', 'No pasa nada', 'data-v="0"')}</div></div>`;
  }
  switch (S.fase) {
    case 'noche': {
      const lista = G.lista;
      h += `<div class="it"><b>🌙 Noche ${S.n}</b> — despierta a cada rol en orden.</div>`;
      if (S.n === 1) h += htmlPrimeraNoche(G);
      h += lista.length ? lista.map(htmlEntradaNoche).join('') : '<div class="it"><small>Nadie tiene habilidad nocturna esta noche.</small></div>';
      h += `<div class="it">${btn('amanecer', '☀️ Amanecer', '', 'primario')}<br><small>Los jugadores con ficha de Muerto morirán al amanecer.</small></div>`;
      break;
    }
    case 'dia':
      h += `<div class="it"><b>☀️ Día ${S.dia}</b> — los jugadores debaten.<div class="btns">${btn('extender', '+1 min', 'data-v="60"')}${btn('abrirNom', '📣 Abrir nominaciones', '', 'primario')}${btn('terminarDia', '🌙 Terminar día', '', 'peligro')}</div></div>`;
      break;
    case 'nominaciones':
      h += `<div class="it"><b>📣 Nominaciones abiertas</b>${htmlBloque()}<div class="btns">${btn('terminarDia', '🌙 Terminar día (ejecutar)', '', 'primario')}</div>
        <small>Los jugadores nominan por su cuenta (1 vez cada uno).</small></div>`;
      break;
    case 'defensa': {
      const a = S.actual, pv = G.virgen;
      h += `<div class="it"><b>🗣️ Defensa</b> — ${a ? `${esc(nom(a.por))} nomina a <b>${esc(nom(a.a))}</b>` : ''}`;
      if (pv) {
        h += `<br><b>👸 ¡Es la Virgen!</b> El nominador (${esc(pv.nominadorNombre)}) ${pv.esPueblerino ? '<span class="ok">es Pueblerino</span>' : '<span class="tenue">no es Pueblerino</span>'}.${pv.emborrachado ? '<br><span class="aviso">⚠️ La Virgen está borracha.</span>' : ''}
          <div class="btns">${btn('virgen', '⚖️ Ejecutar al nominador', 'data-v="1"', 'peligro')}${btn('virgen', 'No pasa nada', 'data-v="0"')}</div>`;
      } else h += `<div class="btns">${btn('iniciarVoto', '⏱️ Iniciar votación ya', '', 'primario')}${btn('cancelarVoto', '↩️ Cancelar')}</div>`;
      h += '</div>';
      break;
    }
    case 'votando':
      h += `<div class="it"><b>🗳️ Votación en curso</b> — ${S.voto.contados.length} / ${S.voto.umbral} votos<div class="btns">${btn('cancelarVoto', '↩️ Cancelar votación', '', 'peligro')}</div></div>`;
      break;
    case 'fin':
      h += `<div class="it"><b>${S.ganador === 'bien' ? '🏆 Ganan los buenos' : '💀 Ganan los malos'}</b><br><small>${esc(S.motivo || '')}</small><div class="btns">${btn('lobby', '↩️ Volver a la sala', '', 'primario')}</div></div>`;
      break;
  }
  if (['dia', 'nominaciones'].includes(S.fase) && S.nominaciones.length) h += htmlNominaciones();
  return h;
}

function htmlBloque() {
  const b = S.bloque;
  if (!b) return '<br><small>Nadie está a punto de morir.</small>';
  return b.empate ? '<br>⚖️ <span class="aviso">Empate a punto de morir: nadie sería ejecutado.</span>' : `<br>⚖️ A punto de morir: <b>${esc(nom(b.id))}</b> (${b.votos} votos)`;
}
function htmlNominaciones() {
  return `<div class="it"><b>Nominaciones de hoy</b><br>${S.nominaciones.map(n => `${esc(nom(n.por))} → <b>${esc(nom(n.a))}</b>: ${n.votos}/${n.umbral} ${n.exito ? '✅' : '❌'}`).join('<br>')}${htmlBloque()}</div>`;
}

function htmlPrimeraNoche(G) {
  const hay7 = S.asientos.length >= 7;
  let h = `<div class="it"><b>😈 Equipo malvado (primera noche)</b><div class="btns">${btn('aliados', '👁️ Que los malos se conozcan')}</div>`;
  if (hay7) {
    h += `<small>El Diablo aprende 3 roles buenos que NO están en juego:</small><br>${G.bluffs ? G.bluffs.map(r => `<span class="chip">${rolTxt(r)}</span>`).join('') : '<small>(sin generar)</small>'}
      <div class="btns">${btn('bluffs', '🎲 Generar', 'data-v="reroll"')}${G.bluffs ? btn('bluffs', '✉️ Enviar al Diablo', 'data-v="enviar"', 'primario') : ''}</div>`;
  } else h += '<small>Con menos de 7 jugadores no se enseñan roles al Diablo.</small>';
  return h + '</div>';
}

function htmlEntradaNoche(e) {
  const eleccion = e.eleccion, nombres = eleccion ? eleccion.map(nom).join(' y ') : null;
  let h = `<div class="it"><b>${e.orden}. ${esc(e.nombre)}</b> — ${rolTxt(e.rol)}${e.rol !== e.real ? ` <small>(en realidad ${rolTxt(e.real)})</small>` : ''}${e.despierto ? ' 🌙 <small class="ok">despierto</small>' : e.hecho ? ' <small class="ok">✔ hecho</small>' : ''}`;
  if (e.borracho) h += '<br><span class="aviso">⚠️ Borracho/emborrachado: puedes darle información falsa.</span>';
  if (e.elige) h += `<br>Elección: ${nombres ? `<b>${esc(nombres)}</b>` : '<span class="tenue">aún no ha elegido</span>'}`;
  if (['monje', 'alquimista', 'mayordomo'].includes(e.rol) && eleccion) h += '<br><small>Ficha colocada sola en el asiento elegido; quítala si no debe contar.</small>';
  h += `<div class="btns">${e.despierto ? btn('dormir', '😴 Dormir', `data-id="${e.id}"`, 'on') : btn('despertar', '👁️ Despertar', `data-id="${e.id}"`)}${e.rol === 'espia' ? btn('espia', '🕵️ Mostrar Grimorio', `data-id="${e.id}"`) : ''}</div>`;
  if (e.rol === 'colgado') h += htmlColgado(e);
  const k = 'info:' + e.id;
  h += `<textarea data-draft="${k}" rows="2" placeholder="Información para ${esc(e.nombre)}…">${esc(borradores[k] || '')}</textarea>
    <div class="btns">${btn('sugerir', '💡 Sugerir', `data-id="${e.id}"`)}${btn('info', '✉️ Enviar', `data-id="${e.id}"`, 'primario')}</div></div>`;
  return h;
}

function htmlColgado(e) {
  const t = e.eleccion && e.eleccion[0], tp = t && pj(t);
  if (!tp) return '';
  const notas = [];
  if (t === e.id) notas.push('Se ha elegido a sí mismo: un Esbirro hereda el puesto.');
  if (tiene(tp, 'proteccion')) notas.push('🔰 Protegido por el Monje.');
  if (tp.rol === 'soldado') notas.push('🪖 Es el Soldado: está a salvo del Diablo.');
  if (tp.rol === 'alcalde' || tiene(tp, 'no_muere')) notas.push('🏛️ Alcalde / "No puede morir": otro jugador puede morir en su lugar.');
  if (e.borracho) notas.push('⚠️ El Colgado está borracho: no mata.');
  let h = notas.length ? `<div class="aviso">${notas.join('<br>')}</div>` : '';
  if (t === e.id) {
    const mins = S.jugadores.filter(p => p.vivo && p.rol && ROLES[p.rol].tipo === 'esbirro');
    h += mins.length ? `<div class="btns"><select data-draft="transfer">${mins.map(p => `<option value="${p.id}" ${(borradores.transfer | 0) === p.id ? 'selected' : ''}>${esc(p.nombre)} (${esc(ROLES[p.rol].nombre)})</option>`).join('')}</select>${btn('transferir', '🩸 Transferir y morir', `data-id="${e.id}"`, 'peligro')}</div>` : '<small>No hay Esbirros vivos.</small>';
  } else h += `<div class="btns">${btn('fichaMuerte', `🩸 Matar a ${esc(tp.nombre)}`, `data-id="${t}"`, 'peligro')}</div>`;
  return h;
}

function htmlAsiento(G) {
  const p = sel && pj(sel);
  if (!p) return det('asiento', '🪑 Asiento seleccionado', '<small>Toca un asiento del círculo para ver y editar su ficha.</small>', S.fase === 'lobby');
  const opts = sel2 => ['pueblerino', 'forastero', 'esbirro', 'diablo'].map(tp => `<optgroup label="${TIPO[tp]}s">${Object.entries(ROLES).filter(([, r]) => r.tipo === tp).map(([k, r]) => `<option value="${k}" ${k === sel2 ? 'selected' : ''}>${r.icono} ${r.nombre}</option>`).join('')}</optgroup>`).join('');
  let h = `<div class="it"><b>${esc(p.nombre)}</b> ${p.vivo ? '' : '💀 <small>(muerto)</small>'}${p.off ? ' 📴' : ''}<br>`;
  h += `<small>Rol:</small> <select data-chg="rolSeat" data-id="${p.id}"><option value="" ${p.rol ? '' : 'selected'}>— sin rol —</option>${opts(p.rol)}</select>`;
  if (p.rol === 'borracho') h += `<br><small>Cree ser:</small> <select data-chg="cree" data-id="${p.id}">${Object.entries(ROLES).filter(([, r]) => r.tipo === 'pueblerino').map(([k, r]) => `<option value="${k}" ${k === p.cree ? 'selected' : ''}>${r.icono} ${r.nombre}</option>`).join('')}</select>`;
  h += `<br><small>Sala de voz:</small> <select data-chg="sala" data-id="${p.id}">${S.salas.map(sa => `<option value="${sa.id}" ${sa.id === p.sala ? 'selected' : ''}>${esc(sa.nombre)}</option>`).join('')}</select>`;
  h += '<div class="btns">';
  if (S.fase === 'lobby') h += btn('mover', '◀', 'data-v="-1"', 'mini') + btn('mover', '▶', 'data-v="1"', 'mini');
  else {
    h += p.vivo ? btn('matar', '☠️ Matar', '', '') : btn('revivir', '✨ Revivir');
    if (p.vivo && ['dia', 'nominaciones'].includes(S.fase)) h += btn('ejecutar', '⚖️ Ejecutar', '', 'peligro');
    h += btn('susurro', '🗣️ Mensaje privado');
  }
  h += '</div>';
  if (S.fase !== 'lobby') {
    h += `<div>${(p.fichas || []).length ? p.fichas.map(f => `<span class="chip" title="${esc(FICHAS[f].nombre)}">${FICHAS[f].icono} ${esc(FICHAS[f].nombre)}<button data-act="quitarFicha" data-v="${f}" aria-label="Quitar">✕</button></span>`).join('') : '<small>Sin fichas.</small>'}</div>
      <div class="btns">${G.fichasDisp.map(f => btn('ponerFicha', `${FICHAS[f].icono}`, `data-v="${f}" title="Poner: ${esc(FICHAS[f].nombre)}"`, 'mini')).join('')}</div>`;
  }
  return det('asiento', '🪑 Asiento seleccionado', h + '</div>', true);
}

function htmlFichas(G) {
  const cuerpo = `<small>Toca una ficha y luego un asiento para colocarla. Las fichas de Muerto matan al amanecer (de noche) o al instante (de día).</small>
    <div class="btns">${G.fichasDisp.map(f => btn('armar', `${FICHAS[f].icono} ${esc(FICHAS[f].nombre)}`, `data-v="${f}"`, armada === f ? 'on' : '')).join('')}</div>`;
  return det('fichas', '🎴 Bandeja de fichas', cuerpo);
}

function htmlExtras() {
  const fin = S.fase !== 'lobby' && S.fase !== 'fin';
  return det('extras', '🛠️ Mesa', `<div class="btns">${btn('anuncio', '📜 Anuncio público')}${btn('silencio', S.silencio ? '🔊 Dejar hablar a todos' : '🤫 Silenciar a los jugadores', '', S.silencio ? 'on' : '')}</div>
    ${fin ? `<div class="btns">${btn('terminar', 'Fin: ganan los buenos', 'data-v="bien"')}${btn('terminar', 'Fin: ganan los malos', 'data-v="mal"')}</div>` : ''}`);
}

function htmlAjustes() {
  const a = S.ajustes;
  return det('ajustes', '⚙️ Ajustes', `<div style="display:grid;gap:.4rem;font-size:.85rem">
    <label class="fila">Tiempo de debate (s, 0 = sin límite) <input type="number" min="0" max="1800" step="30" value="${a.charla}" data-chg="ajuste" data-k="charla" style="width:80px"></label>
    <label class="fila">Tiempo de defensa (s, 0 = manual) <input type="number" min="0" max="300" step="5" value="${a.defensa}" data-chg="ajuste" data-k="defensa" style="width:80px"></label>
    <label class="fila">Segundos por jugador en la votación <input type="number" min="2" max="15" value="${a.paso}" data-chg="ajuste" data-k="paso" style="width:80px"></label>
    <label class="fila">Mayoría absoluta
      <select data-chg="ajuste" data-k="umbral"><option value="mas1" ${a.umbral === 'mas1' ? 'selected' : ''}>mitad de vivos + 1</option><option value="mitad" ${a.umbral === 'mitad' ? 'selected' : ''}>la mitad de vivos (redondeo arriba)</option></select></label>
    <label class="fila"><input type="checkbox" ${a.finAuto ? 'checked' : ''} data-chg="finAuto"> Terminar la partida automáticamente al cumplirse una victoria</label>
    <label class="fila"><input type="checkbox" ${a.salasAbiertas ? 'checked' : ''} data-chg="salasAbiertas"> Permitir salas de voz privadas</label>
    <label class="fila"><input type="checkbox" ${a.salasNom ? 'checked' : ''} data-chg="salasNom"> Mantener las salas durante las nominaciones</label></div>`);
}

// ═════ panel del jugador ═════
function htmlJugador() {
  const p = pj(yo);
  let h = htmlComposicion() + htmlSalas() + '<h3>Tu ficha</h3>';
  if (p && p.rol && S.fase !== 'lobby') {
    const r = ROLES[p.rol], bando = r.equipo;
    h += `<div class="tarjeta ${bando === 'mal' ? 'mal' : 'bien'}"><div class="fila"><span class="ic">${r.icono}</span><div><b style="font-size:1.1rem">${r.nombre}</b><br><small>${TIPO[r.tipo]} · ${bando === 'mal' ? 'bando malvado' : 'bando bueno'}</small></div></div>
      <p style="margin:.6rem 0 0;font-size:.9rem;line-height:1.45">${esc(r.desc)}</p></div>`;
  } else h += '<div class="tarjeta"><small>El Narrador repartirá las fichas al empezar. Solo tú verás la tuya.</small></div>';
  if (p && !p.vivo) h += `<div class="aviso" style="margin-bottom:.6rem">💀 Estás muerto. No puedes nominar, pero conservas ${p.votoFantasma ? '<b>1 voto</b> (🗳️)' : 'ningún voto: ya lo gastaste'}.</div>`;
  h += `<h3>✉️ Información del Narrador</h3>${infos.length ? infos.map(i => `<div class="it"><small>${esc(i.momento)}</small><br>${esc(i.texto)}</div>`).join('') : '<small>Todavía nada.</small>'}`;
  if (S.nominaciones.length || S.bloque) h += `<h3 style="margin-top:.9rem">⚖️ Nominaciones de hoy</h3>${htmlNominaciones().replace('<div class="it"><b>Nominaciones de hoy</b><br>', '<div class="it">')}`;
  h += `<h3 style="margin-top:.9rem">Cómo se juega</h3><small style="line-height:1.5">De noche el Narrador despierta a quien tenga habilidad. De día hablad y buscad al Diablo. Cuando se abran las nominaciones, toca a un jugador y pulsa <b>Nominar</b>. En la votación levanta la mano: tu voto cuenta cuando la manecilla te señale.</small>`;
  return h;
}

// ───────── barra de acciones (jugador) ─────────
function renderBarra() {
  const b = $('#barra'), h = htmlBarra();
  b.innerHTML = h; b.hidden = !h;
}
function htmlBarra() {
  if (soyNar) return armada ? `<h4>Ficha armada: ${FICHAS[armada].icono} ${esc(FICHAS[armada].nombre)}</h4><small>Toca un asiento para colocarla.</small><div class="fila" style="margin-top:.4rem">${btn('desarmar', 'Cancelar')}</div>` : '';
  const p = pj(yo); if (!p) return '';
  if (despertar) {
    const n = despertar.n;
    if (n > 0) return `<h4>🌙 ${esc(despertar.texto)}</h4><div>Elegidos: ${elegidos.length ? elegidos.map(i => `<span class="chip">${esc(nom(i))}</span>`).join('') : '<small>toca a los jugadores en el círculo</small>'}</div>
      <div class="fila" style="margin-top:.5rem">${btn('confirmarEleccion', `Confirmar (${elegidos.length}/${n})`, elegidos.length === n ? '' : 'disabled', 'primario')}</div>${eleccionEnviada ? '<small class="ok">✔ Enviada (puedes cambiarla)</small>' : ''}`;
    return `<h4>🌙 ${esc(despertar.texto)}</h4><small>Puedes hablar con el Narrador.</small>`;
  }
  if (S.fase === 'votando') {
    const puede = p.vivo || p.votoFantasma;
    return `<h4>🗳️ Votación contra ${esc(nom(S.voto.nominado))}</h4>${puede ? `<div class="fila">${btn('mano', p.mano ? '✋ Bajar la mano' : '✋ Levantar la mano', '', p.mano ? 'on' : 'primario')}</div><small>Tu voto cuenta cuando la manecilla te señale.</small>` : '<small>Ya no te queda voto.</small>'}`;
  }
  let h = '';
  const t = sel && pj(sel);
  if (S.fase === 'nominaciones' && p.vivo && !S.nominadores.includes(yo)) {
    const ok = t && t.vivo && !S.nominados.includes(t.id);
    h += `<h4>📣 Nominaciones</h4>${t ? `<div class="fila">${btn('nominar', `Nominar a ${esc(t.nombre)}`, ok ? '' : 'disabled', 'primario')}</div>${!t.vivo ? '<small>Solo se puede nominar a jugadores vivos.</small>' : S.nominados.includes(t.id) ? '<small>Ya ha sido nominado hoy.</small>' : ''}` : '<small>Toca a un jugador para nominarlo.</small>'}`;
  } else if (S.fase === 'nominaciones' && p.vivo) h += '<h4>📣 Nominaciones</h4><small>Ya has nominado hoy.</small>';
  if (p.vivo && ['dia', 'nominaciones'].includes(S.fase) && p.rol === 'cazador' && !cazadorUsado) {
    h += `<div class="fila" style="margin-top:.5rem">${btn('cazar', t ? `🏹 Disparar a ${esc(t.nombre)}` : '🏹 Disparar (elige a un jugador)', t ? '' : 'disabled', 'peligro')}</div>`;
  }
  return h;
}

// ───────── modales (fin de partida y Grimorio del Espía) ─────────
function renderModal() {
  const m = $('#modal'), c = m.firstElementChild;
  if (S.fase === 'fin') {
    const bien = S.ganador === 'bien';
    c.innerHTML = `<h2 style="color:${bien ? 'var(--musgo)' : 'var(--sangre)'}">${bien ? 'Ganan los buenos' : 'Ganan los malos'}</h2><p class="tenue">${esc(S.motivo || '')}</p>
      <table class="grim">${S.jugadores.map(p => `<tr><td>${p.vivo ? '' : '💀 '}${esc(p.nombre)}</td><td>${p.rol ? rolTxt(p.rol) : ''}</td></tr>`).join('')}</table>
      <div style="margin-top:1rem">${soyNar ? btn('lobby', '↩️ Volver a la sala', '', 'primario') : '<small>Esperando al Narrador…</small>'}</div>`;
    m.hidden = false;
  } else if (espia) {
    c.innerHTML = `<h2>🕵️ El Grimorio</h2><table class="grim">${espia.map(f => `<tr><td>${f.vivo ? '' : '💀 '}${esc(f.nombre)}</td><td>${esc(f.rol)}${f.cree ? `<br><small>cree ser ${esc(f.cree)}</small>` : ''}</td><td>${f.fichas.map(esc).join('<br>')}</td></tr>`).join('')}</table>
      <div style="margin-top:1rem">${btn('cerrarEspia', 'Cerrar', '', 'primario')}</div>`;
    m.hidden = false;
  } else m.hidden = true;
}
$('#modal').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) ACT[b.dataset.act] && ACT[b.dataset.act](b.dataset, b); });

// ═════════ acciones ═════════
const draft = id => (borradores['info:' + id] || '').trim();
const ACT = {
  // preparación
  sugerirRoles: () => enviar({ t: 'sugerirRoles' }),
  sortear: () => enviar({ t: 'sortear' }),
  barajar: () => enviar({ t: 'barajar' }),
  iniciar: () => enviar({ t: 'iniciar' }),
  mover: d => sel && enviar({ t: 'moverAsiento', id: sel, dir: +d.v }),
  // fases
  amanecer: () => enviar({ t: 'amanecer' }),
  abrirNom: () => enviar({ t: 'abrirNominaciones' }),
  extender: d => enviar({ t: 'extender', seg: +d.v }),
  terminarDia: () => enviar({ t: 'terminarDia' }),
  iniciarVoto: () => enviar({ t: 'iniciarVoto' }),
  cancelarVoto: () => enviar({ t: 'cancelarVoto' }),
  virgen: d => enviar({ t: 'virgen', ejecutar: d.v === '1' }),
  cazador: d => enviar({ t: 'cazador', matar: d.v === '1' }),
  lobby: () => enviar({ t: 'lobby' }),
  terminar: d => confirm('¿Terminar la partida ahora?') && enviar({ t: 'terminar', ganador: d.v }),
  anuncio: () => { const t = window.prompt('Anuncio para todos los jugadores:'); if (t) enviar({ t: 'anuncio', texto: t }); },
  silencio: () => enviar({ t: 'silencio', on: !S.silencio }),
  // noche
  despertar: d => enviar({ t: 'despertar', id: +d.id }),
  dormir: d => enviar({ t: 'dormir', id: +d.id }),
  sugerir: d => enviar({ t: 'sugerir', id: +d.id }),
  info: d => { const t = draft(d.id); if (!t) return toast('Escribe la información primero.'); enviar({ t: 'info', id: +d.id, texto: t }); borradores['info:' + d.id] = ''; render(); },
  espia: d => enviar({ t: 'grimorioEspia', id: +d.id }),
  aliados: () => enviar({ t: 'aliados' }),
  bluffs: d => enviar({ t: 'bluffs', reroll: d.v === 'reroll', enviar: d.v === 'enviar' }),
  fichaMuerte: d => enviar({ t: 'ficha', id: +d.id, ficha: 'muerto_diablo', accion: 'poner' }),
  transferir: d => {
    const m = +(borradores.transfer || document.querySelector('[data-draft="transfer"]')?.value || 0);
    if (!m) return;
    enviar({ t: 'cambiarRol', id: m, rol: 'colgado' });
    enviar({ t: 'ficha', id: +d.id, ficha: 'muerto_diablo', accion: 'poner' });
  },
  // asiento / fichas
  matar: () => sel && enviar({ t: 'matar', id: sel }),
  revivir: () => sel && enviar({ t: 'revivir', id: sel }),
  ejecutar: () => sel && confirm(`¿Ejecutar a ${nom(sel)}?`) && enviar({ t: 'ejecutar', id: sel }),
  susurro: () => { if (!sel) return; const t = window.prompt(`Mensaje privado para ${nom(sel)}:`); if (t) enviar({ t: 'susurro', id: sel, texto: t }); },
  quitarFicha: d => sel && enviar({ t: 'ficha', id: sel, ficha: d.v, accion: 'quitar' }),
  ponerFicha: d => sel && enviar({ t: 'ficha', id: sel, ficha: d.v, accion: 'poner' }),
  armar: d => { armada = armada === d.v ? null : d.v; render(); },
  desarmar: () => { armada = null; render(); },
  // salas de voz
  unirSala: d => enviar({ t: 'sala', sala: d.id }),
  salaCrear: () => { const t = window.prompt('Nombre de la nueva sala:'); if (t) enviar({ t: 'salaCrear', nombre: t }); },
  salaBorrar: d => confirm('¿Borrar esta sala? Sus ocupantes vuelven a la Plaza.') && enviar({ t: 'salaBorrar', id: d.id }),
  salaRen: d => { const t = window.prompt('Nuevo nombre de la sala:'); if (t) enviar({ t: 'salaRenombrar', id: d.id, nombre: t }); },
  megafono: () => enviar({ t: 'megafono', on: !S.megafono }),
  // jugador
  confirmarEleccion: () => enviar({ t: 'elegir', targets: elegidos }),
  nominar: () => sel && enviar({ t: 'nominar', target: sel }),
  mano: () => { const p = pj(yo); enviar({ t: 'mano', alzada: !p.mano }); },
  cazar: () => { if (!sel) return; if (confirm(`¿Disparar a ${nom(sel)}? Solo puedes hacerlo una vez.`)) { enviar({ t: 'cazar', target: sel }); cazadorUsado = true; render(); } },
  cerrarEspia: () => { espia = null; render(); }
};
const CHG = {
  rol: () => enviar({ t: 'config', roles: [...document.querySelectorAll('#lateral [data-chg="rol"]:checked')].map(e => e.value) }),
  rolSeat: (d, el) => el.value && enviar({ t: 'cambiarRol', id: +d.id, rol: el.value }),
  cree: (d, el) => enviar({ t: 'cree', id: +d.id, rol: el.value }),
  ajuste: (d, el) => enviar({ t: 'config', [d.k]: el.value }),
  finAuto: (d, el) => enviar({ t: 'config', finAuto: el.checked }),
  salasAbiertas: (d, el) => enviar({ t: 'config', salasAbiertas: el.checked }),
  salasNom: (d, el) => enviar({ t: 'config', salasNom: el.checked }),
  sala: (d, el) => enviar({ t: 'moverJugador', id: +d.id, sala: el.value })
};

// ═════════ reloj, micrófono y voz ═════════
$('#mic').onclick = () => { silenciado = !silenciado; aplicarMic(); };
function aplicarMic() { if (!micTrack) return; micTrack.enabled = !silenciado; $('#mic').textContent = silenciado ? '🔇' : '🎙️'; }
setInterval(() => {
  if (!S) return;
  $('#reloj').textContent = S.deadline ? Math.max(0, Math.ceil((S.deadline - S.ahora) / 1000 - (performance.now() - S._rx) / 1000)) + 's' : '';
}, 250);

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
function gestionarPeers() {
  const activos = new Set([S.narrador.id, ...S.jugadores.filter(q => !q.off).map(q => q.id)]); activos.delete(yo);
  for (const id of activos) if (!peers.has(id)) crearPeer(id);
  for (const [id, p] of peers) if (!activos.has(id)) { p.pc.close(); if (p.el) p.el.srcObject = null; peers.delete(id); }
}
function crearPeer(id) {
  const pc = new RTCPeerConnection(ICE);
  const peer = { id, pc, chain: Promise.resolve(), nodes: null, sender: null, emite: true };
  peers.set(id, peer);
  pc.onicecandidate = e => { if (e.candidate) enviar({ t: 'rtc', to: id, data: { cand: e.candidate } }); };
  pc.ontrack = e => montarAudio(peer, e.streams[0] || new MediaStream([e.track]));
  if (micTrack) peer.sender = pc.addTrack(micTrack, micStream);
  if (yo < id) { // el de id menor inicia la negociación
    if (!micTrack) pc.addTransceiver('audio', { direction: 'recvonly' });
    peer.chain = peer.chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      enviar({ t: 'rtc', to: id, data: { desc: pc.localDescription } });
    }).catch(console.warn);
  }
  return peer;
}
function señal(from, data) {
  const peer = peers.get(from) || crearPeer(from), pc = peer.pc;
  peer.chain = peer.chain.then(async () => {
    if (data.desc) {
      await pc.setRemoteDescription(data.desc);
      if (data.desc.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); enviar({ t: 'rtc', to: from, data: { desc: pc.localDescription } }); }
    } else if (data.cand) { try { await pc.addIceCandidate(data.cand); } catch (_) { /* candidato tardío */ } }
  }).catch(console.warn);
}
function montarAudio(peer, stream) {
  const el = new Audio(); el.srcObject = stream; el.muted = true; el.play().catch(() => {}); peer.el = el; // necesario en Chrome
  const src = audioCtx.createMediaStreamSource(stream);
  const g = audioCtx.createGain(); g.gain.value = 0;
  src.connect(g); g.connect(audioCtx.destination);
  peer.nodes = { g };
  actualizarVoz();
}
const rms = (an, buf) => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) { const x = (v - 128) / 128; s += x * x; } return Math.sqrt(s / buf.length); };

// ── Quién oye a quién ──
//  · De noche: el Narrador solo habla con el jugador al que ha despertado. Entre jugadores, nadie.
//  · De día: se oye a los que están en tu misma sala de voz. Si las salas están en pausa
//    (p. ej. durante las nominaciones), todos se oyen. El Narrador puede hablar a todos (📢) o silenciar a los jugadores.
const despiertoDe = id => soyNar ? S.grim.despiertos.includes(id) : (id === yo && S.yo.despierto);
const salaDe = id => id === S.narrador.id ? S.narrador.sala : (pj(id) || {}).sala;
function oye(emisor, oyente) {
  const nar = S.narrador.id;
  if (S.fase === 'noche') {
    if (emisor === nar) return oyente !== nar && despiertoDe(oyente);
    if (oyente === nar) return despiertoDe(emisor);
    return false;
  }
  if (emisor !== nar && S.silencio) return false;
  if (emisor === nar && S.megafono) return true;
  if (!S.salasActivas) return true;
  return salaDe(emisor) === salaDe(oyente);
}
// Privacidad real: el micrófono solo se ENVÍA a quien debe oírte (no basta con bajar el volumen al recibir).
function actualizarEmision() {
  if (!S || !micTrack) return;
  for (const peer of peers.values()) {
    const ok = oye(yo, peer.id);
    if (peer.emite !== ok) { peer.emite = ok; if (peer.sender) peer.sender.replaceTrack(ok ? micTrack : null).catch(() => {}); }
  }
}
function actualizarVoz() {
  if (!S) return;
  const t = audioCtx.currentTime;
  for (const peer of peers.values()) if (peer.nodes) peer.nodes.g.gain.setTargetAtTime(oye(peer.id, yo) ? 1 : 0, t, 0.05);
}

// ── Indicador de "está hablando" (lo ven todos, estén o no en la sala) ──
const hablando = id => hablandoSet.has(id);
function pintarHabla() {
  document.querySelectorAll('#asientos .asiento').forEach(a => a.classList.toggle('habla', hablandoSet.has(+a.dataset.id)));
  document.querySelectorAll('#lateral [data-hab]').forEach(c => c.classList.toggle('habla', hablandoSet.has(+c.dataset.hab)));
}
setInterval(() => {
  if (!S) return;
  actualizarVoz();
  if (!localAn || !micTrack) return;
  const now = performance.now();
  if (micTrack.enabled && rms(localAn, localBuf) > 0.025) ultimoVoz = now;
  const puede = S.fase !== 'noche' && !(S.silencio && !soyNar);
  const on = puede && now - ultimoVoz < 300;
  if (on !== yoHabla) { yoHabla = on; enviar({ t: 'habla', on }); }
}, 120);
addEventListener('resize', () => S && render());
