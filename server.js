// server.js (patched)
// - validate env vars
// - support DATABASE_URL (Railway)
// - better error handling and graceful shutdown

try { require('dotenv').config(); } catch (e) { /* dotenv is optional in production */ }

const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
moment.loadPersian({ usePersianDigits: false });

// --- Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID_RAW = process.env.ADMIN_CHAT_ID;
const ADMIN_CHAT_ID = ADMIN_CHAT_ID_RAW ? parseInt(ADMIN_CHAT_ID_RAW, 10) : null;

// Validate BOT token
if (!TOKEN) {
  console.error('❌ Missing BOT_TOKEN environment variable. Set BOT_TOKEN in Railway / env.');
  process.exit(1);
}

// Validate ADMIN_CHAT_ID (optional)
if (!ADMIN_CHAT_ID) {
  console.warn('⚠️ ADMIN_CHAT_ID is not set or not a valid number. Some admin features may fail.');
}

// --- Configure Postgres pool ---
// Support DATABASE_URL (Railway) or individual DB_* vars
let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway/Postgres often requires SSL; rejectUnauthorized false is common for hosted providers
    ssl: { rejectUnauthorized: false }
  });
} else {
  pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined
  });
}

// --- ایجاد جدول‌ها ---
async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50),
      chat_id BIGINT UNIQUE,
      name VARCHAR(100),
      age INT,
      city VARCHAR(50),
      region VARCHAR(50),
      gender VARCHAR(20),
      job VARCHAR(50),
      goal TEXT,
      phone VARCHAR(20),
      vip_status BOOLEAN DEFAULT FALSE,
      vip_date TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_requests (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      payment_proof TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      message_text TEXT,
      is_answered BOOLEAN DEFAULT FALSE,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ جدول‌ها آماده شدند');
}

// --- توابع کمکی ---
function persianToEnglish(str) { if (!str) return ''; const map = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' }; return str.replace(/[۰-۹]/g, w => map[w]); }

// --- منوها ---
const mainMenu = { reply_markup: { keyboard: [['📺 کانال رایگان', '💎 عضویت VIP'], ['💬 چت با ادمین', '🤖 چت با هوش مصنوعی'], ['📝 ثبت‌نام / ✏️ ویرایش اطلاعات']], resize_keyboard: true, one_time_keyboard: false } };
const editMenu = { reply_markup: { keyboard: [['📝 نام', '🎂 سن'], ['🏙️ شهر', '📍 منطقه'], ['⚧ جنسیت', '💼 شغل'], ['🎯 هدف', '📞 شماره'], ['↩️ بازگشت به منو اصلی']], resize_keyboard: true, one_time_keyboard: true } };
const vipMenu = { reply_markup: { keyboard: [['💳 ارسال رسید', '↩️ بازگشت به منو اصلی']], resize_keyboard: true, one_time_keyboard: true } };

// --- اجرای اصلی ---
let bot;

async function start() {
  try {
    // Test DB connection
    console.log('🔌 Connecting to database...');
    const client = await pool.connect();
    client.release();
    console.log('✅ Connected to database');

    // Create tables
    await createTables();

    // Create bot (polling by default)
    bot = new TelegramBot(TOKEN, { polling: true });

    // TODO: add existing handlers here (message, callback_query, etc.)

    console.log('🤖 Bot started (polling).');
  } catch (err) {
    console.error('❌ Failed to start app:', err);
    // Close pool before exit
    try { await pool.end(); } catch (e) { /* ignore */ }
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown() {
  console.log('🛑 Shutting down...');
  try {
    if (bot && bot.stopPolling) {
      await bot.stopPolling();
      console.log('🟢 Bot polling stopped');
    }
  } catch (e) {
    console.warn('⚠️ Error stopping bot polling:', e);
  }
  try {
    await pool.end();
    console.log('🟢 DB pool closed');
  } catch (e) {
    console.warn('⚠️ Error closing DB pool:', e);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
