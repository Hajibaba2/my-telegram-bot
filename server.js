const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// بررسی متغیرهای محیطی
console.log('🔧 بررسی متغیرهای محیطی...');
console.log(`BOT_TOKEN: ${BOT_TOKEN ? '✅' : '❌'}`);
console.log(`ADMIN_CHAT_ID: ${ADMIN_CHAT_ID || '❌'}`);
console.log(`PORT: ${PORT}`);
console.log(`WEBHOOK_URL: ${WEBHOOK_URL || '❌'}`);

if (!BOT_TOKEN) {
  console.error('❌ خطا: BOT_TOKEN تنظیم نشده است!');
  process.exit(1);
}

if (!ADMIN_CHAT_ID || isNaN(ADMIN_CHAT_ID)) {
  console.error('❌ خطا: ADMIN_CHAT_ID نامعتبر است!');
  process.exit(1);
}

// تنظیم pool دیتابیس
let pool;
try {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  console.log(`🗄️ اتصال به دیتابیس: ${connectionString ? '✅' : '❌'}`);
  
  pool = new Pool({
    connectionString: connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // تست اتصال دیتابیس
  pool.on('connect', () => {
    console.log('✅ اتصال دیتابیس موفق');
  });

  pool.on('error', (err) => {
    console.error('❌ خطای دیتابیس:', err.message);
  });
} catch (err) {
  console.error('❌ خطا در تنظیم دیتابیس:', err.message);
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false,
  filepath: false
});

// ==================== Global Variables ====================
const states = {};
const rateLimit = {};
const tempFiles = {};
let isPolling = false;
let server = null;

// ==================== Helper Functions ====================
function logActivity(userId, action, details = '') {
  console.log(`[${new Date().toISOString()}] User ${userId}: ${action} ${details}`);
}

function checkRateLimit(userId) {
  const now = Date.now();
  if (!rateLimit[userId]) rateLimit[userId] = [];
  rateLimit[userId] = rateLimit[userId].filter(time => now - time < 60000);
  if (rateLimit[userId].length >= 10) return false;
  rateLimit[userId].push(now);
  return true;
}

function cleanupUserState(userId) {
  if (states[userId]) {
    console.log(`🧹 Clearing state for user ${userId}, type: ${states[userId].type}`);
    delete states[userId];
  }
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

function backKeyboard() {
  return createReplyKeyboard([[{ text: '↩️ بازگشت' }]], { one_time: true });
}

function createProgressBar(percentage, length = 20) {
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ==================== Temp File Management ====================
function saveTempFile(userId, content, ext = '.txt') {
  try {
    const tmpDir = '/tmp';
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    
    const filename = `${tmpDir}/${userId}_${Date.now()}${ext}`;
    fs.writeFileSync(filename, content, 'utf8');
    
    if (!tempFiles[userId]) tempFiles[userId] = [];
    tempFiles[userId].push(filename);
    
    // حذف خودکار بعد از 5 دقیقه
    setTimeout(() => {
      try {
        if (tempFiles[userId]) {
          tempFiles[userId].forEach(file => {
            if (fs.existsSync(file)) {
              fs.unlinkSync(file);
            }
          });
          delete tempFiles[userId];
        }
      } catch (err) {
        console.error('❌ خطا در حذف فایل موقت:', err);
      }
    }, 5 * 60 * 1000);
    
    return filename;
  } catch (err) {
    console.error('❌ خطا در ایجاد فایل موقت:', err);
    return null;
  }
}

// ==================== Database Tables Creation ====================
async function createTables() {
  console.log('🗄️ شروع ایجاد/بررسی جدول‌ها...');
  
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
        level INTEGER DEFAULT 1
      );
    `);
    console.log('✅ جدول users ایجاد شد');
    
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
    console.log('✅ جدول vips ایجاد شد');
    
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
    console.log('✅ جدول settings ایجاد شد');
    
    await pool.query(`INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;`);
    console.log('✅ تنظیمات اولیه اضافه شد');
    
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
    console.log('✅ جدول levels ایجاد شد');
    
    try {
      await pool.query(`
        INSERT INTO levels (level_number, name, emoji, min_score, benefits) VALUES
        (1, 'Beginner', '🥉', 500, ARRAY['+1 سوال AI در هفته']),
        (2, 'Explorer', '🥈', 1000, ARRAY['+2 سوال AI در هفته']),
        (3, 'Regular', '🥇', 2500, ARRAY['+5 سوال AI در هفته']),
        (4, 'Advanced', '🏅', 4000, ARRAY['+10 سوال AI در هفته', 'آخرین پست کانال VIP']),
        (5, 'Veteran', '🏆', 6000, ARRAY['آخرین پست کانال VIP', '1 هفته عضویت VIP']),
        (6, 'Master', '💎', 9000, ARRAY['1 هفته عضویت VIP', 'ارسال مدیا در چت ادمین']),
        (7, 'Champion', '👑', 10000, ARRAY['1 ماه عضویت VIP رایگان'])
        ON CONFLICT (level_number) DO NOTHING
      `);
    } catch (err) {
      console.log('⚠️ خطا در افزودن سطوح (ممکن است از قبل وجود داشته باشند):', err.message);
    }
    
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
    
    for (const tableQuery of otherTables) {
      try {
        await pool.query(tableQuery);
      } catch (err) {
        console.log(`⚠️ خطا در ایجاد جدول (ممکن است از قبل وجود داشته باشد): ${err.message}`);
      }
    }
    
    try {
      await pool.query(`
        INSERT INTO point_shop_items (item_code, item_name, description, price, benefit_type, benefit_value) VALUES
        ('extra_ai_2', '۲ سوال AI اضافی', 'خرید ۲ سوال اضافی برای چت با هوش مصنوعی', 50, 'ai_questions', 2),
        ('media_access', 'دسترسی ارسال مدیا', 'اجازه ارسال عکس/ویدیو در چت با ادمین', 100, 'media_access', 1),
        ('vip_1day', '۱ روز VIP رایگان', '۱ روز عضویت VIP رایگان', 200, 'vip_days', 1),
        ('vip_3days', '۳ روز VIP رایگان', '۳ روز عضویت VIP رایگان', 500, 'vip_days', 3),
        ('ai_5_questions', '۵ سوال AI اضافی', '۵ سوال اضافی برای چت با هوش مصنوعی', 100, 'ai_questions', 5)
        ON CONFLICT (item_code) DO NOTHING
      `);
    } catch (err) {
      console.log('⚠️ خطا در افزودن آیتم‌های فروشگاه:', err.message);
    }
    
    console.log('🎉 تمام جدول‌ها با موفقیت ایجاد/بررسی شدند');
    return true;
    
  } catch (err) {
    console.error('❌ خطای جدی در ایجاد جدول‌ها:', err.message);
    console.error('Stack trace:', err.stack);
    return false;
  }
}

// ==================== Score System ====================
async function addPoints(userId, actionCode, details = {}) {
  try {
    const pointRules = {
      'first_login': 100,
      'complete_profile': 100,
      'ai_chat': 10,
      'message_admin': 10,
      'vip_purchase': 500,
      'post_story': 300,
      'daily_activity': 50,
      'add_phone': 50
    };

    const points = pointRules[actionCode] || 0;
    if (points === 0) return false;

    await pool.query(
      'UPDATE users SET total_score = COALESCE(total_score, 0) + $1 WHERE telegram_id = $2',
      [points, userId]
    );

    const today = new Date().toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO daily_activities (telegram_id, activity_date, total_points)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id, activity_date) 
       DO UPDATE SET total_points = daily_activities.total_points + $3`,
      [userId, today, points]
    );

    logActivity(userId, 'امتیاز دریافت کرد', `${actionCode}: ${points} امتیاز`);
    return true;
  } catch (err) {
    console.error('❌ خطا در افزودن امتیاز:', err.message);
    return false;
  }
}

// ==================== DeepSeek AI System ====================
async function callDeepSeekAI(apiKey, messages, model = 'deepseek-chat') {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || null;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('زمان پاسخگویی هوش مصنوعی به پایان رسید');
    }
    throw err;
  }
}

// ==================== Refer to Admin ====================
async function referToAdmin(userId, userQuestion, error) {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT name, username FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    const user = userRows[0] || {};
    const userName = user.name || 'نامشخص';
    const username = user.username ? `@${user.username}` : 'ندارد';
    
    // ثبت خطا در دیتابیس
    await pool.query(
      'INSERT INTO ai_error_logs (telegram_id, error_type, error_message, user_question) VALUES ($1, $2, $3, $4)',
      [userId, error.name || 'Unknown', error.message || 'No message', userQuestion]
    );
    
    // ارسال به ادمین با علامت ارجاع
    const message = `🤖↩️ *ارجاع از هوش مصنوعی*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${escapeMarkdown(userName)}\n🆔 *آیدی:* ${userId}\n👤 *یوزرنیم:* ${username}\n📅 *زمان:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━\n❓ *سوال کاربر:*\n${escapeMarkdown(userQuestion.substring(0, 500))}\n━━━━━━━━━━━━━━━━\n🚫 *دلیل ارجاع:*\n${escapeMarkdown(error.message || 'خطای نامشخص')}\n━━━━━━━━━━━━━━━━`;
    
    await bot.sendMessage(ADMIN_CHAT_ID, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: "💬 پاسخ به کاربر", callback_data: `ai_reply_${userId}` },
            { text: "👁️ مشاهده کاربر", callback_data: `viewuser_${userId}` }
          ],
          [
            { text: "🤖 تست مجدد AI", callback_data: `retry_ai_${userId}` },
            { text: "📊 لاگ خطا", callback_data: `ai_error_log_${userId}` }
          ]
        ]
      }
    });
    
    // اطلاع به کاربر
    await bot.sendMessage(userId,
      `⚠️ *متأسفانه در حال حاضر سیستم هوش مصنوعی پاسخگو نیست.*\n\n` +
      `سوال شما به ادمین ارجاع داده شد و در اسرع وقت پاسخ دریافت خواهید کرد.\n\n` +
      `با تشکر از صبر و شکیبایی شما 🙏`,
      { parse_mode: 'Markdown' }
    );
    
    return true;
  } catch (err) {
    console.error('❌ خطا در ارجاع به ادمین:', err);
    return false;
  }
}

// ==================== Point Shop ====================
async function showPointShop(userId) {
  try {
    const { rows: items } = await pool.query(
      'SELECT * FROM point_shop_items WHERE is_active = TRUE ORDER BY price'
    );
    
    const { rows: userRows } = await pool.query(
      'SELECT total_score FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    const userScore = userRows[0]?.total_score || 0;
    
    let shopMessage = `🛒 *فروشگاه امتیازی*\n━━━━━━━━━━━━━━━━\n`;
    shopMessage += `💰 *موجودی شما:* ${userScore} امتیاز\n\n`;
    shopMessage += `*موجودی کالاها:*\n`;
    
    items.forEach((item, index) => {
      const canBuy = userScore >= item.price;
      const status = canBuy ? '✅' : '❌';
      shopMessage += `${index + 1}. *${item.item_name}*\n`;
      shopMessage += `   📝 ${item.description}\n`;
      shopMessage += `   💰 قیمت: ${item.price} امتیاز ${status}\n`;
      shopMessage += `   🔹 کد خرید: \`/buy_${item.item_code}\`\n`;
      shopMessage += `   ──────────────\n`;
    });
    
    shopMessage += `\nبرای خرید کد مورد نظر را ارسال کنید.`;
    
    return shopMessage;
  } catch (err) {
    console.error('❌ خطا در نمایش فروشگاه:', err.message);
    return '❌ خطا در بارگذاری فروشگاه.';
  }
}

async function handlePurchase(userId, itemCode) {
  try {
    const { rows: itemRows } = await pool.query(
      'SELECT * FROM point_shop_items WHERE item_code = $1 AND is_active = TRUE',
      [itemCode]
    );
    
    if (itemRows.length === 0) return { success: false, reason: 'آیتم یافت نشد' };
    
    const item = itemRows[0];
    const { rows: userRows } = await pool.query(
      'SELECT total_score FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userRows[0].total_score < item.price) {
      return { success: false, reason: 'امتیاز ناکافی' };
    }
    
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
        await pool.query(
          'UPDATE users SET can_send_media = TRUE WHERE telegram_id = $1',
          [userId]
        );
        break;
        
      case 'ai_questions':
        await pool.query(
          'UPDATE users SET extra_ai_questions = extra_ai_questions + $1 WHERE telegram_id = $2',
          [item.benefit_value, userId]
        );
        break;
        
      case 'vip_days':
        const endDate = moment().add(item.benefit_value, 'days').toDate();
        await pool.query(
          `INSERT INTO vips (telegram_id, approved, start_date, end_date)
           VALUES ($1, TRUE, NOW(), $2)
           ON CONFLICT (telegram_id) 
           DO UPDATE SET approved = TRUE, 
                        start_date = CASE WHEN vips.end_date < NOW() THEN NOW() ELSE vips.start_date END,
                        end_date = CASE 
                          WHEN vips.end_date < NOW() THEN $2 
                          ELSE vips.end_date + INTERVAL '${item.benefit_value} days'
                        END`,
          [userId, endDate]
        );
        break;
    }
    
    await pool.query(
      'UPDATE user_purchases SET benefit_applied = TRUE, applied_at = NOW() WHERE id = (SELECT MAX(id) FROM user_purchases WHERE telegram_id = $1)',
      [userId]
    );
    
    return { success: true, item };
  } catch (err) {
    console.error('❌ خطا در پردازش خرید:', err.message);
    return { success: false, reason: 'خطای سرور' };
  }
}

// ==================== Keyboards ====================
function mainKeyboard(reg, admin) {
  const k = [
    [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
    [{ text: '💬 ارسال پیام به کانیا' }, { text: '🤖 چت با هوش مصنوعی' }],
    [{ text: reg ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
    [{ text: '📊 آمار من' }, { text: '🎁 دریافت 300 امتیاز با استوری' }]
  ];
  if (admin) k.push([{ text: '🛡️ پنل ادمین' }]);
  return createReplyKeyboard(k, { placeholder: 'گزینه مورد نظر را انتخاب کنید' });
}

function statsKeyboard() {
  return createReplyKeyboard([
    [{ text: '📊 آمار من' }, { text: '🛒 فروشگاه امتیاز' }],
    [{ text: '↩️ بازگشت به منو اصلی' }]
  ]);
}

function adminKeyboard() {
  return createReplyKeyboard([
    [{ text: '🤖 هوش مصنوعی' }, { text: '📺 کانال‌ها' }],
    [{ text: '👥 کاربران' }, { text: '📨 پیامرسانی' }],
    [{ text: '🎮 سیستم امتیازدهی' }, { text: '📊 آمار' }],
    [{ text: '🔄 ریست دیتابیس' }, { text: '↩️ بازگشت به منو اصلی' }]
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

// ==================== User Functions ====================
async function isVip(id) {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved AND end_date > NOW()',
      [id]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('❌ خطا در بررسی VIP:', err.message);
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

async function formatUserStats(userId) {
  try {
    const { rows: userRows } = await pool.query(
      `SELECT u.*, 
              (SELECT COUNT(*) FROM vips WHERE telegram_id = u.telegram_id AND approved AND end_date > NOW()) as is_vip,
              (SELECT end_date FROM vips WHERE telegram_id = u.telegram_id AND approved AND end_date > NOW() LIMIT 1) as vip_end
       FROM users u WHERE telegram_id = $1`,
      [userId]
    );
    
    if (userRows.length === 0) return null;
    
    const user = userRows[0];
    const vip = user.is_vip > 0;
    
    const { rows: currentLevelRows } = await pool.query(
      'SELECT * FROM levels WHERE min_score <= $1 ORDER BY level_number DESC LIMIT 1',
      [user.total_score]
    );
    
    const currentLevel = currentLevelRows[0] || { level_number: 0, name: 'شروع', emoji: '👶', benefits: [], min_score: 0 };
    
    const { rows: nextLevelRows } = await pool.query(
      'SELECT * FROM levels WHERE min_score > $1 ORDER BY min_score ASC LIMIT 1',
      [user.total_score]
    );
    
    const nextLevel = nextLevelRows[0];
    
    const progress = nextLevel ? 
      Math.min(100, Math.round((user.total_score - currentLevel.min_score) / 
              (nextLevel.min_score - currentLevel.min_score) * 100)) : 100;
    
    const progressBar = createProgressBar(progress);
    
    const weeklyLimit = vip ? 999 : (5 + user.weekly_ai_limit);
    const aiQuestionsLeft = Math.max(0, weeklyLimit - user.weekly_ai_questions);
    
    let stats = `📊 *آمار شما*\n━━━━━━━━━━━━━━━━\n`;
    stats += `${currentLevel.emoji} *سطح ${currentLevel.level_number}: ${currentLevel.name}*\n`;
    stats += `⭐ *امتیاز کل:* ${user.total_score}\n`;
    stats += `📈 *پیشرفت:* ${progress}%\n`;
    stats += `${progressBar}\n`;
    
    if (nextLevel) {
      const needed = nextLevel.min_score - user.total_score;
      stats += `🎯 *سطح بعدی:* ${needed} امتیاز دیگر\n`;
    } else {
      stats += `🏆 *شما به بالاترین سطح رسیده‌اید!*\n`;
    }
    
    stats += `📅 *فعالیت روزانه:* ${user.daily_streak} روز متوالی\n`;
    stats += `🤖 *سوالات AI این هفته:* ${aiQuestionsLeft} باقی‌مانده\n`;
    stats += `📸 *ارسال مدیا:* ${user.can_send_media ? '✅ فعال' : '❌ غیرفعال'}\n`;
    
    if (vip) {
      stats += `💎 *وضعیت VIP:* ✅ تا ${moment(user.vip_end).format('jYYYY/jM/jD')}\n`;
    } else {
      stats += `💎 *وضعیت VIP:* ❌ غیرفعال\n`;
    }
    
    stats += `━━━━━━━━━━━━━━━━\n`;
    stats += `🎁 *مزایای سطح فعلی:*\n`;
    
    if (currentLevel.benefits && currentLevel.benefits.length > 0) {
      currentLevel.benefits.forEach(benefit => {
        stats += `• ${benefit}\n`;
      });
    } else {
      stats += `• ۵ سوال AI رایگان در هفته\n`;
    }
    
    return stats;
  } catch (err) {
    console.error('❌ خطا در ساخت آمار:', err.message);
    return null;
  }
}

// ==================== State Management ====================
async function handleState(id, text, msg) {
  const state = states[id];
  const admin = id === ADMIN_CHAT_ID;
  
  if (!state) return;
  
  console.log(`🔍 Handling state for ${id}: ${state.type}`);
  
  try {
    // 1. ثبت‌نام کامل
    if (state.type === 'register_full') {
      const questions = [
        '👤 نام خود را وارد کنید:',
        '🎂 سن خود را وارد کنید (عدد):',
        '🏙️ شهر خود را وارد کنید:',
        '🌍 منطقه یا محله خود را وارد کنید:',
        '⚧️ جنسیت خود را وارد کنید:',
        '💼 شغل خود را وارد کنید:',
        '🎯 هدف شما چیست؟',
        '📱 مایل به ثبت شماره تلفن هستید؟\n\n• اگر نمی‌خواهید شماره ثبت کنید: عدد 0 را وارد کنید'
      ];
      const fields = ['name', 'age', 'city', 'region', 'gender', 'job', 'goal', 'phone'];
      
      // اعتبارسنجی شماره تلفن (مرحله آخر)
      if (state.step === 7) {
        const phoneInput = text.trim();
        
        // بررسی اگر 0 وارد شده
        if (phoneInput === '0') {
          state.data.phone = null;
          state.step++;
        } 
        // بررسی اگر عدد 10-15 رقمی است
        else if (/^\d{10,15}$/.test(phoneInput)) {
          state.data.phone = phoneInput;
          state.step++;
          await addPoints(id, 'add_phone');
        } 
        // ورودی نامعتبر
        else {
          await bot.sendMessage(id, 
            '❌ ورودی نامعتبر!\n\n' +
            '• فقط عدد وارد کنید\n' +
            '• اگر نمی‌خواهید ثبت کنید: 0\n' +
            '• اگر می‌خواهید ثبت کنید: شماره 10-15 رقمی\n\n' +
            'لطفاً دوباره وارد کنید:'
          );
          return;
        }
      } 
      // مراحل دیگر ثبت‌نام
      else {
        state.data[fields[state.step]] = text.trim();
        state.step++;
      }
      
      if (state.step >= questions.length) {
        const ageVal = isNaN(parseInt(state.data.age)) ? null : parseInt(state.data.age);
        
        await pool.query(`
          INSERT INTO users (telegram_id, name, age, city, region, gender, job, goal, phone)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (telegram_id) DO UPDATE SET name=$2, age=$3, city=$4, region=$5, gender=$6, job=$7, goal=$8, phone=$9
        `, [id, state.data.name, ageVal, state.data.city, state.data.region, state.data.gender, state.data.job, state.data.goal, state.data.phone]);
        
        cleanupUserState(id);
        await bot.sendMessage(id, '✅ *ثبت‌نام با موفقیت انجام شد!* 🎉', { 
          parse_mode: 'Markdown', 
          ...mainKeyboard(true, admin) 
        });
        await addPoints(id, 'complete_profile');
        return;
      }
      
      await bot.sendMessage(id, questions[state.step]);
      return;
    }
    
    // 2. ویرایش اطلاعات
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
        
        let message;
        if (fieldMap[text] === 'phone') {
          message = `✏️ *ویرایش شماره تماس*\n━━━━━━━━━━━━━━━━\n`;
          message += `*مقدار فعلی:* ${current || 'ندارد'}\n`;
          message += `━━━━━━━━━━━━━━━━\n`;
          message += `• اگر نمی‌خواهید شماره ثبت کنید: عدد 0 را وارد کنید\n`;
          message += `• اگر می‌خواهید ثبت کنید: شماره 10-15 رقمی\n`;
          message += `• برای لغو: /cancel`;
        } else {
          const fieldNames = {
            'name': 'نام',
            'age': 'سن',
            'city': 'شهر',
            'region': 'منطقه',
            'gender': 'جنسیت',
            'job': 'شغل',
            'goal': 'هدف'
          };
          const fieldName = fieldNames[fieldMap[text]];
          message = `✏️ *ویرایش ${fieldName}*\n━━━━━━━━━━━━━━━━\n*مقدار فعلی:* ${current}\n━━━━━━━━━━━━━━━━\nمقدار جدید را وارد کنید یا /cancel برای لغو.`;
        }
        
        await bot.sendMessage(id, escapeMarkdown(message), { parse_mode: 'Markdown' });
        states[id] = { type: `edit_${fieldMap[text]}` };
      } else if (text === '↩️ بازگشت به منو اصلی') {
        cleanupUserState(id);
        await bot.sendMessage(id, '↩️ بازگشت به منو اصلی', mainKeyboard(true, admin));
      }
      return;
    }
    
    if (state.type.startsWith('edit_')) {
      if (text === '/cancel') {
        cleanupUserState(id);
        await bot.sendMessage(id, '❌ ویرایش لغو شد.', editKeyboard());
        states[id] = { type: 'edit_menu' };
        return;
      }
      
      const field = state.type.replace('edit_', '');
      
      // اعتبارسنجی ویژه برای شماره تلفن
      if (field === 'phone') {
        if (text === '0') {
          await pool.query(`UPDATE users SET ${field} = NULL WHERE telegram_id = $1`, [id]);
          await bot.sendMessage(id, '✅ شماره تلفن حذف شد.', editKeyboard());
        } else if (/^\d{10,15}$/.test(text)) {
          await pool.query(`UPDATE users SET ${field} = $1 WHERE telegram_id = $2`, [text, id]);
          await bot.sendMessage(id, '✅ شماره تلفن بروزرسانی شد.', editKeyboard());
        } else {
          await bot.sendMessage(id, '❌ شماره تلفن نامعتبر! لطفاً عدد 10-15 رقمی وارد کنید یا 0 برای حذف.');
          return;
        }
      } else {
        const value = field === 'age' ? parseInt(text) || null : text.trim() || null;
        await pool.query(`UPDATE users SET ${field} = $1 WHERE telegram_id = $2`, [value, id]);
        await bot.sendMessage(id, '✅ ویرایش شد.', editKeyboard());
      }
      
      states[id] = { type: 'edit_menu' };
      cleanupUserState(id);
      return;
    }
    
    // 3. چت با ادمین
    if (state.type === 'chat_admin') {
      const { rows: userRows } = await pool.query(
        'SELECT can_send_media FROM users WHERE telegram_id = $1',
        [id]
      );
      const canSendMedia = userRows[0]?.can_send_media || false;
      
      if ((msg.photo || msg.video || msg.document || msg.animation) && !canSendMedia) {
        await bot.sendMessage(id, 
          `⚠️ *شما اجازه ارسال مدیا ندارید!*\n\n` +
          `برای خرید دسترسی ارسال مدیا به فروشگاه امتیاز مراجعه کنید.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      
      const { rows } = await pool.query('SELECT name, username FROM users WHERE telegram_id = $1', [id]);
      const user = rows[0] || {};
      
      const message = `📩 *پیام جدید از کاربر*\n━━━━━━━━━━━━━━━━\n📛 *نام:* ${escapeMarkdown(user.name || 'نامشخص')}\n🆔 *ID:* ${id}\n👤 *یوزرنیم:* @${user.username || 'ندارد'}\n━━━━━━━━━━━━━━━━`;
      
      await bot.sendMessage(ADMIN_CHAT_ID, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💬 پاسخ', callback_data: `reply_${id}` },
              { text: '👁️ مشاهده کاربر', callback_data: `viewuser_${id}` }
            ]
          ]
        }
      });
      
      cleanupUserState(id);
      await bot.sendMessage(id, '✅ *پیام شما با موفقیت ارسال شد.*', { 
        parse_mode: 'Markdown', 
        ...mainKeyboard(true, admin) 
      });
      
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : 
                    msg.video?.file_id || msg.document?.file_id || msg.animation?.file_id || null;
      
      await pool.query(
        `INSERT INTO user_messages (telegram_id, message_text, media_type, media_file_id, is_from_user)
        VALUES ($1, $2, $3, $4, TRUE)`,
        [id, msg.caption || text, 
         msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : msg.animation ? 'animation' : 'text', 
         fileId]
      );
      
      await addPoints(id, 'message_admin');
      return;
    }
    
    // 4. چت با هوش مصنوعی
    if (state.type === 'ai_chat') {
      if (text === '↩️ بازگشت') {
        cleanupUserState(id);
        await bot.sendMessage(id, '↩️ چت با هوش مصنوعی بسته شد.', mainKeyboard(true, admin));
        return;
      }
      
      const vip = await isVip(id);
      const { rows: usedRows } = await pool.query(
        'SELECT ai_questions_used, weekly_ai_questions, weekly_ai_limit, extra_ai_questions FROM users WHERE telegram_id = $1', 
        [id]
      );
      
      const used = usedRows[0]?.ai_questions_used || 0;
      const weeklyUsed = usedRows[0]?.weekly_ai_questions || 0;
      const weeklyLimit = usedRows[0]?.weekly_ai_limit || 5;
      const extraQuestions = usedRows[0]?.extra_ai_questions || 0;
      
      const totalQuestionsLeft = vip ? 999 : (weeklyLimit - weeklyUsed + extraQuestions);
      
      if (!vip && totalQuestionsLeft <= 0) {
        await bot.sendMessage(id, 
          '⚠️ *تعداد سوالات شما تمام شده است.*\n\n' +
          '🛒 برای خرید سوال بیشتر به فروشگاه امتیاز مراجعه کنید.\n' +
          '💎 یا با عضویت VIP از سوالات نامحدود بهره‌مند شوید.',
          { parse_mode: 'Markdown', ...mainKeyboard(true, admin) }
        );
        
        cleanupUserState(id);
        return;
      }
      
      const { rows } = await pool.query('SELECT ai_token, prompt_content, ai_model FROM settings');
      if (!rows[0]?.ai_token) {
        await bot.sendMessage(id, '⚠️ هوش مصنوعی توسط ادمین تنظیم نشده است.', mainKeyboard(true, admin));
        cleanupUserState(id);
        return;
      }
      
      const messages = rows[0].prompt_content ? [{ role: 'system', content: rows[0].prompt_content }] : [];
      messages.push({ role: 'user', content: text });
      
      try {
        const reply = await callDeepSeekAI(rows[0].ai_token, messages, rows[0].ai_model);
        
        if (!reply) {
          throw new Error('هوش مصنوعی پاسخی نداد');
        }
        
        await bot.sendMessage(id, reply, backKeyboard());
        
        if (!vip) {
          if (extraQuestions > 0) {
            await pool.query(
              'UPDATE users SET extra_ai_questions = extra_ai_questions - 1 WHERE telegram_id = $1',
              [id]
            );
          } else {
            await pool.query(
              'UPDATE users SET weekly_ai_questions = weekly_ai_questions + 1 WHERE telegram_id = $1',
              [id]
            );
          }
        }
        
        await pool.query('UPDATE users SET ai_questions_used = ai_questions_used + 1 WHERE telegram_id = $1', [id]);
        await pool.query('INSERT INTO ai_chats (telegram_id, user_question, ai_response) VALUES ($1, $2, $3)', [id, text, reply]);
        await addPoints(id, 'ai_chat');
        
      } catch (err) {
        console.error('❌ خطا در ارتباط با هوش مصنوعی:', err.message);
        
        // ارجاع به ادمین
        await referToAdmin(id, text, err);
        
        cleanupUserState(id);
      }
      return;
    }
    
    // 5. سیستم استوری
    if (state.type === 'story_request_info') {
      if (text === '📨 درخواست بنر و لینک') {
        await pool.query(
          'INSERT INTO story_requests (telegram_id, status) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET status = $2',
          [id, 'requested']
        );
        
        // اطلاع به ادمین
        await bot.sendMessage(ADMIN_CHAT_ID,
          `🎁 *درخواست بنر استوری*\n━━━━━━━━━━━━━━━━\n👤 کاربر: ${id}\n📅 زمان: ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━\nلطفاً بنر و لینک را برای کاربر ارسال کنید.`,
          { parse_mode: 'Markdown' }
        );
        
        states[id] = { type: 'story_waiting_banner' };
        await bot.sendMessage(id,
          '✅ *درخواست شما ثبت شد!*\n\n' +
          'ادمین به زودی بنر و لینک را برای شما ارسال می‌کند.\n' +
          'پس از دریافت، آن را در استوری منتشر کنید و بعد از 24 ساعت اسکرین‌شات را ارسال کنید.',
          {
            parse_mode: 'Markdown',
            ...createReplyKeyboard([
              [{ text: '📸 ارسال اسکرین‌شات' }],
              [{ text: '❌ انصراف' }]
            ], { one_time: true })
          }
        );
        
      } else if (text === '❌ انصراف') {
        cleanupUserState(id);
        await bot.sendMessage(id, '❌ درخواست استوری لغو شد.', mainKeyboard(true, admin));
      }
      return;
    }
    
    if (state.type === 'story_waiting_banner') {
      if (text === '📸 ارسال اسکرین‌شات') {
        await bot.sendMessage(id, '📸 لطفاً اسکرین‌شات استوری را ارسال کنید:');
        states[id] = { type: 'story_submit_screenshot' };
      } else if (text === '❌ انصراف') {
        await pool.query('DELETE FROM story_requests WHERE telegram_id = $1', [id]);
        cleanupUserState(id);
        await bot.sendMessage(id, '❌ درخواست استوری لغو شد.', mainKeyboard(true, admin));
      }
      return;
    }
    
    if (state.type === 'story_submit_screenshot' && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      
      await pool.query(
        'UPDATE story_requests SET story_screenshot = $1, submitted_at = NOW(), status = $2 WHERE telegram_id = $3',
        [fileId, 'submitted', id]
      );
      
      // ارسال به ادمین با inline keyboard
      await bot.sendPhoto(ADMIN_CHAT_ID, fileId, {
        caption: `📸 *اسکرین‌شات استوری*\n━━━━━━━━━━━━━━━━\n👤 کاربر: ${id}\n📅 زمان ارسال: ${moment().format('jYYYY/jM/jD HH:mm')}`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ تأیید و اعطای 300 امتیاز', callback_data: `approve_story_${id}` },
              { text: '❌ رد درخواست', callback_data: `reject_story_${id}` }
            ],
            [
              { text: '👁️ مشاهده کاربر', callback_data: `viewuser_${id}` }
            ]
          ]
        }
      });
      
      cleanupUserState(id);
      await bot.sendMessage(id,
        '✅ *اسکرین‌شات ارسال شد!*\n\n' +
        'درخواست شما برای ادمین ارسال شد.\n' +
        'پس از تأیید، 300 امتیاز به حساب شما اضافه خواهد شد.',
        { parse_mode: 'Markdown', ...mainKeyboard(true, admin) }
      );
      return;
    }
    
    // 6. مدیریت پرامپت ادمین
    if (state.type === 'upload_prompt' && msg.document) {
      if (msg.document.file_name && msg.document.file_name.endsWith('.txt')) {
        try {
          const file = await bot.getFile(msg.document.file_id);
          const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
          const response = await fetch(url);
          const content = await response.text();
          
          await pool.query('UPDATE settings SET prompt_content = $1', [content]);
          
          // ایجاد فایل برای ارسال به ادمین
          const tempFile = saveTempFile(id, content, '_prompt.txt');
          
          await bot.sendDocument(id, tempFile, {
            caption: `✅ *پرامپت ذخیره شد!*\n\n📏 طول: ${content.length} کاراکتر\n💾 حجم: ${Math.round(content.length / 1024)}KB`
          });
          
          cleanupUserState(id);
          await bot.sendMessage(id, '🤖 *مدیریت هوش مصنوعی:*', { 
            parse_mode: 'Markdown', 
            ...aiAdminKeyboard() 
          });
          states[id] = { type: 'admin_ai_menu' };
          
        } catch (err) {
          console.error('❌ خطا در آپلود پرامپت:', err);
          await bot.sendMessage(id, '❌ خطا در پردازش فایل.');
        }
      } else {
        await bot.sendMessage(id, '❌ لطفاً یک فایل متنی (.txt) ارسال کنید.');
      }
      return;
    }
    
    if (state.type === 'view_prompt') {
      const { rows } = await pool.query('SELECT prompt_content FROM settings');
      const prompt = rows[0]?.prompt_content;
      
      if (!prompt) {
        await bot.sendMessage(id, '⚠️ پرامپتی ذخیره نشده است.');
      } else {
        const tempFile = saveTempFile(id, prompt, '_current_prompt.txt');
        
        await bot.sendDocument(id, tempFile, {
          caption: `📄 *پرامپت فعلی*\n\n📏 طول: ${prompt.length} کاراکتر\n📊 خطوط: ${prompt.split('\n').length}\n💾 حجم: ${Math.round(prompt.length / 1024)}KB`
        });
      }
      
      cleanupUserState(id);
      await bot.sendMessage(id, '🤖 *مدیریت هوش مصنوعی:*', { 
        parse_mode: 'Markdown', 
        ...aiAdminKeyboard() 
      });
      states[id] = { type: 'admin_ai_menu' };
      return;
    }
    
    // 7. عضویت VIP
    if (state.type === 'vip_waiting') {
      if (text === '📸 ارسال عکس فیش واریزی') {
        await bot.sendMessage(id, '📸 لطفاً عکس فیش واریزی را ارسال کنید.');
        states[id] = { type: 'vip_receipt' };
      } else if (text === '❌ انصراف از عضویت VIP') {
        cleanupUserState(id);
        await bot.sendMessage(id, '❌ عضویت VIP لغو شد.', mainKeyboard(true, admin));
      }
      return;
    }
    
    if (state.type === 'vip_receipt' && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      
      const message = `📸 *رسید پرداخت VIP*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${id}\n📅 *زمان:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━`;
      
      await bot.sendMessage(ADMIN_CHAT_ID, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ تأیید و فعال‌سازی VIP', callback_data: `approve_${id}` },
              { text: '❌ رد درخواست', callback_data: `reject_${id}` }
            ]
          ]
        }
      });
      
      await pool.query(
        'INSERT INTO vips (telegram_id, payment_receipt) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET payment_receipt = $2',
        [id, fileId]
      );
      
      cleanupUserState(id);
      await bot.sendMessage(id, '✅ *رسید ارسال شد. منتظر تأیید ادمین باشید.*', { 
        parse_mode: 'Markdown', 
        ...mainKeyboard(true, admin) 
      });
      return;
    }
    
    // 8. پاسخ ادمین به کاربر
    if (state.type === 'reply_to_user') {
      if (text === '/cancel') {
        cleanupUserState(id);
        await bot.sendMessage(id, '❌ پاسخ لغو شد.');
        return;
      }
      
      await bot.sendMessage(state.userId, text);
      await pool.query(
        'INSERT INTO user_messages (telegram_id, message_text, is_from_user) VALUES ($1, $2, FALSE)',
        [state.userId, text]
      );
      
      await bot.sendMessage(id, '✅ *پاسخ ارسال شد.*', { parse_mode: 'Markdown' });
      cleanupUserState(id);
      return;
    }
    
    // 9. پاسخ ادمین به کاربر (ارجاع از AI)
    if (state.type === 'ai_reply_to_user') {
      if (text === '/cancel') {
        cleanupUserState(id);
        await bot.sendMessage(id, '❌ پاسخ لغو شد.');
        return;
      }
      
      await bot.sendMessage(state.userId,
        `💬 *پاسخ از کانیا:*\n\n${text}\n\n📝 *این پیام به دلیل خطای موقت در هوش مصنوعی توسط کانیا پاسخ داده شد.*`,
        { parse_mode: 'Markdown' }
      );
      
      await pool.query(
        'INSERT INTO user_messages (telegram_id, message_text, is_from_user) VALUES ($1, $2, FALSE)',
        [state.userId, text]
      );
      
      await bot.sendMessage(id, '✅ *پاسخ ارسال شد.*', { parse_mode: 'Markdown' });
      cleanupUserState(id);
      return;
    }
    
  } catch (err) {
    console.error('❌ خطا در handleState:', err.message, err.stack);
    await bot.sendMessage(id, '❌ خطای داخلی رخ داد. لطفاً دوباره تلاش کنید.');
    cleanupUserState(id);
  }
}

// ==================== /start Command ====================
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  
  if (!checkRateLimit(id)) {
    await bot.sendMessage(id, '⚠️ درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.');
    return;
  }
  
  const username = msg.from.username ? `@${msg.from.username}` : null;
  
  try {
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM users WHERE telegram_id = $1',
      [id]
    );
    
    const isFirstLogin = existing.length === 0;
    
    await pool.query(
      `INSERT INTO users (telegram_id, username) 
       VALUES ($1, $2) 
       ON CONFLICT (telegram_id) 
       DO UPDATE SET username = EXCLUDED.username`,
      [id, username]
    );
    
    if (isFirstLogin) {
      await addPoints(id, 'first_login');
    }
    
    const registered = await isRegistered(id);
    const admin = id === ADMIN_CHAT_ID;
    
    await bot.sendMessage(
      id,
      '🌟 به ربات KaniaChatBot خوش آمدید! 🌟\n\nلطفاً از منوی زیر استفاده کنید 👇',
      mainKeyboard(registered, admin)
    );
    
    logActivity(id, 'استارت کرد');
  } catch (err) {
    console.error('❌ خطا در دستور /start:', err.message, err.stack);
    await bot.sendMessage(id, '❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
  }
});

// ==================== Message Management ====================
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text || '';
  const admin = id === ADMIN_CHAT_ID;
  
  if (!checkRateLimit(id)) {
    await bot.sendMessage(id, '⚠️ درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.');
    return;
  }
  
  console.log(`📨 User ${id}: "${text.substring(0, 50)}"`);
  
  // اگر در state هستیم
  if (states[id]) {
    await handleState(id, text, msg);
    return;
  }
  
  // ---------- منوی اصلی کاربران ----------
  
  // 📊 آمار من
  if (text === '📊 آمار من') {
    try {
      const stats = await formatUserStats(id);
      if (stats) {
        await bot.sendMessage(id, stats, { 
          parse_mode: 'Markdown', 
          ...statsKeyboard() 
        });
      } else {
        await bot.sendMessage(id, '⚠️ ابتدا ثبت‌نام کنید.', mainKeyboard(false, admin));
      }
    } catch (err) {
      console.error('❌ خطا در نمایش آمار:', err);
      await bot.sendMessage(id, '❌ خطا در بارگذاری آمار.');
    }
    return;
  }
  
  // 🛒 فروشگاه امتیاز
  if (text === '🛒 فروشگاه امتیاز') {
    try {
      const shopMessage = await showPointShop(id);
      await bot.sendMessage(id, shopMessage, { 
        parse_mode: 'Markdown', 
        ...backKeyboard() 
      });
      states[id] = { type: 'point_shop' };
    } catch (err) {
      console.error('❌ خطا در نمایش فروشگاه:', err);
      await bot.sendMessage(id, '❌ خطا در بارگذاری فروشگاه.');
    }
    return;
  }
  
  // 🎁 دریافت 300 امتیاز با استوری
  if (text === '🎁 دریافت 300 امتیاز با استوری') {
    await bot.sendMessage(id,
      `🎁 *دریافت 300 امتیاز با انتشار استوری!*\n\n` +
      `📌 *مراحل دریافت امتیاز:*\n` +
      `1. درخواست بنر و لینک می‌دهید\n` +
      `2. بنر ما را در استوری منتشر می‌کنید\n` +
      `3. بعد از 24 ساعت اسکرین‌شات می‌فرستید\n` +
      `4. پس از تأیید ادمین، 300 امتیاز دریافت می‌کنید\n\n` +
      `💰 *مبلغ جایزه:* 300 امتیاز\n` +
      `⏱️ *زمان مورد نیاز:* 24 ساعت بعد از انتشار\n\n` +
      `آیا مایل به ادامه هستید؟`,
      {
        parse_mode: 'Markdown',
        ...createReplyKeyboard([
          [{ text: '📨 درخواست بنر و لینک' }],
          [{ text: '❌ انصراف' }]
        ], { one_time: true })
      }
    );
    states[id] = { type: 'story_request_info' };
    return;
  }
  
  // 📺 کانال رایگان
  if (text === '📺 کانال رایگان') {
    try {
      const { rows } = await pool.query('SELECT free_channel FROM settings');
      await bot.sendMessage(id, 
        `📢 *کانال رایگان*\n━━━━━━━━━━━━━━━━\n${rows[0]?.free_channel || 'تنظیم نشده ⚠️'}\n━━━━━━━━━━━━━━━━`, 
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('❌ خطا در نمایش کانال:', err);
      await bot.sendMessage(id, '❌ خطا در بارگذاری اطلاعات کانال.');
    }
    return;
  }
  
  // 💎 عضویت VIP
  if (text === '💎 عضویت VIP') {
    try {
      const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
      const s = rows[0];
      
      if (s?.membership_fee && s?.wallet_address && s?.network) {
        const msgText = `💎 *عضویت VIP* 💎\n━━━━━━━━━━━━━━━━\n💰 *مبلغ:* ${s.membership_fee}\n\n👛 *آدرس کیف پول:*\n\`${s.wallet_address}\`\n\n🌐 *شبکه:* ${s.network}\n━━━━━━━━━━━━━━━━\n📸 پس از واریز، عکس فیش را ارسال کنید.`;
        await bot.sendMessage(id, escapeMarkdown(msgText), { 
          parse_mode: 'Markdown', 
          ...vipKeyboard() 
        });
        states[id] = { type: 'vip_waiting' };
      } else {
        await bot.sendMessage(id, '⚠️ اطلاعات VIP توسط ادمین تنظیم نشده است.');
      }
    } catch (err) {
      console.error('❌ خطا در نمایش اطلاعات VIP:', err);
      await bot.sendMessage(id, '❌ خطا در بارگذاری اطلاعات VIP.');
    }
    return;
  }
  
  // 💬 ارسال پیام به کانیا
  if (text === '💬 ارسال پیام به کانیا') {
    await bot.sendMessage(id, '💬 پیام خود را بنویسید (متن، عکس، ویدیو، فایل یا گیف).');
    states[id] = { type: 'chat_admin' };
    return;
  }
  
  // 🤖 چت با هوش مصنوعی
  if (text === '🤖 چت با هوش مصنوعی') {
    try {
      const { rows } = await pool.query('SELECT ai_token FROM settings');
      if (!rows[0]?.ai_token) {
        await bot.sendMessage(id, '⚠️ هوش مصنوعی توسط ادمین تنظیم نشده است.');
        return;
      }
      await bot.sendMessage(id, '🧠 سوال خود را بپرسید.', backKeyboard());
      states[id] = { type: 'ai_chat' };
    } catch (err) {
      console.error('❌ خطا در چت با AI:', err);
      await bot.sendMessage(id, '❌ خطا در راه‌اندازی چت.');
    }
    return;
  }
  
  // 📝 ثبت‌نام / ✏️ ویرایش اطلاعات
  if (text === '📝 ثبت‌نام' || text === '✏️ ویرایش اطلاعات') {
    const registered = await isRegistered(id);
    if (!registered) {
      states[id] = { type: 'register_full', step: 0, data: {} };
      await bot.sendMessage(id, '📝 *ثبت‌نام جدید*\n━━━━━━━━━━━━━━━━\n👤 نام خود را وارد کنید:', { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(id, '✏️ کدام فیلد را می‌خواهید ویرایش کنید؟', editKeyboard());
      states[id] = { type: 'edit_menu' };
    }
    return;
  }
  
  // ↩️ بازگشت
  if (text === '↩️ بازگشت' || text === '↩️ بازگشت به منو اصلی') {
    cleanupUserState(id);
    const registered = await isRegistered(id);
    await bot.sendMessage(id, '↩️ بازگشت به منو اصلی', mainKeyboard(registered, admin));
    return;
  }
  
  // دستور خرید
  if (text.startsWith('/buy_')) {
    const itemCode = text.replace('/buy_', '');
    const result = await handlePurchase(id, itemCode);
    
    if (result.success) {
      await bot.sendMessage(id, 
        `✅ *خرید موفقیت‌آمیز!*\n\n` +
        `🎁 *آیتم:* ${result.item.item_name}\n` +
        `💰 *هزینه:* ${result.item.price} امتیاز\n\n` +
        `مزایا در حساب شما اعمال شدند.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(id, 
        `❌ *خرید ناموفق!*\n\n` +
        `دلیل: ${result.reason}`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }
  
  // ---------- منوی ادمین ----------
  if (admin) {
    // 🛡️ پنل ادمین
    if (text === '🛡️ پنل ادمین') {
      await bot.sendMessage(id, '🛡️ *پنل ادمین فعال شد*', { 
        parse_mode: 'Markdown', 
        ...adminKeyboard() 
      });
      return;
    }
    
    // 🤖 هوش مصنوعی
    if (text === '🤖 هوش مصنوعی') {
      await bot.sendMessage(id, '🤖 *مدیریت هوش مصنوعی:*', { 
        parse_mode: 'Markdown', 
        ...aiAdminKeyboard() 
      });
      states[id] = { type: 'admin_ai_menu' };
      return;
    }
    
    // 📊 آمار
    if (text === '📊 آمار') {
      try {
        const { rows: total } = await pool.query('SELECT COUNT(*) FROM users');
        const { rows: vipCount } = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
        const { rows: dailyActive } = await pool.query(
          'SELECT COUNT(DISTINCT telegram_id) FROM daily_activities WHERE activity_date = CURRENT_DATE'
        );
        
        const stats = `📊 *آمار کلی*\n━━━━━━━━━━━━━━━━\n👥 *کل کاربران:* ${total[0].count}\n💎 *کاربران VIP فعال:* ${vipCount[0].count}\n📈 *نسبت VIP:* ${((vipCount[0].count / total[0].count) * 100 || 0).toFixed(1)}%\n📅 *کاربران فعال امروز:* ${dailyActive[0].count || 0}\n━━━━━━━━━━━━━━━━`;
        await bot.sendMessage(id, stats, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('❌ خطا در نمایش آمار:', err);
        await bot.sendMessage(id, '❌ خطا در بارگذاری آمار.');
      }
      return;
    }
    
    // مدیریت منوی AI (ادمین)
    if (states[id] && states[id].type === 'admin_ai_menu') {
      if (text === '📂 ارسال فایل پرامپت') {
        await bot.sendMessage(id, '📂 فایل پرامپت (.txt) را ارسال کنید:');
        states[id] = { type: 'upload_prompt' };
        return;
      }
      
      if (text === '👀 مشاهده پرامپت') {
        states[id] = { type: 'view_prompt' };
        await handleState(id, '', msg);
        return;
      }
      
      if (text === '↩️ بازگشت به پنل ادمین') {
        cleanupUserState(id);
        await bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
        return;
      }
    }
  }
  
  // سایر state‌ها
  if (states[id] && states[id].type === 'point_shop') {
    if (text === '↩️ بازگشت') {
      cleanupUserState(id);
      const registered = await isRegistered(id);
      await bot.sendMessage(id, '↩️ بازگشت', mainKeyboard(registered, admin));
    }
    return;
  }
});

// ==================== مدیریت Callback Query ====================
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;
  const chatId = callbackQuery.message.chat.id;
  
  console.log(`🔘 Callback: ${data} from ${userId}`);
  
  try {
    // 1. تأیید VIP
    if (data.startsWith('approve_')) {
      const targetUserId = parseInt(data.replace('approve_', ''));
      
      if (userId !== ADMIN_CHAT_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⛔ دسترسی غیرمجاز!', 
          show_alert: true 
        });
        return;
      }
      
      const endDate = moment().add(1, 'month').toDate();
      await pool.query(
        'UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2',
        [endDate, targetUserId]
      );
      
      const { rows } = await pool.query('SELECT vip_channel FROM settings');
      await bot.sendMessage(targetUserId,
        `🎉 *عضویت VIP شما تأیید شد!*\n━━━━━━━━━━━━━━━━\n📅 *معتبر تا:* ${moment(endDate).format('jYYYY/jM/jD')}\n📢 *کانال VIP:* ${rows[0]?.vip_channel || 'تنظیم نشده'}\n━━━━━━━━━━━━━━━━\nممنون از اعتماد شما! 💎`,
        { parse_mode: 'Markdown' }
      );
      
      await addPoints(targetUserId, 'vip_purchase');
      
      await bot.answerCallbackQuery(callbackQuery.id, { 
        text: '✅ VIP کاربر تأیید شد و 500 امتیاز دریافت کرد!', 
        show_alert: true 
      });
      
      await bot.editMessageText(`✅ VIP کاربر ${targetUserId} تأیید شد.\n📅 پایان: ${moment(endDate).format('jYYYY/jM/jD')}`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      return;
    }
    
    // 2. رد VIP
    if (data.startsWith('reject_')) {
      const targetUserId = parseInt(data.replace('reject_', ''));
      
      if (userId !== ADMIN_CHAT_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⛔ دسترسی غیرمجاز!', 
          show_alert: true 
        });
        return;
      }
      
      await pool.query('UPDATE vips SET approved = FALSE WHERE telegram_id = $1', [targetUserId]);
      
      await bot.sendMessage(targetUserId,
        '❌ *رسید پرداخت شما تأیید نشد.*\n━━━━━━━━━━━━━━━━\nلطفاً اطلاعات واریز را بررسی کرده و دوباره تلاش کنید.\nدر صورت مشکل با پشتیبانی تماس بگیرید.\n━━━━━━━━━━━━━━━━',
        { parse_mode: 'Markdown' }
      );
      
      await bot.answerCallbackQuery(callbackQuery.id, { 
        text: '❌ درخواست VIP رد شد.', 
        show_alert: true 
      });
      
      await bot.editMessageText(`❌ درخواست VIP کاربر ${targetUserId} رد شد.`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      return;
    }
    
    // 3. تأیید استوری
    if (data.startsWith('approve_story_')) {
      const targetUserId = parseInt(data.replace('approve_story_', ''));
      
      if (userId !== ADMIN_CHAT_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⛔ دسترسی غیرمجاز!', 
          show_alert: true 
        });
        return;
      }
      
      await pool.query(
        `UPDATE story_requests 
         SET approved_by_admin = $1, approved_at = NOW(), status = 'approved', points_awarded = 300
         WHERE telegram_id = $2`,
        [ADMIN_CHAT_ID, targetUserId]
      );
      
      await addPoints(targetUserId, 'post_story');
      
      await bot.sendMessage(targetUserId,
        `🎉 *استوری شما تأیید شد!*\n\n✅ ۳۰۰ امتیاز به حساب شما اضافه شد.\n🏆 امتیاز خود را در بخش آمار مشاهده کنید.`,
        { parse_mode: 'Markdown' }
      );
      
      await bot.answerCallbackQuery(callbackQuery.id, { 
        text: '✅ استوری تأیید و 300 امتیاز اعطا شد!', 
        show_alert: true 
      });
      
      await bot.editMessageText(`✅ استوری کاربر ${targetUserId} تأیید شد.\n🎁 300 امتیاز به کاربر اعطا گردید.`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      return;
    }
    
    // 4. رد استوری
    if (data.startsWith('reject_story_')) {
      const targetUserId = parseInt(data.replace('reject_story_', ''));
      
      if (userId !== ADMIN_CHAT_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⛔ دسترسی غیرمجاز!', 
          show_alert: true 
        });
        return;
      }
      
      await pool.query(
        `UPDATE story_requests 
         SET status = 'rejected'
         WHERE telegram_id = $1`,
        [targetUserId]
      );
      
      await bot.sendMessage(targetUserId,
        `❌ *استوری شما تأیید نشد.*\n\n` +
        `لطفاً مطمئن شوید که:\n` +
        `۱. استوری را به درستی منتشر کرده‌اید\n` +
        `۲. اسکرین‌شات واضح است\n` +
        `۳. حداقل ۲۴ ساعت از انتشار گذشته باشد`,
        { parse_mode: 'Markdown' }
      );
      
      await bot.answerCallbackQuery(callbackQuery.id, { 
        text: '❌ استوری رد شد.', 
        show_alert: true 
      });
      
      await bot.editMessageText(`❌ استوری کاربر ${targetUserId} رد شد.`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      return;
    }
    
    // 5. پاسخ به کاربر
    if (data.startsWith('reply_')) {
      const targetUserId = parseInt(data.replace('reply_', ''));
      
      if (userId !== ADMIN_CHAT_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⛔ دسترسی غیرمجاز!', 
          show_alert: true 
        });
        return;
      }
      
      await bot.sendMessage(userId, 
        `💬 *پاسخ به کاربر ${targetUserId}*\n━━━━━━━━━━━━━━━━\nپاسخ خود را بنویسید (برای لغو /cancel):`, 
        { parse_mode: 'Markdown' }
      );
      
      states[userId] = { type: 'reply_to_user', userId: targetUserId };
      
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    
    // 6. پاسخ به کاربر (ارجاع از AI)
    if (data.startsWith('ai_reply_')) {
      const targetUserId = parseInt(data.replace('ai_reply_', ''));
      
      if (userId !== ADMIN_CHAT_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⛔ دسترسی غیرمجاز!', 
          show_alert: true 
        });
        return;
      }
      
      await bot.sendMessage(userId, 
        `🤖↩️ *پاسخ به کاربر ${targetUserId} (ارجاع از AI)*\n━━━━━━━━━━━━━━━━\nپاسخ خود را بنویسید (برای لغو /cancel):`, 
        { parse_mode: 'Markdown' }
      );
      
      states[userId] = { type: 'ai_reply_to_user', userId: targetUserId };
      
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    
    // 7. مشاهده کاربر
    if (data.startsWith('viewuser_')) {
      const targetUserId = parseInt(data.replace('viewuser_', ''));
      
      if (userId !== ADMIN_CHAT_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⛔ دسترسی غیرمجاز!', 
          show_alert: true 
        });
        return;
      }
      
      const { rows: userRows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [targetUserId]);
      const { rows: vipRows } = await pool.query('SELECT * FROM vips WHERE telegram_id = $1', [targetUserId]);
      
      if (userRows.length === 0) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '❌ کاربر یافت نشد!', 
          show_alert: true 
        });
        return;
      }
      
      const user = userRows[0];
      const isVip = vipRows.length > 0;
      const vip = vipRows[0];
      
      let details = `👤 *جزئیات کاربر*\n━━━━━━━━━━━━━━━━\n`;
      details += `🆔 *آیدی:* \`${targetUserId}\`\n`;
      details += `👤 *نام کاربری:* @${user.username || 'ندارد'}\n`;
      details += `📛 *نام:* ${escapeMarkdown(user.name || 'نامشخص')}\n`;
      details += `🎂 *سن:* ${user.age || 'نامشخص'}\n`;
      details += `🏙️ *شهر:* ${escapeMarkdown(user.city || 'نامشخص')}\n`;
      details += `🌍 *منطقه:* ${escapeMarkdown(user.region || 'نامشخص')}\n`;
      details += `⚧️ *جنسیت:* ${escapeMarkdown(user.gender || 'نامشخص')}\n`;
      details += `💼 *شغل:* ${escapeMarkdown(user.job || 'نامشخص')}\n`;
      details += `🎯 *هدف:* ${escapeMarkdown(user.goal || 'نامشخص')}\n`;
      details += `📱 *شماره:* ${user.phone || 'نامشخص'}\n`;
      details += `🤖 *سوالات AI:* ${user.ai_questions_used || 0}\n`;
      details += `⭐ *امتیاز:* ${user.total_score || 0}\n`;
      details += `📊 *سطح:* ${user.current_level || 0}\n`;
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
      
      await bot.sendMessage(userId, details, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💬 پاسخ', callback_data: `reply_${targetUserId}` },
              { text: '📜 آرشیو چت', callback_data: `archive_${targetUserId}` }
            ],
            [
              { text: isVip ? '❌ حذف VIP' : '💎 تبدیل به VIP', callback_data: isVip ? `removevip_${targetUserId}` : `makevip_${targetUserId}` },
              { text: '🎁 اعطای امتیاز', callback_data: `addpoints_${targetUserId}` }
            ]
          ]
        }
      });
      
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    
    // 8. آرشیو چت کاربر
    if (data.startsWith('archive_')) {
      const targetUserId = parseInt(data.replace('archive_', ''));
      
      if (userId !== ADMIN_CHAT_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: '⛔ دسترسی غیرمجاز!', 
          show_alert: true 
        });
        return;
      }
      
      const { rows: msgs } = await pool.query(
        'SELECT * FROM user_messages WHERE telegram_id = $1 ORDER BY timestamp DESC LIMIT 20',
        [targetUserId]
      );
      
      let archive = `📜 *آرشیو چت کاربر ${targetUserId}*\n━━━━━━━━━━━━━━━━\n`;
      
      if (msgs.length === 0) {
        archive += `📭 هیچ پیامی یافت نشد.\n`;
      } else {
        msgs.forEach((m, index) => {
          const time = moment(m.timestamp).format('jYYYY/jM/jD HH:mm');
          const sender = m.is_from_user ? '👤 کاربر' : '🛡️ ادمین';
          const text = m.message_text ? m.message_text.substring(0, 100) + (m.message_text.length > 100 ? '...' : '') : '[رسانه]';
          archive += `${index + 1}. ${sender} (${time}):\n   ${escapeMarkdown(text)}\n   ──────────────\n`;
        });
      }
      
      archive += `━━━━━━━━━━━━━━━━\n`;
      archive += `📊 تعداد پیام‌ها: ${msgs.length}`;
      
      await bot.sendMessage(userId, archive, { parse_mode: 'Markdown' });
      
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    
    // سایر callback‌ها
    await bot.answerCallbackQuery(callbackQuery.id);
    
  } catch (err) {
    console.error('❌ خطا در callback query:', err.message, err.stack);
    await bot.answerCallbackQuery(callbackQuery.id, { 
      text: '❌ خطا در پردازش درخواست!', 
      show_alert: true 
    });
  }
});

// ==================== Webhook Routes ====================
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'KaniaChatBot',
    timestamp: new Date().toISOString(),
    webhook: WEBHOOK_URL ? 'configured' : 'not-configured',
    uptime: process.uptime()
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ==================== Graceful Shutdown ====================
async function gracefulShutdown() {
  console.log('🛑 در حال خاموش کردن ربات...');
  
  try {
    if (isPolling) {
      console.log('⏹️ توقف polling...');
      bot.stopPolling();
      isPolling = false;
      console.log('✅ Polling متوقف شد.');
    }
  } catch (err) {
    console.error('❌ خطا در توقف polling:', err.message);
  }
  
  try {
    console.log('🗑️ حذف webhook...');
    await bot.deleteWebHook();
    console.log('✅ Webhook حذف شد.');
  } catch (err) {
    console.error('❌ خطا در حذف webhook:', err.message);
  }
  
  try {
    console.log('🔌 بستن اتصال دیتابیس...');
    await pool.end();
    console.log('✅ اتصال دیتابیس بسته شد.');
  } catch (err) {
    console.error('❌ خطا در بستن دیتابیس:', err.message);
  }
  
  if (server) {
    console.log('🔌 بستن سرور HTTP...');
    server.close();
    console.log('✅ سرور HTTP بسته شد.');
  }
  
  console.log('👋 ربات خاموش شد.');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

// ==================== Error Handlers ====================
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason, reason?.stack);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message, error.stack);
  gracefulShutdown().then(() => {
    process.exit(1);
  });
});

bot.on('error', (err) => {
  console.error('❌ خطای Telegram Bot:', err.message, err.stack);
});

bot.on('polling_error', (err) => {
  console.error('❌ خطای Polling:', err.message, err.stack);
});

// ==================== Server Startup ====================
async function startServer() {
  console.log('🚀 راه‌اندازی KaniaChatBot...');
  console.log(`🌐 پورت: ${PORT}`);
  console.log(`🤖 توکن: ${BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`👑 ادمین: ${ADMIN_CHAT_ID}`);
  console.log(`🔗 وب‌هوک: ${WEBHOOK_URL ? '✅' : '❌'}`);
  
  try {
    // ایجاد جدول‌ها
    const tablesCreated = await createTables();
    if (!tablesCreated) {
      console.error('❌ خطا در ایجاد جدول‌ها. خروج...');
      process.exit(1);
    }
    
    console.log('🗄️ دیتابیس آماده است');
    
    // راه‌اندازی webhook یا polling
    if (WEBHOOK_URL && WEBHOOK_URL.trim() !== '') {
      const webhookUrl = WEBHOOK_URL.trim();
      console.log(`🌍 تنظیم Webhook: ${webhookUrl}`);
      
      try {
        await bot.deleteWebHook();
        await bot.setWebHook(webhookUrl);
        console.log('✅ Webhook تنظیم شد.');
      } catch (err) {
        console.error('❌ خطا در تنظیم webhook:', err.message);
        console.log('🔁 فعال‌سازی polling...');
        await startPolling();
      }
    } else {
      console.log('🔁 فعال‌سازی polling...');
      await startPolling();
    }
    
    // شروع سرور Express
    server = app.listen(PORT, () => {
      console.log(`✅ سرور Express روی پورت ${PORT} راه‌اندازی شد`);
      console.log('🎉 KaniaChatBot آماده است! 🚀');
    });
    
    // مدیریت خطای پورت در حال استفاده
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ پورت ${PORT} در حال استفاده است!`);
        console.log('🔄 تلاش برای استفاده از پورت تصادفی...');
        
        // بستن سرور فعلی
        if (server) {
          server.close();
        }
        
        // تلاش با پورت تصادفی
        const randomPort = Math.floor(Math.random() * (65535 - 1024) + 1024);
        server = app.listen(randomPort, () => {
          console.log(`✅ سرور Express روی پورت ${randomPort} راه‌اندازی شد`);
          console.log('🎉 KaniaChatBot آماده است! 🚀');
        });
      } else {
        console.error('❌ خطای سرور:', err.message);
        process.exit(1);
      }
    });
    
  } catch (err) {
    console.error('❌ خطا در راه‌اندازی سرور:', err.message, err.stack);
    process.exit(1);
  }
}

async function startPolling() {
  try {
    await bot.startPolling({
      timeout: 10,
      interval: 300,
      autoStart: true
    });
    isPolling = true;
    console.log('✅ Polling فعال شد.');
  } catch (err) {
    console.error('❌ خطا در شروع polling:', err.message, err.stack);
    process.exit(1);
  }
}

// شروع برنامه
startServer();