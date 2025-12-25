// server.js - کد نهایی کامل، مستقل و بهینه (بدون نیاز به کد قبلی)
// تمام قابلیت‌ها: ثبت‌نام، ویرایش با منو، VIP با دکمه inline، پنل ادمین کامل، بایگانی، پیام همگانی
// رفع تمام خطاها (SQL، Markdown، await، NaN)

const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// هندلر callback_query برای دکمه‌های VIP - حتماً async باشد
bot.on('callback_query', async (callback) => {
  const chatId = callback.message.chat.id;
  const data = callback.data;


// متغیرهای محیطی
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;

// اتصال به دیتابیس
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const bot = new TelegramBot(BOT_TOKEN);
let openai = null;

const states = {}; // حالت‌های موقت کاربران

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

// چک VIP
async function isVip(id) {
  const { rows } = await pool.query(
    'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved AND end_date > NOW()',
    [id]
  );
  return rows.length > 0;
}

// Webhook
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  const url = `https://${process.env.RAILWAY_STATIC_URL || 'your-app.up.railway.app'}/bot${BOT_TOKEN}`;
  await bot.setWebHook(url);
  console.log(`Webhook: ${url}`);
  await createTables();
});

// کیبوردهای اصلی
function mainKeyboard(reg, admin) {
  const k = [
    [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
    [{ text: '💬 چت با ادمین' }, { text: '🤖 چت با هوش مصنوعی' }],
    [{ text: reg ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
  ];
  if (admin) k.push([{ text: '🛡️ پنل ادمین' }]);
  return { reply_markup: { keyboard: k, resize_keyboard: true } };
}

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

function editKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '👤 نام' }, { text: '🎂 سن' }],
        [{ text: '🏙️ شهر' }, { text: '🌍 منطقه' }],
        [{ text: '⚧️ جنسیت' }, { text: '💼 شغل' }],
        [{ text: '🎯 هدف' }, { text: '📱 شماره تماس' }],
        [{ text: '↩️ بازگشت به منو اصلی' }]
      ],
      resize_keyboard: true
    }
  };
}

// /start
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  const user = msg.from.username ? `@${msg.from.username}` : null;

  await pool.query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
    [id, user]
  );

  const { rows } = await pool.query('SELECT name FROM users WHERE telegram_id = $1', [id]);
  const reg = rows[0]?.name != null;
  const admin = id === ADMIN_CHAT_ID;

  bot.sendMessage(id, '🌟 به ربات KaniaChatBot خوش آمدید! 🌟\n\nلطفاً از منوی زیر استفاده کنید 👇', mainKeyboard(reg, admin));
});

// هندلر پیام‌ها
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text || '';
  const user = msg.from.username ? `@${msg.from.username}` : null;
  const admin = id === ADMIN_CHAT_ID;

  if (user) {
    await pool.query(
      `INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
      [id, user]
    );
  }

  if (states[id]) {
    await handleState(id, text, msg);
    return;
  }

  if (text === '📺 کانال رایگان') {
    const { rows } = await pool.query('SELECT free_channel FROM settings');
    bot.sendMessage(id, `📢 کانال رایگان:\n${rows[0]?.free_channel || 'تنظیم نشده ⚠️'}`);
  }

  if (text === '💎 عضویت VIP') {
    const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const s = rows[0];
    if (s?.membership_fee && s?.wallet_address && s?.network) {
      const msgText = `💎 عضویت VIP 💎\n\n` +
        `📌 مبلغ: ${s.membership_fee}\n\n` +
        `💳 آدرس کیف پول (کپی کنید):\n${s.wallet_address}\n\n` +
        `🌐 شبکه: ${s.network}\n\n` +
        `✅ پس از واریز، عکس فیش را ارسال کنید.`;

      bot.sendMessage(id, msgText, {
        reply_markup: {
  inline_keyboard: [
    [{ text: '📸 ارسال عکس فیش', callback_data: 'vip_receipt' }],
    [{ text: '❌ انصراف', callback_data: 'vip_cancel' }]
  ]
}
       
        }
      });

  
      states[id] = { type: 'vip_waiting' };
    } else {
      bot.sendMessage(id, '⚠️ اطلاعات VIP تنظیم نشده است.');
    }
  }

  if (text === '💬 چت با ادمین') {
    bot.sendMessage(id, '💬 پیام خود را بنویسید.');
    states[id] = { type: 'chat_admin' };
  }

  if (text === '🤖 چت با هوش مصنوعی') {
    bot.sendMessage(id, '🧠 سوال خود را بپرسید.');
    states[id] = { type: 'ai_chat' };
  }

  if (text === '📝 ثبت‌نام' || text === '✏️ ویرایش اطلاعات') {
    const { rows } = await pool.query('SELECT name FROM users WHERE telegram_id = $1', [id]);
    const registered = rows.length > 0 && rows[0].name;

    if (!registered) {
      states[id] = { type: 'register_full', step: 0, data: { username: user } };
      bot.sendMessage(id, '📝 ثبت‌نام جدید\n\n👤 نام خود را وارد کنید:');
    } else {
      bot.sendMessage(id, '✏️ کدام فیلد را می‌خواهید ویرایش کنید؟', editKeyboard());
      states[id] = { type: 'edit_menu' };
    }
  }

  if (admin) {
    if (text === '🛡️ پنل ادمین') {
      bot.sendMessage(id, '🛡️ پنل ادمین فعال شد', adminKeyboard());
    }

    if (text === '🤖 هوش مصنوعی') {
      bot.sendMessage(id, '🔑 توکن OpenAI را وارد کنید:');
      states[id] = { type: 'set_ai_token' };
    }

    if (text === '📺 کانال‌ها') {
      bot.sendMessage(id, '⚙️ تنظیمات کانال‌ها و VIP:', {
        reply_markup: {
          keyboard: [
            [{ text: 'لینک کانال رایگان' }, { text: 'لینک کانال VIP' }],
            [{ text: 'مبلغ عضویت' }, { text: 'آدرس کیف پول' }, { text: 'شبکه انتقال' }],
            [{ text: '↩️ بازگشت' }]
          ],
          resize_keyboard: true
        }
      });
    }

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

    if (text === '👥 کاربران') {
      const u = await pool.query('SELECT COUNT(*) FROM users');
      const v = await pool.query('SELECT COUNT(*) FROM vips WHERE approved');
      bot.sendMessage(id, `👥 کاربران:\nعادی: ${u.rows[0].count}\nVIP: ${v.rows[0].count}`);
    }

    if (text === '📊 آمار') {
      const s = await pool.query('SELECT COUNT(*) AS total, SUM(ai_questions_used) AS used FROM users');
      bot.sendMessage(id, `📊 آمار:\nکل کاربران: ${s.rows[0].total}\nسوالات AI: ${s.rows[0].used || 0}`);
    }

    if (text === '🔄 ریست دیتابیس') {
      await pool.query('DROP TABLE IF EXISTS broadcast_messages, vips, users, settings CASCADE;');
      await createTables();
      bot.sendMessage(id, '🔄 دیتابیس ریست شد.');
    }

    if (text === '📨 پیامرسانی') {
      bot.sendMessage(id, '📨 پیامرسانی:', {
        reply_markup: {
          keyboard: [
            [{ text: '📢 پیام همگانی (همه)' }],
            [{ text: '📩 کاربران عادی' }],
            [{ text: '💌 کاربران VIP' }],
            [{ text: '📂 بایگانی' }],
            [{ text: '↩️ بازگشت' }]
          ],
          resize_keyboard: true
        }
      });
    }

    if (text.startsWith('📢') || text.startsWith('📩') || text.startsWith('💌')) {
      const target = text.includes('عادی') ? 'normal' : text.includes('VIP') ? 'vip' : 'all';
      states[id] = { type: 'broadcast', target };
      bot.sendMessage(id, '📤 پیام را ارسال کنید\n/cancel برای لغو');
    }

    if (text === '📂 بایگانی') {
      const { rows } = await pool.query('SELECT id, target_type, timestamp, sent_count, failed_count FROM broadcast_messages ORDER BY timestamp DESC LIMIT 20');
      if (!rows.length) return bot.sendMessage(id, 'بایگانی خالی است.');
      let t = '📂 بایگانی (۲۰ آخر):\n\n';
      rows.forEach(r => {
        const d = moment(r.timestamp).format('jYYYY/jM/jD HH:mm');
        const tg = r.target_type === 'all' ? 'همه' : r.target_type === 'vip' ? 'VIP' : 'عادی';
        t += `${r.id}. ${tg} | ${d}\n✅${r.sent_count} ❌${r.failed_count}\n/view_${r.id}\n\n`;
      });
      bot.sendMessage(id, t);
    }
  }
});


// مدیریت حالت‌ها
async function handleState(id, text, msg) {
  const state = states[id];
  const admin = id === ADMIN_CHAT_ID;

  // منوی ویرایش
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

    if (text === '↩️ بازگشت به منو اصلی') {
      delete states[id];
      bot.sendMessage(id, '↩️ بازگشت به منوی اصلی', mainKeyboard(true, admin));
      return;
    }

    if (fieldMap[text]) {
      states[id] = { type: 'edit_field', field: fieldMap[text], label: text };
      bot.sendMessage(id, `مقدار جدید برای ${text} را وارد کنید:`);
      return;
    }
    return;
  }

  // ویرایش تک فیلد
  if (state.type === 'edit_field') {
    const field = state.field;
    const value = field === 'age' ? (isNaN(parseInt(text)) ? null : parseInt(text)) : text.trim() || null;

    await pool.query(`UPDATE users SET ${field} = $1 WHERE telegram_id = $2`, [value, id]);
    bot.sendMessage(id, `✅ ${state.label} بروزرسانی شد!`);

    bot.sendMessage(id, 'فیلد دیگری انتخاب کنید یا بازگشت بزنید:', editKeyboard());
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

    if (state.step == null) state.step = 0;

    state.data[fields[state.step]] = text.trim();
    state.step++;

    if (state.step >= questions.length) {
      const ageVal = isNaN(parseInt(state.data.age)) ? null : parseInt(state.data.age);

      await pool.query(`
        INSERT INTO users (telegram_id, username, name, age, city, region, gender, job, goal, phone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (telegram_id) DO UPDATE SET
        name=EXCLUDED.name, age=EXCLUDED.age, city=EXCLUDED.city, region=EXCLUDED.region,
        gender=EXCLUDED.gender, job=EXCLUDED.job, goal=EXCLUDED.goal, phone=EXCLUDED.phone
      `, [id, state.data.username || null, state.data.name, ageVal, state.data.city,
          state.data.region, state.data.gender, state.data.job, state.data.goal, state.data.phone]);

      bot.sendMessage(id, '✅ ثبت‌نام با موفقیت انجام شد! 🎉', mainKeyboard(true, admin));
      delete states[id];
      return;
    }

    bot.sendMessage(id, questions[state.step]);
    return;
  }

  // رسید VIP
  if (state.type === 'vip_receipt' && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
    await bot.sendMessage(ADMIN_CHAT_ID, `📸 رسید از کاربر ${id}\n/approve_${id} یا /reject_${id}`);
    await pool.query('INSERT INTO vips (telegram_id, payment_receipt) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, fileId]);
    bot.sendMessage(id, '✅ رسید ارسال شد. منتظر تأیید باشید.');
    delete states[id];
    return;
  }

  // چت با ادمین
  if (state.type === 'chat_admin') {
    await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
    bot.sendMessage(id, '✅ پیام ارسال شد.');
    delete states[id];
    return;
  }

  // چت AI
  if (state.type === 'ai_chat') {
    const vip = await isVip(id);
    const u = await pool.query('SELECT ai_questions_used FROM users WHERE telegram_id = $1', [id]);
    if (!vip && (u.rows[0]?.ai_questions_used || 0) >= 5) {
      bot.sendMessage(id, '⚠️ سوالات رایگان تمام شد. VIP شوید.');
      delete states[id];
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
        bot.sendMessage(id, res.choices[0].message.content);
        await pool.query('UPDATE users SET ai_questions_used = ai_questions_used + 1 WHERE telegram_id = $1', [id]);
      } catch (e) {
        bot.sendMessage(id, '❌ خطا در هوش مصنوعی.');
      }
    } else {
      bot.sendMessage(id, '⚠️ هوش مصنوعی تنظیم نشده.');
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
    const { rows } = await pool.query(query);
    const userIds = rows.map(r => r.telegram_id);

    let success = 0, failed = 0;
    bot.sendMessage(id, `📤 ارسال به ${userIds.length} کاربر...`);

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

    bot.sendMessage(id, `📊 گزارش:\nموفق: ${success}\nناموفق: ${failed}\nکل: ${userIds.length}`);
    delete states[id];
    return;
  }

  // تنظیمات ادمین
  if (admin && state.type?.startsWith('set_')) {
    let field;
    if (state.type === 'set_ai_token') field = 'ai_token';
    else if (state.type === 'set_free_channel') field = 'free_channel';
    else if (state.type === 'set_vip_channel') field = 'vip_channel';
    else if (state.type === 'set_membership_fee') field = 'membership_fee';
    else if (state.type === 'set_wallet_address') field = 'wallet_address';
    else if (state.type === 'set_network') field = 'network';

    await pool.query(`UPDATE settings SET ${field} = $1`, [text]);
    bot.sendMessage(id, '✅ تنظیمات ذخیره شد.');
    if (state.type === 'set_ai_token') openai = new OpenAI({ apiKey: text });
    delete states[id];
    return;
  }

  if (text === '/cancel') {
    delete states[id];
    bot.sendMessage(id, '❌ عملیات لغو شد.');
  }
}

// تأیید/رد VIP
bot.onText(/\/approve_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  const end = moment().add(1, 'month').toDate();
  await pool.query('UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2', [end, uid]);
  const { rows } = await pool.query('SELECT vip_channel FROM settings');
  bot.sendMessage(uid, `🎉 عضویت VIP تأیید شد!\nتا ${moment(end).format('jYYYY/jM/jD')} معتبر است.\nکانال VIP: ${rows[0]?.vip_channel || 'تنظیم نشده'}`);
  bot.sendMessage(ADMIN_CHAT_ID, `✅ کاربر ${uid} VIP شد.`);
});

bot.onText(/\/reject_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  await pool.query('UPDATE vips SET approved = FALSE WHERE telegram_id = $1', [uid]);
  bot.sendMessage(uid, '❌ رسید تأیید نشد. دوباره تلاش کنید.');
  bot.sendMessage(ADMIN_CHAT_ID, `❌ رسید کاربر ${uid} رد شد.`);
});

// مشاهده بایگانی
bot.onText(/\/view_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const pid = match[1];
  const { rows } = await pool.query('SELECT * FROM broadcast_messages WHERE id = $1', [pid]);
  if (rows.length === 0) return bot.sendMessage(id, 'پیام یافت نشد.');

  const row = rows[0];
  const date = moment(row.timestamp).format('jYYYY/jM/jD - HH:mm');
  const target = row.target_type === 'all' ? 'همه' : row.target_type === 'vip' ? 'VIP' : 'عادی';
  const caption = `📋 جزئیات\nشناسه: ${row.id}\nهدف: ${target}\nتاریخ: ${date}\nموفق: ${row.sent_count}\nناموفق: ${row.failed_count}`;

  try {
    if (row.media_type === 'photo') await bot.sendPhoto(id, row.media_file_id, { caption: row.caption || row.message_text });
    else if (row.media_type === 'video') await bot.sendVideo(id, row.media_file_id, { caption: row.caption || row.message_text });
    else if (row.media_type === 'document') await bot.sendDocument(id, row.media_file_id, { caption: row.caption || row.message_text });
    else await bot.sendMessage(id, row.message_text || '(بدون متن)');
    bot.sendMessage(id, caption);
  } catch (e) {
    bot.sendMessage(id, 'خطا در نمایش رسانه.');
  }
});

try {
    // همیشه answerCallbackQuery را فراخوانی کن تا دکمه "لودینگ" تمام شود
    await bot.answerCallbackQuery(callback.id);

    if (data === 'vip_receipt') {
      bot.sendMessage(chatId, '📸 لطفاً عکس فیش واریزی را ارسال کنید.');
      states[chatId] = { type: 'vip_receipt' };
    } else if (data === 'vip_cancel') {
      bot.sendMessage(chatId, '❌ عضویت VIP لغو شد.\nبه منوی اصلی بازگشتید.', mainKeyboard(true, chatId === ADMIN_CHAT_ID));
      bot.sendMessage(ADMIN_CHAT_ID, `⚠️ کاربر ${chatId} از عضویت VIP انصراف داد.`);
      delete states[chatId];
    }
  } catch (error) {
    console.error('خطا در callback_query:', error.message);
    await bot.answerCallbackQuery(callback.id, { text: 'خطایی رخ داد!', show_alert: true });
  }
});




// ... بقیه کد
console.log('KaniaChatBot آماده!');

// Keep Alive برای Railway
const appUrl = `https://${process.env.RAILWAY_STATIC_URL || 'my-telegram-bot-production-5f5e.up.railway.app'}`;
setInterval(() => {
  fetch(appUrl).catch(() => {});
}, 300000); // هر ۵ دقیقه پینگ به خود اپ

console.log('Keep Alive فعال شد.');
