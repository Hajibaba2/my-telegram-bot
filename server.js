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

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!BOT_TOKEN || isNaN(ADMIN_CHAT_ID)) {
  console.error('خطا انتقادی: BOT_TOKEN یا ADMIN_CHAT_ID تنظیم نشده است!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false,
  filepath: false
});
let openai = null;
const states = {};

// تنظیم اولیه OpenAI
async function initOpenAI() {
  try {
    const { rows } = await pool.query('SELECT ai_token FROM settings');
    if (rows[0]?.ai_token) {
      openai = new OpenAI({ apiKey: rows[0].ai_token });
      console.log('🤖 OpenAI با موفقیت تنظیم شد.');
    }
  } catch (err) {
    console.error('خطا در تنظیم اولیه OpenAI:', err.message);
  }
}

// Rate Limiting
const rateLimit = {};
function checkRateLimit(userId) {
  const now = Date.now();
  if (!rateLimit[userId]) rateLimit[userId] = [];
  rateLimit[userId] = rateLimit[userId].filter(time => now - time < 60000);
  if (rateLimit[userId].length >= 10) return false;
  rateLimit[userId].push(now);
  return true;
}

// لاگ فعالیت
function logActivity(userId, action, details = '') {
  console.log(`[${new Date().toISOString()}] User ${userId}: ${action} ${details}`);
}

// تابع زیباسازی گزارش کاربران
function formatUserReport(user, action = 'ثبت‌نام', username = null) {
  const emojiMap = {
    'ثبت‌نام': '🆕',
    'ویرایش': '✏️',
    'VIP': '💎',
    'پیام': '💬',
    'AI': '🤖'
  };
  
  const emoji = emojiMap[action] || '📋';
  
  let report = `${emoji} *${action} ${action === 'ثبت‌نام' ? 'جدید' : 'اطلاعات'}*\n`;
  report += `━━━━━━━━━━━━━━━━\n`;
  report += `👤 *نام کاربری:* ${username || user.username || 'ندارد'}\n`;
  report += `🆔 *آیدی عددی:* \`${user.telegram_id}\`\n`;
  report += `📛 *نام:* ${user.name || 'نامشخص'}\n`;
  report += `🎂 *سن:* ${user.age || 'نامشخص'}\n`;
  report += `🏙️ *شهر:* ${user.city || 'نامشخص'}\n`;
  report += `🌍 *منطقه:* ${user.region || 'نامشخص'}\n`;
  report += `💼 *شغل:* ${user.job || 'نامشخص'}\n`;
  report += `⚧️ *جنسیت:* ${user.gender || 'نامشخص'}\n`;
  report += `🎯 *هدف:* ${user.goal || 'نامشخص'}\n`;
  report += `📱 *شماره:* ${user.phone || 'نامشخص'}\n`;
  report += `📅 *تاریخ ${action === 'ثبت‌نام' ? 'ثبت‌نام' : 'ویرایش'}:* ${moment().format('jYYYY/jM/jD HH:mm')}\n`;
  report += `━━━━━━━━━━━━━━━━`;
  
  return report;
}

// تابع برای لیست زیبای کاربران
function formatUserList(users, title = 'کاربران', type = 'normal') {
  const emojiMap = {
    'normal': '👤',
    'vip': '💎',
    'all': '📊'
  };
  
  const emoji = emojiMap[type] || '👥';
  let list = `${emoji} *${title}*\n`;
  list += `━━━━━━━━━━━━━━━━\n`;
  
  if (users.length === 0) {
    list += `📭 لیست خالی است\n`;
  } else {
    users.forEach((user, index) => {
      const vipBadge = user.vip ? ' 💎' : '';
      list += `${index + 1}. ${user.name || 'نامشخص'}${vipBadge}\n`;
      list += `   🆔: \`${user.telegram_id}\`\n`;
      list += `   👤: @${user.username || 'ندارد'}\n`;
      if (user.registration_date) {
        list += `   📅: ${moment(user.registration_date).format('jYYYY/jM/jD')}\n`;
      }
      list += `   ──────────────\n`;
    });
  }
  
  list += `━━━━━━━━━━━━━━━━\n`;
  list += `📊 تعداد: ${users.length} کاربر`;
  
  return list;
}

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

function confirmKeyboard(action) {
  return createReplyKeyboard([
    [{ text: `✅ تأیید ${action}` }],
    [{ text: '❌ لغو' }]
  ], { one_time: true });
}

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

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1`);

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_messages (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        message_text TEXT,
        media_type VARCHAR(50),
        media_file_id TEXT,
        is_from_user BOOLEAN DEFAULT TRUE,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_chats (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        user_question TEXT,
        ai_response TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ تمام جدول‌ها و فیلدهای جدید آماده شدند.');
  } catch (err) {
    console.error('❌ خطا در ساخت یا بروزرسانی جدول‌ها:', err.message);
  }
}

async function addScore(id, points) {
  try {
    await pool.query(
      'UPDATE users SET score = COALESCE(score, 0) + $1, level = FLOOR((COALESCE(score, 0) + $1) / 50) + 1 WHERE telegram_id = $2',
      [points, id]
    );
    logActivity(id, 'امتیاز اضافه شد', `${points} امتیاز`);
  } catch (err) {
    console.error('❌ خطا در اضافه کردن امتیاز:', err.message);
  }
}

async function isVip(id) {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved AND end_date > NOW()',
      [id]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('❌ خطا در بررسی وضعیت VIP:', err.message);
    return false;
  }
}

async function isRegistered(id) {
  try {
    const { rows } = await pool.query(
      'SELECT name FROM users WHERE telegram_id = $1',
      [id]
    );
    return rows.length > 0 && rows[0].name != null;
  } catch (err) {
    console.error('❌ خطا در بررسی ثبت‌نام:', err.message);
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
    console.error('❌ خطا در دانلود فایل:', err.message);
    return null;
  }
}

// ارسال همگانی بهینه‌شده
async function sendBroadcast(userIds, msg) {
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 10) {
    chunks.push(userIds.slice(i, i + 10));
  }
  
  let success = 0, failed = 0;
  
  for (const chunk of chunks) {
    const promises = chunk.map(async (uid) => {
      try {
        if (msg.photo) {
          await bot.sendPhoto(uid, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption });
        } else if (msg.video) {
          await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption });
        } else if (msg.document) {
          await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption });
        } else if (msg.animation) {
          await bot.sendAnimation(uid, msg.animation.file_id, { caption: msg.caption });
        } else {
          await bot.sendMessage(uid, msg.text);
        }
        success++;
      } catch (e) {
        failed++;
      }
    });
    
    await Promise.all(promises);
    await new Promise(r => setTimeout(r, 1000)); // تاخیر بین چانک‌ها
  }
  
  return { success, failed };
}

// Route برای Webhook
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Route برای بررسی سلامت
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'KaniaChatBot',
    timestamp: new Date().toISOString(),
    webhook: WEBHOOK_URL ? 'configured' : 'not-configured',
    mode: bot.hasOpenWebHook?.() ? 'webhook' : 'polling'
  });
});

// Route برای اطلاعات Webhook
app.get('/webhook-info', async (req, res) => {
  try {
    const info = await bot.getWebHookInfo();
    res.json({
      success: true,
      info: {
        url: info.url,
        has_custom_certificate: info.has_custom_certificate,
        pending_update_count: info.pending_update_count,
        last_error_date: info.last_error_date,
        last_error_message: info.last_error_message,
        max_connections: info.max_connections,
        allowed_updates: info.allowed_updates
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// graceful shutdown
async function gracefulShutdown() {
  console.log('🛑 در حال خاموش کردن ربات...');
  try {
    await bot.stopPolling();
    console.log('⏹️ Polling متوقف شد.');
  } catch (err) {
    console.error('❌ خطا در توقف polling:', err.message);
  }
  
  try {
    await bot.deleteWebHook();
    console.log('🗑️ Webhook حذف شد.');
  } catch (err) {
    console.error('❌ خطا در حذف webhook:', err.message);
  }
  
  try {
    await pool.end();
    console.log('🔌 اتصال دیتابیس بسته شد.');
  } catch (err) {
    console.error('❌ خطا در بستن دیتابیس:', err.message);
  }
  
  console.log('👋 ربات خاموش شد.');
  process.exit(0);
}

// مدیریت خطاها
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
bot.on('error', (err) => console.error('❌ خطای Bot:', err.message));

// راه‌اندازی سرور
app.listen(PORT, async () => {
  await createTables();
  await initOpenAI();
  
  console.log(`🌐 پورت: ${PORT}`);
  console.log(`🤖 توکن بات: ${BOT_TOKEN ? '✅ تنظیم شده' : '❌ تنظیم نشده!'}`);
  console.log(`👑 ادمین: ${ADMIN_CHAT_ID}`);
  console.log(`🔗 WEBHOOK_URL: ${WEBHOOK_URL ? '✅ تنظیم شده' : '❌ تنظیم نشده'}`);
  
  // اولویت با WEBHOOK_URL
  if (WEBHOOK_URL && WEBHOOK_URL.trim() !== '') {
    const webhookUrl = WEBHOOK_URL.trim();
    console.log(`🌍 تنظیم Webhook از متغیر محیطی: ${webhookUrl}`);
    
    try {
      // حذف Webhook قبلی برای جلوگیری از تداخل
      try {
        await bot.deleteWebHook();
        console.log('🧹 Webhook قبلی پاک شد.');
      } catch (e) {
        // ignore
      }
      
      await bot.setWebHook(webhookUrl);
      console.log('✅ Webhook با موفقیت تنظیم شد.');
      
      // بررسی وضعیت Webhook
      const webhookInfo = await bot.getWebHookInfo();
      console.log(`📊 وضعیت Webhook:
      - URL: ${webhookInfo.url}
      - دارد Webhook: ${webhookInfo.has_custom_certificate ? 'کاستوم' : 'معمولی'}
      - تعداد در انتظار: ${webhookInfo.pending_update_count}
      - آخرین خطا: ${webhookInfo.last_error_message || 'ندارد'}`);
      
    } catch (err) {
      console.error('❌ خطا در تنظیم webhook:', err.message);
      console.log('🔄 سوئیچ به polling mode...');
      bot.startPolling();
      console.log('🔁 ربات با polling فعال شد.');
    }
  } else {
    console.log('⚠️ WEBHOOK_URL تنظیم نشده، بررسی دامنه عمومی...');
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || process.env.RENDER_EXTERNAL_URL;
    
    if (domain && domain.trim() !== '') {
      const webhookUrl = `https://${domain.trim()}/bot${BOT_TOKEN}`;
      console.log(`🔗 ساخت Webhook URL: ${webhookUrl}`);
      
      try {
        await bot.setWebHook(webhookUrl);
        console.log('✅ Webhook با موفقیت تنظیم شد.');
      } catch (err) {
        console.error('❌ خطا در تنظیم webhook:', err.message);
        bot.startPolling();
        console.log('🔁 ربات با polling فعال شد.');
      }
    } else {
      console.log('🌐 دامنه عمومی یافت نشد، فعال‌سازی polling...');
      bot.startPolling();
      console.log('🔁 ربات با polling فعال شد.');
    }
  }
  
  console.log('🎉 KaniaChatBot آماده است! 🚀');
});

// کیبوردها
function mainKeyboard(reg, admin) {
  const k = [
    [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
    [{ text: '💬 ارسال پیام به کانیا' }, { text: '🤖 چت با هوش مصنوعی' }],
    [{ text: reg ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
    [{ text: '📊 آمار من' }]
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
    [{ text: '📜 بایگانی چت کاربران' }],
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

// دستور /start
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  
  // بررسی Rate Limit
  if (!checkRateLimit(id)) {
    bot.sendMessage(id, '⚠️ درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.');
    return;
  }
  
  const username = msg.from.username ? `@${msg.from.username}` : null;
  try {
    await pool.query(
      `INSERT INTO users (telegram_id, username) 
       VALUES ($1, $2) 
       ON CONFLICT (telegram_id) 
       DO UPDATE SET username = EXCLUDED.username`,
      [id, username]
    );
    
    const registered = await isRegistered(id);
    const admin = id === ADMIN_CHAT_ID;
    
    bot.sendMessage(
      id,
      '🌟 به ربات KaniaChatBot خوش آمدید! 🌟\n\nلطفاً از منوی زیر استفاده کنید 👇',
      mainKeyboard(registered, admin)
    );
    
    logActivity(id, 'استارت کرد');
  } catch (err) {
    console.error('❌ خطا در دستور /start:', err.message);
    bot.sendMessage(id, '❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
  }
});

// پردازش پیام‌ها
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text || '';
  const admin = id === ADMIN_CHAT_ID;
  
  // بررسی Rate Limit
  if (!checkRateLimit(id)) {
    bot.sendMessage(id, '⚠️ درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.');
    return;
  }
  
  logActivity(id, 'پیام فرستاد', text.substring(0, 50));
  
  if (states[id]) {
    await handleState(id, text, msg);
    return;
  }
  
  // منوی اصلی
  if (text === '📊 آمار من') {
    const { rows } = await pool.query(
      'SELECT name, ai_questions_used, COALESCE(score, 0) AS score, COALESCE(level, 1) AS level, registration_date FROM users WHERE telegram_id = $1',
      [id]
    );
    const vip = await isVip(id);
    
    if (rows.length === 0) {
      bot.sendMessage(id, '⚠️ ابتدا ثبت‌نام کنید.');
      return;
    }
    
    const u = rows[0];
    const stats = `📊 *آمار شما*\n━━━━━━━━━━━━━━━━\n📛 *نام:* ${u.name || 'نامشخص'}\n⭐ *امتیاز:* ${u.score}\n📈 *لِوِل:* ${u.level}\n🤖 *سوالات AI:* ${u.ai_questions_used || 0}\n💎 *وضعیت VIP:* ${vip ? '✅ فعال' : '❌ غیرفعال'}\n📅 *تاریخ ثبت‌نام:* ${moment(u.registration_date).format('jYYYY/jM/jD')}\n━━━━━━━━━━━━━━━━`;
    
    bot.sendMessage(id, stats, { parse_mode: 'Markdown', ...mainKeyboard(true, admin) });
    return;
  }
  
  if (text === '📺 کانال رایگان') {
    const { rows } = await pool.query('SELECT free_channel FROM settings');
    bot.sendMessage(id, `📢 *کانال رایگان*\n━━━━━━━━━━━━━━━━\n${rows[0]?.free_channel || 'تنظیم نشده ⚠️'}\n━━━━━━━━━━━━━━━━`, { parse_mode: 'Markdown' });
  } else if (text === '💎 عضویت VIP') {
    const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const s = rows[0];
    
    if (s?.membership_fee && s?.wallet_address && s?.network) {
      const msgText = `💎 *عضویت VIP* 💎\n━━━━━━━━━━━━━━━━\n💰 *مبلغ:* ${s.membership_fee}\n\n👛 *آدرس کیف پول:*\n\`${s.wallet_address}\`\n\n🌐 *شبکه:* ${s.network}\n━━━━━━━━━━━━━━━━\n📸 پس از واریز، عکس فیش را ارسال کنید.`;
      bot.sendMessage(id, msgText, { parse_mode: 'Markdown', ...vipKeyboard() });
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
  } else if (text === '📝 ثبت‌نام' || text === '✏️ ویرایش اطلاعات') {
    const registered = await isRegistered(id);
    if (!registered) {
      states[id] = { type: 'register_full', step: 0, data: {} };
      bot.sendMessage(id, '📝 *ثبت‌نام جدید*\n━━━━━━━━━━━━━━━━\n👤 نام خود را وارد کنید:', { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(id, '✏️ کدام فیلد را می‌خواهید ویرایش کنید؟', editKeyboard());
      states[id] = { type: 'edit_menu' };
    }
  } else if (admin) {
    // منوی ادمین
    if (text === '🛡️ پنل ادمین') {
      bot.sendMessage(id, '🛡️ *پنل ادمین فعال شد*', { parse_mode: 'Markdown', ...adminKeyboard() });
    } else if (text === '🤖 هوش مصنوعی') {
      bot.sendMessage(id, '🤖 *مدیریت هوش مصنوعی:*', { parse_mode: 'Markdown', ...aiAdminKeyboard() });
      states[id] = { type: 'admin_ai_menu' };
    } else if (text === '📺 کانال‌ها') {
      bot.sendMessage(id, '⚙️ *تنظیمات کانال‌ها و VIP:*', { parse_mode: 'Markdown', ...channelsKeyboard() });
      states[id] = { type: 'admin_channels_menu' };
    } else if (text === '👥 کاربران') {
      bot.sendMessage(id, '👥 *مدیریت کاربران:*', { parse_mode: 'Markdown', ...usersKeyboard() });
      states[id] = { type: 'admin_users_menu' };
    } else if (text === '📨 پیامرسانی') {
      bot.sendMessage(id, '📨 *پیامرسانی:*', { parse_mode: 'Markdown', ...broadcastKeyboard() });
      states[id] = { type: 'admin_broadcast_menu' };
    } else if (text === '📊 آمار') {
      const { rows: total } = await pool.query('SELECT COUNT(*) FROM users');
      const { rows: vipCount } = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
      const stats = `📊 *آمار کلی*\n━━━━━━━━━━━━━━━━\n👥 *کل کاربران:* ${total[0].count}\n💎 *کاربران VIP فعال:* ${vipCount[0].count}\n📈 *نسبت VIP:* ${((vipCount[0].count / total[0].count) * 100 || 0).toFixed(1)}%\n━━━━━━━━━━━━━━━━`;
      bot.sendMessage(id, stats, { parse_mode: 'Markdown' });
    } else if (text === '🔄 ریست دیتابیس') {
      bot.sendMessage(id, '⚠️ *آیا مطمئن هستید؟* تمام داده‌ها پاک می‌شود!', { parse_mode: 'Markdown', ...confirmKeyboard('ریست دیتابیس') });
      states[id] = { type: 'confirm_reset_db' };
    } else if (text === '↩️ بازگشت به منو اصلی') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به منو اصلی', mainKeyboard(true, true));
    }
  }
});

// مدیریت stateها
async function handleState(id, text, msg) {
  const state = states[id];
  const admin = id === ADMIN_CHAT_ID;
  
  try {
    // مدیریت هوش مصنوعی ادمین
    if (state.type === 'admin_ai_menu') {
      if (text === '⚙️ تنظیم توکن API') {
        // دریافت توکن فعلی برای نمایش
        const { rows } = await pool.query('SELECT ai_token FROM settings');
        const currentToken = rows[0]?.ai_token;
        
        let message = '🔑 *تنظیم توکن OpenAI*\n━━━━━━━━━━━━━━━━\n';
        if (currentToken) {
          const maskedToken = currentToken.substring(0, 10) + '...' + currentToken.substring(currentToken.length - 4);
          message += `*توکن فعلی:* \`${maskedToken}\`\n`;
        } else {
          message += '*توکن فعلی:* تنظیم نشده\n';
        }
        message += '━━━━━━━━━━━━━━━━\nلطفاً توکن جدید را وارد کنید:';
        
        bot.sendMessage(id, message, { parse_mode: 'Markdown' });
        states[id] = { type: 'set_ai_token' };
      } else if (text === '📂 ارسال فایل پرامپت') {
        bot.sendMessage(id, '📂 فایل پرامپت (.txt) را ارسال کنید:');
        states[id] = { type: 'upload_prompt' };
      } else if (text === '👀 مشاهده پرامپت') {
        const { rows } = await pool.query('SELECT prompt_content FROM settings');
        const prompt = rows[0]?.prompt_content || 'پرامپت تنظیم نشده است.';
        
        if (prompt.length <= 3800) {
          bot.sendMessage(id, `👀 *پرامپت فعلی*\n━━━━━━━━━━━━━━━━\n${prompt}\n━━━━━━━━━━━━━━━━`, { parse_mode: 'Markdown' });
        } else {
          const tempFilePath = path.join('/tmp', 'prompt.txt');
          fs.writeFileSync(tempFilePath, prompt, 'utf8');
          await bot.sendDocument(id, tempFilePath, { caption: '👀 پرامپت فعلی (طولانی)' });
          fs.unlinkSync(tempFilePath);
        }
      } else if (text === '🗑️ حذف پرامپت') {
        bot.sendMessage(id, '⚠️ *آیا مطمئن هستید؟*', { parse_mode: 'Markdown', ...confirmKeyboard('حذف پرامپت') });
        states[id] = { type: 'confirm_delete_prompt' };
      } else if (text === '↩️ بازگشت به پنل ادمین') {
        delete states[id];
        bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
    }
    
    if (state.type === 'confirm_delete_prompt') {
      if (text.startsWith('✅ تأیید حذف پرامپت')) {
        await pool.query('UPDATE settings SET prompt_content = NULL');
        bot.sendMessage(id, '🗑️ *پرامپت حذف شد.*', { parse_mode: 'Markdown' });
      } else if (text === '❌ لغو') {
        bot.sendMessage(id, '❌ عملیات لغو شد.');
      }
      delete states[id];
      bot.sendMessage(id, '🤖 *مدیریت هوش مصنوعی:*', { parse_mode: 'Markdown', ...aiAdminKeyboard() });
      states[id] = { type: 'admin_ai_menu' };
      return;
    }
    
    if (state.type === 'set_ai_token') {
      await pool.query('UPDATE settings SET ai_token = $1', [text]);
      openai = new OpenAI({ apiKey: text });
      
      // نمایش پیام تأیید زیبا
      const maskedToken = text.substring(0, 10) + '...' + text.substring(text.length - 4);
      const confirmMsg = `✅ *توکن ذخیره شد*\n━━━━━━━━━━━━━━━━\n*توکن جدید:* \`${maskedToken}\`\n*زمان ذخیره:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━`;
      
      bot.sendMessage(id, confirmMsg, { parse_mode: 'Markdown' });
      delete states[id];
      bot.sendMessage(id, '🤖 *مدیریت هوش مصنوعی:*', { parse_mode: 'Markdown', ...aiAdminKeyboard() });
      states[id] = { type: 'admin_ai_menu' };
      return;
    }
    
    if (state.type === 'upload_prompt' && msg.document && msg.document.file_name && msg.document.file_name.endsWith('.txt')) {
      const content = await downloadFile(msg.document.file_id);
      if (content) {
        await pool.query('UPDATE settings SET prompt_content = $1', [content]);
        bot.sendMessage(id, '✅ *پرامپت ذخیره شد.*', { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(id, '❌ خطا در خواندن فایل.');
      }
      delete states[id];
      bot.sendMessage(id, '🤖 *مدیریت هوش مصنوعی:*', { parse_mode: 'Markdown', ...aiAdminKeyboard() });
      states[id] = { type: 'admin_ai_menu' };
      return;
    }
    
    // مدیریت کانال‌ها
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
        const message = `⚙️ *تنظیم ${text}*\n━━━━━━━━━━━━━━━━\n*مقدار فعلی:* ${current}\n━━━━━━━━━━━━━━━━\nمقدار جدید را وارد کنید یا /cancel برای لغو.`;
        bot.sendMessage(id, message, { parse_mode: 'Markdown' });
        states[id] = { type: `set_${fieldMap[text]}` };
      } else if (text === '↩️ بازگشت به پنل ادمین') {
        delete states[id];
        bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
    }
    
    if (state.type.startsWith('set_')) {
      if (text === '/cancel') {
        delete states[id];
        bot.sendMessage(id, '❌ عملیات لغو شد.', channelsKeyboard());
        states[id] = { type: 'admin_channels_menu' };
        return;
      }
      const field = state.type.replace('set_', '');
      await pool.query(`UPDATE settings SET ${field} = $1`, [text]);
      
      const fieldNames = {
        'free_channel': 'لینک کانال رایگان',
        'vip_channel': 'لینک کانال VIP',
        'membership_fee': 'مبلغ عضویت',
        'wallet_address': 'آدرس کیف پول',
        'network': 'شبکه انتقال'
      };
      
      const fieldName = fieldNames[field] || field;
      const confirmMsg = `✅ *${fieldName} بروزرسانی شد*\n━━━━━━━━━━━━━━━━\n*مقدار جدید:* ${text}\n*زمان بروزرسانی:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━`;
      
      bot.sendMessage(id, confirmMsg, { parse_mode: 'Markdown' });
      delete states[id];
      bot.sendMessage(id, '⚙️ *تنظیمات کانال‌ها و VIP:*', { parse_mode: 'Markdown', ...channelsKeyboard() });
      states[id] = { type: 'admin_channels_menu' };
      return;
    }
    
    // مدیریت کاربران
    if (state.type === 'admin_users_menu') {
      if (text === '📊 آمار کاربران') {
        const { rows: total } = await pool.query('SELECT COUNT(*) FROM users');
        const { rows: vipCount } = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
        const stats = `📊 *آمار کلی کاربران*\n━━━━━━━━━━━━━━━━\n👥 *کل کاربران:* ${total[0].count}\n💎 *کاربران VIP فعال:* ${vipCount[0].count}\n📈 *نسبت VIP:* ${((vipCount[0].count / total[0].count) * 100 || 0).toFixed(1)}%\n━━━━━━━━━━━━━━━━`;
        bot.sendMessage(id, stats, { parse_mode: 'Markdown' });
      } else if (text === '👤 لیست کاربران عادی') {
        const { rows } = await pool.query(`
          SELECT u.telegram_id, u.name, u.username, u.registration_date 
          FROM users u 
          LEFT JOIN vips v ON u.telegram_id = v.telegram_id 
          WHERE v.telegram_id IS NULL 
          ORDER BY u.registration_date DESC 
          LIMIT 20
        `);
        
        const users = rows.map(r => ({
          telegram_id: r.telegram_id,
          name: r.name,
          username: r.username,
          registration_date: r.registration_date,
          vip: false
        }));
        
        const list = formatUserList(users, 'کاربران عادی (۲۰ کاربر اخیر)', 'normal');
        bot.sendMessage(id, list, { parse_mode: 'Markdown' });
      } else if (text === '💎 لیست کاربران VIP') {
        const { rows } = await pool.query(`
          SELECT u.telegram_id, u.name, u.username, u.registration_date, v.end_date 
          FROM users u 
          JOIN vips v ON u.telegram_id = v.telegram_id 
          WHERE v.approved AND v.end_date > NOW() 
          ORDER BY v.end_date DESC 
          LIMIT 20
        `);
        
        const users = rows.map(r => ({
          telegram_id: r.telegram_id,
          name: r.name,
          username: r.username,
          registration_date: r.registration_date,
          vip: true,
          vip_end: r.end_date
        }));
        
        const list = formatUserList(users, 'کاربران VIP فعال (۲۰ کاربر اخیر)', 'vip');
        bot.sendMessage(id, list, { parse_mode: 'Markdown' });
      } else if (text === '📜 بایگانی چت کاربران') {
        const { rows } = await pool.query('SELECT telegram_id, name, username FROM users ORDER BY registration_date DESC LIMIT 5');
        let hint = `📜 *بایگانی چت کاربران*\n━━━━━━━━━━━━━━━━\nبرای مشاهده بایگانی چت یک کاربر، دستور زیر را بفرستید:\n\`/archive_user_[ID]\`\n\n*کاربران اخیر:*\n`;
        rows.forEach(r => hint += `\`/archive_user_${r.telegram_id}\` - ${r.name || 'نامشخص'} (@${r.username || 'ندارد'})\n`);
        hint += `━━━━━━━━━━━━━━━━`;
        bot.sendMessage(id, hint, { parse_mode: 'Markdown' });
      } else if (text === '↩️ بازگشت به پنل ادمین') {
        delete states[id];
        bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
    }
    
    // مدیریت پیام‌رسانی
    if (state.type === 'admin_broadcast_menu') {
      if (text === '📢 پیام همگانی (همه)') {
        bot.sendMessage(id, '📤 *پیام خود را بنویسید یا رسانه ارسال کنید.*', { parse_mode: 'Markdown', ...backKeyboard() });
        states[id] = { type: 'broadcast', target: 'all' };
      } else if (text === '📩 کاربران عادی') {
        bot.sendMessage(id, '📤 *پیام خود را بنویسید یا رسانه ارسال کنید.*', { parse_mode: 'Markdown', ...backKeyboard() });
        states[id] = { type: 'broadcast', target: 'normal' };
      } else if (text === '💌 کاربران VIP') {
        bot.sendMessage(id, '📤 *پیام خود را بنویسید یا رسانه ارسال کنید.*', { parse_mode: 'Markdown', ...backKeyboard() });
        states[id] = { type: 'broadcast', target: 'vip' };
      } else if (text === '📂 بایگانی') {
        const { rows } = await pool.query('SELECT id, target_type, timestamp FROM broadcast_messages ORDER BY timestamp DESC LIMIT 10');
        let list = '📂 *بایگانی پیام‌ها (حداکثر ۱۰):*\n━━━━━━━━━━━━━━━━\n';
        rows.forEach(r => list += `\`/view_${r.id}\` - هدف: ${r.target_type}, تاریخ: ${moment(r.timestamp).format('jYYYY/jM/jD HH:mm')}\n`);
        list += `━━━━━━━━━━━━━━━━`;
        bot.sendMessage(id, list, { parse_mode: 'Markdown' });
      } else if (text === '↩️ بازگشت به پنل ادمین') {
        delete states[id];
        bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
    }
    
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
      
      bot.sendMessage(id, `📤 *در حال ارسال به ${userIds.length} کاربر...*`, { parse_mode: 'Markdown' });
      const { success, failed } = await sendBroadcast(userIds, msg);
      
      const media_type = msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : msg.animation ? 'animation' : 'text';
      const media_file_id = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id || msg.document?.file_id || msg.animation?.file_id || null;
      
      await pool.query(`
        INSERT INTO broadcast_messages (admin_id, target_type, message_text, media_type, media_file_id, caption, sent_count, failed_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [ADMIN_CHAT_ID, state.target, text, media_type, media_file_id, msg.caption || null, success, failed]);
      
      const report = `📊 *گزارش ارسال*\n━━━━━━━━━━━━━━━━\n✅ *موفق:* ${success}\n❌ *ناموفق:* ${failed}\n📊 *کل:* ${userIds.length}\n🎯 *هدف:* ${state.target === 'all' ? 'همه' : state.target === 'vip' ? 'VIP' : 'عادی'}\n📅 *زمان:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━`;
      
      bot.sendMessage(id, report, { parse_mode: 'Markdown' });
      delete states[id];
      return;
    }
    
    // ویرایش اطلاعات
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
        const fieldNames = {
          'name': 'نام',
          'age': 'سن',
          'city': 'شهر',
          'region': 'منطقه',
          'gender': 'جنسیت',
          'job': 'شغل',
          'goal': 'هدف',
          'phone': 'شماره تماس'
        };
        
        const fieldName = fieldNames[fieldMap[text]];
        const message = `✏️ *ویرایش ${fieldName}*\n━━━━━━━━━━━━━━━━\n*مقدار فعلی:* ${current}\n━━━━━━━━━━━━━━━━\nمقدار جدید را وارد کنید یا /cancel برای لغو.`;
        
        bot.sendMessage(id, message, { parse_mode: 'Markdown' });
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
      
      // دریافت اطلاعات به‌روز شده کاربر
      const { rows: userRows } = await pool.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [id]
      );
      
      if (userRows.length > 0) {
        const user = userRows[0];
        const { rows: usernameRow } = await pool.query(
          'SELECT username FROM users WHERE telegram_id = $1',
          [id]
        );
        const username = usernameRow[0]?.username;
        
        // ارسال گزارش ویرایش به ادمین
        const report = formatUserReport(user, 'ویرایش', username);
        await bot.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
      }
      
      bot.sendMessage(id, '✅ ویرایش شد.', editKeyboard());
      states[id] = { type: 'edit_menu' };
      await addScore(id, 5);
      
      delete states[id];
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (telegram_id) DO UPDATE SET name=$2, age=$3, city=$4, region=$5, gender=$6, job=$7, goal=$8, phone=$9
        `, [id, state.data.name, ageVal, state.data.city, state.data.region, state.data.gender, state.data.job, state.data.goal, state.data.phone]);
        
        // دریافت اطلاعات کامل کاربر برای گزارش
        const { rows: userRows } = await pool.query(
          'SELECT * FROM users WHERE telegram_id = $1',
          [id]
        );
        
        if (userRows.length > 0) {
          const user = userRows[0];
          const { rows: usernameRow } = await pool.query(
            'SELECT username FROM users WHERE telegram_id = $1',
            [id]
          );
          const username = usernameRow[0]?.username;
          
          // ارسال گزارش زیبا به ادمین
          const report = formatUserReport(user, 'ثبت‌نام', username);
          await bot.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
        }
        
        bot.sendMessage(id, '✅ *ثبت‌نام با موفقیت انجام شد!* 🎉', { parse_mode: 'Markdown', ...mainKeyboard(true, admin) });
        await addScore(id, 20);
        
        delete states[id];
        return;
      }
      
      bot.sendMessage(id, questions[state.step]);
      return;
    }
    
    // عضویت VIP
    if (state.type === 'vip_waiting') {
      if (text === '📸 ارسال عکس فیش واریزی') {
        bot.sendMessage(id, '📸 لطفاً عکس فیش واریزی را ارسال کنید.');
        states[id] = { type: 'vip_receipt' };
      } else if (text === '❌ انصراف از عضویت VIP') {
        delete states[id];
        bot.sendMessage(id, '❌ عضویت VIP لغو شد.', mainKeyboard(true, admin));
      }
      return;
    }
    
    if (state.type === 'vip_receipt' && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      
      const report = `📸 *رسید پرداخت VIP*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${id}\n📅 *زمان:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━\n✅ برای تأیید: \`/approve_${id}\`\n❌ برای رد: \`/reject_${id}\``;
      await bot.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
      
      await pool.query(
        'INSERT INTO vips (telegram_id, payment_receipt) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET payment_receipt = $2',
        [id, fileId]
      );
      
      delete states[id];
      bot.sendMessage(id, '✅ *رسید ارسال شد. منتظر تأیید ادمین باشید.*', { parse_mode: 'Markdown', ...mainKeyboard(true, admin) });
      return;
    }
    
    // چت با ادمین
    if (state.type === 'chat_admin') {
      const registered = await isRegistered(id);
      if (!registered && (msg.photo || msg.video || msg.document || msg.animation)) {
        bot.sendMessage(id, '⚠️ برای ارسال رسانه ابتدا ثبت‌نام کنید.');
        return;
      }
      
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      
      const { rows } = await pool.query('SELECT name, username FROM users WHERE telegram_id = $1', [id]);
      const user = rows[0] || {};
      const info = `📩 *پیام جدید از کاربر*\n━━━━━━━━━━━━━━━━\n📛 *نام:* ${user.name || 'نامشخص'}\n🆔 *ID:* ${id}\n👤 *یوزرنیم:* @${user.username || 'ندارد'}\n━━━━━━━━━━━━━━━━\n💬 برای پاسخ: \`/reply_${id}\``;
      
      await bot.sendMessage(ADMIN_CHAT_ID, info, { parse_mode: 'Markdown' });
      bot.sendMessage(id, '✅ *پیام شما با موفقیت ارسال شد.*', { parse_mode: 'Markdown', ...mainKeyboard(true, admin) });
      
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id || msg.document?.file_id || msg.animation?.file_id || null;
      
      await pool.query(`
        INSERT INTO user_messages (telegram_id, message_text, media_type, media_file_id, is_from_user)
        VALUES ($1, $2, $3, $4, TRUE)
      `, [id, msg.caption || text, msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : msg.animation ? 'animation' : 'text', fileId]);
      
      await addScore(id, 5);
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
        bot.sendMessage(id, '⚠️ *تعداد سوالات رایگان شما تمام شده است. برای سوالات نامحدود VIP شوید.*', { parse_mode: 'Markdown', ...mainKeyboard(true, admin) });
        const alert = `⚠️ *کاربر سوالات رایگانش تمام شد*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${id}\n📛 *نام:* ${usedRows[0]?.name || 'نامشخص'}\n🤖 *سوالات استفاده شده:* ${used}\n━━━━━━━━━━━━━━━━`;
        bot.sendMessage(ADMIN_CHAT_ID, alert, { parse_mode: 'Markdown' });
        delete states[id];
        return;
      }
      
      const { rows } = await pool.query('SELECT ai_token, prompt_content FROM settings');
      if (!rows[0]?.ai_token) {
        bot.sendMessage(id, '⚠️ هوش مصنوعی تنظیم نشده است.', mainKeyboard(true, admin));
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
        await pool.query('INSERT INTO ai_chats (telegram_id, user_question, ai_response) VALUES ($1, $2, $3)', [id, text, reply]);
        await addScore(id, 3);
      } catch (err) {
        console.error('❌ خطا در ارتباط با هوش مصنوعی:', err.message);
        bot.sendMessage(id, '❌ خطا در ارتباط با هوش مصنوعی.', mainKeyboard(true, admin));
        delete states[id];
      }
      return;
    }
    
    // تأیید ریست دیتابیس
    if (state.type === 'confirm_reset_db') {
      if (text.startsWith('✅ تأیید ریست دیتابیس')) {
        await pool.query('DROP TABLE IF EXISTS broadcast_messages CASCADE');
        await pool.query('DROP TABLE IF EXISTS ai_chats CASCADE');
        await pool.query('DROP TABLE IF EXISTS user_messages CASCADE');
        await pool.query('DROP TABLE IF EXISTS vips CASCADE');
        await pool.query('DROP TABLE IF EXISTS users CASCADE');
        await pool.query('DROP TABLE IF EXISTS settings CASCADE');
        
        await createTables();
        bot.sendMessage(id, '🔄 *دیتابیس ریست شد.*', { parse_mode: 'Markdown' });
      } else if (text === '❌ لغو') {
        bot.sendMessage(id, '❌ عملیات لغو شد.');
      }
      delete states[id];
      bot.sendMessage(id, '🛡️ *پنل ادمین*', { parse_mode: 'Markdown', ...adminKeyboard() });
      return;
    }
    
    // پاسخ به کاربر
    if (state.type === 'reply_to_user') {
      if (text === '/cancel') {
        delete states[id];
        bot.sendMessage(id, '❌ پاسخ لغو شد.');
        return;
      }
      
      await bot.sendMessage(state.userId, text);
      await pool.query(
        'INSERT INTO user_messages (telegram_id, message_text, is_from_user) VALUES ($1, $2, FALSE)',
        [state.userId, text]
      );
      
      bot.sendMessage(id, '✅ *پاسخ ارسال شد.*', { parse_mode: 'Markdown' });
      delete states[id];
      return;
    }
    
  } catch (err) {
    console.error('❌ خطا در handleState:', err.message);
    bot.sendMessage(id, '❌ خطای داخلی رخ داد. لطفاً دوباره تلاش کنید.');
    delete states[id];
  }
}

// دستورات ویژه ادمین
bot.onText(/\/user_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  
  const { rows: userRows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [uid]);
  const { rows: vipRows } = await pool.query('SELECT * FROM vips WHERE telegram_id = $1', [uid]);
  
  if (userRows.length === 0) {
    bot.sendMessage(msg.chat.id, '❌ کاربر یافت نشد.');
    return;
  }
  
  const user = userRows[0];
  const isVip = vipRows.length > 0;
  const vip = vipRows[0];
  
  let details = `👤 *جزئیات کاربر*\n━━━━━━━━━━━━━━━━\n`;
  details += `🆔 *آیدی:* \`${uid}\`\n`;
  details += `👤 *نام کاربری:* @${user.username || 'ندارد'}\n`;
  details += `📛 *نام:* ${user.name || 'نامشخص'}\n`;
  details += `🎂 *سن:* ${user.age || 'نامشخص'}\n`;
  details += `🏙️ *شهر:* ${user.city || 'نامشخص'}\n`;
  details += `🌍 *منطقه:* ${user.region || 'نامشخص'}\n`;
  details += `⚧️ *جنسیت:* ${user.gender || 'نامشخص'}\n`;
  details += `💼 *شغل:* ${user.job || 'نامشخص'}\n`;
  details += `🎯 *هدف:* ${user.goal || 'نامشخص'}\n`;
  details += `📱 *شماره:* ${user.phone || 'نامشخص'}\n`;
  details += `🤖 *سوالات AI:* ${user.ai_questions_used || 0}\n`;
  details += `⭐ *امتیاز:* ${user.score || 0}\n`;
  details += `📊 *لِوِل:* ${user.level || 1}\n`;
  details += `📅 *تاریخ ثبت‌نام:* ${moment(user.registration_date).format('jYYYY/jM/jD HH:mm')}\n`;
  
  if (isVip) {
    details += `\n💎 *وضعیت VIP:* ✅ فعال\n`;
    details += `   🏁 *شروع:* ${vip.start_date ? moment(vip.start_date).format('jYYYY/jM/jD HH:mm') : 'ندارد'}\n`;
    details += `   🏁 *پایان:* ${vip.end_date ? moment(vip.end_date).format('jYYYY/jM/jD HH:mm') : 'ندارد'}\n`;
    details += `   ✅ *تأیید شده:* ${vip.approved ? 'بله' : 'خیر'}\n`;
  } else {
    details += `\n💎 *وضعیت VIP:* ❌ غیرفعال\n`;
  }
  
  details += `━━━━━━━━━━━━━━━━\n`;
  details += `📝 *دستورات مدیریت:*\n`;
  details += `\`/reply_${uid}\` - پاسخ به کاربر\n`;
  details += `\`/archive_user_${uid}\` - بایگانی چت\n`;
  if (!isVip) {
    details += `\`/approve_${uid}\` - تبدیل به VIP\n`;
  }
  
  bot.sendMessage(msg.chat.id, details, { parse_mode: 'Markdown' });
});

bot.onText(/\/reply_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  
  bot.sendMessage(msg.chat.id, `💬 *پاسخ به کاربر ${uid}*\n━━━━━━━━━━━━━━━━\nپاسخ خود را بنویسید (برای لغو /cancel):`, { parse_mode: 'Markdown' });
  states[msg.chat.id] = { type: 'reply_to_user', userId: uid };
});

bot.onText(/\/archive_user_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  
  const { rows: msgs } = await pool.query(
    'SELECT * FROM user_messages WHERE telegram_id = $1 ORDER BY timestamp DESC LIMIT 50',
    [uid]
  );
  const { rows: ais } = await pool.query(
    'SELECT * FROM ai_chats WHERE telegram_id = $1 ORDER BY timestamp DESC LIMIT 50',
    [uid]
  );
  
  let archive = `📜 *بایگانی کاربر ${uid}*\n━━━━━━━━━━━━━━━━\n`;
  archive += `💬 *چت با کانیا:*\n`;
  msgs.forEach(m => archive += `${m.is_from_user ? '👤 کاربر' : '🛡️ ادمین'} (${moment(m.timestamp).format('jYYYY/jM/jD HH:mm')}): ${m.message_text || '[رسانه]'}\n`);
  
  archive += `\n🤖 *چت با هوش مصنوعی:*\n`;
  ais.forEach(a => archive += `❓ *سوال* (${moment(a.timestamp).format('jYYYY/jM/jD HH:mm')}): ${a.user_question}\n🤖 *پاسخ:* ${a.ai_response}\n━━━━━━━━━━━━━━━━\n`);
  
  bot.sendMessage(msg.chat.id, archive || '📭 هیچ چتی یافت نشد.', { parse_mode: 'Markdown' });
});

bot.onText(/\/approve_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  
  const endDate = moment().add(1, 'month').toDate();
  await pool.query(
    'UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2',
    [endDate, uid]
  );
  
  const { rows } = await pool.query('SELECT vip_channel FROM settings');
  const vipMessage = `🎉 *عضویت VIP شما تأیید شد!*\n━━━━━━━━━━━━━━━━\n📅 *معتبر تا:* ${moment(endDate).format('jYYYY/jM/jD')}\n📢 *کانال VIP:* ${rows[0]?.vip_channel || 'تنظیم نشده'}\n━━━━━━━━━━━━━━━━\nممنون از اعتماد شما! 💎`;
  
  bot.sendMessage(uid, vipMessage, { parse_mode: 'Markdown' });
  
  const approveReport = `✅ *کاربر به VIP تبدیل شد*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${uid}\n📅 *تأیید در:* ${moment().format('jYYYY/jM/jD HH:mm')}\n📅 *پایان عضویت:* ${moment(endDate).format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━`;
  bot.sendMessage(ADMIN_CHAT_ID, approveReport, { parse_mode: 'Markdown' });
  
  logActivity(ADMIN_CHAT_ID, 'تأیید VIP', `کاربر ${uid}`);
});

bot.onText(/\/reject_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  
  await pool.query('UPDATE vips SET approved = FALSE WHERE telegram_id = $1', [uid]);
  
  const rejectMessage = `❌ *رسید پرداخت شما تأیید نشد.*\n━━━━━━━━━━━━━━━━\nلطفاً اطلاعات واریز را بررسی کرده و دوباره تلاش کنید.\nدر صورت مشکل با پشتیبانی تماس بگیرید.\n━━━━━━━━━━━━━━━━`;
  bot.sendMessage(uid, rejectMessage, { parse_mode: 'Markdown' });
  
  const rejectReport = `❌ *رسید کاربر رد شد*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${uid}\n📅 *زمان رد:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━`;
  bot.sendMessage(ADMIN_CHAT_ID, rejectReport, { parse_mode: 'Markdown' });
  
  logActivity(ADMIN_CHAT_ID, 'رد VIP', `کاربر ${uid}`);
});

bot.onText(/\/view_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const bid = parseInt(match[1]);
  
  const { rows } = await pool.query('SELECT * FROM broadcast_messages WHERE id = $1', [bid]);
  if (!rows.length) {
    bot.sendMessage(msg.chat.id, '📭 پیام یافت نشد.');
    return;
  }
  
  const row = rows[0];
  const date = moment(row.timestamp).format('jYYYY/jM/jD HH:mm');
  const target = row.target_type === 'all' ? 'همه' : row.target_type === 'vip' ? 'VIP' : 'عادی';
  const caption = `📋 *جزئیات پیام همگانی*\n━━━━━━━━━━━━━━━━\n🆔 *شناسه:* ${row.id}\n🎯 *هدف:* ${target}\n📅 *تاریخ:* ${date}\n✅ *موفق:* ${row.sent_count} | ❌ *ناموفق:* ${row.failed_count}\n━━━━━━━━━━━━━━━━`;
  
  try {
    if (row.media_type === 'photo') {
      await bot.sendPhoto(msg.chat.id, row.media_file_id, { caption: row.caption || row.message_text, parse_mode: 'Markdown' });
    } else if (row.media_type === 'video') {
      await bot.sendVideo(msg.chat.id, row.media_file_id, { caption: row.caption || row.message_text, parse_mode: 'Markdown' });
    } else if (row.media_type === 'document') {
      await bot.sendDocument(msg.chat.id, row.media_file_id, { caption: row.caption || row.message_text, parse_mode: 'Markdown' });
    } else if (row.media_type === 'animation') {
      await bot.sendAnimation(msg.chat.id, row.media_file_id, { caption: row.caption || row.message_text, parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(msg.chat.id, row.message_text || '(بدون متن)');
    }
    bot.sendMessage(msg.chat.id, caption, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(msg.chat.id, '❌ خطا در نمایش رسانه.');
  }
});

// مدیریت callback query
bot.on('callback_query', async (query) => {
  await bot.answerCallbackQuery(query.id);
});

console.log('✅ KaniaChatBot — نسخه نهایی با تمام اصلاحات اعمال شده 🚀');
