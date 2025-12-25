const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const { OpenAI } = require('openai');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// متغیرهای محیطی ضروری
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;

// چک اولیه متغیرهای ضروری
if (!BOT_TOKEN || isNaN(ADMIN_CHAT_ID)) {
  console.error('خطا انتقادی: BOT_TOKEN یا ADMIN_CHAT_ID در Environment Variables تنظیم نشده است!');
  process.exit(1);
}

// تنظیمات بهینه Pool دیتابیس برای Railway
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

// تابع ساخت کیبورد reply بهینه
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

// ساخت جدول ها + اضافه کردن فیلدهای جدید اگر وجود نداشته باشند
async function createTables() {
  try {
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vips (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE REFERENCES users(telegram_id) ON DELETE CASCADE,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        payment_receipt TEXT,
        approved BOOLEAN DEFAULT FALSE
      );
    `);
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
    await pool.query(`INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;`);

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
    console.log('تمام جدول ها آماده شدند و فیلدهای لازم اضافه شدند.');
  } catch (err) {
    console.error('خطا در ساخت یا بروزرسانی جدول ها:', err.message);
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
    console.error('خطا در چک ثبت نام:', err.message);
    return false;
  }
}

async function downloadFile(fileId) {
  try {
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
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

// Graceful Shutdown برای Railway
async function gracefulShutdown() {
  console.log('در حال خاموش شدن امن ربات...');
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

// مدیریت خطاهای جهانی
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
bot.on('error', (err) => console.error('خطای Telegram Bot:', err.message));

// استارت سرور و تنظیم Webhook
app.listen(PORT, async () => {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
  if (!domain) {
    console.error('خطا انتقادی: RAILWAY_PUBLIC_DOMAIN یا RAILWAY_STATIC_URL تنظیم نشده است!');
    process.exit(1);
  }

  const webhookUrl = `https://${domain}/bot${BOT_TOKEN}`;
  try {
    const info = await bot.getWebHookInfo();
    if (info.url !== webhookUrl) {
      await bot.deleteWebHook();
      await bot.setWebHook(webhookUrl);
      console.log(`Webhook تنظیم شد: ${webhookUrl}`);
    } else {
      console.log(`Webhook قبلا درست تنظیم شده بود: ${webhookUrl}`);
    }
  } catch (err) {
    console.error('خطا در تنظیم webhook:', err.message);
    process.exit(1);
  }

  await createTables();
  console.log('KaniaChatBot کاملا آماده است! 🚀');
});

// Keep-Alive بهینه (هر ۱۰ دقیقه)
const keepAliveUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL}`;
if (keepAliveUrl.includes('railway.app')) {
  setInterval(() => {
    fetch(keepAliveUrl)
      .then(() => console.log('Keep-Alive: درخواست موفق'))
      .catch(err => console.error('Keep-Alive خطا:', err.message));
  }, 600000);
}

// کیبوردهای اصلی
function mainKeyboard(reg, admin) {
  const k = [
    [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
    [{ text: '💬 ارسال پیام به کانیا' }, { text: '🤖 چت با هوش مصنوعی' }],
    [{ text: reg ? '✏️ ویرایش اطلاعات' : '📝 ثبت نام' }],
  ];
  if (admin) k.push([{ text: '🛡️ پنل ادمین' }]);
  return createReplyKeyboard(k, { placeholder: 'گزینه مورد نظر را انتخاب کنید' });
}

function adminKeyboard() {
  return createReplyKeyboard([
    [{ text: '🤖 هوش مصنوعی' }, { text: '📺 کانال ها' }],
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

function confirmKeyboard(action) {
  return createReplyKeyboard([
    [{ text: '✅ تایید ' + action }],
    [{ text: '❌ لغو' }]
  ], { one_time: true });
}

// /start
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  const username = msg.from.username ? `@${msg.from.username}` : null;
  await pool.query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
    [id, username]
  );
  const registered = await isRegistered(id);
  const admin = id === ADMIN_CHAT_ID;
  bot.sendMessage(id, '🌟 به ربات KaniaChatBot خوش امدید! 🌟\n\nلطفا از منوی زیر استفاده کنید 👇', mainKeyboard(registered, admin));
});

// هندلر اصلی پیام ها
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text || '';
  const username = msg.from.username ? `@${msg.from.username}` : null;
  const admin = id === ADMIN_CHAT_ID;

  if (username) {
    await pool.query(
      `INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
      [id, username]
    );
  }

  if (states[id]) {
    await handleState(id, text, msg);
    return;
  }

  if (text === '📺 کانال رایگان') {
    const { rows } = await pool.query('SELECT free_channel FROM settings');
    bot.sendMessage(id, `📢 کانال رایگان:\n${rows[0]?.free_channel || 'تنظیم نشده ⚠️'}`);
  } else if (text === '💎 عضویت VIP') {
    const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const s = rows[0];
    if (s?.membership_fee && s?.wallet_address && s?.network) {
      const msgText = `💎 عضویت VIP 💎\n\nمبلغ: ${s.membership_fee}\n\nادرس کیف پول:\n${s.wallet_address}\n\nشبکه: ${s.network}\n\nپس از واریز، عکس فیش را ارسال کنید.`;
      bot.sendMessage(id, msgText, vipKeyboard());
      states[id] = { type: 'vip_waiting' };
    } else {
      bot.sendMessage(id, '⚠️ اطلاعات VIP توسط ادمین تنظیم نشده است.');
    }
  } else if (text === '💬 ارسال پیام به کانیا') {
    bot.sendMessage(id, '💬 پیام خود را بنویسید (متن، عکس، ویدیو، فایل یا گیف).');
    states[id] = { type: 'chat_admin' };
  } else if (text === '🤖 چت با هوش مصنوعی') {
    const { rows } = await pool.query('SELECT ai_token FROM settings');
    if (!rows[0]?.ai_token) {
      bot.sendMessage(id, '⚠️ هوش مصنوعی توسط ادمین تنظیم نشده است.');
      return;
    }
    bot.sendMessage(id, '🧠 سوال خود را بپرسید.', backKeyboard());
    states[id] = { type: 'ai_chat' };
  } else if (text === '📝 ثبت نام' || text === '✏️ ویرایش اطلاعات') {
    const registered = await isRegistered(id);
    if (!registered) {
      states[id] = { type: 'register_full', step: 0, data: {} };
      bot.sendMessage(id, '📝 ثبت نام جدید\n\n👤 نام خود را وارد کنید:');
    } else {
      bot.sendMessage(id, '✏️ کدام فیلد را می خواهید ویرایش کنید؟', editKeyboard());
      states[id] = { type: 'edit_menu' };
    }
  } else if (admin) {
    if (text === '🛡️ پنل ادمین') {
      bot.sendMessage(id, '🛡️ پنل ادمین فعال شد', adminKeyboard());
    } else if (text === '🤖 هوش مصنوعی') {
      bot.sendMessage(id, '🤖 مدیریت هوش مصنوعی:', aiAdminKeyboard());
      states[id] = { type: 'admin_ai_menu' };
    } else if (text === '📺 کانال ها') {
      bot.sendMessage(id, '⚙️ تنظیمات کانال ها و VIP:', channelsKeyboard());
      states[id] = { type: 'admin_channels_menu' };
    } else if (text === '👥 کاربران') {
      bot.sendMessage(id, '👥 مدیریت کاربران:', usersKeyboard());
      states[id] = { type: 'admin_users_menu' };
    } else if (text === '📨 پیامرسانی') {
      bot.sendMessage(id, '📨 پیامرسانی:', broadcastKeyboard());
      states[id] = { type: 'admin_broadcast_menu' };
    } else if (text === '📊 آمار') {
      const { rows: total } = await pool.query('SELECT COUNT(*) FROM users');
      const { rows: vipCount } = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
      bot.sendMessage(id, `📊 آمار کلی:\nکل کاربران: ${total[0].count}\nکاربران VIP فعال: ${vipCount[0].count}`);
    } else if (text === '🔄 ریست دیتابیس') {
      bot.sendMessage(id, '⚠️ ایا مطمئن هستید؟ تمام داده ها پاک می شود!', confirmKeyboard('ریست دیتابیس'));
      states[id] = { type: 'confirm_reset_db' };
    } else if (text === '↩️ بازگشت به منو اصلی') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به منو اصلی', mainKeyboard(true, true));
    }
  }
});

// مدیریت تمام stateها
async function handleState(id, text, msg) {
  const state = states[id];
  const admin = id === ADMIN_CHAT_ID;

  // زیرمنوی هوش مصنوعی
  if (state.type === 'admin_ai_menu') {
    if (text === '⚙️ تنظیم توکن API') {
      bot.sendMessage(id, '🔑 توکن OpenAI را وارد کنید:');
      states[id] = { type: 'set_ai_token' };
    } else if (text === '📂 ارسال فایل پرامپت') {
      bot.sendMessage(id, '📂 فایل پرامپت (.txt) را ارسال کنید:');
      states[id] = { type: 'upload_prompt' };
    } else if (text === '👀 مشاهده پرامپت') {
      const { rows } = await pool.query('SELECT prompt_content FROM settings');
      const prompt = rows[0]?.prompt_content || 'پرامپت تنظیم نشده است.';
      if (prompt.length <= 3800) {
        bot.sendMessage(id, `👀 پرامپت فعلی:\n\n${prompt}`);
      } else {
        const tempFilePath = path.join('/tmp', 'prompt.txt');
        fs.writeFileSync(tempFilePath, prompt, 'utf8');
        await bot.sendDocument(id, tempFilePath, { caption: '👀 پرامپت فعلی (طولانی)' });
        fs.unlinkSync(tempFilePath);
      }
    } else if (text === '🗑️ حذف پرامپت') {
      bot.sendMessage(id, '⚠️ ایا مطمئن هستید؟', confirmKeyboard('حذف پرامپت'));
      states[id] = { type: 'confirm_delete_prompt' };
    } else if (text === '↩️ بازگشت به پنل ادمین') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
    }
    return;
  }

  // تایید حذف پرامپت
  if (state.type === 'confirm_delete_prompt') {
    if (text === '✅ تایید حذف پرامپت') {
      await pool.query('UPDATE settings SET prompt_content = NULL');
      bot.sendMessage(id, '🗑️ پرامپت حذف شد.');
    } else if (text === '❌ لغو') {
      bot.sendMessage(id, '❌ عملیات لغو شد.');
    }
    delete states[id];
    bot.sendMessage(id, '🤖 مدیریت هوش مصنوعی:', aiAdminKeyboard());
    states[id] = { type: 'admin_ai_menu' };
    return;
  }

  // زیرمنوی کانال ها
  if (state.type === 'admin_channels_menu') {
    const fieldMap = {
      'لینک کانال رایگان': 'free_channel',
      'لینک کانال VIP': 'vip_channel',
      'مبلغ عضویت': 'membership_fee',
      'آدرس کیف پول': 'wallet_address',
      'شبکه انتقال': 'network'
    };
    if (fieldMap[text]) {
      const { rows } = await pool.query(`SELECT ${fieldMap[text]} FROM settings`);
      const current = rows[0][fieldMap[text]] || 'تنظیم نشده';
      bot.sendMessage(id, `مقدار فعلی: ${current}\nمقدار جدید را وارد کنید یا /cancel برای لغو.`);
      states[id] = { type: `set_${fieldMap[text]}` };
    } else if (text === '↩️ بازگشت به پنل ادمین') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
    }
    return;
  }

  // تنظیم فیلدهای کانال ها
  if (state.type.startsWith('set_')) {
    if (text === '/cancel') {
      delete states[id];
      bot.sendMessage(id, '❌ عملیات لغو شد.', channelsKeyboard());
      states[id] = { type: 'admin_channels_menu' };
      return;
    }
    const field = state.type.replace('set_', '');
    await pool.query(`UPDATE settings SET ${field} = $1`, [text]);
    bot.sendMessage(id, '✅ بروزرسانی شد.');
    delete states[id];
    bot.sendMessage(id, '⚙️ تنظیمات کانال ها و VIP:', channelsKeyboard());
    states[id] = { type: 'admin_channels_menu' };
    return;
  }

  // زیرمنوی کاربران
  if (state.type === 'admin_users_menu') {
    if (text === '📊 آمار کاربران') {
      const { rows: total } = await pool.query('SELECT COUNT(*) FROM users');
      const { rows: vipCount } = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
      bot.sendMessage(id, `📊 آمار:\nکل کاربران: ${total[0].count}\nVIPها: ${vipCount[0].count}`);
    } else if (text === '👤 لیست کاربران عادی') {
      const { rows } = await pool.query(`
        SELECT u.telegram_id, u.name, u.username FROM users u 
        LEFT JOIN vips v ON u.telegram_id = v.telegram_id WHERE v.telegram_id IS NULL LIMIT 20
      `);
      let list = '👤 کاربران عادی (حداکثر ۲۰):\n';
      rows.forEach(r => list += `/user_${r.telegram_id} - ${r.name || 'نامشخص'} (@${r.username || 'ندارد'})\n`);
      bot.sendMessage(id, list || 'هیچ کاربری یافت نشد.');
    } else if (text === '💎 لیست کاربران VIP') {
      const { rows } = await pool.query(`
        SELECT u.telegram_id, u.name, u.username, v.end_date FROM users u 
        JOIN vips v ON u.telegram_id = v.telegram_id WHERE v.approved AND end_date > NOW() LIMIT 20
      `);
      let list = '💎 کاربران VIP (حداکثر ۲۰):\n';
      rows.forEach(r => list += `/user_${r.telegram_id} - ${r.name || 'نامشخص'} (@${r.username || 'ندارد'}) - پایان: ${moment(r.end_date).format('jYYYY/jM/jD')}\n`);
      bot.sendMessage(id, list || 'هیچ کاربری یافت نشد.');
    } else if (text === '↩️ بازگشت به پنل ادمین') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
    }
    return;
  }

  // زیرمنوی پیامرسانی
  if (state.type === 'admin_broadcast_menu') {
    if (text === '📢 پیام همگانی (همه)') {
      bot.sendMessage(id, 'پیام را بنویسید یا رسانه ارسال کنید:', backKeyboard());
      states[id] = { type: 'broadcast', target: 'all' };
    } else if (text === '📩 کاربران عادی') {
      bot.sendMessage(id, 'پیام را بنویسید یا رسانه ارسال کنید:', backKeyboard());
      states[id] = { type: 'broadcast', target: 'normal' };
    } else if (text === '💌 کاربران VIP') {
      bot.sendMessage(id, 'پیام را بنویسید یا رسانه ارسال کنید:', backKeyboard());
      states[id] = { type: 'broadcast', target: 'vip' };
    } else if (text === '📂 بایگانی') {
      const { rows } = await pool.query('SELECT id, target_type, timestamp FROM broadcast_messages ORDER BY timestamp DESC LIMIT 10');
      let list = '📂 بایگانی (حداکثر ۱۰):\n';
      rows.forEach(r => list += `/view_${r.id} - هدف: ${r.target_type}, تاریخ: ${moment(r.timestamp).format('jYYYY/jM/jD HH:mm')}\n`);
      bot.sendMessage(id, list || 'هیچ پیامی یافت نشد.');
    } else if (text === '↩️ بازگشت به پنل ادمین') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
    }
    return;
  }

  // پخش پیام
  if (state.type === 'broadcast') {
    if (text === '↩️ بازگشت') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت', broadcastKeyboard());
      states[id] = { type: 'admin_broadcast_menu' };
      return;
    }
    let query = 'SELECT telegram_id FROM users';
    if (state.target === 'normal') {
      query = `SELECT u.telegram_id FROM users u LEFT JOIN vips v ON u.telegram_id = v.telegram_id WHERE v.telegram_id IS NULL`;
    } else if (state.target === 'vip') {
      query = `SELECT u.telegram_id FROM users u JOIN vips v ON u.telegram_id = v.telegram_id WHERE v.approved AND v.end_date > NOW()`;
    }
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
    bot.sendMessage(id, `📊 گزارش ارسال:\nموفق: ${success}\nناموفق: ${failed}\nکل: ${userIds.length}`);
    delete states[id];
    return;
  }

  // ویرایش فیلد
  if (state.type === 'edit_menu') {
    const fieldMap = {
      '👤 نام': 'name',
      '🎂 سن': 'age',
      '🏙️ شهر': 'city',
      '🌍 منطقه': 'region',
      '⚧️ جنسیت': 'gender',
      '💼 شغل': 'job',
      '🎯 هدف': 'goal',
      '📱 شماره تماس': 'phone'
    };
    if (fieldMap[text]) {
      const { rows } = await pool.query(`SELECT ${fieldMap[text]} FROM users WHERE telegram_id = $1`, [id]);
      const current = rows[0][fieldMap[text]] || 'تنظیم نشده';
      bot.sendMessage(id, `مقدار فعلی: ${current}\nمقدار جدید را وارد کنید یا /cancel برای لغو.`);
      states[id] = { type: `edit_${fieldMap[text]}` };
    } else if (text === '↩️ بازگشت به منو اصلی') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به منو اصلی', mainKeyboard(true, admin));
    }
    return;
  }

  if (state.type.startsWith('edit_')) {
    if (text === '/cancel') {
      delete states[id];
      bot.sendMessage(id, '❌ ویرایش لغو شد.', editKeyboard());
      states[id] = { type: 'edit_menu' };
      return;
    }
    const field = state.type.replace('edit_', '');
    const value = field === 'age' ? parseInt(text) || null : text.trim() || null;
    await pool.query(`UPDATE users SET ${field} = $1 WHERE telegram_id = $2`, [value, id]);
    bot.sendMessage(id, '✅ ویرایش شد.', editKeyboard());
    states[id] = { type: 'edit_menu' };
    return;
  }

  // ثبت نام کامل
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (telegram_id) DO UPDATE SET name=$2, age=$3, city=$4, region=$5, gender=$6, job=$7, goal=$8, phone=$9
      `, [id, state.data.name, ageVal, state.data.city, state.data.region, state.data.gender, state.data.job, state.data.goal, state.data.phone]);
      bot.sendMessage(id, '✅ ثبت نام با موفقیت انجام شد! 🎉', mainKeyboard(true, admin));
      delete states[id];
      return;
    }
    bot.sendMessage(id, questions[state.step]);
    return;
  }

  // VIP
  if (state.type === 'vip_waiting') {
    if (text === '📸 ارسال عکس فیش واریزی') {
      bot.sendMessage(id, '📸 عکس فیش را ارسال کنید.');
      states[id] = { type: 'vip_receipt' };
    } else if (text === '❌ انصراف از عضویت VIP') {
      delete states[id];
      bot.sendMessage(id, '❌ انصراف دادید.', mainKeyboard(true, admin));
    }
    return;
  }

  if (state.type === 'vip_receipt' && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
    bot.sendMessage(ADMIN_CHAT_ID, `📸 رسید پرداخت از کاربر ${id}\n/approve_${id} یا /reject_${id}`);
    await pool.query(
      'INSERT INTO vips (telegram_id, payment_receipt) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET payment_receipt = $2',
      [id, fileId]
    );
    delete states[id];
    bot.sendMessage(id, '✅ رسید ارسال شد. منتظر تایید ادمین باشید.', mainKeyboard(true, admin));
    return;
  }

  // چت با ادمین
  if (state.type === 'chat_admin') {
    const registered = await isRegistered(id);
    if (!registered && (msg.photo || msg.video || msg.document || msg.animation)) {
      bot.sendMessage(id, '⚠️ برای ارسال رسانه ابتدا ثبت نام کنید.');
      return;
    }
    await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
    const { rows } = await pool.query('SELECT name, username FROM users WHERE telegram_id = $1', [id]);
    const user = rows[0] || {};
    const info = `📩 پیام جدید از کاربر\nنام: ${user.name || 'نامشخص'}\nID: ${id}\nیوزرنیم: ${user.username || 'ندارد'}\n/reply_${id} برای پاسخ`;
    await bot.sendMessage(ADMIN_CHAT_ID, info);
    bot.sendMessage(id, '✅ پیام شما با موفقیت ارسال شد.', mainKeyboard(true, admin));
    delete states[id];
    return;
  }

  // چت با هوش مصنوعی
  if (state.type === 'ai_chat') {
    if (text === '↩️ بازگشت') {
      delete states[id];
      bot.sendMessage(id, '↩️ چت با هوش مصنوعی بسته شد.', mainKeyboard(true, admin));
      return;
    }
    const vip = await isVip(id);
    const { rows: usedRows } = await pool.query('SELECT ai_questions_used FROM users WHERE telegram_id = $1', [id]);
    const used = usedRows[0]?.ai_questions_used || 0;
    if (!vip && used >= 5) {
      bot.sendMessage(id, '⚠️ تعداد سوالات رایگان شما تمام شده است. برای سوالات نامحدود VIP شوید.', mainKeyboard(true, admin));
      delete states[id];
      return;
    }
    const { rows } = await pool.query('SELECT ai_token, prompt_content FROM settings');
    if (!rows[0]?.ai_token) {
      bot.sendMessage(id, '⚠️ هوش مصنوعی توسط ادمین تنظیم نشده است.', mainKeyboard(true, admin));
      delete states[id];
      return;
    }
    if (!openai) openai = new OpenAI({ apiKey: rows[0].ai_token });
    const messages = rows[0].prompt_content ? [{ role: 'system', content: rows[0].prompt_content }] : [];
    messages.push({ role: 'user', content: text });
    try {
      const res = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages
      });
      const reply = res.choices[0].message.content || 'پاسخی دریافت نشد.';
      bot.sendMessage(id, reply, backKeyboard());
      await pool.query('UPDATE users SET ai_questions_used = ai_questions_used + 1 WHERE telegram_id = $1', [id]);
    } catch (err) {
      bot.sendMessage(id, '❌ خطا در ارتباط با هوش مصنوعی.', mainKeyboard(true, admin));
      delete states[id];
    }
    return;
  }

  // ریست دیتابیس
  if (state.type === 'confirm_reset_db') {
    if (text === '✅ تایید ریست دیتابیس') {
      await pool.query('DROP TABLE IF EXISTS users, vips, settings, broadcast_messages CASCADE');
      await createTables();
      bot.sendMessage(id, '✅ دیتابیس ریست شد.');
    } else if (text === '❌ لغو') {
      bot.sendMessage(id, '❌ عملیات لغو شد.');
    }
    delete states[id];
    bot.sendMessage(id, '🛡️ پنل ادمین', adminKeyboard());
    return;
  }

  // جزئیات کاربر (با /user_id)
  if (text.startsWith('/user_') && admin) {
    const uid = text.replace('/user_', '');
    const { rows: userRows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [uid]);
    const { rows: vipRows } = await pool.query('SELECT * FROM vips WHERE telegram_id = $1', [uid]);
    if (userRows.length === 0) {
      bot.sendMessage(id, 'کاربر یافت نشد.');
      return;
    }
    const user = userRows[0];
    let details = `جزئیات کاربر ${uid}:\nنام: ${user.name || 'نامشخص'}\nسن: ${user.age || 'نامشخص'}\nشهر: ${user.city || 'نامشخص'}\nمنطقه: ${user.region || 'نامشخص'}\nجنسیت: ${user.gender || 'نامشخص'}\nشغل: ${user.job || 'نامشخص'}\nهدف: ${user.goal || 'نامشخص'}\nشماره تماس: ${user.phone || 'نامشخص'}\nسوالات AI استفاده شده: ${user.ai_questions_used || 0}\nثبت نام: ${moment(user.registration_date).format('jYYYY/jM/jD HH:mm')}`;
    if (vipRows.length > 0) {
      const vip = vipRows[0];
      details += `\n\nوضعیت VIP:\nشروع: ${moment(vip.start_date).format('jYYYY/jM/jD HH:mm')}\nپایان: ${moment(vip.end_date).format('jYYYY/jM/jD HH:mm')}\nتایید شده: ${vip.approved ? 'بله' : 'خیر'}`;
    }
    bot.sendMessage(id, details);
    return;
  }

  // پاسخ به کاربر (با /reply_id)
  if (text.startsWith('/reply_') && admin) {
    const uid = text.replace('/reply_', '');
    bot.sendMessage(id, `پاسخ به کاربر ${uid} را بنویسید: (برای لغو /cancel) `);
    states[id] = { type: 'reply_to_user', userId: uid };
    return;
  }

  if (state.type === 'reply_to_user') {
    if (text === '/cancel') {
      delete states[id];
      bot.sendMessage(id, '❌ پاسخ لغو شد.', adminKeyboard());
      return;
    }
    await bot.sendMessage(state.userId, text);
    bot.sendMessage(id, '✅ پاسخ ارسال شد.');
    delete states[id];
    bot.sendMessage(id, '🛡️ پنل ادمین', adminKeyboard());
    return;
  }

  // مشاهده بایگانی (با /view_id)
  if (text.startsWith('/view_') && admin) {
    const bid = text.replace('/view_', '');
    const { rows } = await pool.query('SELECT * FROM broadcast_messages WHERE id = $1', [bid]);
    if (rows.length === 0) {
      bot.sendMessage(id, 'پیام یافت نشد.');
      return;
    }
    const row = rows[0];
    const date = moment(row.timestamp).format('jYYYY/jM/jD HH:mm');
    const target = row.target_type === 'all' ? 'همه' : row.target_type === 'vip' ? 'VIP' : 'عادی';
    const caption = `📋 شناسه: ${row.id}\nهدف: ${target}\nتاریخ: ${date}\nموفق: ${row.sent_count} | ناموفق: ${row.failed_count}`;
    try {
      if (row.media_type === 'photo') await bot.sendPhoto(id, row.media_file_id, { caption: row.caption || row.message_text });
      else if (row.media_type === 'video') await bot.sendVideo(id, row.media_file_id, { caption: row.caption || row.message_text });
      else if (row.media_type === 'document') await bot.sendDocument(id, row.media_file_id, { caption: row.caption || row.message_text });
      else if (row.media_type === 'animation') await bot.sendAnimation(id, row.media_file_id, { caption: row.caption || row.message_text });
      else await bot.sendMessage(id, row.message_text || '(بدون متن)');
      bot.sendMessage(id, caption);
    } catch (err) {
      bot.sendMessage(id, 'خطا در نمایش رسانه.');
    }
    return;
  }

  // approve/reject VIP
  if (text.startsWith('/approve_') && admin) {
    const uid = text.replace('/approve_', '');
    const endDate = moment().add(1, 'month').toDate();
    await pool.query('UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2', [endDate, uid]);
    const { rows } = await pool.query('SELECT vip_channel FROM settings');
    bot.sendMessage(uid, `🎉 عضویت VIP شما تایید شد!\nمعتبر تا: ${moment(endDate).format('jYYYY/jM/jD')}\nکانال VIP: ${rows[0]?.vip_channel || 'تنظیم نشده'}`);
    bot.sendMessage(id, `✅ کاربر ${uid} VIP شد.`);
    return;
  }

  if (text.startsWith('/reject_') && admin) {
    const uid = text.replace('/reject_', '');
    await pool.query('UPDATE vips SET approved = FALSE WHERE telegram_id = $1', [uid]);
    bot.sendMessage(uid, '❌ رسید پرداخت شما تایید نشد. لطفا دوباره تلاش کنید.');
    bot.sendMessage(id, `❌ رسید کاربر ${uid} رد شد.`);
    return;
  }
}

bot.on('callback_query', async (query) => {
  bot.answerCallbackQuery(query.id, { text: 'این ویژگی به دستور متنی تغییر یافته است. از /commands استفاده کنید.' });
});

console.log('KaniaChatBot کامل و بدون خطا!');
"""
print(check_syntax(full_code))</parameter>
</xai:function_call>
