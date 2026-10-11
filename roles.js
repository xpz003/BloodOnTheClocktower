// ─────────────────────────────────────────────────────────────
//  ROLES, FICHAS y DISTRIBUCIÓN. Todo es dato: añade un rol aquí y aparece en el juego.
//
//  tipo   : pueblerino | forastero (bando bueno) · esbirro | diablo (bando malo)
//  noche  : { primera, otras, ordenPrimera, ordenOtras, elige, excluyeYo, texto, alMorir }
//           elige   = nº de jugadores que el rol elige cuando el Narrador lo despierta
//           alMorir = solo despierta la noche en que muere (Medium)
//  fichas : fichas de recordatorio que aparecen en la bandeja del Narrador si el rol está en juego
// ─────────────────────────────────────────────────────────────
const ROLES = {
  // ───────── PUEBLERINOS ─────────
  adivina: {
    nombre: 'Adivina', icono: '🔮', tipo: 'pueblerino', equipo: 'bien', fichas: ['senuelo'],
    desc: 'Cada noche eliges 2 jugadores (no puedes ser tú): aprendes si alguno es el Diablo. Un jugador bueno lleva la marca de "Señuelo" y siempre se registra como Diablo ante ti.',
    noche: { primera: true, otras: true, ordenPrimera: 9, ordenOtras: 10, elige: 2, excluyeYo: true, texto: 'Elige 2 jugadores (no puedes ser tú): aprenderás si alguno es el Diablo.' }
  },
  alcalde: {
    nombre: 'Alcalde', icono: '🏛️', tipo: 'pueblerino', equipo: 'bien', fichas: ['no_muere'],
    desc: 'Si solo hay 3 jugadores vivos y no se ejecuta a nadie, tu equipo gana. Si mueres por la noche, otro jugador de tu equipo muere en tu lugar.'
  },
  amante: {
    nombre: 'Amante', icono: '💞', tipo: 'pueblerino', equipo: 'bien',
    desc: 'Cada noche aprendes cuántos de tus vecinos son malos.',
    noche: { primera: true, otras: true, ordenPrimera: 8, ordenOtras: 9, elige: 0, texto: 'El Narrador te dirá cuántos de tus vecinos son malos.' }
  },
  bibliotecaria: {
    nombre: 'Bibliotecaria', icono: '📚', tipo: 'pueblerino', equipo: 'bien',
    desc: 'Comienzas la partida sabiendo que 1 de 2 jugadores es cierto Pueblerino.',
    noche: { primera: true, otras: false, ordenPrimera: 4, elige: 0, texto: 'El Narrador te señalará a 2 jugadores: uno es cierto Pueblerino.' }
  },
  cazador: {
    nombre: 'Cazador', icono: '🏹', tipo: 'pueblerino', equipo: 'bien', fichas: ['habilidad_usada'],
    desc: 'Una vez por partida, durante el día, di públicamente que eres el Cazador y nombra a un jugador: si ese jugador es el Diablo, muere.'
  },
  investigador: {
    nombre: 'Investigador', icono: '🔎', tipo: 'pueblerino', equipo: 'bien',
    desc: 'Comienzas la partida sabiendo que 1 de 2 jugadores es cierto Esbirro (o que hay 0 en juego).',
    noche: { primera: true, otras: false, ordenPrimera: 5, elige: 0, texto: 'El Narrador te señalará a 2 jugadores: uno es cierto Esbirro (o no hay ninguno).' }
  },
  medium: {
    nombre: 'Medium', icono: '👻', tipo: 'pueblerino', equipo: 'bien',
    desc: 'Si mueres por la noche, despiertas y eliges 1 jugador: aprendes el rol de ese jugador.',
    noche: { alMorir: true, ordenPrimera: 7, ordenOtras: 7, elige: 1, excluyeYo: true, texto: 'Has muerto esta noche. Elige 1 jugador: aprenderás su rol.' }
  },
  monje: {
    nombre: 'Monje', icono: '🧘', tipo: 'pueblerino', equipo: 'bien', fichas: ['proteccion'],
    desc: 'Cada noche, excepto la primera, eliges 1 jugador (no puedes ser tú): ese jugador no puede morir por el Diablo esta noche.',
    noche: { primera: false, otras: true, ordenOtras: 3, elige: 1, excluyeYo: true, texto: 'Elige 1 jugador (no puedes ser tú): el Diablo no podrá matarlo esta noche.' }
  },
  sepulturero: {
    nombre: 'Sepulturero', icono: '⚰️', tipo: 'pueblerino', equipo: 'bien',
    desc: 'Cada noche, excepto la primera, aprendes qué rol ha muerto ejecutado hoy.',
    noche: { primera: false, otras: true, ordenOtras: 8, elige: 0, texto: 'El Narrador te dirá qué rol fue ejecutado hoy.' }
  },
  soldado: {
    nombre: 'Soldado', icono: '🪖', tipo: 'pueblerino', equipo: 'bien',
    desc: 'Estás a salvo del Diablo.'
  },
  tabernero: {
    nombre: 'Tabernero', icono: '🍻', tipo: 'pueblerino', equipo: 'bien',
    desc: 'Comienzas la partida sabiendo que 1 de 2 jugadores es cierto Forastero (o que hay 0 en juego).',
    noche: { primera: true, otras: false, ordenPrimera: 6, elige: 0, texto: 'El Narrador te señalará a 2 jugadores: uno es cierto Forastero (o no hay ninguno).' }
  },
  tejedora: {
    nombre: 'Tejedora', icono: '🧵', tipo: 'pueblerino', equipo: 'bien',
    desc: 'Comienzas la partida sabiendo cuántas parejas de malos hay sentadas juntas.',
    noche: { primera: true, otras: false, ordenPrimera: 7, elige: 0, texto: 'El Narrador te dirá cuántas parejas de malos hay.' }
  },
  virgen: {
    nombre: 'Virgen', icono: '👸', tipo: 'pueblerino', equipo: 'bien', fichas: ['habilidad_usada'],
    desc: 'La primera vez que seas nominado, si te nomina un Pueblerino, ese jugador es ejecutado inmediatamente.'
  },

  // ───────── FORASTEROS ─────────
  borracho: {
    nombre: 'Borracho', icono: '🥴', tipo: 'forastero', equipo: 'bien', fichas: ['borracho_es'],
    desc: 'No sabes que eres el Borracho. Crees que eres cierto Pueblerino, pero no lo eres: tu habilidad no funciona.'
  },
  mayordomo: {
    nombre: 'Mayordomo', icono: '🎩', tipo: 'forastero', equipo: 'bien', fichas: ['maestro'],
    desc: 'Cada noche eliges 1 jugador (no puedes ser tú): es tu Maestro. Solo puedes votar en una nominación si tu Maestro vota.',
    noche: { primera: true, otras: true, ordenPrimera: 10, ordenOtras: 11, elige: 1, excluyeYo: true, texto: 'Elige 1 jugador (no puedes ser tú): será tu Maestro.' }
  },
  recluso: {
    nombre: 'Recluso', icono: '🛖', tipo: 'forastero', equipo: 'bien',
    desc: 'Serás registrado como Esbirro o Diablo, incluso muerto.'
  },
  santo: {
    nombre: 'Santo', icono: '😇', tipo: 'forastero', equipo: 'bien',
    desc: 'Si mueres ejecutado, tu equipo pierde.'
  },

  // ───────── ESBIRROS ─────────
  alquimista: {
    nombre: 'Alquimista', icono: '⚗️', tipo: 'esbirro', equipo: 'mal', fichas: ['emborrachado'],
    desc: 'Cada noche eliges 1 jugador: esa noche y el día siguiente está borracho (su habilidad falla).',
    noche: { primera: true, otras: true, ordenPrimera: 2, ordenOtras: 2, elige: 1, excluyeYo: false, texto: 'Elige 1 jugador: estará borracho esta noche y el día siguiente.' }
  },
  baron: {
    nombre: 'Barón', icono: '🦇', tipo: 'esbirro', equipo: 'mal',
    desc: 'Al preparar la partida, el Narrador quita 2 Pueblerinos y añade 2 Forasteros.'
  },
  canciller: {
    nombre: 'Canciller', icono: '🌹', tipo: 'esbirro', equipo: 'mal',
    desc: 'Si hay 5 o más jugadores vivos y muere el Diablo, te conviertes en el Diablo. Si el Diablo aprende los roles que no están en juego la primera noche, tú aprendes 1 de ellos.'
  },
  espia: {
    nombre: 'Espía', icono: '🕵️', tipo: 'esbirro', equipo: 'mal',
    desc: 'Cada noche miras el Grimorio. Siempre eres registrado como Pueblerino, incluso muerto.',
    noche: { primera: true, otras: true, ordenPrimera: 3, ordenOtras: 4, elige: 0, texto: 'El Narrador te enseñará el Grimorio.' }
  },

  // ───────── DIABLOS ─────────
  colgado: {
    nombre: 'El Colgado', icono: '😈', tipo: 'diablo', equipo: 'mal', fichas: ['muerto_diablo'],
    desc: 'Cada noche, excepto la primera, eliges 1 jugador: ese jugador muere. Puedes elegirte a ti mismo: si lo haces, un Esbirro se convierte en El Colgado.',
    noche: { primera: false, otras: true, ordenOtras: 6, elige: 1, excluyeYo: false, texto: 'Elige 1 jugador: morirá esta noche (puedes elegirte a ti mismo).' }
  }
};

const FICHAS = {
  muerto:          { nombre: 'Muerto',                          icono: '💀' },
  muerto_diablo:   { nombre: 'Muerto por el Diablo',            icono: '🩸' },
  senuelo:         { nombre: 'Señuelo',                         icono: '🎣' },
  no_muere:        { nombre: 'No puede morir',                  icono: '♾️' },
  habilidad_usada: { nombre: 'Habilidad usada',                 icono: '✖️' },
  proteccion:      { nombre: 'Protección',                      icono: '🔰' },
  borracho_es:     { nombre: 'Es el Borracho',                  icono: '🍷' },
  maestro:         { nombre: 'Maestro',                         icono: '🎓' },
  emborrachado:    { nombre: 'Emborrachado por el Alquimista',  icono: '🧪' }
};

// Distribución oficial [Pueblerinos, Forasteros, Esbirros, Diablos] según nº de jugadores (sin contar al Narrador)
const DISTRIBUCION = {
  5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1], 9: [5, 2, 1, 1],
  10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1], 13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1]
};

module.exports = { ROLES, FICHAS, DISTRIBUCION };
