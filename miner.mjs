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

async function withRetry(fn, maxRetries = 3, baseDelay = 5000, label = "Operation", accountId = null) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`🔄 ${label} (attempt ${attempt}/${maxRetries})...`, accountId, "DEBUG");
      const result = await fn();
      return result;
    } catch (err) {
      lastError = err;
      log(`⚠️ ${label} failed (attempt ${attempt}): ${err.message}`, accountId, "WARN");
      if (attempt === maxRetries) break;
      const waitTime = baseDelay * attempt;
      log(`⏳ Waiting ${waitTime/1000}s before retry...`, accountId, "DEBUG");
      await sleep(waitTime);
    }
  }
  throw lastError;
}

async function registerAgent(accountId, publicKey, computeCapability, maxVcus, wallet, maxRetries = 3) {
  return withRetry(async () => {
    log(`📡 Registering agent...`, accountId);
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
      signal: AbortSignal.timeout(15000)
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (resp.status === 200) {
      log(`✅ Agent registered! Epoch: ${data.epoch_start || data.epoch || 'N/A'}`, accountId);
      return { success: true, data };
    } else {
      throw new Error(`Registration failed (${resp.status}): ${JSON.stringify(data)}`);
    }
  }, maxRetries, 5000, `Register ${accountId}`, accountId).catch(err => {
    log(`❌ Registration failed after retries: ${err.message}`, accountId, "ERROR");
    return { success: false, data: null };
  });
}

async function getCurrentTask() {
  return withRetry(async () => {
    const resp = await fetch(`${BASE_URL}/tasks/current`, {
      method: 'GET',
      signal: AbortSignal.timeout(30000)
    });
    if (resp.status === 200) return await resp.json();
    const errorText = await resp.text();
    throw new Error(`Failed to fetch task (${resp.status}): ${errorText}`);
  }, 3, 5000, "Fetch task", null).catch(err => {
    log(`❌ Task fetch failed: ${err.message}`, null, "ERROR");
    return null;
  });
}

async function submitProof(accountId, taskId, solution, signature, computeTimeMs, maxRetries = 3) {
  return withRetry(async () => {
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
      signal: AbortSignal.timeout(15000)
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (resp.status !== 200) {
      log(`[DEBUG] Submit response (${resp.status}): ${text}`, accountId, "DEBUG");
    }
    if (resp.status !== 200 && data?.error &&
        (data.error.toLowerCase().includes('duplicate') || text.toLowerCase().includes('duplicate submission'))) {
      log(`⚠️ Duplicate submission - counting as SUCCESS!`, accountId, "WARN");
      return {
        success: true,
        data: { vcus_credited: 1, peanut_earned: 500, epoch: data?.epoch || null, duplicate: true }
      };
    }
    if (resp.status === 200) return { success: true, data };
    if (data?.error?.toLowerCase?.()?.includes('not registered')) {
      return { success: false, data, error: 'AGENT_NOT_REGISTERED' };
    }
    throw new Error(`Submit failed (${resp.status}): ${JSON.stringify(data)}`);
  }, maxRetries, 5000, `Submit ${taskId}`, accountId).catch(err => {
    log(`❌ Submit failed after retries: ${err.message}`, accountId, "ERROR");
    return { success: false, error: err };
  });
}

async function runAccountMiner(account, config) {
  const accountId = account.id;
  const settings = { ...config.settings, ...account };

  log("=".repeat(50), accountId);
  log(`🚀 Starting miner for account: ${accountId}`, accountId);
  log(`Wallet: ${account.wallet || 'Not set'}`, accountId);
  log("=".repeat(50), accountId);

  let state = loadAccountState(accountId);

  let privateKey = account.private_key || null;
  let publicKey = null;

  if (!privateKey) {
    log(`🔑 Generating new ED25519 keypair...`, accountId);
    const keypair = generateKeypair();
    if (!keypair) { log(`❌ Failed to generate keypair`, accountId, "ERROR"); return; }
    publicKey = keypair.publicKey;
    privateKey = keypair.privateKey;
    account.private_key = privateKey;
    saveAccountsConfig(config);
    log(`💾 Private key saved to config (keep this file secure!)`, accountId, "WARN");
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
      accountId, publicKey, settings.compute_capability, maxVcus, account.wallet
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
        accountId, publicKey, settings.compute_capability, maxVcus, account.wallet
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
      if (!solution) { consecutiveFailures++; continue; }

      const computeTime = Date.now() - start;
      const solutionJson = JSON.stringify({ nonce: solution.nonce, hash: solution.hash });
      const signature = signMessage(privateKey, `${task.task_id}:${solutionJson}`);
      if (!signature) { consecutiveFailures++; continue; }

      log(`✅ Solution: nonce=${solution.nonce}, hash=${solution.hash.slice(0,16)}..., time=${computeTime}ms`, accountId);

      const result = await submitProof(accountId, task.task_id, solutionJson, signature, computeTime);

      if (result.success) {
        const { vcus_credited = 0, peanut_earned = 0, epoch, duplicate = false } = result.data;
        if (duplicate) {
          log(`🎯 Duplicate accepted! VCUs: +${vcus_credited} | $PEANUT: +${peanut_earned.toLocaleString()} (RECOVERED)`, accountId);
        } else {
          log(`✅ SUBMITTED! VCUs: +${vcus_credited} | $PEANUT: +${peanut_earned.toLocaleString()}`, accountId);
        }
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

async function runMultiAccountMiner() {
  console.log("🥜 $PEANUT Mining Agent - Multi Account");
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
    await runAccountMiner(account, config);
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
if (args[0] === '--list-accounts') {
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
} else {
  runMultiAccountMiner().catch(err => {
    console.log(`❌ Fatal error: ${err.message}`);
    process.exit(1);
  });
}
