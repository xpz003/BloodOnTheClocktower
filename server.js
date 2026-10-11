'use strict';
// Aldea de Sombras — servidor (Express + WebSocket)
// Un Narrador (el que crea la sala) dirige la partida; los jugadores se sientan en un círculo.
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { ROLES, FICHAS, DISTRIBUCION } = require('./roles.js');

const PORT = process.env.PORT || 3000;
const MIN_JUGADORES = 3, MAX_JUGADORES = 15;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();
let nextId = 1;

// ───────── utilidades ─────────
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const azar = a => a[Math.floor(Math.random() * a.length)];
const num = (v, lo, hi, d) => { v = parseInt(v); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)); };
const todos = room => [...room.players.values()];
const jugadores = room => room.asientos.map(id => room.players.get(id)).filter(Boolean); // en orden del círculo
const vivos = room => jugadores(room).filter(p => p.vivo);
const vista = p => p.cree || p.rol;                  // rol que el jugador CREE tener (Borracho)
const tipo = p => ROLES[p.rol].tipo;
const equipo = p => ROLES[p.rol].equipo;
const tiene = (p, f) => p.fichas.includes(f);
const narradorDe = room => room.players.get(room.narrador);
const bcast = (room, o) => todos(room).forEach(p => !p.off && send(p.ws, o));
const anunciar = (room, texto) => bcast(room, { t: 'msg', texto });
const aviso = (room, texto) => { const n = narradorDe(room); if (n) send(n.ws, { t: 'msg', texto, privado: true }); };
const err = (ws, texto) => send(ws, { t: 'error', texto });
const momento = room => room.fase === 'noche' ? `Noche ${room.n}` : room.fase === 'lobby' ? 'Preparación' : `Día ${room.dia}`;
const limpiar = (t, n) => String(t || '').replace(/[<>&"]/g, '').trim().slice(0, n);
// Las salas privadas funcionan de día y, durante las nominaciones, solo si el Narrador lo permite
const salasActivas = room => room.fase === 'noche' ? false : ['nominaciones', 'defensa', 'votando'].includes(room.fase) ? room.ajustes.salasNom : true;
const registrar = (room, texto) => { room.eventos.push(`${momento(room)}: ${texto}`); if (room.eventos.length > 150) room.eventos.shift(); };

function nuevoCodigo() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join(''); } while (rooms.has(c));
  return c;
}

// ───────── roles en juego, fichas y reparto ─────────
const rolesAsignados = room => jugadores(room).map(p => p.rol).filter(Boolean);
const rolesEnJuego = room => room.fase === 'lobby' && !rolesAsignados(room).length ? room.rolesElegidos : rolesAsignados(room);

function fichasDisponibles(room) {
  const set = new Set(['muerto']);
  for (const r of rolesEnJuego(room)) (ROLES[r].fichas || []).forEach(f => set.add(f));
  return [...set];
}

// Fichas que aparecen solas: "Es el Borracho" y "Señuelo"
function repartoFichas(room) {
  const ps = jugadores(room).filter(p => p.rol);
  for (const p of ps) {
    p.fichas = p.fichas.filter(f => f !== 'borracho_es' || p.rol === 'borracho');
    if (p.rol === 'borracho' && !tiene(p, 'borracho_es')) p.fichas.push('borracho_es');
    if (p.rol !== 'borracho') p.cree = null;
  }
  if (!ps.some(p => p.rol === 'adivina')) ps.forEach(p => { p.fichas = p.fichas.filter(f => f !== 'senuelo'); });
  else if (!ps.some(p => tiene(p, 'senuelo'))) {
    const buenos = ps.filter(p => equipo(p) === 'bien');
    if (buenos.length) azar(buenos).fichas.push('senuelo');
  }
}
function asignarCree(room) {
  const enJuego = new Set(rolesAsignados(room));
  for (const p of jugadores(room)) {
    if (p.rol === 'borracho' && !p.cree) {
      const libres = Object.keys(ROLES).filter(r => ROLES[r].tipo === 'pueblerino' && !enJuego.has(r));
      p.cree = azar(libres.length ? libres : Object.keys(ROLES).filter(r => ROLES[r].tipo === 'pueblerino'));
    }
  }
}

function sugerirRoles(n) {
  const clave = Math.max(3, Math.min(15, n));
  let [T, O, M, D] = DISTRIBUCION[clave];
  const pick = (tp, k) => shuffle(Object.keys(ROLES).filter(r => ROLES[r].tipo === tp)).slice(0, Math.max(0, k));
  const esbirros = pick('esbirro', M);
  if (esbirros.includes('baron')) { T -= 2; O += 2; }
  return [...pick('pueblerino', T), ...pick('forastero', O), ...esbirros, ...pick('diablo', D)];
}

// ───────── estado enviado a cada cliente ─────────
function listaNoche(room) {
  const out = [], primera = room.n === 1;
  for (const p of jugadores(room)) {
    const r = vista(p), d = ROLES[r].noche;
    if (!d || !p.vivo) continue;
    const muertoPend = tiene(p, 'muerto') || tiene(p, 'muerto_diablo');
    const cond = d.alMorir ? muertoPend : (primera ? d.primera : d.otras);
    if (!cond) continue;
    out.push({
      id: p.id, nombre: p.nombre, rol: r, real: p.rol,
      borracho: p.rol === 'borracho' || tiene(p, 'emborrachado'),
      orden: primera ? (d.ordenPrimera || 99) : (d.ordenOtras || 99),
      elige: d.elige || 0, despierto: room.despiertos.has(p.id), hecho: room.hechos.has(p.id),
      eleccion: room.elecciones[p.id] || null
    });
  }
  return out.sort((a, b) => a.orden - b.orden);
}

function grimorio(room) {
  return {
    rolesElegidos: room.rolesElegidos, enJuego: rolesEnJuego(room), fichasDisp: fichasDisponibles(room),
    lista: room.fase === 'noche' ? listaNoche(room) : [],
    despiertos: [...room.despiertos], elecciones: room.elecciones,
    virgen: room.pendienteVirgen, cazador: room.pendienteCazador, bluffs: room.bluffs,
    eventos: room.eventos.slice(-60)
  };
}

function estado(room, para) {
  const nar = para.id === room.narrador, fin = room.fase === 'fin';
  const n = narradorDe(room), v = room.voto;
  const out = {
    t: 'estado', ahora: Date.now(), fase: room.fase, n: room.n, dia: room.dia, deadline: room.deadline,
    narrador: { id: n.id, nombre: n.nombre, sala: n.sala }, yo: { id: para.id, nar, despierto: room.despiertos.has(para.id) },
    ajustes: room.ajustes, silencio: room.silencio, asientos: room.asientos.slice(),
    salas: room.salas, salasActivas: salasActivas(room), megafono: room.megafono, composicion: room.composicion,
    hablando: room.fase === 'noche' ? [] : todos(room).filter(p => p.habla && !p.off).map(p => p.id),
    jugadores: jugadores(room).map(p => ({
      id: p.id, nombre: p.nombre, vivo: p.vivo, off: p.off, mano: p.mano, votoFantasma: p.votoFantasma, sala: p.sala,
      rol: nar || fin ? p.rol || undefined : (p.id === para.id && p.rol && room.fase !== 'lobby' ? vista(p) : undefined),
      cree: nar ? p.cree || undefined : undefined,
      fichas: nar ? p.fichas : undefined
    })),
    nominaciones: room.nominaciones, bloque: room.bloque,
    nominadores: [...room.nominadores], nominados: [...room.nominados], actual: room.nominacionActual,
    voto: v ? { nominado: v.nominado, nominador: v.nominador, orden: v.orden, idx: v.idx, inicio: v.inicio, paso: v.paso, contados: v.contados, umbral: v.umbral } : null,
    ganador: room.ganador, motivo: room.motivo
  };
  if (nar) out.grim = grimorio(room);
  return out;
}
const enviarEstado = room => todos(room).forEach(p => !p.off && send(p.ws, estado(room, p)));

function setFase(room, fase, seg, alAcabar) {
  clearTimeout(room.timer);
  room.fase = fase;
  room.deadline = seg ? Date.now() + seg * 1000 : 0;
  if (seg && alAcabar) room.timer = setTimeout(() => { try { alAcabar(); } catch (e) { console.error(e); } }, seg * 1000);
  enviarEstado(room);
}

// ───────── muertes, ejecuciones y fin de partida ─────────
function morir(room, p) {
  const antes = vivos(room).length;
  const eraDiablo = tipo(p) === 'diablo';
  p.vivo = false; p.mano = false;
  if (!tiene(p, 'muerto')) p.fichas.push('muerto');
  if (eraDiablo) { // el Canciller hereda el puesto de Diablo si hay 5 o más jugadores vivos
    const c = vivos(room).find(q => q.rol === 'canciller' && !tiene(q, 'emborrachado'));
    if (c && antes >= 5) {
      c.rol = p.rol; c.cree = null;
      send(c.ws, { t: 'info', texto: `Has heredado el puesto de Diablo: ahora eres ${ROLES[c.rol].nombre} ${ROLES[c.rol].icono}.`, momento: momento(room) });
      registrar(room, `${c.nombre} (Canciller) se convierte en ${ROLES[c.rol].nombre}.`);
      aviso(room, `🌹 ${c.nombre} (Canciller) se ha convertido en ${ROLES[c.rol].nombre}.`);
    }
  }
}

function ejecutar(room, p) {
  room.ejecutadoHoy = { id: p.id, rol: p.rol };
  morir(room, p);
  anunciar(room, `⚖️ ${p.nombre} ha sido ejecutado.`);
  registrar(room, `${p.nombre} (${ROLES[p.rol].nombre}) fue ejecutado.`);
  if (p.rol === 'santo' && !tiene(p, 'emborrachado')) room.santoEjecutado = true;
}

function evaluarFin(room, mayor) {
  const v = vivos(room);
  if (!v.some(p => tipo(p) === 'diablo')) return { g: 'bien', m: 'El Diablo ha muerto.' };
  if (room.santoEjecutado) return { g: 'mal', m: 'El Santo ha sido ejecutado.' };
  if (v.length <= 2) return { g: 'mal', m: 'Quedan 2 jugadores vivos y el Diablo sigue vivo.' };
  if (mayor && v.length === 3 && v.some(p => p.rol === 'alcalde' && !tiene(p, 'emborrachado'))) return { g: 'bien', m: 'Alcalde: quedan 3 vivos y nadie ha sido ejecutado.' };
  return null;
}
function comprobarFin(room, mayor) {
  if (room.fase === 'lobby' || room.fase === 'fin') return false;
  const r = evaluarFin(room, mayor);
  room.santoEjecutado = false;
  if (!r) return false;
  if (room.ajustes.finAuto) { finPartida(room, r.g, r.m); return true; }
  aviso(room, `💡 Sugerencia: ${r.g === 'bien' ? 'ganan los buenos' : 'ganan los malos'} — ${r.m} (usa "Terminar partida" si estás de acuerdo).`);
  return false;
}
function finPartida(room, g, motivo) {
  clearTimeout(room.timer);
  room.ganador = g; room.motivo = motivo || ''; room.voto = null; room.despiertos.clear();
  setFase(room, 'fin', 0);
  anunciar(room, g === 'bien' ? '🏆 ¡Ganan los buenos!' : '💀 ¡Ganan los malos!');
  registrar(room, `Fin de la partida: ${g}. ${motivo || ''}`);
}

// ───────── flujo de fases ─────────
function iniciar(room) {
  const ps = jugadores(room);
  const ws = narradorDe(room).ws;
  if (ps.length < MIN_JUGADORES) return err(ws, `Hacen falta al menos ${MIN_JUGADORES} jugadores (sin contar al Narrador).`);
  if (ps.some(p => !p.rol)) return err(ws, 'Todos los jugadores necesitan un rol. Elige roles y pulsa "Repartir fichas".');
  if (!ps.some(p => tipo(p) === 'diablo')) return err(ws, 'Tiene que haber al menos un Diablo.');
  ps.forEach(p => { p.vivo = true; p.mano = false; p.votoFantasma = true; });
  room.composicion = { pueblerino: 0, forastero: 0, esbirro: 0, diablo: 0 };
  ps.forEach(p => room.composicion[tipo(p)]++);
  room.n = 0; room.dia = 0; room.ganador = null; room.motivo = '';
  room.eventos = [];
  registrar(room, 'Comienza la partida.');
  empezarNoche(room);
}

function empezarNoche(room) {
  room.n++;
  room.despiertos.clear(); room.hechos.clear(); room.elecciones = {};
  room.nominaciones = []; room.nominadores.clear(); room.nominados.clear(); room.bloque = null;
  room.nominacionActual = null; room.voto = null; room.pendienteVirgen = null; room.pendienteCazador = null;
  jugadores(room).forEach(p => { p.mano = false; p.fichas = p.fichas.filter(f => f !== 'emborrachado'); });
  todos(room).forEach(p => { p.habla = false; });
  setFase(room, 'noche', 0);
  anunciar(room, `🌙 Cae la noche ${room.n}. Todos cierran los ojos.`);
  registrar(room, 'Empieza la noche.');
}

function amanecer(room) {
  if (room.fase !== 'noche') return;
  const muertos = [];
  for (const p of jugadores(room)) {
    if (p.vivo && (tiene(p, 'muerto') || tiene(p, 'muerto_diablo'))) { morir(room, p); muertos.push(p); }
    p.fichas = p.fichas.filter(f => f !== 'proteccion');
  }
  room.dia = room.n; room.despiertos.clear();
  todos(room).forEach(p => { p.sala = 'plaza'; }); // al amanecer todos vuelven a la plaza
  room.ejecutadoHoy = null; room.pendienteVirgen = null;
  anunciar(room, muertos.length ? `☀️ Amanece. Esta noche ${muertos.length > 1 ? 'murieron' : 'murió'}: ${muertos.map(p => p.nombre).join(', ')}.` : '☀️ Amanece. Nadie murió esta noche.');
  registrar(room, muertos.length ? `Amanecer: mueren ${muertos.map(p => p.nombre).join(', ')}.` : 'Amanecer: nadie muere.');
  const dur = room.ajustes.charla;
  setFase(room, 'dia', dur, () => abrirNominaciones(room));
  comprobarFin(room, false);
}

function abrirNominaciones(room) {
  if (room.fase !== 'dia') return;
  setFase(room, 'nominaciones', 0);
  anunciar(room, '📣 Se abren las nominaciones.');
}

function nominar(room, p, t) {
  room.nominadores.add(p.id); room.nominados.add(t.id);
  room.nominacionActual = { num: ++room.numNom, por: p.id, a: t.id };
  anunciar(room, `🗣️ ${p.nombre} nomina a ${t.nombre}.`);
  registrar(room, `${p.nombre} nomina a ${t.nombre}.`);
  if (t.rol === 'virgen' && !tiene(t, 'habilidad_usada')) {
    t.fichas.push('habilidad_usada');
    room.pendienteVirgen = { nominador: p.id, virgen: t.id, nominadorNombre: p.nombre, esPueblerino: p.rol === 'espia' ? true : tipo(p) === 'pueblerino', emborrachado: tiene(t, 'emborrachado') };
    setFase(room, 'defensa', 0); // en pausa hasta que el Narrador decida
    aviso(room, `👸 ${t.nombre} (Virgen) ha sido nominada por ${p.nombre}. Decide en el panel si el nominador es ejecutado.`);
  } else iniciarDefensa(room);
}

function iniciarDefensa(room) {
  const seg = room.ajustes.defensa;
  setFase(room, 'defensa', seg, () => iniciarVoto(room));
}

function iniciarVoto(room) {
  if (room.fase !== 'defensa' || room.pendienteVirgen || !room.nominacionActual) return;
  const a = room.nominacionActual;
  const ids = room.asientos.filter(id => room.players.has(id));
  const i0 = ids.indexOf(a.a);
  const orden = [...ids.slice(i0), ...ids.slice(0, i0)]; // sentido horario empezando por el nominado
  const vivosN = vivos(room).length;
  const umbral = room.ajustes.umbral === 'mitad' ? Math.ceil(vivosN / 2) : Math.floor(vivosN / 2) + 1;
  room.voto = { nominado: a.a, nominador: a.por, orden, idx: 0, inicio: Date.now(), paso: room.ajustes.paso, contados: [], umbral };
  jugadores(room).forEach(p => { p.mano = false; });
  setFase(room, 'votando', 0);
  room.timer = setTimeout(() => pasoVoto(room), room.voto.paso * 1000);
}

function puedeContar(room, q) {
  if (!q.mano || q.off) return false;
  if (!q.vivo && !q.votoFantasma) return false;
  if (q.rol === 'mayordomo') { // solo vota si su Maestro está votando
    const m = jugadores(room).find(x => tiene(x, 'maestro'));
    if (!m || !m.mano) return false;
  }
  return true;
}

function pasoVoto(room) {
  const v = room.voto;
  if (!v || room.fase !== 'votando') return;
  if (v.idx >= v.orden.length) return cerrarVoto(room);
  const q = room.players.get(v.orden[v.idx]);
  if (q && puedeContar(room, q)) { v.contados.push(q.id); if (!q.vivo) q.votoFantasma = false; }
  v.idx++;
  v.inicio = Date.now();
  enviarEstado(room);
  room.timer = setTimeout(() => pasoVoto(room), v.idx >= v.orden.length ? 1500 : v.paso * 1000);
}

function cerrarVoto(room) {
  const v = room.voto, n = room.players.get(v.nominado), por = room.players.get(v.nominador);
  const votos = v.contados.length, exito = votos >= v.umbral;
  room.nominaciones.push({ num: room.nominacionActual.num, por: v.nominador, a: v.nominado, votos, umbral: v.umbral, exito, votantes: v.contados.slice() });
  if (exito) {
    if (!room.bloque || votos > room.bloque.votos) room.bloque = { id: v.nominado, votos, empate: false };
    else if (votos === room.bloque.votos) room.bloque.empate = true;
  }
  anunciar(room, exito
    ? `⚖️ ${n.nombre}: ${votos} votos (hacían falta ${v.umbral}). Queda a punto de morir.`
    : `⚖️ ${n.nombre}: ${votos} votos (hacían falta ${v.umbral}). La votación no prospera.`);
  registrar(room, `Votación de ${por.nombre} contra ${n.nombre}: ${votos}/${v.umbral} → ${exito ? 'a punto de morir' : 'no prospera'}.`);
  jugadores(room).forEach(p => { p.mano = false; });
  room.voto = null; room.nominacionActual = null;
  setFase(room, 'nominaciones', 0);
}

function terminarDia(room) {
  if (room.fase !== 'dia' && room.fase !== 'nominaciones') return false;
  clearTimeout(room.timer);
  let ejecutado = null;
  const b = room.bloque;
  if (b && !b.empate) { const p = room.players.get(b.id); if (p && p.vivo) { ejecutar(room, p); ejecutado = p; } }
  else if (b && b.empate) anunciar(room, '⚖️ Empate entre los jugadores a punto de morir: nadie es ejecutado.');
  else anunciar(room, '⚖️ Hoy no se ejecuta a nadie.');
  if (comprobarFin(room, !ejecutado)) return true;
  empezarNoche(room);
  return true;
}

// ───────── información que sugiere el servidor (el Narrador decide) ─────────
function sugerir(room, p) {
  const r = vista(p), ps = jugadores(room), otros = ps.filter(q => q.id !== p.id);
  const nota = ps.some(q => q.rol === 'espia' || q.rol === 'recluso') ? ' (Ojo: hay Espía/Recluso en juego y pueden registrarse distinto.)' : '';
  const par = (tp, etq) => {
    const cands = otros.filter(q => tipo(q) === tp);
    if (!cands.length) return `0 ${etq}s en juego.`;
    const t = azar(cands), x = azar(otros.filter(q => q !== t));
    const dos = shuffle([t, x]);
    return `Uno de ${dos[0].nombre} y ${dos[1].nombre} es ${ROLES[t.rol].nombre} ${ROLES[t.rol].icono}.${nota}`;
  };
  switch (r) {
    case 'adivina': {
      const e = room.elecciones[p.id];
      if (!e || e.length < 2) return 'Aún no ha elegido a 2 jugadores.';
      const si = e.some(id => { const q = room.players.get(id); return q && (tipo(q) === 'diablo' || tiene(q, 'senuelo')); });
      return (si ? 'SÍ: uno de los dos es el Diablo.' : 'NO: ninguno de los dos es el Diablo.') + nota;
    }
    case 'amante': {
      const i = ps.indexOf(p), n = ps.length;
      const vec = d => { for (let k = 1; k < n; k++) { const q = ps[(i + d * k + n * n) % n]; if (q.vivo) return q; } return null; };
      const a = vec(-1), b = vec(1), lista = [...new Set([a, b].filter(Boolean))];
      return `${lista.filter(q => equipo(q) === 'mal').length} de tus vecinos (${lista.map(q => q.nombre).join(' y ')}) son malos.${nota}`;
    }
    case 'bibliotecaria': return par('pueblerino', 'Pueblerino');
    case 'investigador': return par('esbirro', 'Esbirro');
    case 'tabernero': return par('forastero', 'Forastero');
    case 'tejedora': {
      let c = 0; const n = ps.length;
      for (let i = 0; i < n && n > 2; i++) if (equipo(ps[i]) === 'mal' && equipo(ps[(i + 1) % n]) === 'mal') c++;
      return `Hay ${c} pareja${c === 1 ? '' : 's'} de malos sentados juntos.${nota}`;
    }
    case 'sepulturero': {
      const e = room.ejecutadoHoy;
      return e ? `Hoy fue ejecutado: ${ROLES[e.rol].nombre} ${ROLES[e.rol].icono}.` : 'Hoy no fue ejecutado nadie.';
    }
    case 'medium': {
      const e = room.elecciones[p.id], q = e && room.players.get(e[0]);
      return q ? `${q.nombre} es ${ROLES[q.rol].nombre} ${ROLES[q.rol].icono}.` : 'Aún no ha elegido a nadie.';
    }
    default: return '';
  }
}

// ───────── conexiones ─────────
wss.on('connection', ws => {
  let player = null, room = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    // ── entrar ──
    if (m.t === 'crear' || m.t === 'unirse') {
      if (player) return;
      const nombre = String(m.nombre || 'Jugador').replace(/[<>&"]/g, '').trim().slice(0, 14) || 'Jugador';
      const esNar = m.t === 'crear';
      if (esNar) {
        room = {
          code: nuevoCodigo(), players: new Map(), narrador: null, asientos: [], fase: 'lobby', n: 0, dia: 0,
          deadline: 0, timer: null, ganador: null, motivo: '', eventos: [], silencio: false,
          rolesElegidos: [], despiertos: new Set(), hechos: new Set(), elecciones: {},
          nominaciones: [], nominadores: new Set(), nominados: new Set(), bloque: null, nominacionActual: null, numNom: 0,
          voto: null, pendienteVirgen: null, pendienteCazador: null, ejecutadoHoy: null, santoEjecutado: false, bluffs: null,
          salas: [{ id: 'plaza', nombre: 'Plaza' }, { id: 's1', nombre: 'Taberna' }, { id: 's2', nombre: 'Biblioteca' }, { id: 's3', nombre: 'Cripta' }, { id: 's4', nombre: 'Herrería' }],
          numSala: 4, megafono: false, composicion: null,
          ajustes: { charla: 180, defensa: 30, paso: 4, umbral: 'mas1', finAuto: true, salasAbiertas: true, salasNom: false }
        };
        rooms.set(room.code, room);
      } else {
        room = rooms.get(String(m.codigo || '').toUpperCase().trim());
        if (!room) return err(ws, 'Esa sala no existe.'), (room = null);
        if (room.fase !== 'lobby') return err(ws, 'La partida ya ha empezado.'), (room = null);
        if (room.asientos.length >= MAX_JUGADORES) return err(ws, 'La sala está llena.'), (room = null);
      }
      player = { id: nextId++, nombre, vivo: true, rol: null, cree: null, fichas: [], votoFantasma: true, mano: false, off: false, sala: 'plaza', habla: false, ws };
      room.players.set(player.id, player);
      if (esNar) room.narrador = player.id; else room.asientos.push(player.id);
      const roles = {}; for (const [k, r] of Object.entries(ROLES)) roles[k] = r;
      send(ws, { t: 'bienvenida', id: player.id, codigo: room.code, roles, fichas: FICHAS, dist: DISTRIBUCION, min: MIN_JUGADORES });
      if (!esNar) anunciar(room, `👋 ${nombre} se sienta a la mesa.`);
      enviarEstado(room);
      return;
    }
    if (!player || !room) return;
    const esNar = room.narrador === player.id;
    const J = id => room.players.get(id);
    const jug = id => { const q = J(id); return q && q.id !== room.narrador ? q : null; };

    switch (m.t) {
      // ───── comunes ─────
      case 'rtc': { const d = J(m.to); if (d && !d.off) send(d.ws, { t: 'rtc', from: player.id, data: m.data }); return; }

      case 'sala': {
        const s = room.salas.find(x => x.id === m.sala);
        if (!s) return;
        if (s.id !== 'plaza' && !room.ajustes.salasAbiertas && !esNar) return err(ws, 'El Narrador ha cerrado las salas privadas.');
        player.sala = s.id; enviarEstado(room);
        return;
      }
      case 'habla': { // indicador de "está hablando": lo ven todos, también los que no oyen
        if (room.fase === 'noche') return;
        const on = !!m.on;
        if (player.habla === on) return;
        player.habla = on; bcast(room, { t: 'habla', id: player.id, on });
        return;
      }

      // ───── jugador ─────
      case 'elegir': { // elección nocturna cuando el Narrador lo ha despertado
        if (esNar || room.fase !== 'noche' || !room.despiertos.has(player.id)) return;
        const d = ROLES[vista(player)].noche;
        if (!d || !d.elige) return;
        const ids = [...new Set((m.targets || []).map(Number))];
        if (ids.length !== d.elige || ids.some(id => !jug(id) || (d.excluyeYo && id === player.id))) return err(ws, `Debes elegir ${d.elige} jugador${d.elige > 1 ? 'es' : ''}.`);
        room.elecciones[player.id] = ids;
        const r = vista(player);
        const quitar = f => jugadores(room).forEach(q => { q.fichas = q.fichas.filter(x => x !== f); });
        if (r === 'monje') { quitar('proteccion'); jug(ids[0]).fichas.push('proteccion'); }
        if (r === 'alquimista') { quitar('emborrachado'); jug(ids[0]).fichas.push('emborrachado'); }
        if (r === 'mayordomo') { quitar('maestro'); jug(ids[0]).fichas.push('maestro'); }
        registrar(room, `${player.nombre} (${ROLES[r].nombre}) elige a ${ids.map(i => jug(i).nombre).join(' y ')}.`);
        send(ws, { t: 'ack', targets: ids });
        enviarEstado(room);
        return;
      }
      case 'nominar': {
        const t = jug(m.target);
        if (esNar || room.fase !== 'nominaciones') return err(ws, 'Ahora no se puede nominar.');
        if (!player.vivo) return err(ws, 'Los muertos no pueden nominar.');
        if (room.nominadores.has(player.id)) return err(ws, 'Ya has nominado hoy.');
        if (!t || !t.vivo) return err(ws, 'Elige a un jugador vivo.');
        if (room.nominados.has(t.id)) return err(ws, `${t.nombre} ya ha sido nominado hoy.`);
        nominar(room, player, t);
        return;
      }
      case 'mano': {
        if (esNar || room.fase !== 'votando') return;
        if (!player.vivo && !player.votoFantasma) return;
        player.mano = !!m.alzada;
        enviarEstado(room);
        return;
      }
      case 'cazar': {
        const t = jug(m.target);
        if (esNar || !['dia', 'nominaciones'].includes(room.fase) || vista(player) !== 'cazador' || !player.vivo) return;
        if (tiene(player, 'habilidad_usada') || !t) return err(ws, 'No puedes usar esa habilidad.');
        player.fichas.push('habilidad_usada');
        anunciar(room, `🏹 ${player.nombre} dice ser el Cazador y dispara a ${t.nombre}.`);
        room.pendienteCazador = { cazador: player.id, objetivo: t.id, nombre: player.nombre, objetivoNombre: t.nombre, esDiablo: tipo(t) === 'diablo', emborrachado: tiene(player, 'emborrachado') || player.rol !== 'cazador' };
        registrar(room, `${player.nombre} (Cazador) dispara a ${t.nombre}.`);
        aviso(room, `🏹 Disparo del Cazador: resuélvelo en el panel.`);
        enviarEstado(room);
        return;
      }
    }

    // ───── a partir de aquí, solo el Narrador ─────
    if (!esNar) return;

    switch (m.t) {
      // ── preparación ──
      case 'config': {
        const a = room.ajustes;
        if (Array.isArray(m.roles) && room.fase === 'lobby') room.rolesElegidos = [...new Set(m.roles.filter(r => ROLES[r]))];
        if (m.charla !== undefined) a.charla = num(m.charla, 0, 1800, a.charla);
        if (m.defensa !== undefined) a.defensa = num(m.defensa, 0, 300, a.defensa);
        if (m.paso !== undefined) a.paso = num(m.paso, 2, 15, a.paso);
        if (m.umbral === 'mas1' || m.umbral === 'mitad') a.umbral = m.umbral;
        if (m.finAuto !== undefined) a.finAuto = !!m.finAuto;
        if (m.salasNom !== undefined) a.salasNom = !!m.salasNom;
        if (m.salasAbiertas !== undefined) { a.salasAbiertas = !!m.salasAbiertas; if (!a.salasAbiertas) todos(room).forEach(p => { p.sala = 'plaza'; }); }
        enviarEstado(room);
        return;
      }
      case 'salaCrear': {
        if (room.salas.length >= 9) return err(ws, 'Máximo 9 salas.');
        room.salas.push({ id: 's' + (++room.numSala), nombre: limpiar(m.nombre, 20) || `Sala ${room.numSala}` });
        enviarEstado(room); return;
      }
      case 'salaBorrar': {
        if (m.id === 'plaza') return;
        room.salas = room.salas.filter(x => x.id !== m.id);
        todos(room).forEach(p => { if (p.sala === m.id) p.sala = 'plaza'; });
        enviarEstado(room); return;
      }
      case 'salaRenombrar': {
        const sa = room.salas.find(x => x.id === m.id), nb = limpiar(m.nombre, 20);
        if (sa && nb) { sa.nombre = nb; enviarEstado(room); }
        return;
      }
      case 'moverJugador': {
        const p = jug(m.id), sa = room.salas.find(x => x.id === m.sala);
        if (p && sa) { p.sala = sa.id; enviarEstado(room); }
        return;
      }
      case 'megafono': room.megafono = !!m.on; enviarEstado(room); return;
      case 'sugerirRoles': {
        if (room.fase !== 'lobby') return;
        room.rolesElegidos = sugerirRoles(jugadores(room).length);
        enviarEstado(room);
        return;
      }
      case 'sortear': {
        if (room.fase !== 'lobby') return;
        const ps = jugadores(room);
        if (room.rolesElegidos.length !== ps.length) return err(ws, `Has elegido ${room.rolesElegidos.length} roles pero hay ${ps.length} jugadores.`);
        const rs = shuffle(room.rolesElegidos.slice());
        shuffle(ps.slice()).forEach((p, i) => { p.rol = rs[i]; p.cree = null; p.fichas = []; });
        asignarCree(room); repartoFichas(room);
        enviarEstado(room);
        return;
      }
      case 'asignar': case 'cambiarRol': {
        const p = jug(m.id);
        if (!p || !ROLES[m.rol] || room.fase === 'fin') return;
        p.rol = m.rol; p.cree = null;
        asignarCree(room); repartoFichas(room);
        if (room.fase !== 'lobby') { registrar(room, `${p.nombre} pasa a ser ${ROLES[p.rol].nombre}.`); send(p.ws, { t: 'info', texto: `Tu rol ha cambiado: ahora eres ${ROLES[vista(p)].nombre} ${ROLES[vista(p)].icono}.`, momento: momento(room) }); }
        enviarEstado(room);
        return;
      }
      case 'cree': {
        const p = jug(m.id);
        if (!p || p.rol !== 'borracho' || !ROLES[m.rol] || ROLES[m.rol].tipo !== 'pueblerino') return;
        p.cree = m.rol; enviarEstado(room);
        return;
      }
      case 'barajar': if (room.fase === 'lobby') { shuffle(room.asientos); enviarEstado(room); } return;
      case 'moverAsiento': {
        if (room.fase !== 'lobby') return;
        const i = room.asientos.indexOf(m.id), j = (i + (m.dir > 0 ? 1 : -1) + room.asientos.length) % room.asientos.length;
        if (i < 0) return;
        [room.asientos[i], room.asientos[j]] = [room.asientos[j], room.asientos[i]];
        enviarEstado(room);
        return;
      }
      case 'iniciar': if (room.fase === 'lobby') iniciar(room); return;

      // ── fases ──
      case 'amanecer': amanecer(room); return;
      case 'abrirNominaciones': abrirNominaciones(room); return;
      case 'extender': {
        if (room.fase === 'dia' && room.deadline) {
          room.deadline += num(m.seg, 10, 600, 60) * 1000;
          clearTimeout(room.timer);
          room.timer = setTimeout(() => abrirNominaciones(room), Math.max(0, room.deadline - Date.now()));
          enviarEstado(room);
        }
        return;
      }
      case 'iniciarVoto': iniciarVoto(room); return;
      case 'cancelarVoto': {
        if (!['defensa', 'votando'].includes(room.fase) || !room.nominacionActual) return;
        const a = room.nominacionActual;
        room.nominadores.delete(a.por); room.nominados.delete(a.a);
        const t = J(a.a);
        if (room.pendienteVirgen && t) t.fichas = t.fichas.filter((f, i, arr) => !(f === 'habilidad_usada' && arr.indexOf(f) === i));
        room.pendienteVirgen = null; room.voto = null; room.nominacionActual = null;
        jugadores(room).forEach(p => { p.mano = false; });
        clearTimeout(room.timer);
        anunciar(room, '↩️ La nominación se ha cancelado.');
        setFase(room, 'nominaciones', 0);
        return;
      }
      case 'terminarDia': if (!terminarDia(room)) err(ws, 'Termina o cancela la votación en curso primero.'); return;
      case 'virgen': {
        const pv = room.pendienteVirgen;
        if (!pv) return;
        room.pendienteVirgen = null;
        if (m.ejecutar) {
          const q = jug(pv.nominador);
          anunciar(room, `👸 ¡${J(pv.virgen).nombre} era la Virgen!`);
          if (q && q.vivo) ejecutar(room, q);
          room.nominacionActual = null; room.voto = null;
          if (!comprobarFin(room, false)) empezarNoche(room); // la ejecución termina el día
        } else iniciarDefensa(room);
        return;
      }
      case 'cazador': {
        const pc = room.pendienteCazador;
        if (!pc) return;
        room.pendienteCazador = null;
        const t = jug(pc.objetivo);
        if (m.matar && t && t.vivo) {
          morir(room, t);
          anunciar(room, `💥 ${t.nombre} cae muerto por el disparo.`);
          registrar(room, `El disparo del Cazador mata a ${t.nombre}.`);
          comprobarFin(room, false);
        } else anunciar(room, `🏹 El disparo no tiene efecto.`);
        enviarEstado(room);
        return;
      }
      case 'ejecutar': {
        const p = jug(m.id);
        if (!p || !p.vivo || room.fase === 'lobby' || room.fase === 'fin') return;
        ejecutar(room, p);
        if (!comprobarFin(room, false)) enviarEstado(room);
        return;
      }
      case 'silencio': room.silencio = !!m.on; enviarEstado(room); return;

      // ── asientos y fichas ──
      case 'matar': case 'revivir': {
        const p = jug(m.id);
        if (!p || room.fase === 'lobby' || room.fase === 'fin') return;
        if (m.t === 'matar' && p.vivo) {
          if (room.fase === 'noche') { if (!tiene(p, 'muerto')) p.fichas.push('muerto'); }
          else { morir(room, p); anunciar(room, `💀 ${p.nombre} ha muerto.`); }
          registrar(room, `${p.nombre} muere.`);
        } else if (m.t === 'revivir' && !p.vivo) {
          p.vivo = true; p.fichas = p.fichas.filter(f => f !== 'muerto' && f !== 'muerto_diablo'); p.votoFantasma = true;
          anunciar(room, `✨ ${p.nombre} vuelve a la vida.`);
        } else return;
        if (!comprobarFin(room, false)) enviarEstado(room);
        return;
      }
      case 'ficha': {
        const p = jug(m.id);
        if (!p || !FICHAS[m.ficha] || room.fase === 'lobby' || room.fase === 'fin') return;
        const f = m.ficha, muerte = f === 'muerto' || f === 'muerto_diablo';
        if (m.accion === 'poner') {
          if (muerte && room.fase !== 'noche') { if (p.vivo) { morir(room, p); anunciar(room, `💀 ${p.nombre} ha muerto.`); } if (f === 'muerto_diablo') p.fichas.push(f); }
          else if (!tiene(p, f)) p.fichas.push(f);
          registrar(room, `Ficha "${FICHAS[f].nombre}" sobre ${p.nombre}.`);
        } else if (m.accion === 'quitar') {
          if (f === 'muerto' && !p.vivo) { p.vivo = true; p.votoFantasma = true; p.fichas = p.fichas.filter(x => x !== 'muerto_diablo'); anunciar(room, `✨ ${p.nombre} vuelve a la vida.`); }
          const i = p.fichas.indexOf(f); if (i >= 0) p.fichas.splice(i, 1);
        }
        if (!comprobarFin(room, false)) enviarEstado(room);
        return;
      }

      // ── noche: despertar, información ──
      case 'despertar': {
        const p = jug(m.id);
        if (!p || room.fase !== 'noche') return;
        room.despiertos.add(p.id);
        const d = ROLES[vista(p)].noche;
        const opciones = jugadores(room).filter(q => !(d && d.excluyeYo && q.id === p.id)).map(q => ({ id: q.id, nombre: q.nombre, vivo: q.vivo }));
        send(p.ws, { t: 'despertar', texto: d ? d.texto : 'El Narrador te ha despertado.', n: d ? d.elige || 0 : 0, opciones });
        enviarEstado(room);
        return;
      }
      case 'dormir': {
        const p = jug(m.id);
        if (!p) return;
        room.despiertos.delete(p.id); room.hechos.add(p.id);
        send(p.ws, { t: 'dormir' });
        enviarEstado(room);
        return;
      }
      case 'eleccion': { // el Narrador fija o corrige la elección de un jugador
        const p = jug(m.id);
        if (!p) return;
        room.elecciones[p.id] = (m.targets || []).map(Number).filter(i => jug(i));
        enviarEstado(room);
        return;
      }
      case 'sugerir': {
        const p = jug(m.id);
        if (p) send(ws, { t: 'sugerencia', id: p.id, texto: sugerir(room, p) });
        return;
      }
      case 'info': {
        const p = jug(m.id), txt = String(m.texto || '').slice(0, 400);
        if (!p || !txt) return;
        send(p.ws, { t: 'info', texto: txt, momento: momento(room) });
        registrar(room, `Info a ${p.nombre}: ${txt}`);
        aviso(room, `✉️ Enviado a ${p.nombre}.`);
        enviarEstado(room);
        return;
      }
      case 'grimorioEspia': {
        const p = jug(m.id);
        if (!p) return;
        send(p.ws, { t: 'grimorioEspia', filas: jugadores(room).map(q => ({ nombre: q.nombre, rol: ROLES[q.rol].nombre + ' ' + ROLES[q.rol].icono, cree: q.cree ? ROLES[q.cree].nombre : null, vivo: q.vivo, fichas: q.fichas.map(f => FICHAS[f].icono + ' ' + FICHAS[f].nombre) })) });
        aviso(room, `🕵️ Grimorio mostrado a ${p.nombre}.`);
        return;
      }
      case 'aliados': { // el equipo malvado se conoce (primera noche)
        const malos = jugadores(room).filter(p => equipo(p) === 'mal');
        for (const p of malos) {
          const otros = malos.filter(q => q.id !== p.id).map(q => `${q.nombre} (${ROLES[q.rol].nombre} ${ROLES[q.rol].icono})`);
          send(p.ws, { t: 'info', texto: otros.length ? `Tus aliados malvados: ${otros.join(', ')}.` : 'Eres el único malvado.', momento: momento(room) });
        }
        aviso(room, '😈 Enviado el equipo malvado a todos los malos.');
        return;
      }
      case 'bluffs': { // roles buenos que NO están en juego, para el Diablo
        if (jugadores(room).length < 7) return err(ws, 'Solo se enseñan roles al Diablo si hay 7 o más jugadores.');
        const usados = new Set(rolesAsignados(room)); jugadores(room).forEach(p => p.cree && usados.add(p.cree));
        if (m.reroll || !room.bluffs) {
          room.bluffs = shuffle(Object.keys(ROLES).filter(r => ROLES[r].equipo === 'bien' && !usados.has(r))).slice(0, 3);
        }
        if (m.enviar) {
          const txt = room.bluffs.map(r => `${ROLES[r].nombre} ${ROLES[r].icono}`).join(', ');
          for (const p of jugadores(room)) {
            if (tipo(p) === 'diablo') send(p.ws, { t: 'info', texto: `Estos roles NO están en juego: ${txt}.`, momento: momento(room) });
            if (p.rol === 'canciller') send(p.ws, { t: 'info', texto: `El Diablo sabe que este rol NO está en juego: ${ROLES[room.bluffs[0]].nombre} ${ROLES[room.bluffs[0]].icono}.`, momento: momento(room) });
          }
          aviso(room, '😈 Roles falsos enviados al Diablo (y 1 al Canciller).');
        }
        enviarEstado(room);
        return;
      }

      // ── mesa ──
      case 'anuncio': { const t = String(m.texto || '').slice(0, 200); if (t) anunciar(room, '📜 Narrador: ' + t); return; }
      case 'susurro': { const p = jug(m.id), t = String(m.texto || '').slice(0, 300); if (p && t) send(p.ws, { t: 'info', texto: t, momento: momento(room) }); return; }
      case 'terminar': if (['bien', 'mal'].includes(m.ganador) && room.fase !== 'lobby' && room.fase !== 'fin') finPartida(room, m.ganador, 'Decisión del Narrador.'); return;
      case 'lobby': {
        if (room.fase !== 'fin') return;
        clearTimeout(room.timer);
        for (const [id, p] of room.players) if (p.off) { room.players.delete(id); room.asientos = room.asientos.filter(x => x !== id); }
        jugadores(room).forEach(p => { p.vivo = true; p.rol = null; p.cree = null; p.fichas = []; p.mano = false; p.votoFantasma = true; });
        Object.assign(room, { composicion: null, megafono: false, n: 0, dia: 0, ganador: null, motivo: '', voto: null, nominaciones: [], bloque: null, nominacionActual: null, bluffs: null, elecciones: {} });
        room.despiertos.clear(); room.hechos.clear(); room.nominadores.clear(); room.nominados.clear();
        setFase(room, 'lobby', 0);
        return;
      }
    }
  });

  ws.on('close', () => {
    if (!player || !room) return;
    if (room.narrador === player.id) {
      bcast(room, { t: 'cerrada', texto: 'El Narrador se ha ido: la sala se ha cerrado.' });
      clearTimeout(room.timer); rooms.delete(room.code);
      return;
    }
    if (room.fase === 'lobby') { room.players.delete(player.id); room.asientos = room.asientos.filter(i => i !== player.id); }
    else { player.off = true; player.ws = null; player.mano = false; if (player.habla) { player.habla = false; bcast(room, { t: 'habla', id: player.id, on: false }); } }
    anunciar(room, `🚪 ${player.nombre} se ha ido.`);
    enviarEstado(room);
  });
});

server.listen(PORT, () => console.log(`Aldea de Sombras en http://localhost:${PORT}`));
