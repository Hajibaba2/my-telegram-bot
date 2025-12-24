// server.js — FINAL (Stage 1: User Menu + Optional Registration)

try { require('dotenv').config(); } catch (e) {}

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
moment.loadPersian({ usePersianDigits: false });

/* ================= ENV ================= */

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID
  ? parseInt(process.env.ADMIN_CHAT_ID, 10)
  : null;

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TOKEN || !WEBHOOK_URL) {
  console.error('❌ Missing BOT_TOKEN or WEBHOOK_URL');
  process.exit(1);
}

/* ================= DB ================= */

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT
          ? parseInt(process.env.DB_PORT, 10)
          : undefined
      }
);

/* ================= TABLES ================= */

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT UNIQUE,
      username VARCHAR(50),
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
  console.log('✅ users table ready');
}

/* ================= HELPERS ================= */

function persianToEnglish(str) {
  if (!str) return '';
  const map = { '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9' };
  return str.replace(/[۰-۹]/g, d => map[d]);
}

function nowShamsi() {
  return moment().format('jYYYY/jMM/jDD HH:mm');
}

/* ================= MENUS ================= */

const mainMenu = {
  reply_markup: {
    keyboard: [
      ['📺 کانال رایگان', '💎 عضویت VIP'],
      ['🤖 چت با هوش مصنوعی'],
      ['📝 ثبت‌نام / ✏️ ویرایش اطلاعات']
    ],
    resize_keyboard: true
  }
};

const removeKeyboard = {
  reply_markup: { remove_keyboard: true }
};

/* ================= STATE ================= */

const userState = {}; // chat_id => step
const tempData = {};  // chat_id => collected data

const steps = [
  'name',
  'age',
  'city',
  'region',
  'gender',
  'job',
  'goal',
  'phone'
];

const stepQuestions = {
  name: '📝 نام خود را وارد کنید:',
  age: '🎂 سن خود را وارد کنید:',
  city: '🏙️ شهر:',
  region: '📍 منطقه:',
  gender: '⚧ جنسیت:',
  job: '💼 شغل:',
  goal: '🎯 هدف:',
  phone: '📞 شماره تماس (یا بنویسید ندارم):'
};

/* ================= EXPRESS ================= */

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('🤖 Bot is running'));

/* ================= BOT ================= */

const bot = new TelegramBot(TOKEN);
const WEBHOOK_PATH = `/bot${TOKEN}`;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* ================= BOT LOGIC ================= */

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  // START
  if (text === '/start') {
    return bot.sendMessage(
      chatId,
      'سلام 👋\nبه ربات خوش آمدید',
      mainMenu
    );
  }

  // REGISTRATION ENTRY
  if (text === '📝 ثبت‌نام / ✏️ ویرایش اطلاعات') {
    userState[chatId] = 0;
    tempData[chatId] = {};
    return bot.sendMessage(chatId, stepQuestions[steps[0]], removeKeyboard);
  }

  // HANDLE REGISTRATION STEPS
  if (userState[chatId] !== undefined) {
    const stepIndex = userState[chatId];
    const field = steps[stepIndex];

    let value = persianToEnglish(text);
    if (field === 'age') value = parseInt(value, 10) || null;

    tempData[chatId][field] = value;
    userState[chatId]++;

    if (userState[chatId] < steps.length) {
      const nextField = steps[userState[chatId]];
      return bot.sendMessage(chatId, stepQuestions[nextField]);
    }

    // SAVE USER
    const data = tempData[chatId];
    const username = msg.from.username || null;

    await pool.query(
      `
      INSERT INTO users
      (chat_id, username, name, age, city, region, gender, job, goal, phone)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (chat_id) DO UPDATE SET
        username=EXCLUDED.username,
        name=EXCLUDED.name,
        age=EXCLUDED.age,
        city=EXCLUDED.city,
        region=EXCLUDED.region,
        gender=EXCLUDED.gender,
        job=EXCLUDED.job,
        goal=EXCLUDED.goal,
        phone=EXCLUDED.phone
      `,
      [
        chatId,
        username,
        data.name,
        data.age,
        data.city,
        data.region,
        data.gender,
        data.job,
        data.goal,
        data.phone
      ]
    );

    // ADMIN REPORT
    if (ADMIN_CHAT_ID) {
      let report = `📝 ثبت‌نام جدید\n\n`;
      report += `👤 ${data.name}\n`;
      report += `🆔 ${username || '—'}\n`;
      report += `📍 ${data.city} - ${data.region}\n`;
      report += `🎂 ${data.age}\n`;
      report += `🕒 ${nowShamsi()}`;

      bot.sendMessage(ADMIN_CHAT_ID, report);
    }

    delete userState[chatId];
    delete tempData[chatId];

    return bot.sendMessage(
      chatId,
      '✅ اطلاعات شما با موفقیت ذخیره شد',
      mainMenu
    );
  }
});

/* ================= START ================= */

async function start() {
  await pool.query('SELECT 1');
  await createTables();

  await bot.deleteWebHook();
  await bot.setWebHook(`${WEBHOOK_URL}${WEBHOOK_PATH}`);

  app.listen(PORT, () =>
    console.log(`🚀 Server running | Webhook set`)
  );
}

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});

start();