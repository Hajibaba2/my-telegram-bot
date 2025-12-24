// توضیح: کد نهایی کامل server.js - رفع SyntaxError (await در async) + تمام قابلیت‌های قبلی

const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// تنظیمات محیطی
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  user: process.env.DB_USER || process.env.POSTGRES_USER,
  password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD,
  host: process.env.DB_HOST || process.env.POSTGRES_HOST,
  port: process.env.DB_PORT || process.env.POSTGRES_PORT || 5432,
  database: process.env.DB_NAME || process.env.POSTGRES_DB || 'railway',
});

const bot = new TelegramBot(BOT_TOKEN);
let openai = null;

// ذخیره حالت‌های موقت
const states = {};

// ساخت/به‌روزرسانی جدول‌ها
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

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);`).catch(() => {});
    await pool.query(`ALTER TABLE users ADD PRIMARY KEY IF NOT EXISTS (telegram_id);`).catch(() => {});

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
  } catch (error) {
    console.error('خطا در ساخت جدول‌ها:', error.message);
  }
}

// چک VIP
async function isVip(telegramId) {
  const res = await pool.query(
    'SELECT * FROM vips WHERE telegram_id = $1 AND approved = TRUE AND end_date > CURRENT_TIMESTAMP',
    [telegramId]
  );
  return res.rows.length > 0;
}

// Webhook
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  const webhookUrl = `https://${process.env.RAILWAY_STATIC_URL || 'your-domain.com'}/bot${BOT_TOKEN}`;
  await bot.setWebHook(webhookUrl);
  console.log(`Webhook تنظیم شد: ${webhookUrl}`);
  await createTables();
});

// کیبورد اصلی
function mainKeyboard(isRegistered, isAdmin) {
  const keyboard = [
    [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
    [{ text: '💬 چت با ادمین' }, { text: '🤖 چت با هوش مصنوعی' }],
    [{ text: isRegistered ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
  ];
  if (isAdmin) keyboard.push([{ text: '🛡️ پنل ادمین' }]);
  return { reply_markup: { keyboard, resize_keyboard: true } };
}

// کیبورد ادمین
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

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username ? `@${msg.from.username}` : null;

  await pool.query(`
    INSERT INTO users (telegram_id, username) VALUES ($1, $2)
    ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
  `, [chatId, username]);

  const user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [chatId]);
  const isRegistered = user.rows[0]?.name !== null;
  const isAdmin = chatId === ADMIN_CHAT_ID;

  bot.sendMessage(chatId, '🌟 *به ربات KaniaChatBot خوش آمدید!* 🌟\n\nلطفاً از منوی زیر استفاده کنید 👇', { parse_mode: 'Markdown', ...mainKeyboard(isRegistered, isAdmin) });
});

// هندلر پیام‌ها - حتماً async
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const username = msg.from.username ? `@${msg.from.username}` : null;
  const isAdmin = chatId === ADMIN_CHAT_ID;

  if (username) {
    await pool.query(`
      INSERT INTO users (telegram_id, username) VALUES ($1, $2)
      ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
    `, [chatId, username]);
  }

  if (states[chatId]) {
    await handleState(chatId, text, msg);
    return;
  }

  if (text === '📺 کانال رایگان') {
    const s = await pool.query('SELECT free_channel FROM settings');
    const link = s.rows[0]?.free_channel || 'تنظیم نشده ⚠️';
    bot.sendMessage(chatId, `📢 *کانال رایگان ما:*\n${link}`, { parse_mode: 'Markdown' });
  }

  if (text === '💎 عضویت VIP') {
    const s = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const set = s.rows[0];

    if (set?.membership_fee && set?.wallet_address && set?.network) {
      const message = `💎 *عضویت VIP* 💎\n\n` +
        `📌 برای عضویت VIP مبلغ: *${set.membership_fee}* را به کیف پول زیر واریز نمایید\n\n` +
        `💳 آدرس کیف پول (کپی کنید):\n\`${set.wallet_address}\`\n\n` +
        `🌐 شبکه: *${set.network}*\n\n` +
        `✅ پس از واریز، عکس فیش واریزی را ارسال نمایید.`;

      const keyboard = {
        inline_keyboard: [
          [{ text: '📸 ارسال عکس فیش واریزی', callback_data: 'vip_send_receipt' }],
          [{ text: '❌ انصراف', callback_data: 'vip_cancel' }]
        ]
      };

      bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: keyboard });
      states[chatId] = { type: 'vip_waiting' };
    } else {
      bot.sendMessage(chatId, '⚠️ *اطلاعات عضویت VIP توسط ادمین تنظیم نشده است.*', { parse_mode: 'Markdown' });
    }
  }

  if (text === '💬 چت با ادمین') {
    bot.sendMessage(chatId, '💬 *پیام خود را بنویسید.*\nبه زودی ادمین پاسخ خواهد داد 📩', { parse_mode: 'Markdown' });
    states[chatId] = { type: 'chat_admin' };
  }

  if (text === '🤖 چت با هوش مصنوعی') {
    bot.sendMessage(chatId, '🧠 *سوال خود را بپرسید، هوش مصنوعی پاسخ می‌دهد* 🚀', { parse_mode: 'Markdown' });
    states[chatId] = { type: 'ai_chat' };
  }

  if (text === '📝 ثبت‌نام' || text === '✏️ ویرایش اطلاعات') {
    states[chatId] = { type: 'register', step: 0, data: { username } };
    const user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [chatId]);
    if (user.rows.length > 0) states[chatId].data = { ...user.rows[0], username };
    bot.sendMessage(chatId, '📝 *نام خود را وارد کنید:*', { parse_mode: 'Markdown' });
  }

  if (isAdmin) {
    if (text === '🛡️ پنل ادمین') {
      bot.sendMessage(chatId, '🛡️ *پنل ادمین فعال شد* 👑', { parse_mode: 'Markdown', ...adminKeyboard() });
    }

    if (text === '🤖 هوش مصنوعی') {
      bot.sendMessage(chatId, '🔑 *توکن OpenAI را وارد کنید:*', { parse_mode: 'Markdown' });
      states[chatId] = { type: 'set_ai_token' };
    }

    if (text === '📺 کانال‌ها') {
      const k = [
        [{ text: 'لینک کانال رایگان' }, { text: 'لینک کانال VIP' }],
        [{ text: 'مبلغ عضویت' }, { text: 'آدرس کیف پول' }, { text: 'شبکه انتقال' }],
        [{ text: '↩️ بازگشت' }]
      ];
      bot.sendMessage(chatId, '⚙️ *تنظیمات کانال‌ها و VIP:*', { parse_mode: 'Markdown', reply_markup: { keyboard: k, resize_keyboard: true } });
    }

    if (text === 'لینک کانال رایگان') {
      states[chatId] = { type: 'set_free_channel' };
      bot.sendMessage(chatId, '🔗 *لینک جدید کانال رایگان را ارسال کنید:*', { parse_mode: 'Markdown' });
    }
    if (text === 'لینک کانال VIP') {
      states[chatId] = { type: 'set_vip_channel' };
      bot.sendMessage(chatId, '🔗 *لینک جدید کانال VIP را ارسال کنید:*', { parse_mode: 'Markdown' });
    }
    if (text === 'مبلغ عضویت') {
      states[chatId] = { type: 'set_fee' };
      bot.sendMessage(chatId, '💰 *مبلغ جدید عضویت را وارد کنید:*', { parse_mode: 'Markdown' });
    }
    if (text === 'آدرس کیف پول') {
      states[chatId] = { type: 'set_wallet' };
      bot.sendMessage(chatId, '💳 *آدرس جدید کیف پول را وارد کنید:*', { parse_mode: 'Markdown' });
    }
    if (text === 'شبکه انتقال') {
      states[chatId] = { type: 'set_network' };
      bot.sendMessage(chatId, '🌐 *شبکه انتقال را وارد کنید:*', { parse_mode: 'Markdown' });
    }

    if (text === '👥 کاربران') {
      const u = await pool.query('SELECT COUNT(*) FROM users');
      const v = await pool.query('SELECT COUNT(*) FROM vips WHERE approved = TRUE');
      bot.sendMessage(chatId, `👥 *آمار کاربران:*\n\nعادی: ${u.rows[0].count}\nVIP: ${v.rows[0].count}`, { parse_mode: 'Markdown' });
    }

    if (text === '📊 آمار') {
      const s = await pool.query('SELECT COUNT(*) as total, SUM(ai_questions_used) as used FROM users');
      bot.sendMessage(chatId, `📊 *آمار کلی:*\n\nکل کاربران: ${s.rows[0].total}\nسوالات AI استفاده شده: ${s.rows[0].used || 0}`, { parse_mode: 'Markdown' });
    }

    if (text === '🔄 ریست دیتابیس') {
      await resetDatabase();
      bot.sendMessage(chatId, '🔄 *دیتابیس ریست شد.*', { parse_mode: 'Markdown' });
    }

    if (text === '📨 پیامرسانی') {
      const k = [
        [{ text: '📢 پیام همگانی (همه کاربران)' }],
        [{ text: '📩 پیام به کاربران عادی' }],
        [{ text: '💌 پیام به کاربران VIP' }],
        [{ text: '📂 بایگانی پیام‌های همگانی' }],
        [{ text: '↩️ بازگشت' }]
      ];
      bot.sendMessage(chatId, '📨 *عملیات پیامرسانی:*', { parse_mode: 'Markdown', reply_markup: { keyboard: k, resize_keyboard: true } });
    }

    if (text === '📢 پیام همگانی (همه کاربران)' || text === '📩 پیام به کاربران عادی' || text === '💌 پیام به کاربران VIP') {
      let target = 'all';
      if (text.includes('عادی')) target = 'normal';
      if (text.includes('VIP')) target = 'vip';
      states[chatId] = { type: 'broadcast', target };
      bot.sendMessage(chatId, '📤 *پیام خود را ارسال کنید (متن، عکس، ویدیو...)*\nلغو: /cancel', { parse_mode: 'Markdown' });
    }

    // بایگانی پیام‌های همگانی
    if (text === '📂 بایگانی پیام‌های همگانی') {
      const arch = await pool.query(`SELECT id, target_type, timestamp, sent_count, failed_count FROM broadcast_messages ORDER BY timestamp DESC LIMIT 20`);
      if (arch.rows.length === 0) {
        bot.sendMessage(chatId, '📂 *بایگانی خالی است.*', { parse_mode: 'Markdown' });
        return;
      }
      let msgText = '📂 *بایگانی پیام‌های همگانی (آخرین ۲۰)*:\n\n';
      for (const r of arch.rows) {
        const date = moment(r.timestamp).format('jYYYY/jM/jD - HH:mm');
        const target = r.target_type === 'all' ? 'همه' : r.target_type === 'vip' ? 'VIP' : 'عادی';
        msgText += `${r.id}. ${target} | ${date}\n   ✅${r.sent_count} ❌${r.failed_count}\n   /view_${r.id}\n\n`;
      }
      bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
  }
});

// هندلر callback_query - async
bot.on('callback_query', async (callback) => {
  const chatId = callback.message.chat.id;
  const data = callback.data;

  if (data === 'vip_send_receipt') {
    await bot.answerCallbackQuery(callback.id);
    await bot.sendMessage(chatId, '📸 *لطفاً عکس فیش واریزی را ارسال کنید*', { parse_mode: 'Markdown' });
    states[chatId] = { type: 'vip_receipt' };
  }

  if (data === 'vip_cancel') {
    await bot.answerCallbackQuery(callback.id);
    await bot.sendMessage(chatId, '❌ *عضویت VIP لغو شد.*\nبه منوی اصلی بازگشتید.', { parse_mode: 'Markdown', ...mainKeyboard(true, chatId === ADMIN_CHAT_ID) });
    await bot.sendMessage(ADMIN_CHAT_ID, `⚠️ کاربر ${chatId} از عضویت VIP انصراف داد.`);
    delete states[chatId];
  }
});

// مدیریت حالت‌ها
async function handleState(chatId, text, msg) {
  const state = states[chatId];
  const isAdmin = chatId === ADMIN_CHAT_ID;

  if (state.type === 'register') {
    const fields = ['name', 'age', 'city', 'region', 'gender', 'job', 'goal', 'phone'];
    const labels = ['نام', 'سن', 'شهر', 'منطقه', 'جنسیت', 'شغل', 'هدف', 'شماره تماس'];

    if (state.step === undefined) state.step = 0;

    state.data[fields[state.step]] = text.trim();
    state.step++;

    if (state.step >= fields.length) {
      try {
        await pool.query(`
          INSERT INTO users (telegram_id, username, name, age, city, region, gender, job, goal, phone)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (telegram_id) DO UPDATE SET
          username=EXCLUDED.username, name=EXCLUDED.name, age=EXCLUDED.age, city=EXCLUDED.city,
          region=EXCLUDED.region, gender=EXCLUDED.gender, job=EXCLUDED.job, goal=EXCLUDED.goal, phone=EXCLUDED.phone
        `, [chatId, state.data.username || null, state.data.name, parseInt(state.data.age) || null,
            state.data.city, state.data.region, state.data.gender, state.data.job, state.data.goal, state.data.phone]);

        bot.sendMessage(chatId, '✅ *ثبت‌نام/ویرایش با موفقیت انجام شد!*\n\nحالا می‌توانید از امکانات استفاده کنید 🎉', { parse_mode: 'Markdown', ...mainKeyboard(true, isAdmin) });
      } catch (error) {
        console.error('خطا در ذخیره کاربر:', error);
        bot.sendMessage(chatId, '❌ خطا در ذخیره اطلاعات. دوباره تلاش کنید.');
      }
      delete states[chatId];
      return;
    }

    bot.sendMessage(chatId, `*${labels[state.step]} خود را وارد کنید:*`, { parse_mode: 'Markdown' });
    return;
  }

  // رسید VIP
  if (state.type === 'vip_receipt' && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await bot.forwardMessage(ADMIN_CHAT_ID, chatId, msg.message_id);
    await bot.sendMessage(ADMIN_CHAT_ID, `📸 رسید از کاربر ${chatId}\n/approve_${chatId} یا /reject_${chatId}`);
    await pool.query('INSERT INTO vips (telegram_id, payment_receipt) VALUES ($1,$2) ON CONFLICT DO NOTHING', [chatId, fileId]);
    bot.sendMessage(chatId, '✅ *رسید ارسال شد. منتظر تأیید ادمین باشید.*', { parse_mode: 'Markdown' });
    delete states[chatId];
    return;
  }

  // چت با ادمین
  if (state.type === 'chat_admin') {
    await bot.forwardMessage(ADMIN_CHAT_ID, chatId, msg.message_id);
    bot.sendMessage(chatId, '✅ *پیام شما به ادمین ارسال شد.*', { parse_mode: 'Markdown' });
    delete states[chatId];
    return;
  }

  // چت AI
  if (state.type === 'ai_chat') {
    const vip = await isVip(chatId);
    const u = await pool.query('SELECT ai_questions_used FROM users WHERE telegram_id = $1', [chatId]);
    if (!vip && (u.rows[0]?.ai_questions_used || 0) >= 5) {
      bot.sendMessage(chatId, '⚠️ *سوالات رایگان تمام شد. برای نامحدود VIP شوید.*', { parse_mode: 'Markdown' });
      delete states[chatId];
      return;
    }
    const s = await pool.query('SELECT ai_token FROM settings');
    if (s.rows[0]?.ai_token) {
      if (!openai) openai = new OpenAI({ apiKey: s.rows[0].ai_token });
      try {
        const res = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: text }],
        });
        bot.sendMessage(chatId, res.choices[0].message.content);
        await pool.query('UPDATE users SET ai_questions_used = ai_questions_used + 1 WHERE telegram_id = $1', [chatId]);
      } catch (e) {
        bot.sendMessage(chatId, '❌ خطا در ارتباط با هوش مصنوعی.');
      }
    } else {
      bot.sendMessage(chatId, '⚠️ هوش مصنوعی هنوز تنظیم نشده است.');
    }
    return;
  }

  // پیام همگانی
  if (state.type === 'broadcast' && !text.startsWith('/')) {
    let query = 'SELECT telegram_id FROM users';
    if (state.target === 'normal') {
      query = `SELECT u.telegram_id FROM users u LEFT JOIN vips v ON u.telegram_id = v.telegram_id AND v.approved AND v.end_date > NOW() WHERE v.telegram_id IS NULL`;
    } else if (state.target === 'vip') {
      query = `SELECT u.telegram_id FROM users u INNER JOIN vips v ON u.telegram_id = v.telegram_id WHERE v.approved AND v.end_date > NOW()`;
    }
    const users = await pool.query(query);
    const userIds = users.rows.map(r => r.telegram_id);

    let success = 0, failed = 0;
    bot.sendMessage(chatId, `📤 ارسال به ${userIds.length} کاربر شروع شد...`);

    for (const uid of userIds) {
      try {
        if (msg.photo) await bot.sendPhoto(uid, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption });
        else if (msg.video) await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption });
        else if (msg.document) await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption });
        else await bot.sendMessage(uid, text);
        success++;
      } catch (e) { failed++; }
      await new Promise(r => setTimeout(r, 50));
    }

    let media_type = 'text', media_file_id = null, caption = msg.caption || null;
    if (msg.photo) { media_type = 'photo'; media_file_id = msg.photo[msg.photo.length - 1].file_id; }
    else if (msg.video) { media_type = 'video'; media_file_id = msg.video.file_id; }
    else if (msg.document) { media_type = 'document'; media_file_id = msg.document.file_id; }

    await pool.query(`
      INSERT INTO broadcast_messages (admin_id, target_type, message_text, media_type, media_file_id, caption, sent_count, failed_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [ADMIN_CHAT_ID, state.target, text, media_type, media_file_id, caption, success, failed]);

    bot.sendMessage(chatId, `📊 *گزارش ارسال:*\nموفق: ${success}\nناموفق: ${failed}\nکل: ${userIds.length}`, { parse_mode: 'Markdown' });
    delete states[chatId];
    return;
  }

  // تنظیمات ادمین
  if (isAdmin) {
    if (state.type === 'set_ai_token') {
      await pool.query('UPDATE settings SET ai_token = $1', [text]);
      openai = new OpenAI({ apiKey: text });
      bot.sendMessage(chatId, '✅ *توکن هوش مصنوعی ذخیره شد.*', { parse_mode: 'Markdown' });
      delete states[chatId];
    }

    if (state.type?.startsWith('set_')) {
      let field;
      if (state.type === 'set_free_channel') field = 'free_channel';
      else if (state.type === 'set_vip_channel') field = 'vip_channel';
      else if (state.type === 'set_fee') field = 'membership_fee';
      else if (state.type === 'set_wallet') field = 'wallet_address';
      else if (state.type === 'set_network') field = 'network';

      await pool.query(`UPDATE settings SET ${field} = $1`, [text]);
      bot.sendMessage(chatId, '✅ *تنظیمات ذخیره شد.*', { parse_mode: 'Markdown' });
      delete states[chatId];
    }
  }

  if (text === '/cancel') {
    delete states[chatId];
    bot.sendMessage(chatId, '❌ *عملیات لغو شد.*', { parse_mode: 'Markdown' });
  }
}

// تأیید/رد VIP
bot.onText(/\/approve_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  const end = moment().add(1, 'month').toDate();
  await pool.query('UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2', [end, uid]);
  const s = await pool.query('SELECT vip_channel FROM settings');
  bot.sendMessage(uid, `🎉 *عضویت VIP شما تأیید شد!*\n\nتا ${moment(end).format('jYYYY/jM/jD')} معتبر است.\nکانال VIP: ${s.rows[0]?.vip_channel || 'تنظیم نشده'}`, { parse_mode: 'Markdown' });
  bot.sendMessage(ADMIN_CHAT_ID, `✅ کاربر ${uid} VIP شد.`);
});

bot.onText(/\/reject_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  await pool.query('UPDATE vips SET approved = FALSE WHERE telegram_id = $1', [uid]);
  bot.sendMessage(uid, '❌ *متأسفانه رسید شما تأیید نشد.*\nلطفاً دوباره تلاش کنید.', { parse_mode: 'Markdown' });
  bot.sendMessage(ADMIN_CHAT_ID, `❌ رسید کاربر ${uid} رد شد.`);
});

// مشاهده بایگانی
bot.onText(/\/view_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const id = match[1];
  const row = (await pool.query('SELECT * FROM broadcast_messages WHERE id = $1', [id])).rows[0];
  if (!row) return bot.sendMessage(chatId, '❌ پیام یافت نشد.');

  const date = moment(row.timestamp).format('jYYYY/jM/jD - HH:mm');
  const target = row.target_type === 'all' ? 'همه' : row.target_type === 'vip' ? 'VIP' : 'عادی';
  const caption = `📋 *جزئیات پیام همگانی*\nشناسه: ${row.id}\nهدف: ${target}\nتاریخ: ${date}\nموفق: ${row.sent_count}\nناموفق: ${row.failed_count}`;

  try {
    if (row.media_type === 'photo') await bot.sendPhoto(chatId, row.media_file_id, { caption: row.caption || row.message_text });
    else if (row.media_type === 'video') await bot.sendVideo(chatId, row.media_file_id, { caption: row.caption || row.message_text });
    else if (row.media_type === 'document') await bot.sendDocument(chatId, row.media_file_id, { caption: row.caption || row.message_text });
    else await bot.sendMessage(chatId, row.message_text || '(بدون متن)');
    bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, '❌ خطا در نمایش رسانه.');
  }
});

// ریست دیتابیس
async function resetDatabase() {
  await pool.query('DROP TABLE IF EXISTS broadcast_messages, vips, users, settings CASCADE;');
  await createTables();
}

console.log('KaniaChatBot آماده اجرا!');
