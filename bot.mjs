import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==============================
// CONFIG
// ==============================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_DIR = path.join(__dirname, 'states');
const LICENSE_FILE = path.resolve('./.license');
const CONFIG_FILE = path.join(__dirname, 'accounts.json');
const NOTIFY_INTERVAL_MS = parseInt(process.env.NOTIFY_INTERVAL_MS || '1800000');
const TASK_NOTIFY_EVERY = parseInt(process.env.TASK_NOTIFY_EVERY || '50');
const LICENSE_CHECK_URL = 'https://license-server-indol.vercel.app/api/check-code';
const APP_NAME = 'peanut';

if (!TOKEN || !CHAT_ID) {
  console.error('❌ TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID harus diset di environment variables');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ==============================
// SET BOT COMMANDS (Menu button Telegram)
// ==============================
bot.setMyCommands([
  { command: 'start',         description: '🏠 Menu utama' },
  { command: 'stats',         description: '📊 Lihat earnings semua akun' },
  { command: 'status',        description: '✅ Cek apakah miner aktif' },
  { command: 'notify',        description: '🔔 Kirim update stats sekarang' },
  { command: 'license',       description: '🔐 Input atau cek license' },
  { command: 'clearlicense',  description: '🗑️ Hapus license tersimpan' },
  { command: 'addaccount',    description: '➕ Tambah wallet akun baru' },
  { command: 'listaccounts',  description: '📋 Lihat semua akun terdaftar' },
  { command: 'removeaccount', description: '❌ Hapus akun dari daftar' },
  { command: 'setcompute',    description: '⚙️ Ganti compute capability CPU/GPU' },
  { command: 'setinterval',   description: '⏱️ Ganti mining interval ms' },
  { command: 'help',          description: '❓ Bantuan' },
]).then(() => console.log('✅ Bot commands registered'));

// ==============================
// SESSION untuk multi-step input
// ==============================
const sessions = {};

// ==============================
// HELPERS
// ==============================
const fetch = (await import('node-fetch')).default;

function isAuthorized(msg) {
  return msg.chat.id.toString() === CHAT_ID.toString();
}

function escape(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function sendMessage(text, options = {}) {
  return bot.sendMessage(CHAT_ID, text, {
    parse_mode: 'MarkdownV2',
    ...options
  }).catch(err => console.error('Send error:', err.message));
}

function getAllStates() {
  try {
    if (!fs.existsSync(STATE_DIR)) return [];
    return fs.readdirSync(STATE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(file => {
        const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf-8'));
        const id = file.replace('state_', '').replace('.json', '');
        return { id, ...state };
      });
  } catch { return []; }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {
    settings: {
      compute_capability: 'CPU',
      max_vcus: 1000,
      mining_interval_ms: 2000,
      max_consecutive_failures: 10,
      retry_delay_ms: 5000
    },
    accounts: []
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function readLocalLicense() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    if (!data || data.verified !== true) return null;
    if (data.expiresAt && new Date(data.expiresAt) < new Date()) return null;
    return data;
  } catch { return null; }
}

async function verifyLicenseCode(code) {
  try {
    const url = new URL(LICENSE_CHECK_URL);
    url.searchParams.set('app', APP_NAME);
    url.searchParams.set('code', code.trim());
    const res = await fetch(url.toString());
    const json = await res.json().catch(() => null);
    if (json?.enabled === false) return { ok: false, message: 'App dinonaktifkan oleh admin' };
    if (!json || !json.ok || !json.valid) return { ok: false, message: 'Kode license tidak valid' };
    fs.writeFileSync(LICENSE_FILE, JSON.stringify({
      verified: true,
      userId: json.userId,
      app: APP_NAME,
      ts: Date.now(),
      expiresAt: json.expiresAt || null
    }, null, 2), 'utf-8');
    return { ok: true, userId: json.userId };
  } catch (err) {
    return { ok: false, message: `Network error: ${err.message}` };
  }
}

function formatStats(states) {
  if (states.length === 0) {
    return '❌ Belum ada data mining\\. Miner mungkin belum berjalan\\.';
  }

  let text = '📊 *Mining Stats*\n';
  text += `🕐 ${escape(new Date().toLocaleString('id-ID'))}\n`;
  text += '━━━━━━━━━━━━━━━━━━\n\n';

  let totalPeanut = 0, totalVcus = 0, totalTasks = 0;

  states.forEach(state => {
    const peanut = state.total_peanut || 0;
    const vcus = state.total_vcus || 0;
    const tasks = state.total_tasks || 0;
    const lastActivity = state.last_activity
      ? escape(new Date(state.last_activity).toLocaleString('id-ID'))
      : 'N/A';
    totalPeanut += peanut;
    totalVcus += vcus;
    totalTasks += tasks;

    text += `👤 *${escape(state.id)}*\n`;
    text += `💰 \\$PEANUT: \`${escape(peanut.toLocaleString())}\`\n`;
    text += `⚡ VCUs: \`${escape(vcus.toLocaleString())}\`\n`;
    text += `✅ Tasks: \`${escape(tasks.toLocaleString())}\`\n`;
    text += `🕐 Last: ${lastActivity}\n\n`;
  });

  if (states.length > 1) {
    text += '━━━━━━━━━━━━━━━━━━\n';
    text += `📦 *Total ${states.length} Akun*\n`;
    text += `💰 \\$PEANUT: \`${escape(totalPeanut.toLocaleString())}\`\n`;
    text += `⚡ VCUs: \`${escape(totalVcus.toLocaleString())}\`\n`;
    text += `✅ Tasks: \`${escape(totalTasks.toLocaleString())}\`\n`;
  }
  return text;
}

// ==============================
// COMMANDS
// ==============================

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg)) return;
  sendMessage(
    '🥜 *\\$PEANUT Miner Bot*\n\n' +
    '*Mining*\n' +
    '/stats \\- Lihat earnings\n' +
    '/status \\- Cek miner aktif\n' +
    '/notify \\- Update manual\n\n' +
    '*License*\n' +
    '/license \\- Input atau cek license\n' +
    '/clearlicense \\- Hapus license\n\n' +
    '*Akun*\n' +
    '/addaccount \\- Tambah wallet baru\n' +
    '/listaccounts \\- Lihat semua akun\n' +
    '/removeaccount \\- Hapus akun\n\n' +
    '*Settings*\n' +
    '/setcompute \\- Ganti CPU\\/GPU\n' +
    '/setinterval \\- Ganti interval mining'
  );
});

bot.onText(/\/stats/, (msg) => {
  if (!isAuthorized(msg)) return;
  sendMessage(formatStats(getAllStates()));
});

bot.onText(/\/status/, (msg) => {
  if (!isAuthorized(msg)) return;
  const states = getAllStates();
  if (states.length === 0) return sendMessage('❌ Tidak ada data\\. Miner belum jalan\\.');
  let text = '🔍 *Status Miner*\n\n';
  const now = Date.now();
  states.forEach(state => {
    const diffMin = Math.floor((now - new Date(state.last_activity || 0).getTime()) / 60000);
    const icon = diffMin <= 5 ? '🟢' : diffMin <= 30 ? '🟡' : '🔴';
    const label = diffMin <= 5 ? 'Aktif' : diffMin <= 30
      ? `Lambat \\(${diffMin}m\\)`
      : `Mati \\(${diffMin}m\\)`;
    text += `${icon} *${escape(state.id)}*: ${label}\n`;
  });
  sendMessage(text);
});

bot.onText(/\/notify/, (msg) => {
  if (!isAuthorized(msg)) return;
  sendMessage(formatStats(getAllStates()));
});

bot.onText(/\/help/, (msg) => {
  if (!isAuthorized(msg)) return;
  sendMessage(
    '❓ *Help*\n\n' +
    '/stats \\- Earnings semua akun\n' +
    '/status \\- Cek miner aktif\\/mati\n' +
    '/notify \\- Trigger update manual\n' +
    '/license \\- Input atau cek license aktif\n' +
    '/clearlicense \\- Hapus license untuk re\\-input\n' +
    '/addaccount \\- Tambah wallet baru\n' +
    '/listaccounts \\- Lihat semua akun\n' +
    '/removeaccount \\- Hapus akun\n' +
    '/setcompute \\- Ganti CPU atau GPU\n' +
    '/setinterval \\- Ganti mining interval'
  );
});

// ==============================
// LICENSE
// ==============================

bot.onText(/\/license/, (msg) => {
  if (!isAuthorized(msg)) return;
  const local = readLocalLicense();
  if (local) {
    sendMessage(
      '🔓 *License Aktif*\n\n' +
      `👤 User ID: \`${escape(local.userId)}\`\n` +
      `📅 Tersimpan: ${escape(new Date(local.ts).toLocaleString('id-ID'))}\n` +
      `⏳ Expired: ${local.expiresAt ? escape(new Date(local.expiresAt).toLocaleString('id-ID')) : 'Tidak ada'}\n\n` +
      '_Gunakan /clearlicense untuk mengganti license_'
    );
  } else {
    sessions[CHAT_ID] = { step: 'awaiting_license' };
    sendMessage(
      '🔐 *Input License*\n\n' +
      'Kirim kode license kamu sekarang\\.\n' +
      '_Hubungi @AirdropJP\\_JawaPride atau @timplexz untuk mendapatkan kode_'
    );
  }
});

bot.onText(/\/clearlicense/, (msg) => {
  if (!isAuthorized(msg)) return;
  try {
    if (fs.existsSync(LICENSE_FILE)) {
      fs.unlinkSync(LICENSE_FILE);
      sendMessage('🗑️ License dihapus\\.\n\nGunakan /license untuk input kode baru\\.');
    } else {
      sendMessage('ℹ️ Tidak ada license tersimpan\\.');
    }
  } catch (err) {
    sendMessage(`❌ Gagal: ${escape(err.message)}`);
  }
});

// ==============================
// ACCOUNT COMMANDS
// ==============================

bot.onText(/\/addaccount/, (msg) => {
  if (!isAuthorized(msg)) return;
  sessions[CHAT_ID] = { step: 'add_account_id' };
  sendMessage(
    '➕ *Tambah Akun Baru*\n\n' +
    'Langkah 1\\/2: Kirim *ID akun*\n' +
    'Contoh: `account_2`\n\n' +
    '_Kirim /cancel untuk batal_'
  );
});

bot.onText(/\/listaccounts/, (msg) => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  if (config.accounts.length === 0) {
    return sendMessage('📋 Belum ada akun\\. Gunakan /addaccount\\.');
  }
  let text = '📋 *Daftar Akun*\n\n';
  config.accounts.forEach((acc, i) => {
    const stateFile = path.join(STATE_DIR, `state_${acc.id}.json`);
    const state = fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      : {};
    const short = acc.wallet
      ? `${acc.wallet.slice(0, 8)}\\.\\.\\. ${acc.wallet.slice(-6)}`
      : 'Belum diset';
    const status = acc.enabled !== false ? '✅' : '❌';
    text += `${i + 1}\\. ${status} *${escape(acc.id)}*\n`;
    text += `   💳 \`${short}\`\n`;
    text += `   💰 \\$PEANUT: ${escape((state.total_peanut || 0).toLocaleString())}\n\n`;
  });
  sendMessage(text);
});

bot.onText(/\/removeaccount/, (msg) => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  if (config.accounts.length === 0) {
    return sendMessage('❌ Tidak ada akun untuk dihapus\\.');
  }
  sessions[CHAT_ID] = { step: 'remove_account' };
  let text = '❌ *Hapus Akun*\n\nKirim ID akun yang ingin dihapus:\n\n';
  config.accounts.forEach((acc, i) => {
    text += `${i + 1}\\. \`${escape(acc.id)}\`\n`;
  });
  text += '\n_Atau /cancel untuk batal_';
  sendMessage(text);
});

// ==============================
// SETTINGS COMMANDS
// ==============================

bot.onText(/\/setcompute/, (msg) => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  const current = config.settings.compute_capability;
  bot.sendMessage(CHAT_ID,
    `⚙️ *Compute Capability*\n\nSaat ini: \`${escape(current)}\`\nPilih:`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[
          { text: '🖥️ CPU', callback_data: 'compute_CPU' },
          { text: '🎮 GPU', callback_data: 'compute_GPU' }
        ]]
      }
    }
  );
});

bot.onText(/\/setinterval/, (msg) => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  sessions[CHAT_ID] = { step: 'set_interval' };
  sendMessage(
    `⏱️ *Mining Interval*\n\nSaat ini: \`${escape(config.settings.mining_interval_ms.toString())}ms\`\n\n` +
    'Kirim nilai baru dalam milidetik\\.\n' +
    'Contoh: `2000` \\= 2 detik, `5000` \\= 5 detik\n\n' +
    '_Atau /cancel untuk batal_'
  );
});

// ==============================
// CALLBACK QUERY (inline buttons)
// ==============================
bot.on('callback_query', async (query) => {
  if (query.message.chat.id.toString() !== CHAT_ID.toString()) return;
  const data = query.data;

  if (data.startsWith('compute_')) {
    const value = data.replace('compute_', '');
    const config = loadConfig();
    config.settings.compute_capability = value;
    saveConfig(config);
    bot.answerCallbackQuery(query.id, { text: `Diset ke ${value}` });
    sendMessage(`✅ Compute diubah ke \`${escape(value)}\`\n\n_Restart miner agar berlaku_`);
  }
});

// ==============================
// SESSION HANDLER (multi-step input)
// ==============================
bot.on('message', async (msg) => {
  if (!isAuthorized(msg)) return;
  if (!msg.text || msg.text.startsWith('/')) return;

  const session = sessions[CHAT_ID];
  if (!session) return;

  const text = msg.text.trim();

  // Awaiting license code
  if (session.step === 'awaiting_license') {
    delete sessions[CHAT_ID];
    sendMessage('🔍 Memverifikasi license\\.\\.\\.');
    const result = await verifyLicenseCode(text);
    if (result.ok) {
      sendMessage(
        `✅ *License Verified\\!*\n\n👤 User: \`${escape(result.userId)}\`\n\nMiner bisa berjalan sekarang\\.`
      );
    } else {
      sendMessage(`❌ *Gagal:* ${escape(result.message)}\n\nCoba lagi dengan /license`);
    }
    return;
  }

  // Add account: step 1 - ID
  if (session.step === 'add_account_id') {
    sessions[CHAT_ID] = { step: 'add_account_wallet', id: text };
    return sendMessage(
      `✅ ID: \`${escape(text)}\`\n\n` +
      'Langkah 2\\/2: Kirim *wallet address*\n\n' +
      '_Atau /cancel untuk batal_'
    );
  }

  // Add account: step 2 - wallet
  if (session.step === 'add_account_wallet') {
    const config = loadConfig();
    if (config.accounts.find(a => a.id === session.id)) {
      delete sessions[CHAT_ID];
      return sendMessage(`❌ ID \`${escape(session.id)}\` sudah ada\\. Gunakan ID lain\\.`);
    }
    config.accounts.push({
      id: session.id,
      wallet: text,
      agent_id: null,
      private_key: null,
      enabled: true,
      max_vcus_override: null
    });
    saveConfig(config);
    delete sessions[CHAT_ID];
    return sendMessage(
      `✅ *Akun Ditambahkan\\!*\n\n` +
      `🆔 ID: \`${escape(session.id)}\`\n` +
      `💳 Wallet: \`${escape(text.slice(0, 8))}\\.\\.\\.\`\n\n` +
      '_Restart miner agar akun baru aktif_'
    );
  }

  // Remove account
  if (session.step === 'remove_account') {
    const config = loadConfig();
    const idx = config.accounts.findIndex(a => a.id === text);
    if (idx === -1) {
      return sendMessage(`❌ Akun \`${escape(text)}\` tidak ditemukan\\. Coba lagi atau /cancel`);
    }
    config.accounts.splice(idx, 1);
    saveConfig(config);
    delete sessions[CHAT_ID];
    return sendMessage(`✅ Akun \`${escape(text)}\` berhasil dihapus\\.`);
  }

  // Set interval
  if (session.step === 'set_interval') {
    const val = parseInt(text);
    if (isNaN(val) || val < 1000) {
      return sendMessage('❌ Minimal `1000` ms\\. Coba lagi:');
    }
    const config = loadConfig();
    config.settings.mining_interval_ms = val;
    saveConfig(config);
    delete sessions[CHAT_ID];
    return sendMessage(
      `✅ Interval diubah ke \`${escape(val.toString())}ms\`\n\n_Restart miner agar berlaku_`
    );
  }
});

// ==============================
// AUTO NOTIFIKASI
// ==============================
let lastTaskCounts = {};

// Berkala setiap NOTIFY_INTERVAL_MS
setInterval(() => {
  const states = getAllStates();
  if (states.length > 0) sendMessage(formatStats(states));
}, NOTIFY_INTERVAL_MS);

// Cek milestone setiap 1 menit
setInterval(() => {
  const states = getAllStates();
  let changed = false;
  states.forEach(state => {
    const prev = lastTaskCounts[state.id] || 0;
    const curr = state.total_tasks || 0;
    if (curr - prev >= TASK_NOTIFY_EVERY) {
      changed = true;
      lastTaskCounts[state.id] = curr;
    }
  });
  if (changed) {
    sendMessage(`🎯 *Milestone\\!*\n\n${formatStats(states).replace('📊 *Mining Stats*\n', '')}`);
  }
}, 60000);

// ==============================
// STARTUP MESSAGE
// ==============================
bot.sendMessage(CHAT_ID,
  '🥜 *\\$PEANUT Miner Bot aktif\\!*\n\n' +
  `🔔 Auto notif: setiap *${escape((NOTIFY_INTERVAL_MS / 60000).toString())} menit*\n` +
  `📊 Milestone: setiap *${escape(TASK_NOTIFY_EVERY.toString())} tasks*\n\n` +
  'Ketik /start untuk menu lengkap',
  { parse_mode: 'MarkdownV2' }
).catch(err => console.error('Startup error:', err.message));

console.log('🤖 Telegram bot started');
console.log(`🔔 Auto notif: ${NOTIFY_INTERVAL_MS / 60000} menit`);
console.log(`📊 Milestone notif: setiap ${TASK_NOTIFY_EVERY} tasks`);
