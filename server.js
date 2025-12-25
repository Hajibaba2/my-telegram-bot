const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const { OpenAI } = require('openai');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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

// ساخت جدول‌ها
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
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
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
        prompt_content TEXT,
        free_channel TEXT,
        vip_channel TEXT,
        membership_fee VARCHAR(100),
        wallet_address TEXT,
        network TEXT
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
    console.log('جدول‌ها آماده شدند.');
  } catch (err) {
    console.error('خطا در ساخت جدول‌ها:', err.message);
  }
}

// توابع کمکی
async function isVip(id) {
  const { rows } = await pool.query(
    'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved AND end_date > NOW()',
    [id]
  );
  return rows.length > 0;
}

async function isRegistered(id) {
  const { rows } = await pool.query('SELECT name FROM users WHERE telegram_id = $1', [id]);
  return rows.length > 0 && rows[0].name != null;
}

async function downloadFile(fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  return await res.text();
}

// Webhook و استارت
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
  if (!domain) {
    console.error('دامنه Railway پیدا نشد!');
    bot.startPolling();
    console.log('ربات در حالت polling شروع شد.');
    await createTables();
    return;
  }
  const url = `https://${domain}/bot${BOT_TOKEN}`;
  try {
    await bot.setWebHook(url);
    console.log(`Webhook تنظیم شد: ${url}`);
  } catch (err) {
    console.error('خطا در تنظیم webhook:', err.message);
    bot.startPolling();
  }
  await createTables();
});

// کیبوردهای اصلی
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
  const k = [
    [{ text: '🤖 هوش مصنوعی' }, { text: '📺 کانال‌ها' }],
    [{ text: '👥 کاربران' }, { text: '📨 پیامرسانی' }],
    [{ text: '📊 آمار' }, { text: '🔄 ریست دیتابیس' }],
    [{ text: '↩️ بازگشت به منو اصلی' }],
  ];
  return createReplyKeyboard(k);
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
  const user = msg.from.username ? `@${msg.from.username}` : null;
  await pool.query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
    [id, user]
  );
  const registered = await isRegistered(id);
  const admin = id === ADMIN_CHAT_ID;
  bot.sendMessage(id, '🌟 به ربات KaniaChatBot خوش آمدید! 🌟\n\nلطفاً از منوی زیر استفاده کنید 👇', mainKeyboard(registered, admin));
});

// هندلر پیام‌ها
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

  // منوی کاربر
  if (text === '📺 کانال رایگان') {
    const { rows } = await pool.query('SELECT free_channel FROM settings');
    bot.sendMessage(id, `📢 کانال رایگان:\n${rows[0]?.free_channel || 'تنظیم نشده ⚠️'}`);
  }

  if (text === '💎 عضویت VIP') {
    const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const s = rows[0];
    if (s?.membership_fee && s?.wallet_address && s?.network) {
      const msgText = `💎 عضویت VIP 💎\n\nمبلغ: ${s.membership_fee}\n\nآدرس کیف پول:\n${s.wallet_address}\n\nشبکه: ${s.network}\n\nپس از واریز، عکس فیش را ارسال کنید.`;
      bot.sendMessage(id, msgText, vipKeyboard());
      states[id] = { type: 'vip_waiting' };
    } else {
      bot.sendMessage(id, '⚠️ اطلاعات VIP تنظیم نشده است.');
    }
  }

  if (text === '💬 ارسال پیام به کانیا') {
    bot.sendMessage(id, '💬 پیام خود را بنویسید (متن، عکس، ویدیو، فایل).');
    states[id] = { type: 'chat_admin' };
  }

  if (text === '🤖 چت با هوش مصنوعی') {
    const { rows } = await pool.query('SELECT ai_token FROM settings');
    if (!rows[0]?.ai_token) {
      bot.sendMessage(id, '⚠️ هوش مصنوعی تنظیم نشده است.');
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
      bot.sendMessage(id, '✏️ کدام فیلد را ویرایش کنید؟', editKeyboard());
      states[id] = { type: 'edit_menu' };
    }
  }

  // پنل ادمین
  if (admin) {
    if (text === '🛡️ پنل ادمین') {
      bot.sendMessage(id, '🛡️ پنل ادمین', adminKeyboard());
    }

    if (text === '🤖 هوش مصنوعی') {
      bot.sendMessage(id, '🤖 مدیریت هوش مصنوعی:', aiAdminKeyboard());
      states[id] = { type: 'admin_ai_menu' };
    }

    if (text === '📺 کانال‌ها') {
      bot.sendMessage(id, '⚙️ تنظیمات کانال‌ها:', channelsKeyboard());
      states[id] = { type: 'admin_channels_menu' };
    }

    if (text === '👥 کاربران') {
      bot.sendMessage(id, '👥 مدیریت کاربران:', usersKeyboard());
      states[id] = { type: 'admin_users_menu' };
    }

    if (text === '📨 پیامرسانی') {
      bot.sendMessage(id, '📨 پیامرسانی:', broadcastKeyboard());
      states[id] = { type: 'admin_broadcast_menu' };
    }

    // تنظیمات AI
    if (text === '⚙️ تنظیم توکن API') {
      bot.sendMessage(id, '🔑 توکن OpenAI را وارد کنید:');
      states[id] = { type: 'set_ai_token' };
    }
    if (text === '📂 ارسال فایل پرامپت') {
      bot.sendMessage(id, '📂 فایل پرامپت (.txt) ارسال کنید:');
      states[id] = { type: 'upload_prompt' };
    }
    if (text === '👀 مشاهده پرامپت') {
      const { rows } = await pool.query('SELECT prompt_content FROM settings');
      bot.sendMessage(id, `👀 پرامپت فعلی:\n\n${rows[0]?.prompt_content || 'تنظیم نشده'}`);
    }
    if (text === '🗑️ حذف پرامپت') {
      await pool.query('UPDATE settings SET prompt_content = NULL');
      bot.sendMessage(id, '🗑️ پرامپت حذف شد.');
    }

    // تنظیمات کانال
    if (['لینک کانال رایگان', 'لینک کانال VIP', 'مبلغ عضویت', 'آدرس کیف پول', 'شبکه انتقال'].includes(text)) {
      const map = {
        'لینک کانال رایگان': 'free_channel',
        'لینک کانال VIP': 'vip_channel',
        'مبلغ عضویت': 'membership_fee',
        'آدرس کیف پول': 'wallet_address',
        'شبکه انتقال': 'network'
      };
      states[id] = { type: 'set_' + map[text] };
      bot.sendMessage(id, `مقدار جدید برای ${text} را وارد کنید:`);
    }

    // کاربران
    if (text === '📊 آمار کاربران') {
      const total = await pool.query('SELECT COUNT(*) FROM users');
      const vip = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
      const normal = parseInt(total.rows[0].count) - parseInt(vip.rows[0].count);
      bot.sendMessage(id, `👥 آمار کاربران:\nعادی: ${normal}\nVIP: ${vip.rows[0].count}\nکل: ${total.rows[0].count}`);
    }

    if (text === '👤 لیست کاربران عادی') {
      const { rows } = await pool.query(`
        SELECT u.telegram_id, u.username, u.name FROM users u
        LEFT JOIN vips v ON u.telegram_id = v.telegram_id AND v.approved AND v.end_date > NOW()
        WHERE v.telegram_id IS NULL ORDER BY u.registration_date DESC LIMIT 20
      `);
      let list = rows.length ? '👤 کاربران عادی (۲۰ اخیر):\n\n' : 'هیچ کاربری یافت نشد.';
      rows.forEach(r => list += `ID: ${r.telegram_id}\nنام: ${r.name || 'ندارد'}\nیوزرنیم: ${r.username || 'ندارد'}\n\n`);
      bot.sendMessage(id, list);
    }

    if (text === '💎 لیست کاربران VIP') {
      const { rows } = await pool.query(`
        SELECT u.telegram_id, u.username, u.name, v.end_date FROM users u
        JOIN vips v ON u.telegram_id = v.telegram_id
        WHERE v.approved AND v.end_date > NOW() ORDER BY v.start_date DESC LIMIT 20
      `);
      let list = rows.length ? '💎 کاربران VIP (۲۰ اخیر):\n\n' : 'هیچ VIP یافت نشد.';
      rows.forEach(r => {
        const end = moment(r.end_date).format('jYYYY/jM/jD');
        list += `ID: ${r.telegram_id}\nنام: ${r.name || 'ندارد'}\nیوزرنیم: ${r.username || 'ندارد'}\nپایان: ${end}\n\n`;
      });
      bot.sendMessage(id, list);
    }

    if (text === '📊 آمار') {
      const { rows } = await pool.query('SELECT COUNT(*) AS total, SUM(ai_questions_used) AS used FROM users');
      bot.sendMessage(id, `📊 آمار کلی:\nکاربران: ${rows[0].total}\nسوالات AI: ${rows[0].used || 0}`);
    }

    if (text === '🔄 ریست دیتابیس') {
      const tables = ['users', 'vips', 'settings', 'broadcast_messages'];
      states[id] = { type: 'reset_db', tables, step: 0 };
      bot.sendMessage(id, '⚠️ ریست دیتابیس — تمام داده‌ها حذف می‌شوند!\nجدول اول: users', createReplyKeyboard([
        [{ text: '✅ تأیید پاکسازی' }],
        [{ text: '❌ لغو' }]
      ], { one_time: true }));
    }

    if (text.startsWith('📢') || text.startsWith('📩') || text.startsWith('💌')) {
      const target = text.includes('عادی') ? 'normal' : text.includes('VIP') ? 'vip' : 'all';
      states[id] = { type: 'broadcast', target };
      bot.sendMessage(id, '📤 پیام را ارسال کنید (/cancel برای لغو)');
    }

    if (text === '📂 بایگانی') {
      const { rows } = await pool.query('SELECT id, target_type, timestamp, sent_count, failed_count FROM broadcast_messages ORDER BY timestamp DESC LIMIT 20');
      if (!rows.length) return bot.sendMessage(id, 'بایگانی خالی است.');
      let msg = '📂 بایگانی پیام‌ها (۲۰ آخر):\n\n';
      rows.forEach(r => {
        const date = moment(r.timestamp).format('jYYYY/jM/jD HH:mm');
        const target = r.target_type === 'all' ? 'همه' : r.target_type === 'vip' ? 'VIP' : 'عادی';
        msg += `${r.id}. ${target} — ${date}\n✅ ${r.sent_count} ❌ ${r.failed_count}\n/view_${r.id}\n\n`;
      });
      bot.sendMessage(id, msg);
    }

    // بازگشت‌ها
    if (text.includes('↩️ بازگشت به پنل ادمین') || text === '↩️ بازگشت') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
    }
    if (text === '↩️ بازگشت به منو اصلی') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به منوی اصلی', mainKeyboard(true, true));
    }
  }

  // VIP waiting
  if (states[id]?.type === 'vip_waiting') {
    if (text === '📸 ارسال عکس فیش واریزی') {
      bot.sendMessage(id, '📸 عکس فیش واریزی را ارسال کنید.');
      states[id] = { type: 'vip_receipt' };
    }
    if (text === '❌ انصراف از عضویت VIP') {
      delete states[id];
      bot.sendMessage(id, '❌ انصراف ثبت شد.', mainKeyboard(true, admin));
      bot.sendMessage(ADMIN_CHAT_ID, `⚠️ کاربر ${id} از VIP انصراف داد.`);
    }
  }
});

// مدیریت stateها
async function handleState(id, text, msg) {
  const state = states[id];
  const admin = id === ADMIN_CHAT_ID;
  const registered = await isRegistered(id);

  // ویرایش منو
  if (state.type === 'edit_menu') {
    const fields = {
      '👤 نام': 'name', '🎂 سن': 'age', '🏙️ شهر': 'city', '🌍 منطقه': 'region',
      '⚧️ جنسیت': 'gender', '💼 شغل': 'job', '🎯 هدف': 'goal', '📱 شماره تماس': 'phone'
    };
    if (text === '↩️ بازگشت به منو اصلی') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت', mainKeyboard(true, admin));
      return;
    }
    if (fields[text]) {
      states[id] = { type: 'edit_field', field: fields[text], label: text };
      bot.sendMessage(id, `مقدار جدید ${text}:`);
      return;
    }
  }

  if (state.type === 'edit_field') {
    const value = state.field === 'age' ? parseInt(text) || null : text.trim() || null;
    await pool.query(`UPDATE users SET ${state.field} = $1 WHERE telegram_id = $2`, [value, id]);
    bot.sendMessage(id, `✅ ${state.label} بروز شد.`, editKeyboard());
    states[id] = { type: 'edit_menu' };
    return;
  }

  // ثبت‌نام کامل
  if (state.type === 'register_full') {
    const questions = ['👤 نام:', '🎂 سن:', '🏙️ شهر:', '🌍 منطقه:', '⚧️ جنسیت:', '💼 شغل:', '🎯 هدف:', '📱 شماره تماس:'];
    const fields = ['name', 'age', 'city', 'region', 'gender', 'job', 'goal', 'phone'];
    state.data[fields[state.step]] = text.trim();
    state.step++;
    if (state.step >= questions.length) {
      const age = parseInt(state.data.age) || null;
      await pool.query(`
        INSERT INTO users (telegram_id, name, age, city, region, gender, job, goal, phone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (telegram_id) DO UPDATE SET
        name=EXCLUDED.name, age=EXCLUDED.age, city=EXCLUDED.city, region=EXCLUDED.region,
        gender=EXCLUDED.gender, job=EXCLUDED.job, goal=EXCLUDED.goal, phone=EXCLUDED.phone
      `, [id, state.data.name, age, state.data.city, state.data.region, state.data.gender, state.data.job, state.data.goal, state.data.phone]);
      delete states[id];
      bot.sendMessage(id, '✅ ثبت‌نام کامل شد! 🎉', mainKeyboard(true, admin));
      return;
    }
    bot.sendMessage(id, questions[state.step]);
  }

  // رسید VIP
  if (state.type === 'vip_receipt' && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
    bot.sendMessage(ADMIN_CHAT_ID, `📸 رسید از ${id}\n/approve_${id} یا /reject_${id}`);
    await pool.query('INSERT INTO vips (telegram_id, payment_receipt) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, fileId]);
    delete states[id];
    bot.sendMessage(id, '✅ رسید ارسال شد. منتظر تأیید باشید.', mainKeyboard(true, admin));
    return;
  }

  // چت با ادمین
  if (state.type === 'chat_admin') {
    if (!registered && (msg.photo || msg.video || msg.document || msg.animation)) {
      bot.sendMessage(id, '⚠️ برای ارسال رسانه ابتدا ثبت‌نام کنید.');
      return;
    }
    try {
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      const { rows } = await pool.query('SELECT name, username FROM users WHERE telegram_id = $1', [id]);
      const user = rows[0] || {};
      const info = `📩 پیام کاربر\nنام: ${user.name || 'نامشخص'}\nID: ${id}\nیوزرنیم: ${user.username || 'ندارد'}`;
      await bot.sendMessage(ADMIN_CHAT_ID, info, {
        reply_markup: { inline_keyboard: [[{ text: 'پاسخ به کاربر', callback_data: `reply_${id}` }]] }
      });
      bot.sendMessage(id, '✅ پیام ارسال شد.', mainKeyboard(true, admin));
    } catch {
      bot.sendMessage(id, '❌ خطا در ارسال. دوباره سعی کنید.', mainKeyboard(true, admin));
    }
    delete states[id];
  }

  // چت AI
  if (state.type === 'ai_chat') {
    if (text === '↩️ بازگشت') {
      delete states[id];
      bot.sendMessage(id, '↩️ چت بسته شد.', mainKeyboard(true, admin));
      return;
    }
    const vip = await isVip(id);
    const used = (await pool.query('SELECT ai_questions_used FROM users WHERE telegram_id = $1', [id])).rows[0]?.ai_questions_used || 0;
    if (!vip && used >= 5) {
      bot.sendMessage(id, '⚠️ سوالات رایگان تمام شد. VIP شوید.', mainKeyboard(true, admin));
      delete states[id];
      return;
    }
    const { rows } = await pool.query('SELECT ai_token, prompt_content FROM settings');
    if (!rows[0]?.ai_token) {
      bot.sendMessage(id, '⚠️ هوش مصنوعی تنظیم نشده.', mainKeyboard(true, admin));
      delete states[id];
      return;
    }
    if (!openai) openai = new OpenAI({ apiKey: rows[0].ai_token });
    const messages = rows[0].prompt_content ? [{ role: 'system', content: rows[0].prompt_content }] : [];
    messages.push({ role: 'user', content: text });
    try {
      const res = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', messages });
      bot.sendMessage(id, res.choices[0].message.content || 'پاسخی دریافت نشد.', backKeyboard());
      await pool.query('UPDATE users SET ai_questions_used = ai_questions_used + 1 WHERE telegram_id = $1', [id]);
    } catch (e) {
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      const user = (await pool.query('SELECT name, username FROM users WHERE telegram_id = $1', [id])).rows[0] || {};
      await bot.sendMessage(ADMIN_CHAT_ID, `🚨 خطا در AI\nنام: ${user.name || 'نامشخص'}\nID: ${id}\nیوزرنیم: ${user.username || 'ندارد'}`, {
        reply_markup: { inline_keyboard: [[{ text: 'پاسخ به کاربر', callback_data: `reply_${id}` }]] }
      });
      bot.sendMessage(id, '❌ خطا در AI. پیام به ادمین ارسال شد.', mainKeyboard(true, admin));
      delete states[id];
    }
  }

  // پیام همگانی
  if (state.type === 'broadcast' && !text.startsWith('/')) {
    let query = 'SELECT telegram_id FROM users';
    if (state.target === 'normal') query = `SELECT u.telegram_id FROM users u LEFT JOIN vips v ON u.telegram_id = v.telegram_id AND v.approved AND v.end_date > NOW() WHERE v.telegram_id IS NULL`;
    if (state.target === 'vip') query = `SELECT u.telegram_id FROM users u JOIN vips v ON u.telegram_id = v.telegram_id WHERE v.approved AND v.end_date > NOW()`;
    const { rows } = await pool.query(query);
    const ids = rows.map(r => r.telegram_id);
    let success = 0, failed = 0;
    bot.sendMessage(id, `📤 در حال ارسال به ${ids.length} کاربر...`);
    for (const uid of ids) {
      try {
        if (msg.photo) await bot.sendPhoto(uid, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption });
        else if (msg.video) await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption });
        else if (msg.document) await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption });
        else await bot.sendMessage(uid, text);
        success++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 50));
    }
    const media_type = msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : 'text';
    const media_file_id = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id || msg.document?.file_id || null;
    await pool.query(`
      INSERT INTO broadcast_messages (admin_id, target_type, message_text, media_type, media_file_id, caption, sent_count, failed_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [ADMIN_CHAT_ID, state.target, text, media_type, media_file_id, msg.caption, success, failed]);
    bot.sendMessage(id, `📊 نتیجه:\nموفق: ${success}\nناموفق: ${failed}`);
    delete states[id];
  }

  // تنظیمات ادمین
  if (admin && state.type?.startsWith('set_')) {
    const field = state.type.replace('set_', '');
    await pool.query(`UPDATE settings SET ${field} = $1`, [text]);
    bot.sendMessage(id, '✅ ذخیره شد.');
    if (field === 'ai_token') openai = new OpenAI({ apiKey: text });
    delete states[id];
    bot.sendMessage(id, '↩️ بازگشت به پنل', adminKeyboard());
  }

  // آپلود پرامپت
  if (state.type === 'upload_prompt' && msg.document?.file_name.endsWith('.txt')) {
    const content = await downloadFile(msg.document.file_id);
    await pool.query('UPDATE settings SET prompt_content = $1', [content]);
    bot.sendMessage(id, '✅ پرامپت ذخیره شد.');
    delete states[id];
    bot.sendMessage(id, '↩️ بازگشت', adminKeyboard());
  }

  // ریست دیتابیس
  if (state.type === 'reset_db') {
    if (text === '✅ تأیید پاکسازی') {
      await pool.query(`DROP TABLE IF EXISTS ${state.tables[state.step]} CASCADE`);
      state.step++;
      if (state.step >= state.tables.length) {
        await createTables();
        bot.sendMessage(id, '🔄 دیتابیس ریست شد.');
        delete states[id];
      } else {
        bot.sendMessage(id, `⚠️ پاکسازی ${state.tables[state.step]}؟`, createReplyKeyboard([
          [{ text: '✅ تأیید پاکسازی' }], [{ text: '❌ لغو' }]
        ], { one_time: true }));
      }
    } else if (text === '❌ لغو') {
      delete states[id];
      bot.sendMessage(id, '❌ لغو شد.');
    }
  }

  // پاسخ به کاربر
  if (state.type === 'reply_to_user') {
    try {
      await bot.sendMessage(state.userId, text);
      bot.sendMessage(id, '✅ پاسخ ارسال شد.');
    } catch {
      bot.sendMessage(id, '❌ خطا در ارسال.');
    }
    delete states[id];
  }

  if (text === '/cancel') {
    delete states[id];
    bot.sendMessage(id, '❌ لغو شد.');
  }
}

// تأیید/رد VIP
bot.onText(/\/approve_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  const end = moment().add(1, 'month').toDate();
  await pool.query('UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2', [end, uid]);
  const { rows } = await pool.query('SELECT vip_channel FROM settings');
  bot.sendMessage(uid, `🎉 VIP تأیید شد!\nتا ${moment(end).format('jYYYY/jM/jD')}\nکانال: ${rows[0]?.vip_channel || 'تنظیم نشده'}`);
  bot.sendMessage(ADMIN_CHAT_ID, `✅ کاربر ${uid} VIP شد.`);
});

bot.onText(/\/reject_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  await pool.query('UPDATE vips SET approved = FALSE WHERE telegram_id = $1', [uid]);
  bot.sendMessage(uid, '❌ رسید تأیید نشد.');
  bot.sendMessage(ADMIN_CHAT_ID, `❌ رسید ${uid} رد شد.`);
});

bot.onText(/\/view_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const row = (await pool.query('SELECT * FROM broadcast_messages WHERE id = $1', [match[1]])).rows[0];
  if (!row) return bot.sendMessage(msg.chat.id, 'یافت نشد.');
  const caption = `📋 شناسه: ${row.id}\nهدف: ${row.target_type}\nتاریخ: ${moment(row.timestamp).format('jYYYY/jM/jD HH:mm')}\nموفق: ${row.sent_count} | ناموفق: ${row.failed_count}`;
  if (row.media_type === 'photo') await bot.sendPhoto(msg.chat.id, row.media_file_id, { caption: row.caption || row.message_text });
  else if (row.media_type === 'video') await bot.sendVideo(msg.chat.id, row.media_file_id, { caption: row.caption || row.message_text });
  else if (row.media_type === 'document') await bot.sendDocument(msg.chat.id, row.media_file_id, { caption: row.caption || row.message_text });
  else await bot.sendMessage(msg.chat.id, row.message_text);
  bot.sendMessage(msg.chat.id, caption);
});

// پاسخ inline به کاربر
bot.on('callback_query', async (query) => {
  if (query.message.chat.id !== ADMIN_CHAT_ID) return;
  if (query.data.startsWith('reply_')) {
    const userId = parseInt(query.data.split('_')[1]);
    states[ADMIN_CHAT_ID] = { type: 'reply_to_user', userId };
    bot.sendMessage(ADMIN_CHAT_ID, `📝 پاسخ به کاربر ${userId}:`);
    bot.answerCallbackQuery(query.id);
  }
});

// Keep Alive
const appUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || 'fallback.up.railway.app'}`;
setInterval(() => fetch(appUrl).catch(() => {}), 300000);

console.log('KaniaChatBot آماده است! 🚀');
