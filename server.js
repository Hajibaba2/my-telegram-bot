// توضیح: واردات ماژول‌ها - Telegram Bot، PostgreSQL، تاریخ شمسی، Express برای Webhook و OpenAI (اختیاری برای AI واقعی)
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const { OpenAI } = require('openai'); // npm install openai اگر می‌خواهید AI واقعی استفاده کنید

const app = express();
app.use(express.json());

// توضیح: تنظیم متغیرهای محیطی
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
});

const bot = new TelegramBot(BOT_TOKEN);
let openai = null;

// توضیح: حالت‌های موقت کاربران (ثبت‌نام، VIP، تنظیمات ادمین و ...)
const states = {};

// توضیح: ساخت جدول‌های لازم
async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      name VARCHAR(255), age INTEGER, city VARCHAR(255), region VARCHAR(255),
      gender VARCHAR(50), job VARCHAR(255), goal TEXT, phone VARCHAR(50),
      ai_questions_used INTEGER DEFAULT 0,
      registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vips (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
      start_date TIMESTAMP, end_date TIMESTAMP,
      payment_receipt TEXT, approved BOOLEAN DEFAULT FALSE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      ai_token TEXT,
      free_channel TEXT, vip_channel TEXT,
      membership_fee VARCHAR(100), wallet_address TEXT, network TEXT
    );
    INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;
  `);
  console.log('جدول‌ها آماده شدند.');
}

// توضیح: ریست کامل دیتابیس (حذف و بازسازی جدول‌ها)
async function resetDatabase() {
  await pool.query('DROP TABLE IF EXISTS vips, users, settings CASCADE;');
  await createTables();
  bot.sendMessage(ADMIN_CHAT_ID, 'دیتابیس ریست شد و جدول‌ها بازسازی شدند.');
}

// توضیح: چک وضعیت VIP کاربر
async function isVip(telegramId) {
  const res = await pool.query(
    'SELECT * FROM vips WHERE telegram_id = $1 AND approved = TRUE AND end_date > CURRENT_TIMESTAMP',
    [telegramId]
  );
  return res.rows.length > 0;
}

// توضیح: تنظیم Webhook و راه‌اندازی سرور
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  const webhookUrl = `https://${process.env.RAILWAY_STATIC_URL || process.env.HEROKU_APP_NAME || 'your-domain.com'}/bot${BOT_TOKEN}`;
  await bot.setWebHook(webhookUrl);
  console.log(`Webhook تنظیم شد: ${webhookUrl}`);
  await createTables();
});

// توضیح: منوی اصلی کاربر
function mainKeyboard(isRegistered, isAdmin) {
  const keyboard = [
    [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
    [{ text: '💬 چت با ادمین' }, { text: '🤖 چت با هوش مصنوعی' }],
    [{ text: isRegistered ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
  ];
  if (isAdmin) keyboard.push([{ text: '🛡️ پنل ادمین' }]);
  return { reply_markup: { keyboard, resize_keyboard: true } };
}

// توضیح: منوی ادمین
function adminKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '🤖 هوش مصنوعی' }, { text: '📺 کانال‌ها' }],
        [{ text: '👥 کاربران' }, { text: '📨 پیامرسانی' }],
        [{ text: '📊 آمار' }, { text: '🔄 ریست دیتابیس' }],
        [{ text: '↩️ بازگشت به منو اصلی' }],
      ],
      resize_keyboard: true,
    },
  };
}

// توضیح: هندلر /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [chatId]);
  const isRegistered = user.rows.length > 0;
  const isAdmin = chatId === ADMIN_CHAT_ID;

  bot.sendMessage(chatId, 'به KaniaChatBot خوش آمدید! 🎉', mainKeyboard(isRegistered, isAdmin));
});

// توضیح: هندلر پیام‌های متنی اصلی
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const isAdmin = chatId === ADMIN_CHAT_ID;

  // حالت‌های موقت (ثبت‌نام، تنظیمات ادمین و ...)
  if (states[chatId]) {
    await handleState(chatId, text, msg);
    return;
  }

  // منوی کاربر عادی
  if (text === '📺 کانال رایگان') {
    const settings = await pool.query('SELECT free_channel FROM settings');
    const link = settings.rows[0]?.free_channel || 'تنظیم نشده';
    bot.sendMessage(chatId, `کانال رایگان: ${link}`);
  }

  if (text === '💎 عضویت VIP') {
    const settings = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const s = settings.rows[0];
    if (s && s.membership_fee) {
      bot.sendMessage(chatId, `💎 عضویت VIP\nمبلغ: ${s.membership_fee}\nکیف پول: ${s.wallet_address}\nشبکه: ${s.network}\n\nرسید پرداخت را ارسال کنید.`);
      states[chatId] = { type: 'vip_receipt' };
    } else {
      bot.sendMessage(chatId, 'اطلاعات VIP هنوز تنظیم نشده.');
    }
  }

  if (text === '💬 چت با ادمین') {
    bot.sendMessage(chatId, 'پیام خود را بنویسید، به ادمین ارسال می‌شود.');
    states[chatId] = { type: 'chat_admin' };
  }

  if (text === '🤖 چت با هوش مصنوعی') {
    bot.sendMessage(chatId, 'سوال خود را بپرسید:');
    states[chatId] = { type: 'ai_chat' };
  }

  if (text === '📝 ثبت‌نام' || text === '✏️ ویرایش اطلاعات') {
    states[chatId] = { type: 'register', step: 0, data: {} };
    const user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [chatId]);
    if (user.rows.length > 0) states[chatId].data = user.rows[0];
    bot.sendMessage(chatId, 'نام خود را وارد کنید:');
  }

  // پنل ادمین
  if (isAdmin && text === '🛡️ پنل ادمین') {
    bot.sendMessage(chatId, 'پنل ادمین فعال شد.', adminKeyboard());
  }

  // زیرمنوهای ادمین
  if (isAdmin) {
    if (text === '🤖 هوش مصنوعی') {
      bot.sendMessage(chatId, 'توکن API هوش مصنوعی (OpenAI) را وارد کنید:');
      states[chatId] = { type: 'set_ai_token' };
    }
    if (text === '📺 کانال‌ها') {
      const keyboard = [
        [{ text: 'لینک کانال رایگان' }, { text: 'لینک کانال VIP' }],
        [{ text: 'مبلغ عضویت' }, { text: 'آدرس کیف پول' }, { text: 'شبکه انتقال' }],
        [{ text: '↩️ بازگشت' }],
      ];
      bot.sendMessage(chatId, 'تنظیمات کانال‌ها:', { reply_markup: { keyboard, resize_keyboard: true } });
    }
    if (text === '👥 کاربران') {
      const users = await pool.query('SELECT COUNT(*) FROM users');
      const vips = await pool.query('SELECT COUNT(*) FROM vips WHERE approved = TRUE');
      bot.sendMessage(chatId, `کاربران عادی: ${users.rows[0].count}\nکاربران VIP: ${vips.rows[0].count}`);
    }
    if (text === '📊 آمار') {
      const stats = await pool.query('SELECT COUNT(*) as total, SUM(ai_questions_used) as ai_used FROM users');
      bot.sendMessage(chatId, `کل کاربران: ${stats.rows[0].total}\nسوالات AI استفاده شده: ${stats.rows[0].ai_used || 0}`);
    }
    if (text === '🔄 ریست دیتابیس') {
      await resetDatabase();
    }
    if (text === '↩️ بازگشت به منو اصلی' || text === '↩️ بازگشت') {
      delete states[chatId];
      bot.sendMessage(chatId, 'بازگشت به منو اصلی.', mainKeyboard(true, true));
    }
  }
});

// توضیح: مدیریت حالت‌های موقت (ثبت‌نام، VIP، چت، تنظیمات ادمین)
async function handleState(chatId, text, msg) {
  const state = states[chatId];
  const isAdmin = chatId === ADMIN_CHAT_ID;

  if (state.type === 'register') {
    const fields = ['name', 'age', 'city', 'region', 'gender', 'job', 'goal', 'phone'];
    if (state.step < fields.length) {
      state.data[fields[state.step]] = text;
      state.step++;
      if (state.step < fields.length) {
        const labels = ['نام', 'سن', 'شهر', 'منطقه', 'جنسیت', 'شغل', 'هدف', 'شماره تماس'];
        bot.sendMessage(chatId, `${labels[state.step]} خود را وارد کنید:`);
      } else {
        await pool.query(`
          INSERT INTO users (telegram_id, name, age, city, region, gender, job, goal, phone)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (telegram_id) DO UPDATE SET
          name=EXCLUDED.name, age=EXCLUDED.age, city=EXCLUDED.city, region=EXCLUDED.region,
          gender=EXCLUDED.gender, job=EXCLUDED.job, goal=EXCLUDED.goal, phone=EXCLUDED.phone
        `, [chatId, state.data.name, state.data.age, state.data.city, state.data.region,
            state.data.gender, state.data.job, state.data.goal, state.data.phone]);
        bot.sendMessage(chatId, 'اطلاعات با موفقیت ذخیره شد! ✅');
        delete states[chatId];
      }
    }
  }

  if (state.type === 'vip_receipt' && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await bot.forwardMessage(ADMIN_CHAT_ID, chatId, msg.message_id);
    bot.sendMessage(ADMIN_CHAT_ID, `رسید VIP از کاربر ${chatId} - /approve_${chatId} یا /reject_${chatId}`);
    await pool.query('INSERT INTO vips (telegram_id, payment_receipt) VALUES ($1, $2) ON CONFLICT DO NOTHING', [chatId, fileId]);
    bot.sendMessage(chatId, 'رسید ارسال شد. منتظر تأیید ادمین باشید.');
    delete states[chatId];
  }

  if (state.type === 'chat_admin') {
    await bot.forwardMessage(ADMIN_CHAT_ID, chatId, msg.message_id);
    bot.sendMessage(chatId, 'پیام شما به ادمین ارسال شد.');
    delete states[chatId];
  }

  if (state.type === 'ai_chat') {
    const vip = await isVip(chatId);
    const user = await pool.query('SELECT ai_questions_used FROM users WHERE telegram_id = $1', [chatId]);
    if (!vip && (user.rows[0]?.ai_questions_used || 0) >= 5) {
      bot.sendMessage(chatId, 'سوالات رایگان تمام شد. برای نامحدود VIP شوید.');
      delete states[chatId];
      return;
    }

    const settings = await pool.query('SELECT ai_token FROM settings');
    if (settings.rows[0]?.ai_token) {
      if (!openai) openai = new OpenAI({ apiKey: settings.rows[0].ai_token });
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: text }],
        });
        bot.sendMessage(chatId, completion.choices[0].message.content);
        await pool.query('UPDATE users SET ai_questions_used = ai_questions_used + 1 WHERE telegram_id = $1', [chatId]);
      } catch (e) {
        bot.sendMessage(chatId, 'خطا در ارتباط با AI.');
      }
    } else {
      bot.sendMessage(chatId, 'AI هنوز تنظیم نشده.');
    }
  }

  // تنظیمات ادمین
  if (isAdmin) {
    if (state.type === 'set_ai_token') {
      await pool.query('UPDATE settings SET ai_token = $1', [text]);
      openai = new OpenAI({ apiKey: text });
      bot.sendMessage(chatId, 'توکن AI ذخیره شد.');
      delete states[chatId];
    }
    // تنظیم لینک‌ها و اطلاعات VIP
    if (text === 'لینک کانال رایگان') { states[chatId] = { type: 'set_free_channel' }; bot.sendMessage(chatId, 'لینک را وارد کنید:'); }
    if (text === 'لینک کانال VIP') { states[chatId] = { type: 'set_vip_channel' }; bot.sendMessage(chatId, 'لینک را وارد کنید:'); }
    if (text === 'مبلغ عضویت') { states[chatId] = { type: 'set_fee' }; bot.sendMessage(chatId, 'مبلغ را وارد کنید:'); }
    if (text === 'آدرس کیف پول') { states[chatId] = { type: 'set_wallet' }; bot.sendMessage(chatId, 'آدرس را وارد کنید:'); }
    if (text === 'شبکه انتقال') { states[chatId] = { type: 'set_network' }; bot.sendMessage(chatId, 'شبکه را وارد کنید:'); }

    if (state.type?.startsWith('set_')) {
      const field = state.type.replace('set_', '');
      const map = { free_channel: 'free_channel', vip_channel: 'vip_channel', fee: 'membership_fee', wallet: 'wallet_address', network: 'network' };
      await pool.query(`UPDATE settings SET ${map[field]} = $1`, [text]);
      bot.sendMessage(chatId, `${field} ذخیره شد.`);
      delete states[chatId];
    }
  }
});

// توضیح: دستورات تأیید/رد VIP توسط ادمین
bot.onText(/\/approve_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const userId = match[1];
  const endDate = moment().add(1, 'month').toDate();
  await pool.query('UPDATE vips SET approved = TRUE, start_date = CURRENT_TIMESTAMP, end_date = $1 WHERE telegram_id = $2', [endDate, userId]);
  const settings = await pool.query('SELECT vip_channel FROM settings');
  bot.sendMessage(userId, `عضویت VIP تأیید شد! تا ${moment(endDate).format('jYYYY/jM/jD')} معتبر است.\nکانال VIP: ${settings.rows[0]?.vip_channel || ''}`);
  bot.sendMessage(ADMIN_CHAT_ID, `کاربر ${userId} VIP شد.`);
});

bot.onText(/\/reject_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const userId = match[1];
  await pool.query('UPDATE vips SET approved = FALSE WHERE telegram_id = $1', [userId]);
  bot.sendMessage(userId, 'رسید پرداخت تأیید نشد. دوباره تلاش کنید.');
  bot.sendMessage(ADMIN_CHAT_ID, `رسید کاربر ${userId} رد شد.`);
});

console.log('ربات با Webhook آماده است!');
