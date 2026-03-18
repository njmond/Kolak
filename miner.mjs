#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import process from "node:process";
import readline from "readline";

config();
const fetch = (await import('node-fetch')).default;

const LicenseConfig = {
  APP_NAME: "peanut",
  CHECK_CODE_URL: "https://license-server-indol.vercel.app/api/check-code",
  LICENSE_FILE: path.resolve("./.license"),
  LOG_LEVEL: (process.env.LOG_LEVEL || "normal").toLowerCase(),
};

function logLicense(...args) {
  if (LicenseConfig.LOG_LEVEL === "debug") console.log(...args);
}

function readLocalLicense(appName = LicenseConfig.APP_NAME, licenseFile = LicenseConfig.LICENSE_FILE) {
  try {
    if (!fs.existsSync(licenseFile)) return null;
    const data = JSON.parse(fs.readFileSync(licenseFile, "utf8"));
    if (!data || data.verified !== true) return null;
    if (data.app && data.app !== appName) {
      logLicense(`[LICENSE] App name mismatch: ${data.app} vs ${appName} - accepting`);
    }
    if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
      logLicense(`[LICENSE] License expired at ${data.expiresAt}`);
      return null;
    }
    return data;
  } catch { return null; }
}

function saveVerification(info, licenseFile = LicenseConfig.LICENSE_FILE, appName = LicenseConfig.APP_NAME) {
  try {
    const licenseData = {
      verified: true,
      userId: info.userId,
      app: appName,
      ts: Date.now(),
      expiresAt: info.expiresAt || null
    };
    fs.writeFileSync(licenseFile, JSON.stringify(licenseData, null, 2), "utf8");
    console.log(`💾 License saved`);
    return true;
  } catch (e) {
    console.warn(`⚠️ Failed to save license: ${e.message}`);
    return false;
  }
}

async function verifyLicenseCode({ code, appName = LicenseConfig.APP_NAME, checkUrl = LicenseConfig.CHECK_CODE_URL, licenseFile = LicenseConfig.LICENSE_FILE, autoSave = true } = {}) {
  if (!code || code.trim() === "") return { ok: false, error: "CODE_EMPTY", message: "License code cannot be empty" };
  try {
    const url = new URL(checkUrl.trim());
    url.searchParams.set("app", appName);
    url.searchParams.set("code", code.trim());
    console.log(`🔍 Verifying license...`);
    const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json" } });
    const text = await res.text().catch(() => null);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (json?.enabled === false) return { ok: false, error: "APP_DISABLED", message: "App disabled by admin" };
    if (!json || !json.ok || !json.valid) return { ok: false, error: "CODE_INVALID", message: "Invalid license code" };
    if (autoSave) saveVerification(json, licenseFile, appName);
    return { ok: true, userId: json.userId, app: appName, expiresAt: json.expiresAt, message: `✅ Verified: ${json.userId}` };
  } catch (err) {
    console.error(`❌ License network error: ${err.message}`);
    return { ok: false, error: "NETWORK_ERROR", message: err.message };
  }
}

function createLicensePrompt({ appName = LicenseConfig.APP_NAME, hintMessage = "📌 Contact admin for license" } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async askCode() {
      return new Promise((resolve) => {
        rl.question(`🔐 Enter ${appName} license code:\n${hintMessage}\n> `, (answer) => resolve(answer.trim()));
      });
    },
    close() { rl.close(); }
  };
}

// ==============================
// PATCHED: Support Railway non-interactive mode
// Tunggu file .license dibuat oleh Telegram bot
// ==============================
export async function verifyLicense({ appName = LicenseConfig.APP_NAME, checkUrl = LicenseConfig.CHECK_CODE_URL, licenseFile = LicenseConfig.LICENSE_FILE, hintMessage } = {}) {
  // Cek license lokal dulu
  const local = readLocalLicense(appName, licenseFile);
  if (local) {
    console.log(`🔓 License already verified (user: ${local.userId}) - skipping prompt`);
    return { ok: true, source: "local", ...local };
  }

  // Deteksi Railway / non-interactive environment
  const isNonInteractive = !process.stdin.isTTY;
  if (isNonInteractive) {
    console.log(`⏳ Non-interactive mode detected (Railway).`);
    console.log(`⏳ Waiting for license via Telegram bot...`);
    console.log(`💡 Send /license to your Telegram bot to activate.`);
    while (true) {
      await new Promise(r => setTimeout(r, 5000));
      const retryLocal = readLocalLicense(appName, licenseFile);
      if (retryLocal) {
        console.log(`🔓 License detected! User: ${retryLocal.userId}`);
        return { ok: true, source: "local", ...retryLocal };
      }
      console.log(`⏳ Still waiting for license... (send /license to your bot)`);
    }
  }

  // Mode interaktif (lokal) — prompt seperti biasa
  const prompt = createLicensePrompt({ appName, hintMessage });
  while (true) {
    const code = await prompt.askCode();
    if (!code) { console.log("❗ Code cannot be empty.\n"); continue; }
    const result = await verifyLicenseCode({ code, appName, checkUrl, licenseFile, autoSave: true });
    if (result.ok) { prompt.close(); console.log(result.message); return { ok: true, source: "remote", ...result }; }
    if (result.error === "APP_DISABLED") { console.error(`❌ ${result.message}`); prompt.close(); process.exit(1); }
    console.log(`❌ ${result.message}\n`);
  }
}

export function clearLocalLicense(licenseFile = LicenseConfig.LICENSE_FILE) {
  try {
    if (fs.existsSync(licenseFile)) {
      fs.unlinkSync(licenseFile);
      console.log(`🗑️ Local license cleared`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn(`⚠️ Failed to clear license: ${e.message}`);
    return false;
  }
}


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.PEANUT_API_BASE || "https://wrcenmardnbprfpqhrqe.supabase.co/functions/v1/peanut-mining").trim();
const CONFIG_FILE = path.join(__dirname, 'accounts.json');
const STATE_DIR = path.join(__dirname, 'states');

if (!fs.existsSync(STATE_DIR)) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadAccountsConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (Array.isArray(data.accounts) && data.accounts.length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.log(`⚠️ Config load error: ${err.message}`);
  }

  const defaultConfig = {
    settings: {
      compute_capability: "CPU",
      max_vcus: 1000,
      mining_interval_ms: 2000,
      max_consecutive_failures: 10,
      retry_delay_ms: 5000
    },
    accounts: [
      {
        id: "account_1",
        wallet: process.env.PEANUT_WALLET_1 || "",
        agent_id: process.env.PEANUT_AGENT_ID_1 || null,
        private_key: null,
        enabled: true,
        max_vcus_override: null
      }
    ]
  };

  console.log(`📝 Creating default config at: ${CONFIG_FILE}`);
  console.log(`💡 Edit this file to add multiple wallets/accounts`);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf-8');

  return defaultConfig;
}

function saveAccountsConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.log(`❌ Config save error: ${err.message}`);
    return false;
  }
}

function log(msg, accountId = null, level = "INFO") {
  const ts = new Date().toLocaleString('id-ID', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const prefix = accountId ? `[${accountId}] ` : '';
  console.log(`[${ts}] [${level}] ${prefix}${msg}`);
}

function getAccountStateFile(accountId) {
  return path.join(STATE_DIR, `state_${accountId}.json`);
}

function loadAccountState(accountId) {
  const stateFile = getAccountStateFile(accountId);
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }
  } catch (err) {
    log(`State load error: ${err.message}`, accountId, "WARN");
  }
  return {
    registered: false,
    total_vcus: 0,
    total_peanut: 0,
    epoch: 0,
    last_registered_key: null,
    total_tasks: 0,
    last_activity: null
  };
}

function saveAccountState(accountId, state) {
  const stateFile = getAccountStateFile(accountId);
  try {
    state.last_activity = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    log(`State save error: ${err.message}`, accountId, "ERROR");
  }
}

function generateKeypair() {
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
    const privateKeyHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
    const rawPublicKey = publicKeyHex.length >= 64 ? publicKeyHex.slice(-64) : publicKeyHex;
    return { publicKey: rawPublicKey, privateKey: privateKeyHex };
  } catch (err) {
    log(`Keypair generation error: ${err.message}`, null, "ERROR");
    return null;
  }
}

function signMessage(privateKeyHex, message) {
  try {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(privateKeyHex, 'hex'),
      format: 'der',
      type: 'pkcs8'
    });
    const signature = crypto.sign(null, Buffer.from(message, 'utf-8'), privateKey);
    return signature.toString('hex');
  } catch (err) {
    log(`Signing error: ${err.message}`, null, "ERROR");
    return null;
  }
}

function solveHashChallenge(payload, difficulty, maxIterations = 10000000) {
  const target = '0'.repeat(difficulty);
  let nonce = 0;
  while (nonce < maxIterations) {
    const data = `${payload}${nonce}`;
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash.startsWith(target)) return { nonce, hash };
    nonce++;
    if (nonce % 100000 === 0) log(`Solving... nonce=${nonce}`, null, "DEBUG");
  }
  log(`Failed to solve challenge after ${maxIterations} iterations`, null, "ERROR");
  return null;
}

async function registerAgent(accountId, publicKey, computeCapability, maxVcus, wallet, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`📡 Registering agent (attempt ${attempt}/${maxRetries})...`, accountId);
      const resp = await fetch(`${BASE_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: accountId,
          public_key: publicKey,
          compute_capability: computeCapability,
          max_vcus: maxVcus,
          wallet: wallet
        }),
        signal: AbortSignal.timeout(30000)
      });
      const text = await resp.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (resp.status === 200) {
        log(`✅ Agent registered! Epoch: ${data.epoch_start || data.epoch || 'N/A'}`, accountId);
        return { success: true, data };
      } else {
        log(`❌ Registration failed (${resp.status}): ${JSON.stringify(data)}`, accountId, "ERROR");
        if (attempt < maxRetries) await sleep(Math.pow(2, attempt) * 1000);
      }
    } catch (err) {
      log(`❌ Registration error (attempt ${attempt}): ${err.message}`, accountId, "ERROR");
      if (attempt < maxRetries) await sleep(Math.pow(2, attempt) * 1000);
    }
  }
  return { success: false, data: null };
}

async function getCurrentTask() {
  try {
    const resp = await fetch(`${BASE_URL}/tasks/current`, { method: 'GET', signal: AbortSignal.timeout(30000) });
    if (resp.status === 200) return await resp.json();
    log(`❌ Failed to fetch task: ${await resp.text()}`, null, "ERROR");
    return null;
  } catch (err) {
    log(`❌ Task fetch error: ${err.message}`, null, "ERROR");
    return null;
  }
}

async function submitProof(accountId, taskId, solution, signature, computeTimeMs) {
  try {
    const resp = await fetch(`${BASE_URL}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: accountId,
        task_id: taskId,
        solution: solution,
        signature: signature,
        compute_time_ms: computeTimeMs
      }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (resp.status !== 200) log(`[DEBUG] Submit response (${resp.status}): ${text}`, accountId, "DEBUG");
    if (resp.status === 200) return { success: true, data };
    if (data?.error?.toLowerCase?.()?.includes('not registered')) {
      return { success: false, data, error: 'AGENT_NOT_REGISTERED' };
    }
    log(`❌ Submit failed (${resp.status}): ${JSON.stringify(data)}`, accountId, "ERROR");
    return { success: false, data };
  } catch (err) {
    log(`❌ Submit error: ${err.message}`, accountId, "ERROR");
    return { success: false, error: err };
  }
}

async function runAccountMiner(account, config, license) {
  const accountId = account.id;
  const settings = { ...config.settings, ...account };

  log("=".repeat(50), accountId);
  log(`🚀 Starting miner for account: ${accountId}`, accountId);
  log(`Wallet: ${account.wallet || 'Not set'}`, accountId);
  log("=".repeat(50), accountId);

  let state = loadAccountState(accountId);

  let privateKey = account.private_key;
  let publicKey = null;

  if (!privateKey) {
    log(`🔑 Generating new ED25519 keypair...`, accountId);
    const keypair = generateKeypair();
    if (!keypair) { log(`❌ Failed to generate keypair`, accountId, "ERROR"); return; }
    publicKey = keypair.publicKey;
    privateKey = keypair.privateKey;
    account.private_key = privateKey;
    saveAccountsConfig(config);
    log(`💾 Private key saved to config`, accountId, "WARN");
  } else {
    try {
      const privKey = crypto.createPrivateKey({
        key: Buffer.from(privateKey, 'hex'),
        format: 'der',
        type: 'pkcs8'
      });
      const pubKey = crypto.createPublicKey(privKey);
      const publicKeyHex = pubKey.export({ type: 'spki', format: 'der' }).toString('hex');
      publicKey = publicKeyHex.length >= 64 ? publicKeyHex.slice(-64) : publicKeyHex;
      log(`🔑 Using existing keypair`, accountId);
    } catch (err) {
      log(`❌ Invalid private key: ${err.message}`, accountId, "ERROR");
      return;
    }
  }

  log(`Public Key: ${publicKey.slice(0, 32)}...`, accountId);

  const forceRegister = process.env.FORCE_REGISTER === 'true';
  const keyChanged = state.last_registered_key && state.last_registered_key !== publicKey;

  if (!state.registered || keyChanged || forceRegister) {
    if (keyChanged) log(`🔄 Key changed, re-registering...`, accountId, "WARN");
    const maxVcus = account.max_vcus_override || settings.max_vcus;
    const { success, data } = await registerAgent(
      accountId,
      publicKey,
      settings.compute_capability,
      maxVcus,
      account.wallet
    );
    if (success) {
      state.registered = true;
      state.last_registered_key = publicKey;
      state.epoch = data?.epoch || state.epoch;
      saveAccountState(accountId, state);
      log(`✅ Registration confirmed`, accountId);
    } else {
      log(`⚠️ Registration failed, will retry on submit...`, accountId, "WARN");
    }
  } else {
    log(`✅ Agent already registered`, accountId);
  }

  let consecutiveFailures = 0;
  const maxFailures = settings.max_consecutive_failures;
  let submitCount = 0;
  let needReRegister = false;

  while (true) {
    if (needReRegister) {
      log(`🔄 Attempting to re-register agent...`, accountId);
      const maxVcus = account.max_vcus_override || settings.max_vcus;
      const { success } = await registerAgent(
        accountId,
        publicKey,
        settings.compute_capability,
        maxVcus,
        account.wallet
      );
      if (success) {
        state.registered = true;
        state.last_registered_key = publicKey;
        saveAccountState(accountId, state);
        log(`✅ Re-registration successful`, accountId);
        needReRegister = false;
      } else {
        await sleep(10000);
        continue;
      }
    }

    try {
      const task = await getCurrentTask();
      if (!task) {
        await sleep(settings.mining_interval_ms);
        consecutiveFailures++;
        continue;
      }

      const difficulty = task.difficulty || 3;
      const payload = task.payload || "";
      log(`🔨 Solving ${task.task_id} (diff=${difficulty})`, accountId);

      const start = Date.now();
      const solution = solveHashChallenge(payload, difficulty);
      if (!solution) {
        consecutiveFailures++;
        continue;
      }

      const computeTime = Date.now() - start;
      const solutionJson = JSON.stringify({ nonce: solution.nonce, hash: solution.hash });
      const signature = signMessage(privateKey, `${task.task_id}:${solutionJson}`);
      if (!signature) {
        consecutiveFailures++;
        continue;
      }

      log(`✅ Solution: nonce=${solution.nonce}, hash=${solution.hash.slice(0,16)}..., time=${computeTime}ms`, accountId);

      const result = await submitProof(accountId, task.task_id, solutionJson, signature, computeTime);
      if (result.success) {
        const { vcus_credited = 0, peanut_earned = 0, epoch } = result.data;
        log(`✅ SUBMITTED! VCUs: +${vcus_credited} | $PEANUT: +${peanut_earned.toLocaleString()}`, accountId);
        state.total_vcus += vcus_credited;
        state.total_peanut += peanut_earned;
        state.epoch = epoch || state.epoch;
        state.total_tasks = (state.total_tasks || 0) + 1;
        saveAccountState(accountId, state);
        submitCount++;
        consecutiveFailures = 0;

        if (submitCount % 10 === 0) {
          log(`📊 Stats: VCUs=${state.total_vcus.toLocaleString()} | $PEANUT=${state.total_peanut.toLocaleString()} | Tasks=${state.total_tasks}`, accountId);
        }
      } else {
        if (result.error === 'AGENT_NOT_REGISTERED') {
          log(`⚠️ Not registered - will re-register`, accountId, "WARN");
          needReRegister = true;
          state.registered = false;
          saveAccountState(accountId, state);
        } else {
          consecutiveFailures++;
          if (consecutiveFailures >= maxFailures) {
            consecutiveFailures = 0;
            await sleep(settings.retry_delay_ms);
          }
        }
      }
      await sleep(settings.mining_interval_ms);
    } catch (err) {
      log(`❌ Error: ${err.message}`, accountId, "ERROR");
      await sleep(settings.retry_delay_ms);
      consecutiveFailures++;
    }
  }
}

// ==============================
// MULTI ACCOUNT ORCHESTRATOR
// ==============================

async function runMultiAccountMiner() {
  console.log("🥜 $PEANUT Mining Agent - Multi Account + License");
  console.log("=".repeat(60));

  const license = await verifyLicense({
    appName: LicenseConfig.APP_NAME,
    checkUrl: LicenseConfig.CHECK_CODE_URL,
    licenseFile: LicenseConfig.LICENSE_FILE,
    hintMessage: "📌 Contact @AirdropJP_JawaPride or @timplexz for license"
  });

  if (!license.ok) {
    console.log("❌ License verification failed - all accounts stopped");
    return;
  }
  console.log(`🔓 License OK - User: ${license.userId} (source: ${license.source})`);
  console.log("=".repeat(60));

  const config = loadAccountsConfig();
  const enabledAccounts = config.accounts.filter(acc => acc.enabled !== false);

  console.log(`📦 Loaded ${enabledAccounts.length} enabled account(s)`);
  console.log(`⚙️ Settings: compute=${config.settings.compute_capability}, interval=${config.settings.mining_interval_ms}ms`);
  console.log("=".repeat(60));

  if (enabledAccounts.length === 0) {
    console.log("❌ No enabled accounts found. Edit accounts.json to add wallets.");
    return;
  }

  for (const account of enabledAccounts) {
    if (!account.wallet || account.wallet.trim() === "") {
      console.log(`⚠️ Skipping account "${account.id}" - no wallet address set`);
      continue;
    }
    await runAccountMiner(account, config, license);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function setupGracefulShutdown() {
  const shutdown = (signal) => {
    console.log(`\n👋 Received ${signal}, shutting down gracefully...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

setupGracefulShutdown();

const args = process.argv.slice(2);
if (args[0] === '--add-account') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const config = loadAccountsConfig();
  console.log('\n➕ Add New Account');
  console.log('-'.repeat(40));
  rl.question('Account ID (e.g., account_2): ', (id) => {
    rl.question('Wallet Address: ', (wallet) => {
      const newAccount = {
        id: id || `account_${Date.now()}`,
        wallet: wallet,
        agent_id: null,
        private_key: null,
        enabled: true,
        max_vcus_override: null
      };
      config.accounts.push(newAccount);
      saveAccountsConfig(config);
      console.log(`✅ Account "${newAccount.id}" added to ${CONFIG_FILE}`);
      rl.close();
      process.exit(0);
    });
  });
} else if (args[0] === '--list-accounts') {
  const config = loadAccountsConfig();
  console.log('\n📋 Registered Accounts:');
  console.log('-'.repeat(50));
  config.accounts.forEach((acc, i) => {
    const state = loadAccountState(acc.id);
    console.log(`${i+1}. ${acc.id}`);
    console.log(`   Wallet: ${acc.wallet?.slice(0,20)}${acc.wallet?.length > 20 ? '...' : ''}`);
    console.log(`   Enabled: ${acc.enabled !== false ? '✅' : '❌'}`);
    console.log(`   Stats: VCUs=${state.total_vcus.toLocaleString()}, $PEANUT=${state.total_peanut.toLocaleString()}`);
    console.log('');
  });
  process.exit(0);
} else if (args[0] === '--clear-license') {
  clearLocalLicense();
  process.exit(0);
} else {
  runMultiAccountMiner().catch(err => {
    console.log(`❌ Fatal error: ${err.message}`);
    process.exit(1);
  });
}
