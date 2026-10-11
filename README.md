# Aldea de Sombras

Juego social de deducción basado en *Blood on the Clocktower*: un **Narrador** dirige la partida
y los jugadores se sientan en un **círculo de fichas**. Voz en directo por WebRTC.

## Ejecutar
```bash
npm install
npm start
# abre http://localhost:3000
```
Quien crea la sala es el **Narrador** (no cuenta como jugador). Hacen falta **5 jugadores como mínimo**, sin contar al Narrador (máximo 15). Los demás se unen con el código de 4 letras.
El micrófono solo funciona en `localhost` o con **HTTPS** (para jugar por internet, despliega en Render/Railway/Fly.io o usa un túnel como cloudflared).

## Preparación (Narrador)
1. Elige los roles de la partida (te muestra la distribución oficial según el número de jugadores, con ajuste del Barón) o pulsa **Sugerir roles**.
2. **Repartir fichas**: se asignan al azar. Toca un asiento para cambiar su rol, y puedes barajar o mover asientos.
3. Aparecen solas las fichas necesarias: *Es el Borracho*, *Señuelo* y la bandeja de fichas de recordatorio de los roles en juego (más la ficha de **Muerto**).
4. **Empezar partida**.

## Composición de la partida
Los jugadores ven siempre cuántos roles hay de cada tipo (Pueblerinos, Forasteros, Esbirros, Diablo), más la **tabla de 5 a 15 jugadores** con su fila resaltada. En la sala de espera se muestra la composición esperada y, al empezar, la real:

| Jugadores | Pueblerinos | Forasteros | Esbirros | Diablo |
|---|---|---|---|---|
| 5 | 3 | 0 | 1 | 1 |
| 6 | 3 | 1 | 1 | 1 |
| 7 | 5 | 0 | 1 | 1 |
| 8 | 5 | 1 | 1 | 1 |
| 9 | 5 | 2 | 1 | 1 |
| 10 | 7 | 0 | 2 | 1 |
| 11 | 7 | 1 | 2 | 1 |
| 12 | 7 | 2 | 2 | 1 |
| 13 | 9 | 0 | 3 | 1 |
| 14 | 9 | 1 | 3 | 1 |
| 15 | 9 | 2 | 3 | 1 |

## Salas de voz (como en Discord)
- Hay una **Plaza** y 4 salas privadas (Taberna, Biblioteca, Cripta, Herrería). Pulsa **Entrar** para cambiarte; solo te oyen y oyes a quienes están en tu sala.
- **Todos ven quién está en cada sala y quién está hablando**, aunque no oigan esa sala.
- La privacidad es real: tu micrófono **solo se envía** a los que están en tu sala, no solo se les baja el volumen.
- Al amanecer todos vuelven a la Plaza. De noche nadie habla, salvo el Narrador con el jugador al que ha despertado.
- Durante las nominaciones las salas se pausan y todos se oyen (el Narrador puede mantenerlas activas en Ajustes).
- El Narrador puede crear, renombrar y borrar salas, mover a cualquiera, cerrar las salas privadas, silenciar a los jugadores y usar **📢 Hablar a todos**. También puede entrar en una sala para escuchar.

## Qué ve cada uno
- **Narrador:** el círculo con el rol de todos, las fichas puestas, quién está despierto, y el Grimorio con el registro de todo.
- **Jugadores:** su propio rol; el resto de fichas, tapadas. Las acciones del Narrador son invisibles para ellos.
- Al terminar la partida se revelan todos los roles.

## La noche
El Narrador ve la lista de roles que despiertan, **en orden**, y para cada uno puede:
- **Despertar**: se abre una conversación de voz privada entre ambos y el jugador recibe su elección (por ejemplo, la Adivina elige 2 jugadores).
- **Sugerir** la información correcta (el servidor la calcula; si el jugador está borracho te avisa) y **Enviarla** editada como quieras.
- Mostrar el Grimorio al Espía, que los malos se conozcan, o enseñar 3 roles que no están en juego al Diablo (solo con 7+ jugadores).
- Poner fichas de **Muerto**: los jugadores marcados mueren al **Amanecer**.

## El día
1. **Debate** con tiempo fijado por el Narrador (ampliable).
2. **Nominaciones**: cada jugador vivo puede nominar a 1 jugador (y cada jugador solo puede ser nominado una vez).
3. **Defensa** del nominado y **votación en sentido horario empezando por él**. Una **manecilla** en el centro señala a cada jugador por turno; el voto cuenta si tiene la mano levantada cuando la manecilla le señala. Votos y manos son visibles para todos.
4. Mayoría absoluta = mitad de vivos + 1 (configurable). Quien la logre queda a punto de morir; el de más votos será ejecutado al final del día. Un empate entre jugadores a punto de morir = nadie es ejecutado.
5. Los muertos no pueden nominar y tienen **1 voto** para toda la partida.

## Victoria
- **Buenos:** el Diablo es ejecutado (o muere).
- **Malos:** el Diablo sigue vivo cuando quedan 2 jugadores vivos.
- Casos especiales automáticos: Santo ejecutado, Alcalde con 3 vivos sin ejecución, Canciller que hereda al Diablo. El Narrador puede desactivar el fin automático o terminar la partida a mano.

## Roles incluidos (`roles.js`)
- **Pueblerinos:** Adivina, Alcalde, Amante, Bibliotecaria, Cazador, Investigador, Medium, Monje, Sepulturero, Soldado, Tabernero, Tejedora, Virgen.
- **Forasteros:** Borracho, Mayordomo, Recluso, Santo.
- **Esbirros:** Alquimista, Barón, Canciller, Espía.
- **Diablos:** El Colgado.

Añadir un rol o un Diablo nuevo = una entrada en `roles.js`; aparece solo en la selección del Narrador.

## Estructura
- `server.js` — salas, fases, nominaciones y votación, Grimorio y señalización WebRTC.
- `roles.js` — roles, fichas y distribución (datos).
- `public/index.html` + `public/cliente.js` — interfaz, círculo, manecilla y voz.

## Límites conocidos
- Voz en malla P2P: va bien hasta ~12 jugadores; para más, usa un SFU como LiveKit. Solo STUN público (algunas redes necesitarán TURN).
- El audio va directo entre navegadores (P2P): la privacidad de las salas y de la noche la aplica cada cliente al enviar el micrófono; el servidor no filtra el audio.
- No hay reconexión a mitad de partida; si el Narrador se va, la sala se cierra.
