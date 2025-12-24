// server.js (FINAL - based on your code, Railway compatible)

try { require('dotenv').config(); } catch (e) {}

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
moment.loadPersian({ usePersianDigits: false });

/* ================= ENV ================= */

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID_RAW = process.env.ADMIN_CHAT_ID;
const ADMIN_CHAT_ID = ADMIN_CHAT_ID_RAW ? parseInt(ADMIN_CHAT_ID_RAW, 10) : null;

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TOKEN) {
  console.error('❌ Missing BOT_TOKEN');
  process.exit(1);
}

if (!WEBHOOK_URL) {
  console.error('❌ Missing WEBHOOK_URL');
  process.exit(1);
}

if (!ADMIN_CHAT_ID) {
  console.warn('⚠️ ADMIN_CHAT_ID not set');
}

/* ================= DB ================= */

let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT
      ? parseInt(process.env.DB_PORT, 10)
      : undefined
  });
}

/* ================= TABLES ================= */

async function createTables() {
  try {
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

    console.log('✅ Tables ready');
  } catch (err) {
    console.error('❌ Error creating tables:', err);
    throw err;
  }
}

/* ================= HELPERS ================= */

function persianToEnglish(str) {
  if (!str) return '';
  const map = { '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9' };
  return str.replace(/[۰-۹]/g, w => map[w]);
}

/* ================= MENUS (UNCHANGED) ================= */

const mainMenu = {
  reply_markup: {
    keyboard: [
      ['📺 کانال رایگان', '💎 عضویت VIP'],
      ['💬 چت با ادمین', '🤖 چت با هوش مصنوعی'],
      ['📝 ثبت‌نام / ✏️ ویرایش اطلاعات']
    ],
    resize_keyboard: true
  }
};

const editMenu = {
  reply_markup: {
    keyboard: [
      ['📝 نام', '🎂 سن'],
      ['🏙️ شهر', '📍 منطقه'],
      ['⚧ جنسیت', '💼 شغل'],
      ['🎯 هدف', '📞 شماره'],
      ['↩️ بازگشت به منو اصلی']
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

const vipMenu = {
  reply_markup: {
    keyboard: [['💳 ارسال رسید', '↩️ بازگشت به منو اصلی']],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

/* ================= EXPRESS ================= */

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('🤖 Bot is running');
});

/* ================= BOT (WEBHOOK) ================= */

const bot = new TelegramBot(TOKEN);
const WEBHOOK_PATH = `/bot${TOKEN}`;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* ================= BASIC HANDLER (TEST) ================= */

bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  if (msg.text === '/start') {
    return bot.sendMessage(
      chatId,
      'سلام 👋\nربات با موفقیت به Railway وصل شد ✅',
      mainMenu
    );
  }

  bot.sendMessage(chatId, '✅ پیام دریافت شد');
});

/* ================= START ================= */

async function start() {
  try {
    console.log('🔌 Connecting to DB...');
    await pool.query('SELECT 1');
    console.log('✅ DB connected');

    await createTables();

    await bot.deleteWebHook();
    await bot.setWebHook(`${WEBHOOK_URL}${WEBHOOK_PATH}`);

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔗 Webhook: ${WEBHOOK_URL}${WEBHOOK_PATH}`);
    });
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

/* ================= SHUTDOWN ================= */

async function shutdown() {
  console.log('🛑 Shutting down...');
  try {
    await bot.deleteWebHook();
    await pool.end();
  } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();