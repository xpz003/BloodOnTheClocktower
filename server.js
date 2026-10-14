'use strict';
// Aldea de Sombras — servidor (Express + WebSocket)
// Un Narrador (el que crea la sala) dirige la partida; los jugadores se sientan en un círculo.
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { ROLES, FICHAS, DISTRIBUCION } = require('./roles.js');

const PORT = process.env.PORT || 3000;
const MIN_JUGADORES = 5, MAX_JUGADORES = 15; // mínimo sin contar al Narrador
const MARCAS = ['❌', '✅', '❓', '⭐', '🔴', '🔵']; // marcas rápidas para las anotaciones de los jugadores
const GRACIA_LOBBY = +process.env.GRACIA_LOBBY_MS || 20 * 1000; // en la sala de espera, margen para volver antes de perder el asiento
const GRACIA_NARRADOR = +process.env.GRACIA_NAR_MS || 3 * 60 * 1000; // tiempo que se espera a un Narrador desconectado

// Servidores para conectar el audio. Sin TURN, algunas redes (móviles, empresas, NAT estricto) no pueden conectar entre sí.
//   TURN_URL=turn:mi.servidor:3478,turns:mi.servidor:443?transport=tcp  TURN_USER=...  TURN_PASS=...
//   o bien ICE_SERVERS='[{"urls":"stun:..."},{"urls":"turn:...","username":"...","credential":"..."}]'
const ICE_SERVERS = (() => {
  try { if (process.env.ICE_SERVERS) return JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.error('ICE_SERVERS no es un JSON válido'); }
  const l = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (process.env.TURN_URL) l.push({ urls: process.env.TURN_URL.split(',').map(x => x.trim()), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  return l;
})();

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
const claveNombre = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const ocupacion = (room, id) => todos(room).filter(p => !p.off && p.sala === id).length; // incluye al Narrador si está dentro
// Jugadores que no pueden hablar: los silenciados a mano, todos si hay silencio general,
// y (si el Narrador lo activa) todos menos el nominado mientras dura la nominación.
function silenciadosDe(room) {
  const set = new Set(room.silenciados);
  if (room.silencio) jugadores(room).forEach(p => set.add(p.id));
  const a = room.nominacionActual;
  if (room.ajustes.soloNominado && a && ['defensa', 'votando'].includes(room.fase)) jugadores(room).forEach(p => { if (p.id !== a.a) set.add(p.id); });
  return [...set];
}
// Información privada del Narrador a un jugador: se guarda para devolvérsela si se reconecta
function darInfo(room, p, texto) {
  const mo = momento(room);
  p.infos.push({ momento: mo, texto });
  send(p.ws, { t: 'info', texto, momento: mo });
}
// Captura temporal: se muestra un momento y no queda guardada (no se puede volver a ver)
function capturar(room, p, datos) { send(p.ws, { t: 'captura', seg: room.ajustes.espiaSeg, ...datos }); }
const rolItems = roles => roles.map(r => ({ icono: ROLES[r].icono, nombre: ROLES[r].nombre, desc: ROLES[r].desc }));
// Roles buenos que NO están realmente en juego (el rol que cree ser el Borracho tampoco lo está: el Narrador decide si lo enseña)
function bluffDisponibles(room) {
  const usados = new Set(rolesAsignados(room));
  return Object.keys(ROLES).filter(r => ROLES[r].equipo === 'bien' && !usados.has(r));
}
function nuevoJugador(nombre, ws) {
  return { id: nextId++, nombre, vivo: true, rol: null, cree: null, fichas: [], votoFantasma: true, mano: false, off: false, sala: 'plaza', habla: false, infos: [], prompt: null, notas: {}, ws };
}
const registrar = (room, texto) => { room.eventos.push(`${momento(room)}: ${texto}`); if (room.eventos.length > 150) room.eventos.shift(); };

// Un jugador sale de la sala (se desconecta o lo echa el Narrador)
function quitar(room, p, motivo) {
  if (p.quitado) return;
  p.quitado = true;
  const borrar = () => { room.players.delete(p.id); room.asientos = room.asientos.filter(i => i !== p.id); room.silenciados.delete(p.id); };
  if (room.fase === 'lobby' && motivo) borrar(); // expulsado: sale ya
  else {
    p.off = true; p.ws = null; p.mano = false;
    if (room.fase === 'lobby') { // en la sala de espera conserva su asiento un rato por si vuelve (misma persona, mismo nombre)
      clearTimeout(p.limpieza);
      p.limpieza = setTimeout(() => {
        if (p.off && room.players.get(p.id) === p && room.fase === 'lobby') { borrar(); anunciar(room, `🚪 ${p.nombre} se ha ido.`); enviarEstado(room); }
      }, GRACIA_LOBBY);
    }
  }
  if (p.habla) { p.habla = false; bcast(room, { t: 'habla', id: p.id, on: false }); }
  if (room.fase !== 'lobby') room.silenciados.delete(p.id);
  anunciar(room, motivo || `📴 ${p.nombre} se ha desconectado${room.fase === 'lobby' ? '.' : ' (puede volver con el mismo nombre).'}`);
  enviarEstado(room);
}

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
  const clave = Math.max(5, Math.min(15, n));
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
    virgen: room.pendienteVirgen, bluffDisp: bluffDisponibles(room), silenciados: [...room.silenciados],
    eventos: room.eventos.slice(-60)
  };
}

function estado(room, para) {
  const nar = para.id === room.narrador, fin = room.fase === 'fin';
  const n = narradorDe(room), v = room.voto;
  const sil = silenciadosDe(room);
  const out = {
    t: 'estado', ahora: Date.now(), fase: room.fase, n: room.n, dia: room.dia, deadline: room.deadline,
    narrador: { id: n.id, nombre: n.nombre, sala: n.sala, off: !!n.off }, yo: { id: para.id, nar, despierto: room.despiertos.has(para.id) },
    ajustes: room.ajustes, silencio: room.silencio, silenciados: sil, asientos: room.asientos.slice(),
    salas: room.salas, salasActivas: salasActivas(room), megafono: room.megafono, composicion: room.composicion,
    hablando: room.fase === 'noche' ? [] : todos(room).filter(p => p.habla && !p.off && !sil.includes(p.id)).map(p => p.id),
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
      darInfo(room, c, `Has heredado el puesto de Diablo: ahora eres ${ROLES[c.rol].nombre} ${ROLES[c.rol].icono}.`);
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
  if (ps.some(p => p.off)) return err(ws, 'Hay jugadores desconectados. Espera a que vuelvan (con el mismo nombre) o échalos.');
  if (ps.length < MIN_JUGADORES) return err(ws, `Hacen falta al menos ${MIN_JUGADORES} jugadores (sin contar al Narrador).`);
  if (ps.some(p => !p.rol)) return err(ws, 'Todos los jugadores necesitan un rol. Elige roles y pulsa "Repartir fichas".');
  if (!ps.some(p => tipo(p) === 'diablo')) return err(ws, 'Tiene que haber al menos un Diablo.');
  ps.forEach(p => { p.vivo = true; p.mano = false; p.votoFantasma = true; p.infos = []; p.prompt = null; p.notas = {}; send(p.ws, { t: 'notas', notas: {} }); });
  room.composicion = { pueblerino: 0, forastero: 0, esbirro: 0, diablo: 0 };
  ps.forEach(p => room.composicion[tipo(p)]++);
  // Con Barón en juego se muestran los números ORIGINALES (se devuelven 2 Pueblerinos por 2 Forasteros) para no delatarlo
  if (ps.some(p => p.rol === 'baron') && room.composicion.forastero >= 2) { room.composicion.forastero -= 2; room.composicion.pueblerino += 2; }
  room.n = 0; room.dia = 0; room.ganador = null; room.motivo = '';
  room.eventos = [];
  registrar(room, 'Comienza la partida.');
  empezarNoche(room);
}

function empezarNoche(room) {
  room.n++;
  room.despiertos.clear(); room.hechos.clear(); room.elecciones = {};
  room.nominaciones = []; room.nominadores.clear(); room.nominados.clear(); room.bloque = null;
  room.nominacionActual = null; room.voto = null; room.pendienteVirgen = null;
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
  todos(room).forEach(p => { p.sala = 'plaza'; p.prompt = null; }); // al amanecer todos vuelven a la plaza
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
  room.voto = { nominado: a.a, nominador: a.por, orden, idx: 0, inicio: Date.now(), paso: room.ajustes.paso, contados: [], gastados: [], umbral };
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
  if (q && puedeContar(room, q)) {
    v.contados.push(q.id);
    if (!q.vivo) { // los muertos solo tienen UN voto en toda la partida
      q.votoFantasma = false; v.gastados.push(q.id);
      send(q.ws, { t: 'msg', texto: '🗳️ Has gastado tu único voto de muerto: no podrás votar más.', privado: true });
    }
  }
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
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    // ── entrar ──
    if (m.t === 'crear' || m.t === 'unirse') {
      if (player) return;
      const nombre = String(m.nombre || 'Jugador').replace(/[<>&"]/g, '').trim().slice(0, 14) || 'Jugador';
      const clave = claveNombre(nombre);
      let r, reconexion = false;
      if (m.t === 'crear') {
        r = {
          code: nuevoCodigo(), players: new Map(), narrador: null, asientos: [], fase: 'lobby', n: 0, dia: 0,
          deadline: 0, timer: null, ganador: null, motivo: '', eventos: [], silencio: false,
          rolesElegidos: [], despiertos: new Set(), hechos: new Set(), elecciones: {},
          nominaciones: [], nominadores: new Set(), nominados: new Set(), bloque: null, nominacionActual: null, numNom: 0,
          voto: null, pendienteVirgen: null, silenciados: new Set(), vetados: new Set(), graciaNar: null,
          ejecutadoHoy: null, santoEjecutado: false, bluffs: null,
          salas: [{ id: 'plaza', nombre: 'Plaza' }, { id: 's1', nombre: 'Taberna' }, { id: 's2', nombre: 'Biblioteca' }, { id: 's3', nombre: 'Cripta' }, { id: 's4', nombre: 'Herrería' }],
          numSala: 4, megafono: false, composicion: null,
          ajustes: { charla: 180, defensa: 30, paso: 4, umbral: 'mas1', finAuto: true, salasAbiertas: true, salasNom: false, soloNominado: false, espiaSeg: 15 }
        };
        rooms.set(r.code, r);
        player = nuevoJugador(nombre, ws);
      } else {
        r = rooms.get(String(m.codigo || '').toUpperCase().trim());
        if (!r) return err(ws, 'Esa sala no existe.');
        if (r.vetados.has(clave)) return err(ws, 'El Narrador te ha echado de esta sala.');
        const ex = todos(r).find(q => claveNombre(q.nombre) === clave);
        if (ex) {
          // Mismo nombre que alguien desconectado: vuelve a su sitio con todo lo que tenía (rol, fichas, información…)
          if (!ex.off) return err(ws, `El nombre "${nombre}" ya está en uso en esta sala. Si eres tú y te desconectaste, espera unos segundos y vuelve a intentarlo.`);
          player = ex; reconexion = true;
          clearTimeout(player.limpieza);
          Object.assign(player, { ws, off: false, quitado: false, habla: false });
          if (r.narrador === player.id) { clearTimeout(r.graciaNar); r.graciaNar = null; }
        } else {
          if (r.fase !== 'lobby') return err(ws, 'La partida ya ha empezado. Solo pueden volver quienes ya estaban sentados, con el mismo nombre.');
          if (r.asientos.length >= MAX_JUGADORES) return err(ws, 'La sala está llena.');
          player = nuevoJugador(nombre, ws);
        }
      }
      room = r;
      if (!reconexion) { room.players.set(player.id, player); if (m.t === 'crear') room.narrador = player.id; else room.asientos.push(player.id); }
      const roles = {}; for (const [k, ro] of Object.entries(ROLES)) roles[k] = ro;
      send(ws, { t: 'bienvenida', id: player.id, codigo: room.code, roles, fichas: FICHAS, dist: DISTRIBUCION, min: MIN_JUGADORES, ice: ICE_SERVERS, reconectado: reconexion });
      send(ws, { t: 'notas', notas: player.notas });
      if (reconexion) {
        player.infos.forEach(i => send(ws, { t: 'info', texto: i.texto, momento: i.momento, reenvio: true }));
        if (room.fase === 'noche' && room.despiertos.has(player.id) && player.prompt) send(ws, player.prompt);
        anunciar(room, room.narrador === player.id ? '🎭 El Narrador ha vuelto.' : `🔁 ${player.nombre} ha vuelto a la mesa.`);
      } else if (m.t !== 'crear') anunciar(room, `👋 ${nombre} se sienta a la mesa.`);
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
        if (!esNar && s.id !== 'plaza' && s.max > 0 && player.sala !== s.id && ocupacion(room, s.id) >= s.max) return err(ws, `La sala "${s.nombre}" está llena (máximo ${s.max}).`);
        player.sala = s.id; enviarEstado(room);
        return;
      }
      case 'habla': { // indicador de "está hablando": lo ven todos, también los que no oyen
        if (room.fase === 'noche') return;
        const on = !!m.on && !silenciadosDe(room).includes(player.id);
        if (player.habla === on) return;
        player.habla = on; bcast(room, { t: 'habla', id: player.id, on });
        return;
      }

      // ───── anotaciones privadas: solo las ve quien las escribe ─────
      case 'nota': {
        if (esNar) return;
        const t = jug(m.id);
        if (!t) return;
        const marca = MARCAS.includes(m.marca) ? m.marca : '';
        const rol = ROLES[m.rol] ? m.rol : '';
        const texto = limpiar(m.texto, 80);
        if (!marca && !rol && !texto) delete player.notas[t.id]; else player.notas[t.id] = { marca, rol, texto };
        send(ws, { t: 'notas', notas: player.notas });
        return;
      }
      case 'notasLimpiar': if (!esNar) { player.notas = {}; send(ws, { t: 'notas', notas: {} }); } return;

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
        if (t && t.id === player.id) return err(ws, 'No puedes nominarte a ti mismo.');
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
        if (m.soloNominado !== undefined) a.soloNominado = !!m.soloNominado;
        if (m.espiaSeg !== undefined) a.espiaSeg = num(m.espiaSeg, 3, 60, a.espiaSeg);
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
      case 'salaLimite': {
        const sa = room.salas.find(x => x.id === m.id);
        if (sa && sa.id !== 'plaza') { sa.max = num(m.max, 0, 15, 0); enviarEstado(room); }
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
        if (room.fase !== 'lobby') { registrar(room, `${p.nombre} pasa a ser ${ROLES[p.rol].nombre}.`); darInfo(room, p, `Tu rol ha cambiado: ahora eres ${ROLES[vista(p)].nombre} ${ROLES[vista(p)].icono}.`); }
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
        if (room.voto) for (const gid of room.voto.gastados) { const g = J(gid); if (g) g.votoFantasma = true; } // esa votación se anula
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
      case 'disparo': { // El Cazador lo anuncia en voz alta; el Narrador ejecuta la acción
        const c = jug(m.id), t = jug(m.objetivo);
        if (!c || !t || !['dia', 'nominaciones', 'defensa', 'votando'].includes(room.fase)) return;
        if (!tiene(c, 'habilidad_usada')) c.fichas.push('habilidad_usada');
        if (m.matar && t.vivo) {
          morir(room, t);
          anunciar(room, `💀 ${t.nombre} ha muerto.`);
          registrar(room, `El disparo de ${c.nombre} (Cazador) mata a ${t.nombre}.`);
          if (!comprobarFin(room, false)) enviarEstado(room);
        } else { registrar(room, `El disparo de ${c.nombre} (Cazador) a ${t.nombre} no tiene efecto.`); enviarEstado(room); }
        return;
      }
      case 'ejecutar': {
        const p = jug(m.id);
        if (!p || !p.vivo || room.fase === 'lobby' || room.fase === 'fin') return;
        ejecutar(room, p);
        if (!comprobarFin(room, false)) enviarEstado(room);
        return;
      }
      case 'votoFantasma': { const p = jug(m.id); if (p && !p.vivo) { p.votoFantasma = !!m.on; enviarEstado(room); } return; }
      case 'silencio': room.silencio = !!m.on; enviarEstado(room); return;
      case 'silenciar': {
        const p = jug(m.id);
        if (!p) return;
        if (m.on) room.silenciados.add(p.id); else room.silenciados.delete(p.id);
        enviarEstado(room); return;
      }
      case 'expulsar': {
        const p = jug(m.id);
        if (!p) return;
        const w = p.ws;
        room.vetados.add(claveNombre(p.nombre));
        send(w, { t: 'expulsado', texto: 'El Narrador te ha echado de la sala.' });
        quitar(room, p, `🚪 ${p.nombre} ha sido expulsado.`);
        if (w && w.close) w.close();
        return;
      }

      // ── asientos y fichas ──
      case 'matar': case 'revivir': {
        const p = jug(m.id);
        if (!p || room.fase === 'lobby' || room.fase === 'fin') return;
        if (m.t === 'matar' && p.vivo) {
          if (room.fase === 'noche') { if (!tiene(p, 'muerto')) p.fichas.push('muerto'); }
          else { morir(room, p); anunciar(room, `💀 ${p.nombre} ha muerto.`); }
          registrar(room, `${p.nombre} muere.`);
        } else if (m.t === 'revivir' && !p.vivo) {
          p.vivo = true; p.fichas = p.fichas.filter(f => f !== 'muerto' && f !== 'muerto_diablo');
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
          if (f === 'muerto' && !p.vivo) { p.vivo = true; p.fichas = p.fichas.filter(x => x !== 'muerto_diablo'); anunciar(room, `✨ ${p.nombre} vuelve a la vida.`); }
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
        p.prompt = { t: 'despertar', texto: d ? d.texto : 'El Narrador te ha despertado.', n: d ? d.elige || 0 : 0, opciones };
        send(p.ws, p.prompt);
        enviarEstado(room);
        return;
      }
      case 'dormir': {
        const p = jug(m.id);
        if (!p) return;
        room.despiertos.delete(p.id); room.hechos.add(p.id); p.prompt = null;
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
        darInfo(room, p, txt);
        registrar(room, `Info a ${p.nombre}: ${txt}`);
        aviso(room, `✉️ Enviado a ${p.nombre}.`);
        enviarEstado(room);
        return;
      }
      case 'grimorioEspia': {
        const p = jug(m.id);
        if (!p) return;
        send(p.ws, { t: 'grimorioEspia', seg: room.ajustes.espiaSeg, filas: jugadores(room).map(q => ({ nombre: q.nombre, rol: ROLES[q.rol].nombre + ' ' + ROLES[q.rol].icono, cree: q.cree ? ROLES[q.cree].nombre : null, vivo: q.vivo, fichas: q.fichas.map(f => FICHAS[f].icono + ' ' + FICHAS[f].nombre) })) });
        aviso(room, `🕵️ Captura del Grimorio mostrada a ${p.nombre} durante ${room.ajustes.espiaSeg} s.`);
        return;
      }
      case 'aliados': { // primera noche: SOLO se señala quiénes son; no se dicen los roles
        const malos = jugadores(room).filter(p => equipo(p) === 'mal');
        const diablos = malos.filter(p => tipo(p) === 'diablo'), esbirros = malos.filter(p => tipo(p) !== 'diablo');
        const quienes = l => l.map(q => ({ icono: '👤', nombre: q.nombre }));
        if (m.quien === 'diablo') {
          diablos.forEach(p => capturar(room, p, { titulo: '😈 Estos son tus Esbirros', grupos: [{ items: quienes(esbirros), vacio: 'No tienes Esbirros.' }] }));
          aviso(room, '😈 Captura mostrada al Diablo: quiénes son sus Esbirros (sin roles).');
        } else {
          esbirros.forEach(p => capturar(room, p, { titulo: '🗡️ Tu equipo malvado', grupos: [
            { titulo: 'El Diablo', items: quienes(diablos) },
            { titulo: 'Tus compañeros Esbirros', items: quienes(esbirros.filter(q => q.id !== p.id)), vacio: 'Eres el único Esbirro.' }] }));
          aviso(room, '🗡️ Captura mostrada a los Esbirros: quién es el Diablo y sus compañeros (sin roles).');
        }
        registrar(room, `Se muestra el equipo malvado (${m.quien === 'diablo' ? 'al Diablo' : 'a los Esbirros'}), solo nombres.`);
        return;
      }
      case 'bluffs': { // el Narrador ELIGE qué roles que no están en juego enseña (no se asignan solos)
        if (jugadores(room).length < 7) return err(ws, 'Solo se enseñan roles al Diablo si hay 7 o más jugadores.');
        const disp = bluffDisponibles(room);
        const roles = [...new Set(m.roles || [])].filter(r => disp.includes(r));
        if (m.a === 'canciller') {
          if (roles.length !== 1) return err(ws, 'Elige 1 rol para el Canciller.');
          const cs = jugadores(room).filter(p => p.rol === 'canciller');
          if (!cs.length) return err(ws, 'No hay Canciller en la partida.');
          cs.forEach(p => capturar(room, p, { titulo: '🌹 El Diablo sabe que este rol NO está en juego', grupos: [{ items: rolItems(roles) }] }));
          aviso(room, '🌹 Captura mostrada al Canciller (1 rol).'); registrar(room, `Se enseña al Canciller: ${rolItems(roles)[0].nombre}.`);
          return;
        }
        const n = Math.min(3, disp.length);
        if (roles.length !== n) return err(ws, `Elige exactamente ${n} rol${n === 1 ? '' : 'es'} para enseñar al Diablo.`);
        const ds = jugadores(room).filter(p => tipo(p) === 'diablo');
        if (!ds.length) return err(ws, 'No hay ningún Diablo en la partida.');
        ds.forEach(p => capturar(room, p, { titulo: '😈 Estos roles NO están en juego', grupos: [{ items: rolItems(roles) }] }));
        aviso(room, '😈 Captura mostrada al Diablo con los roles que has elegido.');
        registrar(room, `Se enseñan al Diablo: ${rolItems(roles).map(r => r.nombre).join(', ')}.`);
        return;
      }
      // ── mesa ──
      case 'anuncio': { const t = String(m.texto || '').slice(0, 200); if (t) anunciar(room, '📜 Narrador: ' + t); return; }
      case 'susurro': { const p = jug(m.id), t = String(m.texto || '').slice(0, 300); if (p && t) darInfo(room, p, t); return; }
      case 'terminar': if (['bien', 'mal'].includes(m.ganador) && room.fase !== 'lobby' && room.fase !== 'fin') finPartida(room, m.ganador, 'Decisión del Narrador.'); return;
      case 'lobby': {
        if (room.fase !== 'fin') return;
        clearTimeout(room.timer);
        for (const [id, p] of room.players) if (p.off) { clearTimeout(p.limpieza); room.players.delete(id); room.asientos = room.asientos.filter(x => x !== id); }
        jugadores(room).forEach(p => { p.vivo = true; p.rol = null; p.cree = null; p.fichas = []; p.mano = false; p.votoFantasma = true; p.infos = []; p.prompt = null; p.notas = {}; send(p.ws, { t: 'notas', notas: {} }); });
        room.vetados.clear(); room.silenciados.clear(); room.silencio = false;
        Object.assign(room, { composicion: null, megafono: false, n: 0, dia: 0, ganador: null, motivo: '', voto: null, nominaciones: [], bloque: null, nominacionActual: null, bluffs: null, elecciones: {} });
        room.despiertos.clear(); room.hechos.clear(); room.nominadores.clear(); room.nominados.clear();
        setFase(room, 'lobby', 0);
        return;
      }
    }
  });

  ws.on('close', () => {
    if (!player || !room || player.ws !== ws) return; // una conexión antigua ya sustituida no cuenta
    if (room.narrador === player.id) {
      player.off = true; player.ws = null; player.habla = false;
      anunciar(room, '⚠️ El Narrador se ha desconectado. Se espera a que vuelva…');
      enviarEstado(room);
      clearTimeout(room.graciaNar);
      const r = room;
      r.graciaNar = setTimeout(() => {
        bcast(r, { t: 'cerrada', texto: 'El Narrador no ha vuelto: la sala se ha cerrado.' });
        clearTimeout(r.timer); rooms.delete(r.code);
      }, GRACIA_NARRADOR);
      return;
    }
    quitar(room, player);
  });
});

// Detecta conexiones caídas que el navegador no ha avisado (cambio de wifi, suspensión…) para liberar el nombre pronto
setInterval(() => {
  if (!wss.clients) return;
  wss.clients.forEach(c => { if (c.isAlive === false) return c.terminate(); c.isAlive = false; try { c.ping(); } catch (e) { /* ya cerrada */ } });
}, 10000);

server.listen(PORT, () => console.log(`Aldea de Sombras en http://localhost:${PORT}`));
