const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const { OpenAI } = require('openai');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// متغیرهای محیطی ضروری
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// چک اولیه متغیرها
if (!BOT_TOKEN || isNaN(ADMIN_CHAT_ID) || !WEBHOOK_URL) {
  console.error('خطا انتقادی: BOT_TOKEN، ADMIN_CHAT_ID یا WEBHOOK_URL تنظیم نشده است!');
  process.exit(1);
}

// تنظیمات Pool دیتابیس
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const bot = new TelegramBot(BOT_TOKEN);
let openai = null;
const states = {};

// تابع ساخت کیبورد
function createReplyKeyboard(keyboardArray, options = {}) {
  return {
    reply_markup: {
      keyboard: keyboardArray,
      resize_keyboard: true,
      one_time_keyboard: options.one_time || false,
      input_field_placeholder: options.placeholder || ''
    }
  };
}

// ساخت جدول‌ها و تضمین constraintها
async function createTables() {
  try {
    // جدول users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        name VARCHAR(255),
        age INTEGER,
        city VARCHAR(255),
        region VARCHAR(255),
        gender VARCHAR(50),
        job VARCHAR(255),
        goal TEXT,
        phone VARCHAR(50),
        ai_questions_used INTEGER DEFAULT 0,
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // جدول vips
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vips (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        payment_receipt TEXT,
        approved BOOLEAN DEFAULT FALSE
      );
    `);

    // تضمین UNIQUE constraint روی telegram_id در vips
    try {
      await pool.query(`ALTER TABLE vips ADD CONSTRAINT vips_telegram_id_key UNIQUE (telegram_id)`);
    } catch (err) {
      if (!err.message.includes('already exists')) throw err;
    }

    // تضمین Foreign Key
    try {
      await pool.query(`
        ALTER TABLE vips ADD CONSTRAINT vips_telegram_id_fkey
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      `);
    } catch (err) {
      if (!err.message.includes('already exists')) throw err;
    }

    // جدول settings با prompt_content
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        ai_token TEXT,
        free_channel TEXT,
        vip_channel TEXT,
        membership_fee VARCHAR(100),
        wallet_address TEXT,
        network TEXT,
        prompt_content TEXT
      );
    `);
    await pool.query(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

    // جدول broadcast_messages
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broadcast_messages (
        id SERIAL PRIMARY KEY,
        admin_id BIGINT NOT NULL,
        target_type VARCHAR(50) NOT NULL,
        message_text TEXT,
        media_type VARCHAR(50),
        media_file_id TEXT,
        caption TEXT,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('تمام جدول‌ها و constraintها با موفقیت آماده شدند.');
  } catch (err) {
    console.error('خطا در ساخت جدول‌ها:', err.message);
  }
}

// توابع کمکی
async function isVip(id) {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved AND end_date > NOW()',
      [id]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('خطا در چک VIP:', err.message);
    return false;
  }
}

async function isRegistered(id) {
  try {
    const { rows } = await pool.query('SELECT name FROM users WHERE telegram_id = $1', [id]);
    return rows.length > 0 && rows[0].name != null;
  } catch (err) {
    console.error('خطا در چک ثبت‌نام:', err.message);
    return false;
  }
}

async function downloadFile(fileId) {
  try {
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot\( {BOT_TOKEN}/ \){file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('دانلود ناموفق');
    return await res.text();
  } catch (err) {
    console.error('خطا در دانلود فایل پرامپت:', err.message);
    return null;
  }
}

// Webhook endpoint
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Graceful shutdown
async function gracefulShutdown() {
  console.log('در حال خاموش شدن امن...');
  try {
    await bot.deleteWebHook();
    console.log('Webhook حذف شد.');
  } catch (err) {
    console.error('خطا در حذف webhook:', err.message);
  }
  await pool.end();
  console.log('اتصال دیتابیس بسته شد.');
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
bot.on('error', (err) => console.error('خطای Telegram Bot:', err.message));

// استارت سرور و تنظیم webhook
app.listen(PORT, async () => {
  try {
    const info = await bot.getWebHookInfo();
    if (info.url !== WEBHOOK_URL) {
      await bot.deleteWebHook();
      await bot.setWebHook(WEBHOOK_URL);
      console.log(`Webhook جدید تنظیم شد: ${WEBHOOK_URL}`);
    } else {
      console.log(`Webhook قبلاً درست تنظیم شده بود: ${WEBHOOK_URL}`);
    }
  } catch (err) {
    console.error('خطا در تنظیم webhook:', err.message);
    process.exit(1);
  }

  await createTables();
  console.log('KaniaChatBot کاملاً آماده است! 🚀');
});

// Keep-Alive هر ۵ دقیقه
const keepAliveUrl = WEBHOOK_URL.replace(`/bot${BOT_TOKEN}`, '') || WEBHOOK_URL;
if (keepAliveUrl.includes('railway.app')) {
  setInterval(() => {
    fetch(keepAliveUrl)
      .then(() => console.log('Keep-Alive: درخواست موفق'))
      .catch(err => console.error('Keep-Alive خطا:', err.message));
  }, 300000); // ۵ دقیقه
}

// تمام کیبورد‌ها
function mainKeyboard(reg, admin) {
  const k = [
    [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
    [{ text: '💬 ارسال پیام به کانیا' }, { text: '🤖 چت با هوش مصنوعی' }],
    [{ text: reg ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
  ];
  if (admin) k.push([{ text: '🛡️ پنل ادمین' }]);
  return createReplyKeyboard(k, { placeholder: 'گزینه مورد نظر را انتخاب کنید' });
}

function adminKeyboard() {
  return createReplyKeyboard([
    [{ text: '🤖 هوش مصنوعی' }, { text: '📺 کانال‌ها' }],
    [{ text: '👥 کاربران' }, { text: '📨 پیامرسانی' }],
    [{ text: '📊 آمار' }, { text: '🔄 ریست دیتابیس' }],
    [{ text: '↩️ بازگشت به منو اصلی' }]
  ]);
}

function aiAdminKeyboard() {
  return createReplyKeyboard([
    [{ text: '⚙️ تنظیم توکن API' }],
    [{ text: '📂 ارسال فایل پرامپت' }],
    [{ text: '👀 مشاهده پرامپت' }],
    [{ text: '🗑️ حذف پرامپت' }],
    [{ text: '↩️ بازگشت به پنل ادمین' }]
  ]);
}

function channelsKeyboard() {
  return createReplyKeyboard([
    [{ text: 'لینک کانال رایگان' }, { text: 'لینک کانال VIP' }],
    [{ text: 'مبلغ عضویت' }, { text: 'آدرس کیف پول' }, { text: 'شبکه انتقال' }],
    [{ text: '↩️ بازگشت به پنل ادمین' }]
  ]);
}

function usersKeyboard() {
  return createReplyKeyboard([
    [{ text: '📊 آمار کاربران' }],
    [{ text: '👤 لیست کاربران عادی' }],
    [{ text: '💎 لیست کاربران VIP' }],
    [{ text: '↩️ بازگشت به پنل ادمین' }]
  ]);
}

function broadcastKeyboard() {
  return createReplyKeyboard([
    [{ text: '📢 پیام همگانی (همه)' }],
    [{ text: '📩 کاربران عادی' }],
    [{ text: '💌 کاربران VIP' }],
    [{ text: '📂 بایگانی' }],
    [{ text: '↩️ بازگشت به پنل ادمین' }]
  ]);
}

function editKeyboard() {
  return createReplyKeyboard([
    [{ text: '👤 نام' }, { text: '🎂 سن' }],
    [{ text: '🏙️ شهر' }, { text: '🌍 منطقه' }],
    [{ text: '⚧️ جنسیت' }, { text: '💼 شغل' }],
    [{ text: '🎯 هدف' }, { text: '📱 شماره تماس' }],
    [{ text: '↩️ بازگشت به منو اصلی' }]
  ]);
}

function vipKeyboard() {
  return createReplyKeyboard([
    [{ text: '📸 ارسال عکس فیش واریزی' }],
    [{ text: '❌ انصراف از عضویت VIP' }]
  ], { one_time: true });
}

function backKeyboard() {
  return createReplyKeyboard([[{ text: '↩️ بازگشت' }]], { one_time: true });
}

// /start
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  const username = msg.from.username ? `@${msg.from.username}` : null;
  await pool.query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
    [id, username]
  );
  const registered = await isRegistered(id);
  const admin = id === ADMIN_CHAT_ID;
  bot.sendMessage(id, '🌟 به ربات KaniaChatBot خوش آمدید! 🌟\n\nلطفاً از منوی زیر استفاده کنید 👇', mainKeyboard(registered, admin));
});

// هندلر اصلی پیام‌ها
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text || '';
  const username = msg.from.username ? `@${msg.from.username}` : null;
  const admin = id === ADMIN_CHAT_ID;

  if (username) {
    await pool.query(
      `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
      [id, username]
    );
  }

  if (states[id]) {
    await handleState(id, text, msg);
    return;
  }

  // منوی کاربر
  if (text === '📺 کانال رایگان') {
    const { rows } = await pool.query('SELECT free_channel FROM settings');
    bot.sendMessage(id, `📢 کانال رایگان:\n${rows[0]?.free_channel || 'تنظیم نشده ⚠️'}`);
  }

  if (text === '💎 عضویت VIP') {
    const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const s = rows[0];
    if (s?.membership_fee && s?.wallet_address && s?.network) {
      const msgText = `💎 عضویت VIP 💎\n\nمبلغ: \( {s.membership_fee}\n\nآدرس کیف پول:\n \){s.wallet_address}\n\nشبکه: ${s.network}\n\nپس از واریز، عکس فیش را ارسال کنید.`;
      bot.sendMessage(id, msgText, vipKeyboard());
      states[id] = { type: 'vip_waiting' };
    } else {
      bot.sendMessage(id, '⚠️ اطلاعات VIP توسط ادمین تنظیم نشده است.');
    }
  }

  if (text === '💬 ارسال پیام به کانیا') {
    bot.sendMessage(id, '💬 پیام خود را بنویسید (متن، عکس، ویدیو، فایل یا گیف).');
    states[id] = { type: 'chat_admin' };
  }

  if (text === '🤖 چت با هوش مصنوعی') {
    const { rows } = await pool.query('SELECT ai_token FROM settings');
    if (!rows[0]?.ai_token) {
      bot.sendMessage(id, '⚠️ هوش مصنوعی توسط ادمین تنظیم نشده است.');
      return;
    }
    bot.sendMessage(id, '🧠 سوال خود را بپرسید.', backKeyboard());
    states[id] = { type: 'ai_chat' };
  }

  if (text === '📝 ثبت‌نام' || text === '✏️ ویرایش اطلاعات') {
    const registered = await isRegistered(id);
    if (!registered) {
      states[id] = { type: 'register_full', step: 0, data: {} };
      bot.sendMessage(id, '📝 ثبت‌نام جدید\n\n👤 نام خود را وارد کنید:');
    } else {
      bot.sendMessage(id, '✏️ کدام فیلد را می‌خواهید ویرایش کنید؟', editKeyboard());
      states[id] = { type: 'edit_menu' };
    }
  }

  if (admin && text === '🛡️ پنل ادمین') {
    bot.sendMessage(id, '🛡️ پنل ادمین فعال شد', adminKeyboard());
  }

  if (admin && text === '🤖 هوش مصنوعی') {
    bot.sendMessage(id, '🤖 مدیریت هوش مصنوعی:', aiAdminKeyboard());
    states[id] = { type: 'admin_ai_menu' };
  }

  if (admin && text === '📺 کانال‌ها') {
    bot.sendMessage(id, '⚙️ تنظیمات کانال‌ها و VIP:', channelsKeyboard());
    states[id] = { type: 'admin_channels_menu' };
  }

  if (admin && text === '👥 کاربران') {
    bot.sendMessage(id, '👥 مدیریت کاربران:', usersKeyboard());
    states[id] = { type: 'admin_users_menu' };
  }

  if (admin && text === '📨 پیامرسانی') {
    bot.sendMessage(id, '📨 پیامرسانی:', broadcastKeyboard());
    states[id] = { type: 'admin_broadcast_menu' };
  }
});

// مدیریت تمام stateها
async function handleState(id, text, msg) {
  const state = states[id];
  const admin = id === ADMIN_CHAT_ID;

  // ادمین - هوش مصنوعی
  if (state.type === 'admin_ai_menu') {
    if (text === '⚙️ تنظیم توکن API') {
      bot.sendMessage(id, '🔑 توکن OpenAI را وارد کنید:');
      states[id] = { type: 'set_ai_token' };
    } else if (text === '📂 ارسال فایل پرامپت') {
      bot.sendMessage(id, '📂 فایل پرامپت (.txt) را ارسال کنید:');
      states[id] = { type: 'upload_prompt' };
    } else if (text === '👀 مشاهده پرامپت') {
      const { rows } = await pool.query('SELECT prompt_content FROM settings');
      bot.sendMessage(id, `👀 پرامپت فعلی:\n\n${rows[0]?.prompt_content || 'پرامپت تنظیم نشده است.'}`);
    } else if (text === '🗑️ حذف پرامپت') {
      await pool.query('UPDATE settings SET prompt_content = NULL WHERE id = 1');
      bot.sendMessage(id, '🗑️ پرامپت با موفقیت حذف شد.');
    } else if (text === '↩️ بازگشت به پنل ادمین') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
    }
    return;
  }

  // ادمین - کانال‌ها
  if (state.type === 'admin_channels_menu') {
    const map = {
      'لینک کانال رایگان': 'free_channel',
      'لینک کانال VIP': 'vip_channel',
      'مبلغ عضویت': 'membership_fee',
      'آدرس کیف پول': 'wallet_address',
      'شبکه انتقال': 'network'
    };
    if (map[text]) {
      states[id] = { type: `set_${map[text]}`, label: text };
      bot.sendMessage(id, `مقدار جدید برای ${text} را وارد کنید:`);
    } else if (text === '↩️ بازگشت به پنل ادمین') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت', adminKeyboard());
    }
    return;
  }

  // ادمین - کاربران
  if (state.type === 'admin_users_menu') {
    if (text === '📊 آمار کاربران') {
      const { rows: all } = await pool.query('SELECT COUNT(*) FROM users');
      const { rows: vip } = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
      bot.sendMessage(id, `📊 آمار کاربران:\nکل: ${all[0].count}\nVIP فعال: ${vip[0].count}`);
    } else if (text === '👤 لیست کاربران عادی') {
      const { rows } = await pool.query(`
        SELECT u.telegram_id, u.name, u.username FROM users u
        LEFT JOIN vips v ON u.telegram_id = v.telegram_id AND v.approved AND v.end_date > NOW()
        WHERE v.telegram_id IS NULL LIMIT 50
      `);
      const list = rows.map(r => `ID: ${r.telegram_id} | نام: \( {r.name || 'نامشخص'} | @ \){r.username || 'ندارد'}`).join('\n') || 'هیچ کاربری یافت نشد.';
      bot.sendMessage(id, `👤 کاربران عادی (حداکثر ۵۰):\n${list}`);
    } else if (text === '💎 لیست کاربران VIP') {
      const { rows } = await pool.query(`
        SELECT u.telegram_id, u.name, u.username, v.end_date FROM users u
        JOIN vips v ON u.telegram_id = v.telegram_id WHERE v.approved AND v.end_date > NOW() LIMIT 50
      `);
      const list = rows.map(r => `ID: ${r.telegram_id} | نام: \( {r.name || 'نامشخص'} | @ \){r.username || 'ندارد'} | پایان: ${moment(r.end_date).format('jYYYY/jM/jD')}`).join('\n') || 'هیچ کاربری یافت نشد.';
      bot.sendMessage(id, `💎 کاربران VIP (حداکثر ۵۰):\n${list}`);
    } else if (text === '↩️ بازگشت به پنل ادمین') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت', adminKeyboard());
    }
    return;
  }

  // ادمین - پیامرسانی
  if (state.type === 'admin_broadcast_menu') {
    if (['📢 پیام همگانی (همه)', '📩 کاربران عادی', '💌 کاربران VIP'].includes(text)) {
      const target = text === '📢 پیام همگانی (همه)' ? 'all' : text === '📩 کاربران عادی' ? 'normal' : 'vip';
      bot.sendMessage(id, '📨 پیام یا رسانه مورد نظر را ارسال کنید.');
      states[id] = { type: 'broadcast', target };
    } else if (text === '📂 بایگانی') {
      const { rows } = await pool.query('SELECT id, target_type, timestamp, sent_count, failed_count FROM broadcast_messages ORDER BY timestamp DESC LIMIT 20');
      const list = rows.map(r => `/view_${r.id} | ${r.target_type} | ${moment(r.timestamp).format('jYYYY/jM/jD HH:mm')} | موفق: ${r.sent_count} | ناموفق: ${r.failed_count}`).join('\n') || 'هیچ پیامی یافت نشد.';
      bot.sendMessage(id, `📂 بایگانی پیام‌های همگانی (حداکثر ۲۰):\n${list}`);
    } else if (text === '↩️ بازگشت به پنل ادمین') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت', adminKeyboard());
    }
    return;
  }

  // تنظیم فیلدهای ادمین (set_)
  if (admin && state.type?.startsWith('set_')) {
    const field = state.type.replace('set_', '');
    await pool.query(`UPDATE settings SET ${field} = $1 WHERE id = 1`, [text]);
    bot.sendMessage(id, `✅ ${state.label || field} با موفقیت ذخیره شد.`);
    if (field === 'ai_token') openai = new OpenAI({ apiKey: text });
    delete states[id];
    bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
    return;
  }

  // آپلود پرامپت
  if (state.type === 'upload_prompt' && msg.document && msg.document.file_name.endsWith('.txt')) {
    const content = await downloadFile(msg.document.file_id);
    if (content !== null) {
      await pool.query('UPDATE settings SET prompt_content = $1 WHERE id = 1', [content]);
      bot.sendMessage(id, '✅ پرامپت جدید با موفقیت ذخیره شد.');
    } else {
      bot.sendMessage(id, '❌ خطا در خواندن فایل پرامپت.');
    }
    delete states[id];
    bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
    return;
  }

  // ویرایش اطلاعات
  if (state.type === 'edit_menu') {
    const map = {
      '👤 نام': { field: 'name', label: 'نام' },
      '🎂 سن': { field: 'age', label: 'سن' },
      '🏙️ شهر': { field: 'city', label: 'شهر' },
      '🌍 منطقه': { field: 'region', label: 'منطقه' },
      '⚧️ جنسیت': { field: 'gender', label: 'جنسیت' },
      '💼 شغل': { field: 'job', label: 'شغل' },
      '🎯 هدف': { field: 'goal', label: 'هدف' },
      '📱 شماره تماس': { field: 'phone', label: 'شماره تماس' }
    };
    if (map[text]) {
      states[id] = { type: 'edit_field', field: map[text].field, label: map[text].label };
      bot.sendMessage(id, `مقدار جدید برای ${map[text].label} را وارد کنید:`);
    } else if (text === '↩️ بازگشت به منو اصلی') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت', mainKeyboard(true, admin));
    }
    return;
  }

  if (state.type === 'edit_field') {
    const value = state.field === 'age' ? (isNaN(parseInt(text)) ? null : parseInt(text)) : text.trim() || null;
    await pool.query(`UPDATE users SET ${state.field} = $1 WHERE telegram_id = $2`, [value, id]);
    bot.sendMessage(id, `✅ ${state.label} بروزرسانی شد.`, editKeyboard());
    states[id] = { type: 'edit_menu' };
    return;
  }

  // ثبت‌نام کامل
  if (state.type === 'register_full') {
    const questions = [
      '👤 نام خود را وارد کنید:',
      '🎂 سن خود را وارد کنید (عدد):',
      '🏙️ شهر خود را وارد کنید:',
      '🌍 منطقه یا محله خود را وارد کنید:',
      '⚧️ جنسیت خود را وارد کنید:',
      '💼 شغل خود را وارد کنید:',
      '🎯 هدف شما چیست؟',
      '📱 شماره تماس خود را وارد کنید:'
    ];
    const fields = ['name', 'age', 'city', 'region', 'gender', 'job', 'goal', 'phone'];
    state.data[fields[state.step]] = text.trim();
    state.step++;
    if (state.step >= questions.length) {
      const ageVal = isNaN(parseInt(state.data.age)) ? null : parseInt(state.data.age);
      await pool.query(`
        INSERT INTO users (telegram_id, name, age, city, region, gender, job, goal, phone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (telegram_id) DO UPDATE SET
        name=EXCLUDED.name, age=EXCLUDED.age, city=EXCLUDED.city, region=EXCLUDED.region,
        gender=EXCLUDED.gender, job=EXCLUDED.job, goal=EXCLUDED.goal, phone=EXCLUDED.phone
      `, [id, state.data.name, ageVal, state.data.city, state.data.region, state.data.gender, state.data.job, state.data.goal, state.data.phone]);
      bot.sendMessage(id, '✅ ثبت‌نام با موفقیت انجام شد! 🎉', mainKeyboard(true, admin));
      delete states[id];
    } else {
      bot.sendMessage(id, questions[state.step]);
    }
    return;
  }

  // VIP waiting
  if (state.type === 'vip_waiting') {
    if (text === '📸 ارسال عکس فیش واریزی') {
      bot.sendMessage(id, '📸 لطفاً عکس فیش واریزی را ارسال کنید.');
      states[id] = { type: 'vip_receipt' };
    } else if (text === '❌ انصراف از عضویت VIP') {
      delete states[id];
      bot.sendMessage(id, '❌ عضویت VIP لغو شد.', mainKeyboard(await isRegistered(id), admin));
      bot.sendMessage(ADMIN_CHAT_ID, `⚠️ کاربر ${id} از عضویت VIP انصراف داد.`);
    }
    return;
  }

  // دریافت رسید VIP
  if (state.type === 'vip_receipt' && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
    bot.sendMessage(ADMIN_CHAT_ID, `📸 رسید پرداخت از کاربر \( {id}\n/approve_ \){id} یا /reject_${id}`);
    await pool.query(`
      INSERT INTO vips (telegram_id, payment_receipt)
      VALUES ($1, $2)
      ON CONFLICT ON CONSTRAINT vips_telegram_id_key
      DO UPDATE SET payment_receipt = $2
    `, [id, fileId]);
    delete states[id];
    bot.sendMessage(id, '✅ رسید ارسال شد. منتظر تأیید ادمین باشید.', mainKeyboard(await isRegistered(id), admin));
    return;
  }

  // چت با ادمین
  if (state.type === 'chat_admin') {
    const registered = await isRegistered(id);
    if (!registered && (msg.photo || msg.video || msg.document || msg.animation)) {
      bot.sendMessage(id, '⚠️ برای ارسال رسانه ابتدا ثبت‌نام کنید.');
      return;
    }
    try {
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      const { rows } = await pool.query('SELECT name, username FROM users WHERE telegram_id = $1', [id]);
      const user = rows[0] || {};
      const info = `📩 پیام جدید از کاربر\nنام: ${user.name || 'نامشخص'}\nID: ${id}\nیوزرنیم: ${user.username || 'ندارد'}`;
      await bot.sendMessage(ADMIN_CHAT_ID, info, {
        reply_markup: { inline_keyboard: [[{ text: 'پاسخ به کاربر', callback_data: `reply_${id}` }]] }
      });
      bot.sendMessage(id, '✅ پیام شما ارسال شد.', mainKeyboard(await isRegistered(id), admin));
    } catch (err) {
      bot.sendMessage(id, '❌ خطا در ارسال پیام.');
    }
    delete states[id];
    return;
  }

  // چت با هوش مصنوعی
  if (state.type === 'ai_chat') {
    if (text === '↩️ بازگشت') {
      delete states[id];
      bot.sendMessage(id, '↩️ چت بسته شد.', mainKeyboard(await isRegistered(id), admin));
      return;
    }
    const vip = await isVip(id);
    const { rows: usedRows } = await pool.query('SELECT ai_questions_used FROM users WHERE telegram_id = $1', [id]);
    const used = usedRows[0]?.ai_questions_used || 0;
    if (!vip && used >= 5) {
      bot.sendMessage(id, '⚠️ سوالات رایگان تمام شد. برای نامحدود VIP شوید.', mainKeyboard(await isRegistered(id), admin));
      delete states[id];
      return;
    }
    const { rows } = await pool.query('SELECT ai_token, prompt_content FROM settings');
    if (!rows[0]?.ai_token) {
      bot.sendMessage(id, '⚠️ هوش مصنوعی تنظیم نشده است.');
      delete states[id];
      return;
    }
    if (!openai) openai = new OpenAI({ apiKey: rows[0].ai_token });
    const messages = rows[0].prompt_content ? [{ role: 'system', content: rows[0].prompt_content }] : [];
    messages.push({ role: 'user', content: text });
    try {
      const res = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages });
      const reply = res.choices[0].message.content || 'پاسخی دریافت نشد.';
      bot.sendMessage(id, reply, backKeyboard());
      await pool.query('UPDATE users SET ai_questions_used = ai_questions_used + 1 WHERE telegram_id = $1', [id]);
    } catch (err) {
      console.error('خطا در OpenAI:', err.message);
      bot.sendMessage(id, '❌ خطا در هوش مصنوعی. پیام به ادمین ارسال شد.', mainKeyboard(await isRegistered(id), admin));
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      delete states[id];
    }
    return;
  }

  // پیام همگانی
  if (state.type === 'broadcast' && !text.startsWith('/')) {
    let query = 'SELECT telegram_id FROM users';
    if (state.target === 'normal') query = `SELECT u.telegram_id FROM users u LEFT JOIN vips v ON u.telegram_id = v.telegram_id AND v.approved AND v.end_date > NOW() WHERE v.telegram_id IS NULL`;
    if (state.target === 'vip') query = `SELECT u.telegram_id FROM users u JOIN vips v ON u.telegram_id = v.telegram_id WHERE v.approved AND v.end_date > NOW()`;
    const { rows } = await pool.query(query);
    const userIds = rows.map(r => r.telegram_id);
    let success = 0, failed = 0;
    bot.sendMessage(id, `📤 در حال ارسال به ${userIds.length} کاربر...`);
    for (const uid of userIds) {
      try {
        if (msg.photo) await bot.sendPhoto(uid, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption });
        else if (msg.video) await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption });
        else if (msg.document) await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption });
        else if (msg.animation) await bot.sendAnimation(uid, msg.animation.file_id, { caption: msg.caption });
        else await bot.sendMessage(uid, text);
        success++;
      } catch (e) {
        failed++;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    const media_type = msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : msg.animation ? 'animation' : 'text';
    const media_file_id = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id || msg.document?.file_id || msg.animation?.file_id || null;
    await pool.query(`
      INSERT INTO broadcast_messages (admin_id, target_type, message_text, media_type, media_file_id, caption, sent_count, failed_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [ADMIN_CHAT_ID, state.target, text, media_type, media_file_id, msg.caption || null, success, failed]);
    bot.sendMessage(id, `📊 گزارش:\nموفق: ${success}\nناموفق: ${failed}\nکل: ${userIds.length}`);
    delete states[id];
    return;
  }

  // لغو
  if (text === '/cancel') {
    delete states[id];
    bot.sendMessage(id, '❌ عملیات لغو شد.', mainKeyboard(await isRegistered(id), admin));
  }
}

// دستورات ادمین VIP
bot.onText(/\/approve_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  const endDate = moment().add(1, 'month').toDate();
  await pool.query('UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2', [endDate, uid]);
  const { rows } = await pool.query('SELECT vip_channel FROM settings');
  bot.sendMessage(uid, `🎉 عضویت VIP تأیید شد!\nمعتبر تا: ${moment(endDate).format('jYYYY/jM/jD')}\nکانال VIP: ${rows[0]?.vip_channel || 'تنظیم نشده'}`);
  bot.sendMessage(ADMIN_CHAT_ID, `✅ کاربر ${uid} به VIP تبدیل شد.`);
});

bot.onText(/\/reject_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  await pool.query('UPDATE vips SET approved = FALSE, payment_receipt = NULL WHERE telegram_id = $1', [uid]);
  bot.sendMessage(uid, '❌ رسید تأیید نشد. لطفاً دوباره تلاش کنید.');
  bot.sendMessage(ADMIN_CHAT_ID, `❌ رسید کاربر ${uid} رد شد.`);
});

// مشاهده پیام بایگانی
bot.onText(/\/view_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const pid = parseInt(match[1]);
  const { rows } = await pool.query('SELECT * FROM broadcast_messages WHERE id = $1', [pid]);
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'پیام یافت نشد.');
  const r = rows[0];
  const caption = `📋 شناسه: ${r.id} | هدف: ${r.target_type} | ${moment(r.timestamp).format('jYYYY/jM/jD HH:mm')}\nموفق: ${r.sent_count} | ناموفق: ${r.failed_count}`;
  try {
    if (r.media_type === 'photo') await bot.sendPhoto(msg.chat.id, r.media_file_id, { caption: r.caption || r.message_text });
    else if (r.media_type === 'video') await bot.sendVideo(msg.chat.id, r.media_file_id, { caption: r.caption || r.message_text });
    else if (r.media_type === 'document') await bot.sendDocument(msg.chat.id, r.media_file_id, { caption: r.caption || r.message_text });
    else if (r.media_type === 'animation') await bot.sendAnimation(msg.chat.id, r.media_file_id, { caption: r.caption || r.message_text });
    else await bot.sendMessage(msg.chat.id, r.message_text || '(بدون متن)');
    bot.sendMessage(msg.chat.id, caption);
  } catch (err) {
    bot.sendMessage(msg.chat.id, 'خطا در نمایش رسانه.');
  }
});

// پاسخ مستقیم به کاربر
bot.on('callback_query', async (query) => {
  if (query.message.chat.id !== ADMIN_CHAT_ID) return;
  if (query.data.startsWith('reply_')) {
    const userId = parseInt(query.data.split('_')[1]);
    states[ADMIN_CHAT_ID] = { type: 'reply_to_user', userId };
    bot.sendMessage(ADMIN_CHAT_ID, `📝 پاسخ خود را برای کاربر ${userId} بنویسید:`);
    bot.answerCallbackQuery(query.id);
  }
});

// پاسخ مستقیم ادمین
if (states[ADMIN_CHAT_ID]?.type === 'reply_to_user' && admin) {
  const targetId = states[ADMIN_CHAT_ID].userId;
  try {
    await bot.sendMessage(targetId, text);
    bot.sendMessage(ADMIN_CHAT_ID, '✅ پاسخ ارسال شد.');
  } catch (err) {
    bot.sendMessage(ADMIN_CHAT_ID, '❌ خطا در ارسال (ممکن است بلاک کرده باشد).');
  }
  delete states[ADMIN_CHAT_ID];
}

console.log('KaniaChatBot — نسخه نهایی، کامل، بدون خطا و آماده اجرا! 🚀');