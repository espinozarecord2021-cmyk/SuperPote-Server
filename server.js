require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const cors = require('cors'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));


// ==========================================
// SECCIÓN 1: INICIALIZACIÓN Y CONFIGURACIÓN DE BASE DE DATOS
// ==========================================

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.PROJECT_ID,
        clientEmail: process.env.CLIENT_EMAIL,
        privateKey: process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
    }),
    databaseURL: "https://superpote-e3dc4-default-rtdb.firebaseio.com/"
});

const db = admin.database();

// --- CONSTANTES FINANCIERAS Y DE VALIDACIÓN ---
const MIN_MONTO = 10;
const MAX_MONTO = 500;

// [ESPÍA] Inicialización de la estructura base
db.ref('sistema').once('value', (snap) => {
    if (!snap.exists()) {
        db.ref('sistema').set({
            global: { pote: 0, estadoJuego: "apuestas" },
            usuarios: {}
        });
        console.log("[ESPÍA - SISTEMA] Estructura base creada en Firebase.");
    } else {
        console.log("[ESPÍA - SISTEMA] Estructura base ya existente cargada correctamente.");
    }
});

let contadorRondas = 0;
let juegoEnEjecucion = false;


// ==========================================
// SECCIÓN 2: RUTINAS AUTOMÁTICAS Y MANTENIMIENTO
// ==========================================

async function limpiarRegistrosAntiguos() {
    const ahora = Date.now();
    const sieteDiasMs = 7 * 24 * 60 * 60 * 1000; // 7 días en milisegundos
    const limiteTiempo = ahora - sieteDiasMs;

    const rutasALimpiar = ['sistema/depositos_pendientes', 'sistema/historial'];

    for (const ruta of rutasALimpiar) {
        const ref = db.ref(ruta);
        try {
            const snapshot = await ref.once('value');
            if (snapshot.exists()) {
                const actualizaciones = {};
                
                snapshot.forEach((childSnapshot) => {
                    const registro = childSnapshot.val();
                    const tiempoRegistro = registro.timestamp || registro.fecha || 0;

                    if (typeof tiempoRegistro === 'number' && tiempoRegistro > 0 && tiempoRegistro < limiteTiempo) {
                        actualizaciones[childSnapshot.key] = null;
                    }
                });

                if (Object.keys(actualizaciones).length > 0) {
                    await ref.update(actualizaciones);
                    console.log(`[LIMPIEZA AUTOMÁTICA] Se eliminaron registros antiguos en la ruta: ${ruta}`);
                }
            }
        } catch (error) {
            console.error(`[ERROR DE LIMPIEZA] No se pudo limpiar la ruta ${ruta}:`, error);
        }
    }
}

// Programar ejecución de limpieza cada 24 horas y al iniciar el servidor
const CADA_24_HORAS = 24 * 60 * 60 * 1000;
setInterval(limpiarRegistrosAntiguos, CADA_24_HORAS);
limpiarRegistrosAntiguos();


// ==========================================
// SECCIÓN 3: MOTOR Y CICLO DE VIDA DEL JUEGO
// ==========================================

function cicloJuego() {
    if (juegoEnEjecucion) return;
    juegoEnEjecucion = true;      
    
    contadorRondas++;
    console.log(`[ESPÍA - CICLO] ==================== INICIANDO RONDA #${contadorRondas} ====================`);
    
    db.ref('sistema/global/estadoJuego').set("apuestas");
    db.ref('sistema/global/comandoGiro').set(null);
    
    let tiempo = 40; 
    let contador = setInterval(async () => {
        const snapComando = await db.ref('sistema/global/comandoGiro').once('value');
        const cmd = snapComando.val();
        
        if (cmd && cmd.estado === "girando" && cmd.forzadoManual) {
            console.log(`[ESPÍA - CICLO] ¡Alerta! Giro manual forzado por el administrador detectado en el segundo ${tiempo}.`);
            clearInterval(contador);
            await ejecutarGiroManual(cmd.indiceGanador);
            juegoEnEjecucion = false;
            return;
        }

        io.emit('tiempo-actualizado', tiempo); 
        tiempo--;
        
        if (tiempo < 0) {
            clearInterval(contador);
            console.log("[ESPÍA - CICLO] Tiempo de apuestas agotado. Verificando cierre...");
            setTimeout(async () => {
                const snapCheck = await db.ref('sistema/global/comandoGiro').once('value');
                const cmdCheck = snapCheck.val();
                
                if (cmdCheck && cmdCheck.estado === "girando" && cmdCheck.indiceGanador !== undefined) {
                    console.log(`[ESPÍA - CICLO] Ejecutando giro dirigido de última hora. Índice: ${cmdCheck.indiceGanador}`);
                    await ejecutarGiroManual(cmdCheck.indiceGanador);
                } else {
                    await iniciarFaseGiro();
                }
                juegoEnEjecucion = false;
            }, 500); 
        }
    }, 1000);
}

async function iniciarFaseGiro() {
    console.log("[ESPÍA - GIRO] Iniciando fase de giro automático seguro.");
    await db.ref('sistema/global/estadoJuego').set("giro");
    let resultado = await determinarGanadorSeguro();
    
    console.log(`[ESPÍA - GIRO] Resultado seleccionado de forma segura -> Figura Índice: ${resultado.indice}, Tipo: ${resultado.tipo}`);

    const comandoGiroData = { 
        estado: "girando", 
        indiceGanador: resultado.indice, 
        tipo: resultado.tipo,
        forzadoManual: false
    };

    await db.ref('sistema/global/comandoGiro').set(comandoGiroData);
    io.emit('iniciar-giro-visual', comandoGiroData);

    await procesarFinalizacionGiro(resultado.indice, resultado.tipo);
}

async function ejecutarGiroManual(indiceGanador) {
    console.log(`[ESPÍA - GIRO MANUAL] Administrador forzó giro manual. Índice objetivo: ${indiceGanador}`);
    await db.ref('sistema/global/estadoJuego').set("giro");
    
    const comandoGiroData = { 
        estado: "girando", 
        indiceGanador: indiceGanador, 
        tipo: "MANUAL_ADMIN",
        forzadoManual: true
    };

    await db.ref('sistema/global/comandoGiro').set(comandoGiroData);
    io.emit('iniciar-giro-visual', comandoGiroData);

    await procesarFinalizacionGiro(indiceGanador, "NORMAL");
}

async function procesarFinalizacionGiro(indiceGanador, tipoJuego) {
    const elementosSorteo = ["Limón", "Coco", "Manzana", "Pera", "Cereza", "Durazno", "Kiwi", "Ciruela", "Mora", "Aguacate", "Perro", "Gato", "León", "Tigre", "Mono", "Oso", "Zorro", "Lobo", "Águila", "Loro", "Delfín", "Culebra", "Sapo", "Pez", "Toro", "Vaca", "Caballo", "Oveja", "Gallo", "Fresa"];

    setTimeout(() => {
        db.ref('sistema/global/estadoJuego').set("resultados");
        console.log("[ESPÍA - RESULTADOS] Mostrando resultados en pantalla...");
        
        setTimeout(async () => {
            const figuraGanadora = elementosSorteo[indiceGanador];
            console.log(`[ESPÍA - RESULTADOS] Figura ganadora oficial de la ronda: ${figuraGanadora}`);
            
            // ⚡ REGISTRO DE HISTORIAL DESDE EL BACKEND (Soluciona el error de permisos del cliente)
            try {
                await db.ref('sistema/historial').push({
                    resultado: figuraGanadora,
                    timestamp: admin.database.ServerValue.TIMESTAMP
                });
                console.log(`[ESPÍA - HISTORIAL] Resultado '${figuraGanadora}' guardado correctamente en el historial.`);
            } catch (histError) {
                console.error("[ESPÍA - ERROR HISTORIAL] No se pudo guardar el historial:", histError);
            }

            await procesarGanadores(figuraGanadora, tipoJuego);
            
            console.log("[ESPÍA - LIMPIEZA] Limpiando apuestas de la figura y historiales de usuarios...");
            await db.ref('sistema/apuestas_por_figura').set(null);
            
            const snapUsers = await db.ref('sistema/usuarios').once('value');
            const updatesLimpieza = {};
            snapUsers.forEach((child) => {
                updatesLimpieza[`sistema/usuarios/${child.key}/historialApuestas`] = null;
            });
            await db.ref().update(updatesLimpieza);
            
            io.emit('limpiar-interfaz'); 
            console.log("[ESPÍA - CICLO] Limpieza completa. Reiniciando ciclo de juego...");
            cicloJuego(); 
        }, 5000); 
    }, 5000); 
}


// ==========================================
// SECCIÓN 4: PROCESAMIENTO DE GANADORES Y SORTEO SEGURO
// ==========================================

async function procesarGanadores(figuraGanadora, tipoJuego) {
    console.log(`[ESPÍA - GANADORES] Iniciando procesamiento. Figura: ${figuraGanadora}, Tipo de juego: ${tipoJuego}`);
    
    io.emit('resultado-ronda', { figura: figuraGanadora });
    console.log(`[ESPÍA - RESULTADO GENERAL] Emitido evento global de resultado: Salió ${figuraGanadora}`);

    const snapUsuarios = await db.ref('sistema/usuarios').once('value');
    const usuarios = snapUsuarios.val() || {};
    
    let ganadoresSuperpote = [];
    let totalApuestasSuperpote = 0;
    let totalPremiosRonda = 0;
    let totalPremiosRealesPagados = 0; 

    const snapPote = await db.ref('sistema/global/pote').once('value');
    const poteActual = snapPote.val() || 0;

    let ganadoresDetectados = [];

    for (const userId in usuarios) {
        const usuario = usuarios[userId];
        
        if (usuario.online !== true) {
            console.log(`[ESPÍA - GANADORES] Omitiendo usuario ${userId} por encontrarse desconectado.`);
            continue;
        }

        if (usuario.historialApuestas) {
            const apuestasArray = Object.values(usuario.historialApuestas);
            const apuestaGanadora = apuestasArray.find(a => a.figura === figuraGanadora);

            if (apuestaGanadora) {
                const gananciaBase = apuestaGanadora.monto * 30;
                ganadoresDetectados.push({ userId, usuario, apuestaGanadora, gananciaBase });
                totalPremiosRonda += gananciaBase;
            }
        }
    }

    let factorDeAjuste = 1;
    if (totalPremiosRonda > poteActual) {
        console.log(`[ESPÍA - POTE GLOBAL] ¡ALERTA CRÍTICA DE SOLVENCIA! El premio total (${totalPremiosRonda}) supera el pote disponible (${poteActual}). Ajustando pagos al capital real.`);
        if (poteActual > 0) {
            factorDeAjuste = poteActual / totalPremiosRonda;
        } else {
            factorDeAjuste = 0;
        }
    }

    let huboGanadoresGenerales = ganadoresDetectados.length > 0;
    let montoTotalRepartidoRonda = 0;

    for (const ganador of ganadoresDetectados) {
        montoTotalRepartidoRonda += Math.floor(ganador.gananciaBase * factorDeAjuste);
    }

    for (const ganador of ganadoresDetectados) {
        const { userId, usuario, apuestaGanadora, gananciaBase } = ganador;
        const gananciaReal = Math.floor(gananciaBase * factorDeAjuste);
        
        totalPremiosRealesPagados += gananciaReal;
        
        console.log(`[ESPÍA - GANADORES] ¡Acierto detectado! Usuario ${userId} apostó ${apuestaGanadora.monto} a ${figuraGanadora}. Premio base ajustado: ${gananciaReal} (Original: ${gananciaBase})`);
        
        if (gananciaReal > 0) {
            await db.ref(`sistema/usuarios/${userId}/saldo`).transaction(s => {
                const saldoActual = s || 0;
                const nuevoSaldo = saldoActual + gananciaReal;
                console.log(`[ESPÍA - SALDO USUARIO] ID: ${userId} | Saldo anterior: ${saldoActual} | Nuevo saldo sumado premio: ${nuevoSaldo}`);
                return nuevoSaldo;
            });

            io.to(userId).emit('notificar-resultado-personal', {
                figuraGanadora: figuraGanadora,
                montoGanado: gananciaReal,
                huboGanadores: true,
                montoTotalRepartido: montoTotalRepartidoRonda
            });

            if (tipoJuego === "SUPERPOTE" && apuestaGanadora.esAptoParaPote && factorDeAjuste === 1) {
                ganadoresSuperpote.push({ userId, monto: apuestaGanadora.monto });
                totalApuestasSuperpote += apuestaGanadora.monto;
                console.log(`[ESPÍA - SUPERPOTE] Usuario ${userId} es apto para el extra del superpote con monto: ${apuestaGanadora.monto}`);
            }
        } else {
            console.log(`[ESPÍA - SALDO USUARIO] ID: ${userId} | El pote estaba en 0, no se pudo emitir pago de premio en esta ronda.`);
            
            io.to(userId).emit('notificar-resultado-personal', {
                figuraGanadora: figuraGanadora,
                montoGanado: 0,
                huboGanadores: true,
                montoTotalRepartido: 0
            });
        }
    }

    for (const userId in usuarios) {
        const usuario = usuarios[userId];
        if (usuario.online !== true) continue;

        const esGanador = ganadoresDetectados.some(g => g.userId === userId);
        if (!esGanador) {
            io.to(userId).emit('notificar-resultado-personal', {
                figuraGanadora: figuraGanadora,
                montoGanado: 0,
                huboGanadores: huboGanadoresGenerales,
                montoTotalRepartido: montoTotalRepartidoRonda
            });
        }
    }
    
    const LIMITE_SUPERPOTE = 150000;
    let montoExtraSuperpote = 0;

    if (poteActual >= LIMITE_SUPERPOTE && tipoJuego === "SUPERPOTE" && ganadoresSuperpote.length > 0 && factorDeAjuste === 1) {
        montoExtraSuperpote = 150000;
        console.log(`[ESPÍA - SUPERPOTE] ¡Condición cumplida! El pote (${poteActual}) supera los ${LIMITE_SUPERPOTE}. Activando extra de superpote.`);
    }

    const descuentoTotalDelPote = totalPremiosRealesPagados + montoExtraSuperpote;

    if (descuentoTotalDelPote > 0) {
        console.log(`[ESPÍA - POTE GLOBAL] Descontando del pote mesa un total de: ${descuentoTotalDelPote} Bs`);

        await db.ref('sistema/global/pote').transaction(p => {
            const actual = p || 0;
            const resultado = Math.max(0, actual - descuentoTotalDelPote);
            console.log(`[ESPÍA - POTE GLOBAL] Pote anterior: ${actual} | Pote posterior al pago: ${resultado}`);
            return resultado;
        });
    } else {
        console.log("[ESPÍA - POTE GLOBAL] No hubo premios que descontar del pote en esta ronda.");
    }

    if (montoExtraSuperpote > 0 && ganadoresSuperpote.length > 0) {
        for (const ganador of ganadoresSuperpote) {
            const parteExtra = (ganador.monto / totalApuestasSuperpote) * montoExtraSuperpote;
            console.log(`[ESPÍA - REPARTO EXTRA] Repartiendo extra de superpote a ${ganador.userId}: ${parteExtra}`);
            
            await db.ref(`sistema/usuarios/${ganador.userId}/saldo`).transaction(s => (s || 0) + parteExtra);
            
            io.to(ganador.userId).emit('evento-superpote', { 
                mensaje: "¡GANADOR DE EXTRA SUPERPOTE!", 
                monto: parteExtra.toFixed(2) 
            });
        }
    }

    console.log("[ESPÍA - GANADORES] Procesamiento de ganadores finalizado con éxito.");
}

async function determinarGanadorSeguro() {
    const FONDO_RESERVA = 1000; 
    
    const snapPote = await db.ref('sistema/global/pote').once('value');
    const poteActual = snapPote.val() || 0;
    const snapApuestas = await db.ref('sistema/apuestas_por_figura').once('value');
    const apuestas = snapApuestas.val() || {};

    const elementosSorteo = [
        "Limón", "Coco", "Manzana", "Pera", "Cereza", "Durazno", "Kiwi", "Ciruela", "Mora", "Aguacate",
        "Perro", "Gato", "León", "Tigre", "Mono", "Oso", "Zorro", "Lobo", "Águila", "Loro",
        "Delfín", "Culebra", "Sapo", "Pez", "Toro", "Vaca", "Caballo", "Oveja", "Gallo", "Fresa"
    ];

    const excedenteReal = Math.max(0, poteActual - FONDO_RESERVA);
    console.log(`[ESPÍA - SEGURIDAD] Evaluando sorteo seguro -> Pote actual: ${poteActual} | Fondo reserva obligatorio: ${FONDO_RESERVA} | Excedente real disponible: ${excedenteReal}`);

    let seguras = elementosSorteo.map((figura, index) => ({ 
        figura, index, monto: apuestas[figura] || 0 
    })).filter(item => {
        const pagoPotencial = item.monto * 30;
        const esSegura = item.monto === 0 || pagoPotencial <= excedenteReal;
        return esSegura;
    });

    console.log(`[ESPÍA - SEGURIDAD] Figuras con apuestas y pago cubrible por el excedente (o sin apuestas): ${seguras.length}`);

    if (seguras.length === 0) {
        console.log("[ESPÍA - SEGURIDAD] ¡ALERTA MÁXIMA! Tablero saturado o sin excedente. Buscando figura con la menor apuesta para minimizar impacto.");
        
        let listaElementos = elementosSorteo.map((figura, index) => ({
            figura, index, monto: apuestas[figura] || 0
        }));

        listaElementos.sort((a, b) => a.monto - b.monto);

        let elegidaRespaldo = listaElementos[0];
        console.log(`[ESPÍA - SEGURIDAD] Sorteo modo CONTENCIÓN DE CRISIS: Seleccionando figura con menor apuesta -> ${elegidaRespaldo.figura} (Monto: ${elegidaRespaldo.monto})`);
        return { indice: elegidaRespaldo.index, tipo: "NORMAL" };
    }

    let figurasSinApuestas = seguras.filter(s => s.monto === 0);
    
    if (figurasSinApuestas.length > 0) {
        let elegida = figurasSinApuestas[Math.floor(Math.random() * figurasSinApuestas.length)];
        console.log(`[ESPÍA - SEGURIDAD] Sorteo modo SEGURO ABSOLUTO (Figura sin riesgo con 0 apuestas): ${elegida.figura} (Índice: ${elegida.index})`);
        return { indice: elegida.index, tipo: "NORMAL" };
    }

    const esSuperpote = poteActual >= 150000;
    if (esSuperpote) {
        let conApuestas = seguras.filter(s => s.monto > 0);
        if (conApuestas.length > 0) {
            let elegida = conApuestas[Math.floor(Math.random() * conApuestas.length)];
            console.log(`[ESPÍA - SEGURIDAD] Sorteo modo SUPERPOTE activado de forma segura con la figura: ${elegida.figura} (Índice: ${elegida.index})`);
            return { indice: elegida.index, tipo: "SUPERPOTE" };
        }
    }

    let elegida = seguras[Math.floor(Math.random() * seguras.length)];
    console.log(`[ESPÍA - SEGURIDAD] Sorteo modo NORMAL seguro seleccionado con la figura: ${elegida.figura} (Índice: ${elegida.index})`);
    return { indice: elegida.index, tipo: "NORMAL" };
}


// ==========================================
// SECCIÓN 5: RUTAS HTTP Y TRANSACCIONES DE APUESTAS
// ==========================================

app.post('/realizar-apuesta', async (req, res) => {
    const { userId, monto, figura } = req.body;
    const montoNum = Number(monto);
    console.log(`[ESPÍA - APUESTA] Recibida solicitud de usuario ${userId} -> Figura: ${figura}, Monto: ${montoNum}`);
    
    if (typeof montoNum !== 'number' || isNaN(montoNum) || montoNum < MIN_MONTO || montoNum > MAX_MONTO) {
        console.log(`[ESPÍA - APUESTA RECHAZADA] Monto fuera de límites válidos (${MIN_MONTO} - ${MAX_MONTO}): ${montoNum}`);
        return res.status(400).json({ error: `El monto de la apuesta debe estar entre ${MIN_MONTO} y ${MAX_MONTO} Bs.` });
    }

    try {
        const refUser = db.ref(`sistema/usuarios/${userId}`);
        const snapshot = await refUser.once('value');
        const usuario = snapshot.val();

        if (!usuario || Number(usuario.saldo) < montoNum) {
            console.log(`[ESPÍA - APUESTA RECHAZADA] Saldo insuficiente para usuario ${userId}. Saldo actual: ${usuario ? usuario.saldo : 'No existe'}`);
            return res.status(400).json({ error: "Saldo insuficiente" });
        }

        if (montoNum > 500) {
            console.log(`[ESPÍA - APUESTA RECHAZADA] Monto excedido por usuario ${userId}: ${montoNum} (Máximo 500)`);
            return res.status(400).json({ error: "La apuesta máxima por figura es de 500 Bs." });
        }

        const snapApuestasUsuario = await db.ref('sistema/usuarios').once('value');
        const todosUsuarios = snapApuestasUsuario.val() || {};
        let contadorEnFigura = 0;

        for (const uid in todosUsuarios) {
            if (todosUsuarios[uid].historialApuestas) {
                const haApostado = Object.values(todosUsuarios[uid].historialApuestas).some(a => a.figura === figura);
                if (haApostado) contadorEnFigura++;
            }
        }

        if (contadorEnFigura >= 10) {
            console.log(`[ESPÍA - APUESTA RECHAZADA] Figura ${figura} alcanzó el límite global de 10 jugadores.`);
            return res.status(400).json({ error: "Esta figura ya alcanzó el límite de 10 apuestas." });
        }

        if (usuario.historialApuestas) {
            const yaApostoFigura = Object.values(usuario.historialApuestas).some(a => a.figura === figura);
            if (yaApostoFigura) {
                console.log(`[ESPÍA - APUESTA RECHAZADA] Usuario ${userId} ya tiene una apuesta activa en ${figura}.`);
                return res.status(400).json({ error: "Ya tienes una apuesta activa en esta figura." });
            }
        }
        
        const esAptoParaPote = montoNum >= 500;
        const comision = montoNum * 0.20;
        const apuestaNeta = montoNum * 0.80;

        console.log(`[ESPÍA - APUESTA EXITOSA] Descontando saldo usuario, aplicando 20% casa (${comision}) y 80% al pote (${apuestaNeta})`);

        await refUser.update({ saldo: Number(usuario.saldo) - montoNum });
        await db.ref('sistema/global/bovedaCasa').transaction(b => (b || 0) + comision);
        await db.ref('sistema/global/pote').transaction(p => (p || 0) + apuestaNeta);
        await db.ref(`sistema/apuestas_por_figura/${figura}`).transaction(m => (m || 0) + montoNum);
        
        await db.ref(`sistema/usuarios/${userId}/historialApuestas`).push({ 
            figura: figura, 
            monto: montoNum, 
            esAptoParaPote: esAptoParaPote, 
            timestamp: Date.now() 
        });
        
        await db.ref(`sistema/usuarios/${userId}/ultimaApuesta`).set({ figura, monto: montoNum, timestamp: Date.now() });
        
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("[ESPÍA - ERROR APUESTA] Error crítico al procesar apuesta:", error);
        return res.status(500).json({ error: "Error interno" });
    }
});

app.post('/solicitar-deposito', async (req, res) => {
    const { userId, nombre, monto, referencia, banco } = req.body;
    const montoNum = Number(monto);

    if (typeof montoNum !== 'number' || isNaN(montoNum) || montoNum < MIN_MONTO || montoNum > MAX_MONTO) {
        console.log(`[DEPÓSITO RECHAZADO] Monto fuera de rango permitido (${MIN_MONTO} - ${MAX_MONTO}): ${montoNum}`);
        return res.status(400).json({ error: `El monto del depósito debe estar entre ${MIN_MONTO} Bs y ${MAX_MONTO} Bs.` });
    }
    
    try {
        const snapUser = await db.ref(`sistema/usuarios/${userId}`).once('value');
        const userData = snapUser.val() || {};

        let nombreReal = userData.nombre || nombre || "Usuario";

        let nuevaSolicitud = {
            usuarioId: userId,
            nombre: nombreReal,
            monto: montoNum,
            tipo: "DEPOSITAR",
            referencia: String(referencia).trim(),
            banco: banco ? String(banco).trim() : "No especificado",
            timestamp: admin.database.ServerValue.TIMESTAMP
        };

        await db.ref('sistema/depositos_pendientes').push(nuevaSolicitud);
        console.log(`[ESPÍA - DEPÓSITO] Solicitud registrada para el usuario ${userId} con banco: ${nuevaSolicitud.banco}`);
        return res.status(200).json({ success: true, message: "Depósito registrado." });
    } catch (error) {
        console.error("[ERROR DEPOSITO]:", error);
        return res.status(500).json({ error: "Error interno en el servidor." });
    }
});

app.post('/login-usuario', async (req, res) => {
    try {
        const { dato } = req.body;
        if (!dato) {
            return res.status(400).json({ success: false, error: "Dato de ingreso vacío." });
        }

        const snapshot = await admin.database().ref('sistema/usuarios').once('value');
        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, error: "No hay usuarios registrados." });
        }

        let idEncontrado = null;
        snapshot.forEach((child) => {
            let usuario = child.val();
            if (child.key.toLowerCase() === dato || (usuario.telefono && usuario.telefono.toLowerCase() === dato)) {
                idEncontrado = child.key;
            }
        });

        if (idEncontrado) {
            return res.json({ success: true, userId: idEncontrado });
        } else {
            return res.status(404).json({ success: false, error: "El usuario o teléfono no existe." });
        }

    } catch (error) {
        console.error("❌ Error en /login-usuario:", error);
        return res.status(500).json({ success: false, error: "Error interno del servidor." });
    }
});

app.post('/deshacer-apuesta', async (req, res) => {
    const { userId } = req.body;
    console.log(`[ESPÍA - DESHACER] Solicitud para deshacer última apuesta del usuario ${userId}`);
    
    try {
        const estadoSnap = await db.ref('sistema/global/estadoJuego').once('value');
        const estadoActual = estadoSnap.val();

        if (estadoActual !== "apuestas") {
            console.log(`[ESPÍA - DESHACER RECHAZADO] Tiempo de apuestas cerrado (Estado: ${estadoActual})`);
            return res.status(403).json({ success: false, message: "Tiempo de apuestas cerrado." });
        }

        const userRef = db.ref(`sistema/usuarios/${userId}`);
        const snap = await userRef.once('value');
        const userData = snap.val();

        if (!userData || !userData.historialApuestas) {
            console.log(`[ESPÍA - DESHACER RECHAZADO] No hay apuestas activas para ${userId}`);
            return res.status(400).json({ success: false, message: "No hay apuestas activas." });
        }

        const keys = Object.keys(userData.historialApuestas);
        const lastKey = keys[keys.length - 1];
        const apuesta = userData.historialApuestas[lastKey];

        console.log(`[ESPÍA - DESHACER] Devolviendo ${apuesta.monto} Bs al usuario ${userId} por apuesta en ${apuesta.figura}`);

        await db.ref(`sistema/usuarios/${userId}/saldo`).transaction((currentSaldo) => {
            return (Number(currentSaldo) || 0) + Number(apuesta.monto);
        });

        const updates = {};
        updates[`sistema/usuarios/${userId}/historialApuestas/${lastKey}`] = null;
        
        const poteSnap = await db.ref('sistema/global/pote').once('value');
        updates['sistema/global/pote'] = Math.max(0, (poteSnap.val() || 0) - apuesta.monto);
        
        const figSnap = await db.ref(`sistema/apuestas_por_figura/${apuesta.figura}`).once('value');
        updates[`sistema/apuestas_por_figura/${apuesta.figura}`] = Math.max(0, (figSnap.val() || 0) - apuesta.monto);

        await db.ref().update(updates);
        
        console.log(`[ESPÍA - DESHACER EXITOSO] Apuesta revertida correctamente para ${userId}.`);
        res.json({ success: true });
    } catch (e) {
        console.error("[ESPÍA - ERROR DESHACER] Error crítico al deshacer apuesta:", e);
        res.status(500).json({ success: false, message: "Error interno" });
    }
});

app.post('/repetir-ultima-apuesta', async (req, res) => {
    const { userId } = req.body;
    try {
        const snap = await db.ref(`sistema/usuarios/${userId}/ultimaJugada`).once('value');
        const jugada = snap.val();
        
        if (!jugada) return res.json({ success: false, message: "No hay jugada previa." });
        
        res.json({ success: true, figura: jugada.figura, monto: jugada.monto });
    } catch (error) { res.status(500).json({ success: false }); }
});


// ==========================================
// SECCIÓN 6: GESTIÓN DE WEBSOCKETS (SOCKET.IO)
// ==========================================

io.on('connection', (socket) => {
    console.log("[ESPÍA - SOCKET] Nuevo usuario conectado al servidor por WebSocket.");
    
    socket.on('usuario_conecta', (userId) => { 
        socket.userId = userId; 
        socket.join(userId); 
        
        const refUserOnline = db.ref(`sistema/usuarios/${userId}/online`);
        refUserOnline.set(true);
        refUserOnline.onDisconnect().set(false);

        db.ref(`sistema/online/${userId}`).set(true); 
        console.log(`[ESPÍA - SOCKET] Usuario autenticado y vinculado a sala personal: ${userId}`);
    });
    
    socket.on('disconnect', (reason) => { 
        if(socket.userId) {
            db.ref(`sistema/usuarios/${socket.userId}/online`).set(false);
            db.ref(`sistema/online/${socket.userId}`).remove();
            console.log(`[ESPÍA - RED ALERTA] ⚠️ Usuario desconectado por red/cierre: ${socket.userId} | Motivo del socket: ${reason}`);
        } else {
            console.log(`[ESPÍA - RED ALERTA] ⚠️ Cliente anónimo o sin sesión socket desconectado. Motivo: ${reason}`);
        }
    });
    
    socket.on('log_cliente', (data) => console.log(`[LOG CLIENTE - ${socket.userId || 'Anonimo'}]:`, data));

    db.ref('sistema/global/estadoJuego').once('value', (snap) => {
        const estado = snap.val();
        if (estado === 'apuestas') {
            socket.emit('tiempo-actualizado', 40); 
        } else if (estado === 'giro') {
            socket.emit('estado-juego', 'girando');
        }
    });
});


// ==========================================
// SECCIÓN 7: INICIO DEL SERVIDOR HTTP
// ==========================================

cicloJuego();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});