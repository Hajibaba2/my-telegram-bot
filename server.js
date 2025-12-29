// server.js - KaniaChatBot v2.0 (نسخه کامل بازنویسی‌شده و بهبودیافته)

const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ==================== تنظیمات محیطی ====================
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL?.trim();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET?.trim(); // برای امنیت وب‌هوک

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN تنظیم نشده است!');
  process.exit(1);
}
if (!ADMIN_CHAT_ID || isNaN(ADMIN_CHAT_ID)) {
  console.error('❌ ADMIN_CHAT_ID نامعتبر است!');
  process.exit(1);
}

console.log('🔧 متغیرهای محیطی بررسی شد ✅');

// اتصال به دیتابیس
let pool;
try {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('DATABASE_URL تنظیم نشده');

  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('connect', () => console.log('✅ اتصال جدید به دیتابیس'));
  pool.on('error', (err) => console.error('❌ خطای دیتابیس:', err.message));
} catch (err) {
  console.error('❌ خطا در اتصال به دیتابیس:', err.message);
  process.exit(1);
}

// ایجاد بات
const bot = new TelegramBot(BOT_TOKEN, { filepath: false });

// ==================== متغیرهای سراسری ====================
const states = {}; // وضعیت کاربران
const rateLimit = {}; // محدودیت درخواست
const tempFiles = new Set(); // فایل‌های موقت برای پاکسازی
let server = null;

// ==================== توابع کمکی ====================
const log = (userId, action, details = '') => {
  console.log(`[${new Date().toISOString()}] User ${userId}: ${action} ${details}`);
};

const isRateLimited = (userId) => {
  const now = Date.now();
  rateLimit[userId] = rateLimit[userId] || [];
  rateLimit[userId] = rateLimit[userId].filter(t => now - t < 60000);
  if (rateLimit[userId].length >= 10) return true;
  rateLimit[userId].push(now);
  return false;
};

const escapeMD = (text) => text ? text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&') : '';

const createKeyboard = (buttons, options = {}) => ({
  reply_markup: {
    keyboard: buttons,
    resize_keyboard: true,
    one_time_keyboard: options.one_time || false,
    input_field_placeholder: options.placeholder || '',
  },
});

const backKb = () => createKeyboard([[{ text: '↩️ بازگشت' }]], { one_time: true });

const confirmKb = (action) => createKeyboard([
  [{ text: `✅ تأیید ${action}` }],
  [{ text: '❌ لغو' }],
], { one_time: true });

// ذخیره فایل موقت
const saveTempFile = (userId, content, ext = '.txt') => {
  try {
    const dir = '/tmp';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filename = `${dir}/${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${ext}`;
    fs.writeFileSync(filename, content, 'utf8');
    tempFiles.add(filename);

    setTimeout(() => {
      if (fs.existsSync(filename)) fs.unlinkSync(filename);
      tempFiles.delete(filename);
    }, 5 * 60 * 1000);

    return filename;
  } catch (err) {
    console.error('❌ خطا در ذخیره فایل موقت:', err);
    return null;
  }
};

const clearState = (userId) => {
  if (states[userId]) {
    log(userId, 'پاکسازی وضعیت', states[userId].type);
    delete states[userId];
  }
};

// ==================== ایجاد جدول‌های دیتابیس ====================
const createTables = async () => {
  console.log('🗄️ ایجاد/بررسی جدول‌ها...');

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
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_score INTEGER DEFAULT 0,
        current_level INTEGER DEFAULT 0,
        daily_streak INTEGER DEFAULT 0,
        last_activity_date DATE,
        weekly_ai_questions INTEGER DEFAULT 0,
        weekly_ai_limit INTEGER DEFAULT 5,
        can_send_media BOOLEAN DEFAULT FALSE,
        extra_ai_questions INTEGER DEFAULT 0,
        vip_days_from_points INTEGER DEFAULT 0,
        score INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        last_weekly_reset DATE DEFAULT '1970-01-01'
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
        ai_provider VARCHAR(20) DEFAULT 'deepseek',
        ai_model VARCHAR(50) DEFAULT 'deepseek-chat',
        free_channel TEXT,
        vip_channel TEXT,
        membership_fee VARCHAR(100),
        wallet_address TEXT,
        network TEXT,
        prompt_content TEXT
      );
    `);
    await pool.query('INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS levels (
        level_number INTEGER PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        emoji VARCHAR(10) NOT NULL,
        min_score INTEGER NOT NULL,
        benefits TEXT[] NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      INSERT INTO levels (level_number, name, emoji, min_score, benefits) VALUES
      (1, 'Beginner', '🥉', 500, ARRAY['+1 سوال AI در هفته']),
      (2, 'Explorer', '🥈', 1000, ARRAY['+2 سوال AI در هفته']),
      (3, 'Regular', '🥇', 2500, ARRAY['+5 سوال AI در هفته']),
      (4, 'Advanced', '🏅', 4000, ARRAY['+10 سوال AI در هفته', 'آخرین پست کانال VIP']),
      (5, 'Veteran', '🏆', 6000, ARRAY['آخرین پست کانال VIP', '1 هفته عضویت VIP']),
      (6, 'Master', '💎', 9000, ARRAY['1 هفته عضویت VIP', 'ارسال مدیا در چت ادمین']),
      (7, 'Champion', '👑', 10000, ARRAY['1 ماه عضویت VIP رایگان'])
      ON CONFLICT (level_number) DO NOTHING;
    `);

    // جدول‌های دیگر
    const otherTables = [
      `CREATE TABLE IF NOT EXISTS level_rewards_claimed (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        level_number INTEGER NOT NULL,
        reward_type VARCHAR(50) NOT NULL,
        reward_value TEXT,
        claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(telegram_id, level_number, reward_type)
      )`,
      `CREATE TABLE IF NOT EXISTS story_requests (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        banner_text TEXT,
        banner_link TEXT,
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        banner_sent_at TIMESTAMP,
        story_screenshot TEXT,
        submitted_at TIMESTAMP,
        approved_by_admin BIGINT,
        approved_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'pending',
        points_awarded INTEGER DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS point_shop_items (
        id SERIAL PRIMARY KEY,
        item_code VARCHAR(50) UNIQUE NOT NULL,
        item_name VARCHAR(100) NOT NULL,
        description TEXT,
        price INTEGER NOT NULL,
        benefit_type VARCHAR(50),
        benefit_value INTEGER,
        max_purchases INTEGER DEFAULT NULL,
        is_active BOOLEAN DEFAULT TRUE
      )`,
      `CREATE TABLE IF NOT EXISTS user_purchases (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        item_code VARCHAR(50),
        price_paid INTEGER,
        purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        benefit_applied BOOLEAN DEFAULT FALSE,
        applied_at TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS daily_activities (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        activity_date DATE NOT NULL,
        actions_count JSONB DEFAULT '{}',
        total_points INTEGER DEFAULT 0,
        has_daily_bonus BOOLEAN DEFAULT FALSE,
        UNIQUE(telegram_id, activity_date)
      )`,
      `CREATE TABLE IF NOT EXISTS broadcast_messages (
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
      )`,
      `CREATE TABLE IF NOT EXISTS user_messages (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        message_text TEXT,
        media_type VARCHAR(50),
        media_file_id TEXT,
        is_from_user BOOLEAN DEFAULT TRUE,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS ai_chats (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        user_question TEXT,
        ai_response TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS ai_error_logs (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        error_type VARCHAR(50),
        error_message TEXT,
        user_question TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    for (const query of otherTables) {
      await pool.query(query);
    }

    await pool.query(`
      INSERT INTO point_shop_items (item_code, item_name, description, price, benefit_type, benefit_value) VALUES
      ('extra_ai_2', '۲ سوال AI اضافی', 'خرید ۲ سوال اضافی برای چت با هوش مصنوعی', 50, 'ai_questions', 2),
      ('media_access', 'دسترسی ارسال مدیا', 'اجازه ارسال عکس/ویدیو در چت با ادمین', 100, 'media_access', 1),
      ('vip_1day', '۱ روز VIP رایگان', '۱ روز عضویت VIP رایگان', 200, 'vip_days', 1),
      ('vip_3days', '۳ روز VIP رایگان', '۳ روز عضویت VIP رایگان', 500, 'vip_days', 3),
      ('ai_5_questions', '۵ سوال AI اضافی', '۵ سوال اضافی برای چت با هوش مصنوعی', 100, 'ai_questions', 5)
      ON CONFLICT (item_code) DO NOTHING;
    `);

    console.log('🎉 تمام جدول‌ها آماده شدند');
  } catch (err) {
    console.error('❌ خطا در ایجاد جدول‌ها:', err.message);
    process.exit(1);
  }
};

// ==================== سیستم امتیاز ====================
const addPoints = async (userId, actionCode) => {
  const pointRules = {
    first_login: 100,
    complete_profile: 100,
    ai_chat: 10,
    message_admin: 10,
    vip_purchase: 500,
    post_story: 300,
    daily_activity: 50,
    add_phone: 50,
  };

  const points = pointRules[actionCode] || 0;
  if (points === 0) return false;

  try {
    await pool.query(
      'UPDATE users SET total_score = COALESCE(total_score, 0) + $1 WHERE telegram_id = $2',
      [points, userId]
    );

    const today = moment().format('YYYY-MM-DD');
    await pool.query(
      `INSERT INTO daily_activities (telegram_id, activity_date, total_points)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id, activity_date) 
       DO UPDATE SET total_points = daily_activities.total_points + $3`,
      [userId, today, points]
    );

    log(userId, 'امتیاز دریافت کرد', `${actionCode}: ${points}`);
    return true;
  } catch (err) {
    console.error('❌ خطا در addPoints:', err);
    return false;
  }
};

// ریست هفتگی سوالات AI
const ensureWeeklyReset = async (userId) => {
  try {
    const { rows } = await pool.query(
      'SELECT last_weekly_reset FROM users WHERE telegram_id = $1',
      [userId]
    );

    const lastReset = rows[0]?.last_weekly_reset;
    const today = moment().format('YYYY-MM-DD');
    const weekStart = moment().startOf('week').format('YYYY-MM-DD');

    if (!lastReset || moment(lastReset).isBefore(weekStart)) {
      await pool.query(
        'UPDATE users SET weekly_ai_questions = 0, last_weekly_reset = $1 WHERE telegram_id = $2',
        [today, userId]
      );
      log(userId, 'ریست هفتگی AI انجام شد');
    }
  } catch (err) {
    console.error('❌ خطا در ریست هفتگی:', err);
  }
};

// ==================== هوش مصنوعی ====================
const callAI = async (apiKey, messages, model = 'deepseek-chat') => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('زمان پاسخ AI به پایان رسید');
    throw err;
  }
};

// ارجاع سوال به ادمین
const referToAdmin = async (userId, userQuestion, error) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, username FROM users WHERE telegram_id = $1',
      [userId]
    );

    const user = rows[0] || {};
    const name = user.name || 'نامشخص';
    const username = user.username ? `@${user.username}` : 'ندارد';

    await pool.query(
      'INSERT INTO ai_error_logs (telegram_id, error_type, error_message, user_question) VALUES ($1, $2, $3, $4)',
      [userId, error.name || 'Unknown', error.message, userQuestion]
    );

    const message = `🤖↩️ *ارجاع از AI*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${escapeMD(name)}\n🆔 *ID:* ${userId}\n👤 *یوزرنیم:* ${username}\n📅 *زمان:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━\n❓ *سوال:* ${escapeMD(userQuestion.substring(0, 500))}\n━━━━━━━━━━━━━━━━\n🚫 *دلیل:* ${escapeMD(error.message)}\n━━━━━━━━━━━━━━━━`;

    await bot.sendMessage(ADMIN_CHAT_ID, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💬 پاسخ', callback_data: `ai_reply_${userId}` },
            { text: '👁️ مشاهده', callback_data: `viewuser_${userId}` },
          ],
        ],
      },
    });

    await bot.sendMessage(userId, '⚠️ سوال شما به ادمین ارجاع داده شد. لطفاً منتظر باشید.', { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('❌ خطا در ارجاع به ادمین:', err);
  }
};

// ==================== فروشگاه امتیاز ====================
const showPointShop = async (userId) => {
  try {
    const { rows: items } = await pool.query(
      'SELECT * FROM point_shop_items WHERE is_active = TRUE ORDER BY price'
    );

    const { rows: [user] } = await pool.query(
      'SELECT total_score FROM users WHERE telegram_id = $1',
      [userId]
    );

    const score = user?.total_score || 0;
    let msg = `🛒 *فروشگاه امتیاز*\n━━━━━━━━━━━━━━━━\n💰 *موجودی:* ${score}\n\n*آیتم‌ها:*\n`;

    items.forEach((item, i) => {
      const canBuy = score >= item.price;
      msg += `${i + 1}. *${item.item_name}*\n   📝 ${item.description}\n   💰 ${item.price} امتیاز ${canBuy ? '✅' : '❌'}\n   کد: /buy_${item.item_code}\n──────────────\n`;
    });

    return msg;
  } catch (err) {
    console.error('❌ خطا در فروشگاه:', err);
    return '❌ خطا در بارگذاری فروشگاه';
  }
};

const handlePurchase = async (userId, itemCode) => {
  try {
    const { rows: [item] } = await pool.query(
      'SELECT * FROM point_shop_items WHERE item_code = $1 AND is_active = TRUE',
      [itemCode]
    );
    if (!item) return { success: false, reason: 'آیتم یافت نشد' };

    const { rows: [user] } = await pool.query(
      'SELECT total_score FROM users WHERE telegram_id = $1',
      [userId]
    );
    if ((user?.total_score || 0) < item.price) return { success: false, reason: 'امتیاز ناکافی' };

    await pool.query(
      'UPDATE users SET total_score = total_score - $1 WHERE telegram_id = $2',
      [item.price, userId]
    );

    await pool.query(
      'INSERT INTO user_purchases (telegram_id, item_code, price_paid) VALUES ($1, $2, $3)',
      [userId, itemCode, item.price]
    );

    switch (item.benefit_type) {
      case 'media_access':
        await pool.query('UPDATE users SET can_send_media = TRUE WHERE telegram_id = $1', [userId]);
        break;
      case 'ai_questions':
        await pool.query(
          'UPDATE users SET extra_ai_questions = extra_ai_questions + $1 WHERE telegram_id = $2',
          [item.benefit_value, userId]
        );
        break;
      case 'vip_days':
        const { rows: [vip] } = await pool.query(
          'SELECT end_date FROM vips WHERE telegram_id = $1 AND approved AND end_date > NOW()',
          [userId]
        );
        let endDate;
        if (vip && vip.end_date > new Date()) {
          endDate = moment(vip.end_date).add(item.benefit_value, 'days').toDate();
        } else {
          endDate = moment().add(item.benefit_value, 'days').toDate();
        }
        await pool.query(
          'INSERT INTO vips (telegram_id, approved, start_date, end_date) VALUES ($1, TRUE, NOW(), $2) ON CONFLICT (telegram_id) DO UPDATE SET end_date = $2',
          [userId, endDate]
        );
        break;
    }

    await addPoints(userId, 'vip_purchase');
    return { success: true, item };
  } catch (err) {
    console.error('❌ خطا در خرید:', err);
    return { success: false, reason: 'خطای سرور' };
  }
};

// ==================== کیبوردهای اصلی ====================
const mainKeyboard = (registered, isAdmin) => createKeyboard([
  [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
  [{ text: '💬 ارسال پیام به کانیا' }, { text: '🤖 چت با هوش مصنوعی' }],
  [{ text: registered ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
  [{ text: '📊 آمار من' }, { text: '🎁 دریافت 300 امتیاز با استوری' }],
  isAdmin ? [{ text: '🛡️ پنل ادمین' }] : [],
]);

const statsKeyboard = () => createKeyboard([
  [{ text: '📊 آمار من' }, { text: '🛒 فروشگاه امتیاز' }],
  [{ text: '↩️ بازگشت به منو اصلی' }],
]);

const adminKeyboard = () => createKeyboard([
  [{ text: '🤖 هوش مصنوعی' }, { text: '📺 کانال‌ها' }],
  [{ text: '👥 کاربران' }, { text: '📨 پیامرسانی' }],
  [{ text: '🎮 سیستم امتیازدهی' }, { text: '📊 آمار' }],
  [{ text: '🔄 ریست دیتابیس' }, { text: '↩️ بازگشت به منو اصلی' }],
]);

const aiAdminKeyboard = () => createKeyboard([
  [{ text: '⚙️ تنظیم توکن API' }],
  [{ text: '📂 ارسال فایل پرامپت' }],
  [{ text: '👀 مشاهده پرامپت' }],
  [{ text: '🗑️ حذف پرامپت' }],
  [{ text: '↩️ بازگشت به پنل ادمین' }],
]);

const editKeyboard = () => createKeyboard([
  [{ text: '👤 نام' }, { text: '🎂 سن' }],
  [{ text: '🏙️ شهر' }, { text: '🌍 منطقه' }],
  [{ text: '⚧️ جنسیت' }, { text: '💼 شغل' }],
  [{ text: '🎯 هدف' }, { text: '📱 شماره تماس' }],
  [{ text: '↩️ بازگشت به منو اصلی' }],
]);

const vipKeyboard = () => createKeyboard([
  [{ text: '📸 ارسال عکس فیش واریزی' }],
  [{ text: '❌ انصراف از عضویت VIP' }],
], { one_time: true });

// ==================== توابع کاربر ====================
const isVip = async (id) => {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved AND end_date > NOW()',
      [id]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('❌ خطا در isVip:', err);
    return false;
  }
};

const isRegistered = async (id) => {
  try {
    const { rows } = await pool.query(
      'SELECT name FROM users WHERE telegram_id = $1 AND name IS NOT NULL',
      [id]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('❌ خطا در isRegistered:', err);
    return false;
  }
};

const formatUserStats = async (userId) => {
  try {
    await ensureWeeklyReset(userId); // ریست هفتگی قبل از نمایش

    const { rows: [user] } = await pool.query(
      `SELECT u.*, 
              (SELECT COUNT(*) FROM vips WHERE telegram_id = u.telegram_id AND approved AND end_date > NOW()) as is_vip,
              (SELECT end_date FROM vips WHERE telegram_id = u.telegram_id AND approved AND end_date > NOW() LIMIT 1) as vip_end
       FROM users u WHERE telegram_id = $1`,
      [userId]
    );

    if (!user) return null;

    const vip = user.is_vip > 0;

    const { rows: [currentLevel] } = await pool.query(
      'SELECT * FROM levels WHERE min_score <= $1 ORDER BY level_number DESC LIMIT 1',
      [user.total_score]
    );

    const { rows: [nextLevel] } = await pool.query(
      'SELECT * FROM levels WHERE min_score > $1 ORDER BY min_score ASC LIMIT 1',
      [user.total_score]
    );

    const progress = nextLevel ? Math.min(100, Math.round((user.total_score - currentLevel.min_score) / (nextLevel.min_score - currentLevel.min_score) * 100)) : 100;
    const filled = Math.round(progress / 5);
    const progressBar = `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}]`;

    const weeklyLimit = vip ? 999 : user.weekly_ai_limit;
    const aiLeft = Math.max(0, weeklyLimit - user.weekly_ai_questions + user.extra_ai_questions);

    let stats = `📊 *آمار شما*\n━━━━━━━━━━━━━━━━\n`;
    stats += `${currentLevel.emoji} *سطح ${currentLevel.level_number}: ${currentLevel.name}*\n`;
    stats += `⭐ *امتیاز:* ${user.total_score}\n`;
    stats += `📈 *پیشرفت:* ${progress}%\n${progressBar}\n`;

    if (nextLevel) stats += `🎯 *سطح بعدی:* ${nextLevel.min_score - user.total_score} امتیاز\n`;
    else stats += `🏆 *بالاترین سطح!*\n`;

    stats += `📅 *استریک روزانه:* ${user.daily_streak} روز\n`;
    stats += `🤖 *سوالات AI باقی:* ${aiLeft}\n`;
    stats += `📸 *ارسال مدیا:* ${user.can_send_media ? '✅' : '❌'}\n`;

    if (vip) stats += `💎 *VIP تا:* ${moment(user.vip_end).format('jYYYY/jM/jD')}\n`;
    else stats += `💎 *VIP:* ❌\n`;

    stats += `\n🎁 *مزایا:*\n• ${currentLevel.benefits.join('\n• ')}\n`;

    return stats;
  } catch (err) {
    console.error('❌ خطا در آمار:', err);
    return null;
  }
};

// ==================== مدیریت وضعیت‌ها (handleState) ====================
const handleState = async (id, text, msg) => {
  const state = states[id];
  if (!state) return;

  const isAdmin = id === ADMIN_CHAT_ID;

  try {
    // ثبت‌نام
    if (state.type === 'register_full') {
      const questions = [
        '👤 نام:',
        '🎂 سن (عدد):',
        '🏙️ شهر:',
        '🌍 منطقه:',
        '⚧️ جنسیت:',
        '💼 شغل:',
        '🎯 هدف:',
        '📱 شماره (0 برای عدم ثبت):',
      ];
      const fields = ['name', 'age', 'city', 'region', 'gender', 'job', 'goal', 'phone'];

      if (state.step === 7) { // شماره تلفن
        if (text === '0') {
          state.data.phone = null;
        } else if (/^\d{10,15}$/.test(text)) {
          state.data.phone = text;
          await addPoints(id, 'add_phone');
        } else {
          await bot.sendMessage(id, '❌ نامعتبر! 0 یا عدد 10-15 رقمی.');
          return;
        }
      } else {
        state.data[fields[state.step]] = text.trim();
      }

      state.step++;

      if (state.step >= questions.length) {
        const age = parseInt(state.data.age) || null;
        await pool.query(`
          INSERT INTO users (telegram_id, name, age, city, region, gender, job, goal, phone)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (telegram_id) DO UPDATE SET name=$2, age=$3, city=$4, region=$5, gender=$6, job=$7, goal=$8, phone=$9
        `, [id, state.data.name, age, state.data.city, state.data.region, state.data.gender, state.data.job, state.data.goal, state.data.phone]);

        clearState(id);
        await bot.sendMessage(id, '✅ ثبت‌نام موفق!', { ...mainKeyboard(true, isAdmin) });
        await addPoints(id, 'complete_profile');
        return;
      }

      await bot.sendMessage(id, questions[state.step]);
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
        '📱 شماره تماس': 'phone',
      };

      if (fieldMap[text]) {
        const field = fieldMap[text];
        const { rows } = await pool.query(`SELECT ${field} FROM users WHERE telegram_id = $1`, [id]);
        const current = rows[0][field] || 'تنظیم نشده';

        await bot.sendMessage(id, `✏️ ویرایش ${text}\nمقدار فعلی: ${current}\nجدید را وارد کنید یا /cancel`, { parse_mode: 'Markdown' });
        states[id] = { type: `edit_${field}` };
      } else if (text === '↩️ بازگشت به منو اصلی') {
        clearState(id);
        await bot.sendMessage(id, '↩️ بازگشت', mainKeyboard(true, isAdmin));
      }
      return;
    }

    if (state.type.startsWith('edit_')) {
      if (text === '/cancel') {
        states[id] = { type: 'edit_menu' };
        await bot.sendMessage(id, '❌ لغو شد', editKeyboard());
        return;
      }

      const field = state.type.replace('edit_', '');
      let value = text.trim();

      if (field === 'phone') {
        if (text === '0') value = null;
        else if (!/^\d{10,15}$/.test(text)) {
          await bot.sendMessage(id, '❌ نامعتبر! 0 یا عدد 10-15 رقمی.');
          return;
        }
      } else if (field === 'age') {
        value = parseInt(value) || null;
      }

      await pool.query(`UPDATE users SET ${field} = $1 WHERE telegram_id = $2`, [value, id]);
      await bot.sendMessage(id, '✅ ویرایش شد', editKeyboard());
      states[id] = { type: 'edit_menu' };
      return;
    }

    // چت با ادمین
    if (state.type === 'chat_admin') {
      const { rows } = await pool.query('SELECT can_send_media FROM users WHERE telegram_id = $1', [id]);
      const canMedia = rows[0]?.can_send_media || false;

      if ((msg.photo || msg.video || msg.document || msg.animation) && !canMedia) {
        await bot.sendMessage(id, '⚠️ اجازه ارسال مدیا ندارید. از فروشگاه بخرید.');
        return;
      }

      try {
        await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);

        const { rows: userRows } = await pool.query('SELECT name, username FROM users WHERE telegram_id = $1', [id]);
        const user = userRows[0] || {};

        await bot.sendMessage(ADMIN_CHAT_ID, `📩 *پیام جدید*\n👤 ${escapeMD(user.name || 'نامشخص')}\n🆔 ${id}\n👤 @${user.username || 'ندارد'}`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💬 پاسخ', callback_data: `reply_${id}` },
                { text: '👁️ مشاهده', callback_data: `viewuser_${id}` },
              ],
            ],
          },
        });

        clearState(id);
        await bot.sendMessage(id, '✅ پیام ارسال شد', mainKeyboard(true, isAdmin));

        const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id || msg.document?.file_id || msg.animation?.file_id || null;

        await pool.query(
          'INSERT INTO user_messages (telegram_id, message_text, media_type, media_file_id, is_from_user) VALUES ($1, $2, $3, $4, TRUE)',
          [id, msg.caption || text, msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : msg.animation ? 'animation' : 'text', fileId]
        );

        await addPoints(id, 'message_admin');
      } catch (err) {
        await bot.sendMessage(id, '❌ خطا در ارسال پیام. دوباره سعی کنید.');
      }
      return;
    }

    // چت با AI
    if (state.type === 'ai_chat') {
      if (text === '↩️ بازگشت') {
        clearState(id);
        await bot.sendMessage(id, '↩️ چت بسته شد', mainKeyboard(true, isAdmin));
        return;
      }

      await ensureWeeklyReset(id);

      const vip = await isVip(id);
      const { rows: userRows } = await pool.query(
        'SELECT weekly_ai_questions, weekly_ai_limit, extra_ai_questions FROM users WHERE telegram_id = $1',
        [id]
      );

      const user = userRows[0] || {};
      const weeklyUsed = user.weekly_ai_questions || 0;
      const weeklyLimit = user.weekly_ai_limit || 5;
      const extra = user.extra_ai_questions || 0;

      const left = vip ? 999 : weeklyLimit - weeklyUsed + extra;

      if (!vip && left <= 0) {
        await bot.sendMessage(id, '⚠️ سوالات تمام شد. از فروشگاه بخرید یا VIP شوید.', mainKeyboard(true, isAdmin));
        clearState(id);
        return;
      }

      const { rows: settings } = await pool.query('SELECT ai_token, prompt_content, ai_model FROM settings');
      const { ai_token, prompt_content, ai_model } = settings[0] || {};

      if (!ai_token) {
        await bot.sendMessage(id, '⚠️ AI تنظیم نشده است.');
        clearState(id);
        return;
      }

      const messages = prompt_content ? [{ role: 'system', content: prompt_content }] : [];
      messages.push({ role: 'user', content: text });

      try {
        const reply = await callAI(ai_token, messages, ai_model);

        if (!reply) throw new Error('پاسخ خالی از AI');

        await bot.sendMessage(id, reply, backKb());

        if (!vip) {
          if (extra > 0) {
            await pool.query('UPDATE users SET extra_ai_questions = extra_ai_questions - 1 WHERE telegram_id = $1', [id]);
          } else {
            await pool.query('UPDATE users SET weekly_ai_questions = weekly_ai_questions + 1 WHERE telegram_id = $1', [id]);
          }
        }

        await pool.query('UPDATE users SET ai_questions_used = ai_questions_used + 1 WHERE telegram_id = $1', [id]);
        await pool.query('INSERT INTO ai_chats (telegram_id, user_question, ai_response) VALUES ($1, $2, $3)', [id, text, reply]);

        await addPoints(id, 'ai_chat');
      } catch (err) {
        console.error('❌ خطا در AI:', err);
        await referToAdmin(id, text, err);
        clearState(id);
      }
      return;
    }

    // سیستم استوری
    if (state.type === 'story_request_info') {
      if (text === '📨 درخواست بنر و لینک') {
        await pool.query('INSERT INTO story_requests (telegram_id, status) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET status = $2', [id, 'requested']);

        await bot.sendMessage(ADMIN_CHAT_ID, `🎁 درخواست بنر از کاربر ${id}`, { parse_mode: 'Markdown' });

        states[id] = { type: 'story_waiting_banner' };
        await bot.sendMessage(id, '✅ درخواست ثبت شد. منتظر بنر باشید.', createKeyboard([
          [{ text: '📸 ارسال اسکرین‌شات' }],
          [{ text: '❌ انصراف' }],
        ], { one_time: true }));
      } else if (text === '❌ انصراف') {
        clearState(id);
        await bot.sendMessage(id, '❌ لغو شد', mainKeyboard(true, isAdmin));
      }
      return;
    }

    if (state.type === 'story_waiting_banner') {
      if (text === '📸 ارسال اسکرین‌شات') {
        await bot.sendMessage(id, '📸 اسکرین‌شات را ارسال کنید:');
        states[id] = { type: 'story_submit_screenshot' };
      } else if (text === '❌ انصراف') {
        await pool.query('DELETE FROM story_requests WHERE telegram_id = $1', [id]);
        clearState(id);
        await bot.sendMessage(id, '❌ لغو شد', mainKeyboard(true, isAdmin));
      }
      return;
    }

    if (state.type === 'story_submit_screenshot' && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;

      await pool.query(
        'UPDATE story_requests SET story_screenshot = $1, submitted_at = NOW(), status = $2 WHERE telegram_id = $3',
        [fileId, 'submitted', id]
      );

      await bot.sendPhoto(ADMIN_CHAT_ID, fileId, {
        caption: `📸 اسکرین‌شات استوری از ${id}`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ تأیید', callback_data: `approve_story_${id}` },
              { text: '❌ رد', callback_data: `reject_story_${id}` },
            ],
          ],
        },
      });

      clearState(id);
      await bot.sendMessage(id, '✅ اسکرین ارسال شد. منتظر تأیید باشید.', mainKeyboard(true, isAdmin));
      return;
    }

    // آپلود پرامپت
    if (state.type === 'upload_prompt' && msg.document && msg.document.file_name.endsWith('.txt')) {
      try {
        const file = await bot.getFile(msg.document.file_id);
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        const content = await response.text();

        await pool.query('UPDATE settings SET prompt_content = $1', [content]);

        const tempFile = saveTempFile(id, content, '_prompt.txt');
        await bot.sendDocument(id, tempFile, { caption: '✅ پرامپت ذخیره شد' });

        clearState(id);
        await bot.sendMessage(id, '🤖 مدیریت AI', aiAdminKeyboard());
      } catch (err) {
        await bot.sendMessage(id, '❌ خطا در آپلود پرامپت');
      }
      return;
    }

    if (state.type === 'view_prompt') {
      const { rows } = await pool.query('SELECT prompt_content FROM settings');
      const prompt = rows[0]?.prompt_content;

      if (!prompt) {
        await bot.sendMessage(id, '⚠️ پرامپتی وجود ندارد');
      } else {
        const tempFile = saveTempFile(id, prompt, '_prompt.txt');
        await bot.sendDocument(id, tempFile, { caption: `📄 پرامپت فعلی (${prompt.length} کاراکتر)` });
      }

      clearState(id);
      await bot.sendMessage(id, '🤖 مدیریت AI', aiAdminKeyboard());
      return;
    }

    // عضویت VIP
    if (state.type === 'vip_waiting') {
      if (text === '📸 ارسال عکس فیش واریزی') {
        await bot.sendMessage(id, '📸 عکس فیش را ارسال کنید');
        states[id] = { type: 'vip_receipt' };
      } else if (text === '❌ انصراف از عضویت VIP') {
        clearState(id);
        await bot.sendMessage(id, '❌ لغو شد', mainKeyboard(true, isAdmin));
      }
      return;
    }

    if (state.type === 'vip_receipt' && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;

      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);

      await bot.sendMessage(ADMIN_CHAT_ID, `📸 رسید VIP از ${id}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ تأیید', callback_data: `approve_${id}` },
              { text: '❌ رد', callback_data: `reject_${id}` },
            ],
          ],
        },
      });

      await pool.query(
        'INSERT INTO vips (telegram_id, payment_receipt) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET payment_receipt = $2',
        [id, fileId]
      );

      clearState(id);
      await bot.sendMessage(id, '✅ رسید ارسال شد. منتظر باشید', mainKeyboard(true, isAdmin));
      return;
    }

    // پاسخ ادمین به کاربر
    if (state.type === 'reply_to_user') {
      if (text === '/cancel') {
        clearState(id);
        await bot.sendMessage(id, '❌ لغو شد');
        return;
      }

      await bot.sendMessage(state.userId, text);
      await pool.query(
        'INSERT INTO user_messages (telegram_id, message_text, is_from_user) VALUES ($1, $2, FALSE)',
        [state.userId, text]
      );

      await bot.sendMessage(id, '✅ پاسخ ارسال شد');
      clearState(id);
      return;
    }

    if (state.type === 'ai_reply_to_user') {
      if (text === '/cancel') {
        clearState(id);
        await bot.sendMessage(id, '❌ لغو شد');
        return;
      }

      await bot.sendMessage(state.userId, `💬 پاسخ از کانیا:\n${text}\n(پاسخ توسط ادمین به دلیل خطای AI)`, { parse_mode: 'Markdown' });
      await pool.query(
        'INSERT INTO user_messages (telegram_id, message_text, is_from_user) VALUES ($1, $2, FALSE)',
        [state.userId, text]
      );

      await bot.sendMessage(id, '✅ پاسخ ارسال شد');
      clearState(id);
      return;
    }
  } catch (err) {
    console.error('❌ خطا در handleState:', err);
    await bot.sendMessage(id, '❌ خطای داخلی. دوباره سعی کنید');
    clearState(id);
  }
};

// ==================== دستور /start ====================
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  const username = msg.from.username ? `@${msg.from.username}` : null;

  if (isRateLimited(id)) {
    await bot.sendMessage(id, '⚠️ درخواست زیاد! ۱ دقیقه صبر کنید');
    return;
  }

  try {
    await pool.query(
      'INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET username = $2',
      [id, username]
    );

    const isNew = (await pool.query('SELECT 1 FROM users WHERE telegram_id = $1 AND registration_date = CURRENT_TIMESTAMP', [id])).rows.length > 0;

    if (isNew) await addPoints(id, 'first_login');

    const registered = await isRegistered(id);

    await bot.sendMessage(id, '🌟 خوش آمدید به کانیا چت!', mainKeyboard(registered, id === ADMIN_CHAT_ID));
    log(id, 'استارت کرد');
  } catch (err) {
    console.error('❌ خطا در /start:', err);
  }
});

// ==================== مدیریت پیام‌ها ====================
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text || '';
  const username = msg.from.username ? `@${msg.from.username}` : null;

  if (isRateLimited(id)) {
    await bot.sendMessage(id, '⚠️ درخواست زیاد! ۱ دقیقه صبر کنید');
    return;
  }

  // آپدیت username همیشه
  if (username) {
    await pool.query('UPDATE users SET username = $1 WHERE telegram_id = $2', [username, id]);
  }

  log(id, 'پیام', text.substring(0, 50));

  if (states[id]) {
    await handleState(id, text, msg);
    return;
  }

  // منوی اصلی
  if (text === '📊 آمار من') {
    const stats = await formatUserStats(id);
    if (stats) await bot.sendMessage(id, stats, statsKeyboard());
    else await bot.sendMessage(id, '⚠️ ابتدا ثبت‌نام کنید', mainKeyboard(false, id === ADMIN_CHAT_ID));
    return;
  }

  if (text === '🛒 فروشگاه امتیاز') {
    const shopMsg = await showPointShop(id);
    await bot.sendMessage(id, shopMsg, backKb());
    states[id] = { type: 'point_shop' };
    return;
  }

  if (text === '🎁 دریافت 300 امتیاز با استوری') {
    await bot.sendMessage(id, '🎁 مراحل دریافت 300 امتیاز با استوری:\n1. درخواست بنر\n2. انتشار استوری\n3. ارسال اسکرین بعد از 24 ساعت', {
      ...createKeyboard([
        [{ text: '📨 درخواست بنر و لینک' }],
        [{ text: '❌ انصراف' }],
      ], { one_time: true }),
    });
    states[id] = { type: 'story_request_info' };
    return;
  }

  if (text === '📺 کانال رایگان') {
    const { rows } = await pool.query('SELECT free_channel FROM settings');
    await bot.sendMessage(id, `📢 کانال رایگان: ${rows[0]?.free_channel || 'تنظیم نشده'}`);
    return;
  }

  if (text === '💎 عضویت VIP') {
    const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const s = rows[0] || {};
    if (s.membership_fee) {
      await bot.sendMessage(id, `💎 VIP\nمبلغ: ${s.membership_fee}\nکیف پول: ${s.wallet_address}\nشبکه: ${s.network}`, vipKeyboard());
      states[id] = { type: 'vip_waiting' };
    } else {
      await bot.sendMessage(id, '⚠️ اطلاعات VIP تنظیم نشده');
    }
    return;
  }

  if (text === '💬 ارسال پیام به کانیا') {
    await bot.sendMessage(id, '💬 پیام خود را بنویسید (متن/عکس/ویدیو)');
    states[id] = { type: 'chat_admin' };
    return;
  }

  if (text === '🤖 چت با هوش مصنوعی') {
    await bot.sendMessage(id, '🧠 سوال بپرسید', backKb());
    states[id] = { type: 'ai_chat' };
    return;
  }

  if (text === '📝 ثبت‌نام' || text === '✏️ ویرایش اطلاعات') {
    const registered = await isRegistered(id);
    if (!registered) {
      states[id] = { type: 'register_full', step: 0, data: {} };
      await bot.sendMessage(id, '📝 ثبت‌نام\n👤 نام:');
    } else {
      await bot.sendMessage(id, '✏️ ویرایش کدام؟', editKeyboard());
      states[id] = { type: 'edit_menu' };
    }
    return;
  }

  if (text === '↩️ بازگشت' || text === '↩️ بازگشت به منو اصلی') {
    clearState(id);
    const registered = await isRegistered(id);
    await bot.sendMessage(id, '↩️ بازگشت', mainKeyboard(registered, id === ADMIN_CHAT_ID));
    return;
  }

  if (text.startsWith('/buy_')) {
    const itemCode = text.replace('/buy_', '');
    const result = await handlePurchase(id, itemCode);
    await bot.sendMessage(id, result.success ? `✅ خرید موفق: ${result.item.item_name}` : `❌ ${result.reason}`);
    return;
  }

  // پنل ادمین
  if (id === ADMIN_CHAT_ID) {
    if (text === '🛡️ پنل ادمین') {
      await bot.sendMessage(id, '🛡️ پنل ادمین', adminKeyboard());
      return;
    }

    if (text === '🤖 هوش مصنوعی') {
      await bot.sendMessage(id, '🤖 مدیریت AI', aiAdminKeyboard());
      states[id] = { type: 'admin_ai_menu' };
      return;
    }

    if (states[id]?.type === 'admin_ai_menu') {
      if (text === '📂 ارسال فایل پرامپت') {
        await bot.sendMessage(id, '📂 فایل .txt پرامپت را ارسال کنید');
        states[id] = { type: 'upload_prompt' };
      } else if (text === '👀 مشاهده پرامپت') {
        states[id] = { type: 'view_prompt' };
        await handleState(id, '', msg);
      } else if (text === '↩️ بازگشت به پنل ادمین') {
        clearState(id);
        await bot.sendMessage(id, '↩️ بازگشت', adminKeyboard());
      }
      return;
    }

    if (text === '📊 آمار') {
      const { rows: total } = await pool.query('SELECT COUNT(*) FROM users');
      const { rows: vip } = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
      await bot.sendMessage(id, `👥 کل کاربران: ${total[0].count}\n💎 VIP: ${vip[0].count}`);
      return;
    }
  }
});

// ==================== مدیریت Callback ====================
bot.on('callback_query', async (query) => {
  const data = query.data;
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;

  try {
    if (data.startsWith('approve_')) {
      if (userId !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ غیرمجاز', show_alert: true });

      const targetId = parseInt(data.replace('approve_', ''));
      const endDate = moment().add(1, 'month').toDate();

      await pool.query(
        'UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2',
        [endDate, targetId]
      );

      const { rows } = await pool.query('SELECT vip_channel FROM settings');
      await bot.sendMessage(targetId, `🎉 VIP تأیید شد!\nتا: ${moment(endDate).format('jYYYY/jM/jD')}\nکانال: ${rows[0]?.vip_channel || 'تنظیم نشده'}`, { parse_mode: 'Markdown' });

      await bot.editMessageText(`✅ VIP ${targetId} تأیید شد`, { chat_id: chatId, message_id: msgId });
      await bot.answerCallbackQuery(query.id, { text: '✅ تأیید شد' });
    } else if (data.startsWith('reject_')) {
      if (userId !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ غیرمجاز', show_alert: true });

      const targetId = parseInt(data.replace('reject_', ''));
      await pool.query('UPDATE vips SET approved = FALSE WHERE telegram_id = $1', [targetId]);

      await bot.sendMessage(targetId, '❌ VIP رد شد. دوباره سعی کنید.');
      await bot.editMessageText(`❌ VIP ${targetId} رد شد`, { chat_id: chatId, message_id: msgId });
      await bot.answerCallbackQuery(query.id, { text: '❌ رد شد' });
    } else if (data.startsWith('approve_story_')) {
      if (userId !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ غیرمجاز', show_alert: true });

      const targetId = parseInt(data.replace('approve_story_', ''));
      await pool.query('UPDATE story_requests SET status = \'approved\', points_awarded = 300, approved_by_admin = $1, approved_at = NOW() WHERE telegram_id = $2', [userId, targetId]);

      await addPoints(targetId, 'post_story');

      await bot.sendMessage(targetId, '🎉 استوری تأیید شد! 300 امتیاز اضافه شد');
      await bot.editMessageText(`✅ استوری ${targetId} تأیید شد`, { chat_id: chatId, message_id: msgId });
      await bot.answerCallbackQuery(query.id, { text: '✅ تأیید شد' });
    } else if (data.startsWith('reject_story_')) {
      if (userId !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ غیرمجاز', show_alert: true });

      const targetId = parseInt(data.replace('reject_story_', ''));
      await pool.query('UPDATE story_requests SET status = \'rejected\' WHERE telegram_id = $1', [targetId]);

      await bot.sendMessage(targetId, '❌ استوری رد شد. بررسی کنید');
      await bot.editMessageText(`❌ استوری ${targetId} رد شد`, { chat_id: chatId, message_id: msgId });
      await bot.answerCallbackQuery(query.id, { text: '❌ رد شد' });
    } else if (data.startsWith('reply_')) {
      if (userId !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ غیرمجاز', show_alert: true });

      const targetId = parseInt(data.replace('reply_', ''));
      await bot.sendMessage(userId, `💬 پاسخ به ${targetId}\nمتن را بنویسید (/cancel برای لغو):`);
      states[userId] = { type: 'reply_to_user', userId: targetId };
      await bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('ai_reply_')) {
      if (userId !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ غیرمجاز', show_alert: true });

      const targetId = parseInt(data.replace('ai_reply_', ''));
      await bot.sendMessage(userId, `🤖 پاسخ به ${targetId} (از AI)\nمتن را بنویسید (/cancel برای لغو):`);
      states[userId] = { type: 'ai_reply_to_user', userId: targetId };
      await bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('viewuser_')) {
      if (userId !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(query.id, { text: '⛔ غیرمجاز', show_alert: true });

      const targetId = parseInt(data.replace('viewuser_', ''));
      const { rows: user } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [targetId]);
      if (!user.length) return bot.answerCallbackQuery(query.id, { text: '❌ کاربر یافت نشد', show_alert: true });

      let details = `👤 کاربر ${targetId}\n━━━━━━━━━━━━━━━━\n`;
      details += `نام: ${escapeMD(user[0].name || 'نامشخص')}\n`;
      details += `یوزرنیم: @${user[0].username || 'ندارد'}\n`;
      details += `امتیاز: ${user[0].total_score}\n`;
      // ... (بقیه جزئیات مثل قبل)

      await bot.sendMessage(userId, details, { parse_mode: 'Markdown' });
      await bot.answerCallbackQuery(query.id);
    }

    // سایر callbackها را می‌توانید اضافه کنید
  } catch (err) {
    console.error('❌ خطا در callback:', err);
    await bot.answerCallbackQuery(query.id, { text: '❌ خطا', show_alert: true });
  }
});

// ==================== روت‌های وب ====================
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(403).send('Forbidden');
  }
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.json({ status: 'online', timestamp: new Date().toISOString() }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy' });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// ==================== راه‌اندازی سرور ====================
const startServer = async () => {
  await createTables();

  if (WEBHOOK_URL) {
    try {
      await bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
      console.log('✅ وب‌هوک تنظیم شد');
    } catch (err) {
      console.error('❌ خطا در وب‌هوک:', err);
      await bot.startPolling();
      console.log('✅ Polling فعال شد');
    }
  } else {
    await bot.startPolling();
    console.log('✅ Polling فعال شد');
  }

  server = app.listen(PORT, () => console.log(`🚀 سرور روی پورت ${PORT}`));
};

startServer().catch(err => {
  console.error('❌ خطا در شروع:', err);
  process.exit(1);
});

// graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 خاموش کردن...');
  bot.stopPolling();
  tempFiles.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
  await pool.end();
  if (server) server.close();
  process.exit(0);
});

console.log('🎉 KaniaChatBot آماده است!');
