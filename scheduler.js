// Agendador em Node puro (sem binario externo). Dispara o fuzzing.js no horario
// alvo, de segunda a sexta, usando o fuso definido por TZ no container.
const { spawn } = require('child_process');
const path = require('path');

const HH = Number(process.env.CRON_HOUR || 11);
const MM = Number(process.env.CRON_MINUTE || 57);
const DAYS = [1, 2, 3, 4, 5]; // getDay(): 0=domingo ... 6=sabado -> seg a sex

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function runFuzzing() {
  log('=> disparando fuzzing.js');
  const child = spawn(process.execPath, [path.join(__dirname, 'fuzzing.js')], { stdio: 'inherit' });
  child.on('exit', code => log('<= fuzzing.js finalizou (codigo', code + ')'));
  child.on('error', err => log('!! erro ao iniciar fuzzing.js:', err.message));
}

// Calcula quantos ms faltam para o proximo HH:MM que caia em dia util.
function msUntilNext() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(HH, MM, 0, 0);
  while (next <= now || !DAYS.includes(next.getDay())) {
    next.setDate(next.getDate() + 1);
    next.setHours(HH, MM, 0, 0);
  }
  return next.getTime() - now.getTime();
}

function scheduleNext() {
  const ms = msUntilNext();
  const when = new Date(Date.now() + ms);
  log(`proxima execucao: ${when.toString()} (em ${Math.round(ms / 1000)}s)`);
  setTimeout(() => {
    runFuzzing();
    scheduleNext();
  }, ms);
}

const alvo = `${String(HH).padStart(2, '0')}:${String(MM).padStart(2, '0')}`;
log(`scheduler ativo | alvo ${alvo} seg-sex | TZ=${process.env.TZ || '(host)'} | agora=${new Date().toString()}`);

// RUN_ON_START=1 executa uma vez ao subir (util para testar sem esperar o horario).
if (process.env.RUN_ON_START === '1') runFuzzing();

scheduleNext();
