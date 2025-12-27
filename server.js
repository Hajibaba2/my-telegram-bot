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

const states = {};
const rateLimit = {};
const tempFiles = {};

// -------------------- توابع کمکی --------------------
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

function confirmDangerKeyboard(action) {
  return createReplyKeyboard([
    [{ text: `⚠️ تأیید ریست ${action}` }],
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

// -------------------- مدیریت فایل موقت --------------------
function saveTempFile(userId, content, ext = '.txt') {
  const filename = `/tmp/${userId}_${Date.now()}${ext}`;
  fs.writeFileSync(filename, content, 'utf8');
  
  if (!tempFiles[userId]) tempFiles[userId] = [];
  tempFiles[userId].push(filename);
  
  // پاکسازی فایل‌های قدیمی بعد از 5 دقیقه
  setTimeout(() => {
    if (tempFiles[userId]) {
      tempFiles[userId].forEach(file => {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      });
      delete tempFiles[userId];
    }
  }, 5 * 60 * 1000);
  
  return filename;
}

// -------------------- ایجاد جداول --------------------
async function createTables() {
  console.log('🗄️ شروع ایجاد/بررسی جدول‌ها...');
  
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
    console.log('✅ جدول users ایجاد/بررسی شد');
    
    // جدول vips
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
    console.log('✅ جدول vips ایجاد/بررسی شد');
    
    // جدول settings
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
    await pool.query(`INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;`);
    console.log('✅ جدول settings ایجاد/بررسی شد');
    
    // جدول levels
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
    console.log('✅ جدول levels ایجاد/بررسی شد');
    
    // داده‌های اولیه levels
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
      console.log('✅ داده‌های levels اضافه شدند');
    } catch (err) {
      console.log('⚠️ داده‌های levels از قبل وجود دارند');
    }
    
    // جداول دیگر
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
      )`
    ];
    
    for (const tableQuery of otherTables) {
      try {
        await pool.query(tableQuery);
      } catch (err) {
        console.log(`⚠️ در ایجاد جدول: ${err.message.substring(0, 50)}`);
      }
    }
    
    // داده‌های اولیه فروشگاه
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
      console.log('✅ داده‌های فروشگاه اضافه شدند');
    } catch (err) {
      console.log('⚠️ داده‌های فروشگاه از قبل وجود دارند');
    }
    
    console.log('🎉 تمام جدول‌ها با موفقیت ایجاد/بررسی شدند');
    return true;
    
  } catch (err) {
    console.error('❌ خطای جدی در ایجاد جدول‌ها:', err.message);
    return false;
  }
}

// -------------------- سیستم امتیازدهی --------------------
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

async function checkLevelUp(userId) {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT total_score, current_level FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (userRows.length === 0) return;

    const userScore = userRows[0].total_score;
    const currentLevel = userRows[0].current_level;

    const { rows: newLevelRows } = await pool.query(
      'SELECT * FROM levels WHERE min_score <= $1 ORDER BY level_number DESC LIMIT 1',
      [userScore]
    );

    if (newLevelRows.length === 0) return;

    const newLevel = newLevelRows[0].level_number;

    if (newLevel > currentLevel) {
      await pool.query(
        'UPDATE users SET current_level = $1 WHERE telegram_id = $2',
        [newLevel, userId]
      );

      logActivity(userId, 'سطح ارتقاء یافت', `سطح ${currentLevel} → ${newLevel}`);
    }
  } catch (err) {
    console.error('❌ خطا در بررسی ارتقاء سطح:', err.message);
  }
}

// -------------------- سیستم DeepSeek AI --------------------
async function callDeepSeekAI(apiKey, messages, model = 'deepseek-chat', options = {}) {
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || 1000,
        ...options
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || 'پاسخی دریافت نشد.';
  } catch (err) {
    console.error('❌ خطا در ارتباط با DeepSeek:', err.message);
    throw err;
  }
}

// -------------------- سیستم فروشگاه امتیازی --------------------
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

// -------------------- کیبوردها --------------------
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

function statsKeyboard() {
  return createReplyKeyboard([
    [{ text: '📊 آمار من' }, { text: '🛒 فروشگاه امتیاز' }],
    [{ text: '📢 درخواست استوری' }],
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

function scoringManagementKeyboard() {
  return createReplyKeyboard([
    [{ text: '📊 تنظیمات امتیازدهی' }],
    [{ text: '🎮 مدیریت Level‌ها' }],
    [{ text: '👤 اعطای دستی امتیاز' }],
    [{ text: '📈 گزارش‌گیری' }],
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

// -------------------- توابع کمکی کاربر --------------------
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

// -------------------- مدیریت State --------------------
async function handleState(id, text, msg) {
  const state = states[id];
  const admin = id === ADMIN_CHAT_ID;
  
  if (!state) {
    console.log(`⚠️ No state for user ${id}`);
    return;
  }
  
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
          
          const report = formatUserReport(user, 'ثبت‌نام', username);
          await bot.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
        }
        
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
        
        await bot.sendMessage(id, message, { parse_mode: 'Markdown' });
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
      const value = field === 'age' ? parseInt(text) || null : text.trim() || null;
      
      await pool.query(`UPDATE users SET ${field} = $1 WHERE telegram_id = $2`, [value, id]);
      
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
        
        const report = formatUserReport(user, 'ویرایش', username);
        await bot.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
      }
      
      await bot.sendMessage(id, '✅ ویرایش شد.', editKeyboard());
      states[id] = { type: 'edit_menu' };
      await addPoints(id, 'complete_profile');
      
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
          `⚠️ *شما اجازه ارسال مدیا ندارید!*\n\n`
          + `برای خرید دسترسی ارسال مدیا به فروشگاه امتیاز مراجعه کنید.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      
      await bot.forwardMessage(ADMIN_CHAT_ID, id, msg.message_id);
      
      const { rows } = await pool.query('SELECT name, username FROM users WHERE telegram_id = $1', [id]);
      const user = rows[0] || {};
      const info = `📩 *پیام جدید از کاربر*\n━━━━━━━━━━━━━━━━\n📛 *نام:* ${user.name || 'نامشخص'}\n🆔 *ID:* ${id}\n👤 *یوزرنیم:* @${user.username || 'ندارد'}\n━━━━━━━━━━━━━━━━\n💬 برای پاسخ: \`/reply_${id}\``;
      
      await bot.sendMessage(ADMIN_CHAT_ID, info, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ پاسخ', callback_data: `reply_${id}` }],
            [{ text: '👁️ مشاهده کاربر', callback_data: `viewuser_${id}` }]
          ]
        }
      });
      
      cleanupUserState(id);
      await bot.sendMessage(id, '✅ *پیام شما با موفقیت ارسال شد.*', { 
        parse_mode: 'Markdown', 
        ...mainKeyboard(true, admin) 
      });
      
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id || msg.document?.file_id || msg.animation?.file_id || null;
      
      await pool.query(`
        INSERT INTO user_messages (telegram_id, message_text, media_type, media_file_id, is_from_user)
        VALUES ($1, $2, $3, $4, TRUE)
      `, [id, msg.caption || text, msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : msg.animation ? 'animation' : 'text', fileId]);
      
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
      const { rows: usedRows } = await pool.query('SELECT ai_questions_used, weekly_ai_questions, weekly_ai_limit, extra_ai_questions FROM users WHERE telegram_id = $1', [id]);
      const used = usedRows[0]?.ai_questions_used || 0;
      const weeklyUsed = usedRows[0]?.weekly_ai_questions || 0;
      const weeklyLimit = usedRows[0]?.weekly_ai_limit || 5;
      const extraQuestions = usedRows[0]?.extra_ai_questions || 0;
      
      const totalQuestionsLeft = vip ? 999 : (weeklyLimit - weeklyUsed + extraQuestions);
      
      if (!vip && totalQuestionsLeft <= 0) {
        await bot.sendMessage(id, '⚠️ *تعداد سوالات شما تمام شده است.*\n\n' +
          '🛒 برای خرید سوال بیشتر به فروشگاه امتیاز مراجعه کنید.\n' +
          '💎 یا با عضویت VIP از سوالات نامحدود بهره‌مند شوید.',
          { parse_mode: 'Markdown', ...mainKeyboard(true, admin) }
        );
        
        cleanupUserState(id);
        return;
      }
      
      const { rows } = await pool.query('SELECT ai_token, prompt_content, ai_model FROM settings');
      if (!rows[0]?.ai_token) {
        await bot.sendMessage(id, '⚠️ هوش مصنوعی تنظیم نشده است.', mainKeyboard(true, admin));
        cleanupUserState(id);
        return;
      }
      
      const messages = rows[0].prompt_content ? [{ role: 'system', content: rows[0].prompt_content }] : [];
      messages.push({ role: 'user', content: text });
      
      try {
        const reply = await callDeepSeekAI(rows[0].ai_token, messages, rows[0].ai_model);
        
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
        await bot.sendMessage(id, '❌ خطا در ارتباط با هوش مصنوعی.', mainKeyboard(true, admin));
        cleanupUserState(id);
      }
      return;
    }
    
    // 5. مدیریت ادمین - آپلود پرامپت
    if (state.type === 'upload_prompt') {
      if (msg.document && msg.document.file_name && msg.document.file_name.endsWith('.txt')) {
        try {
          await bot.sendMessage(id, '📥 در حال دانلود فایل...');
          const content = await downloadFile(msg.document.file_id);
          
          if (content) {
            await pool.query('UPDATE settings SET prompt_content = $1', [content]);
            
            // ایجاد فایل برای نمایش
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
          } else {
            await bot.sendMessage(id, '❌ خطا در خواندن فایل.');
          }
        } catch (err) {
          console.error('❌ خطا در آپلود پرامپت:', err);
          await bot.sendMessage(id, '❌ خطا در پردازش فایل.');
        }
      } else {
        await bot.sendMessage(id, '❌ لطفاً یک فایل متنی (.txt) ارسال کنید.');
      }
      return;
    }
    
    // 6. مشاهده پرامپت (ارسال به صورت فایل)
    if (state.type === 'view_prompt') {
      const { rows } = await pool.query('SELECT prompt_content FROM settings');
      const prompt = rows[0]?.prompt_content;
      
      if (!prompt) {
        await bot.sendMessage(id, '⚠️ پرامپتی ذخیره نشده است.');
      } else {
        // ایجاد فایل txt
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
    
    // 7. درخواست استوری
    if (state.type === 'confirm_story_request') {
      if (text.startsWith('✅ تأیید درخواست استوری')) {
        await bot.sendMessage(ADMIN_CHAT_ID,
          `📢 *درخواست استوری جدید*\n━━━━━━━━━━━━━━━━\n👤 کاربر: ${id}\n📅 زمان: ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━\nلطفاً بنر و لینک را ارسال کنید:`,
          { parse_mode: 'Markdown' }
        );
        states[ADMIN_CHAT_ID] = { type: 'story_banner', userId: id };
        
        cleanupUserState(id);
        await bot.sendMessage(id, '✅ درخواست شما ثبت شد. منتظر پاسخ ادمین باشید.', mainKeyboard(true, admin));
      } else if (text === '❌ لغو') {
        cleanupUserState(id);
        await bot.sendMessage(id, '❌ درخواست استوری لغو شد.', mainKeyboard(true, admin));
      }
      return;
    }
    
    // 8. اعطای دستی امتیاز (فقط ادمین)
    if (state.type === 'manual_points' && admin) {
      if (text === '/cancel') {
        cleanupUserState(id);
        await bot.sendMessage(id, '❌ عملیات لغو شد.', scoringManagementKeyboard());
        states[id] = { type: 'scoring_management_menu' };
        return;
      }
      
      const parts = text.split(' ');
      if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
        await bot.sendMessage(id, '❌ فرمت اشتباه. لطفاً مطابق مثال وارد کنید: `123456789 100`');
        return;
      }
      
      const userId = parseInt(parts[0]);
      const points = parseInt(parts[1]);
      
      await pool.query(
        'UPDATE users SET total_score = COALESCE(total_score, 0) + $1 WHERE telegram_id = $2',
        [points, userId]
      );
      
      await checkLevelUp(userId);
      
      await bot.sendMessage(id, `✅ ${points} امتیاز به کاربر ${userId} اضافه شد.`);
      cleanupUserState(id);
      await bot.sendMessage(id, '🎮 *سیستم امتیازدهی:*', { 
        parse_mode: 'Markdown', 
        ...scoringManagementKeyboard() 
      });
      states[id] = { type: 'scoring_management_menu' };
      return;
    }
    
    // 9. پاسخ به کاربر (ادمین)
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
    
    // 10. عضویت VIP
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
      
      const report = `📸 *رسید پرداخت VIP*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${id}\n📅 *زمان:* ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━\n✅ برای تأیید: \`/approve_${id}\`\n❌ برای رد: \`/reject_${id}\``;
      await bot.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
      
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
    
    // اگر state شناسایی نشد
    console.log(`❌ Unknown state type: ${state.type}`);
    cleanupUserState(id);
    await bot.sendMessage(id, '🔄 وضعیت بازنشانی شد. لطفاً دوباره تلاش کنید.', mainKeyboard(await isRegistered(id), admin));
    
  } catch (err) {
    console.error('❌ خطا در handleState:', err.message);
    await bot.sendMessage(id, '❌ خطای داخلی رخ داد. لطفاً دوباره تلاش کنید.');
    cleanupUserState(id);
  }
}

// -------------------- فرمت‌بندی گزارش کاربر --------------------
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

// -------------------- دستورات اصلی --------------------
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
    console.error('❌ خطا در دستور /start:', err.message);
    await bot.sendMessage(id, '❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
  }
});

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
  
  // 📢 درخواست استوری
  if (text === '📢 درخواست استوری') {
    await bot.sendMessage(id, 
      '📢 *درخواست استوری*\n\nبرای درخواست استوری تأیید کنید:',
      { 
        parse_mode: 'Markdown', 
        ...confirmKeyboard('درخواست استوری') 
      }
    );
    states[id] = { type: 'confirm_story_request' };
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
        await bot.sendMessage(id, msgText, { parse_mode: 'Markdown', ...vipKeyboard() });
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
    
    // 📺 کانال‌ها
    if (text === '📺 کانال‌ها') {
      await bot.sendMessage(id, '⚙️ *تنظیمات کانال‌ها و VIP:*', { 
        parse_mode: 'Markdown', 
        ...channelsKeyboard() 
      });
      states[id] = { type: 'admin_channels_menu' };
      return;
    }
    
    // 👥 کاربران
    if (text === '👥 کاربران') {
      await bot.sendMessage(id, '👥 *مدیریت کاربران:*', { 
        parse_mode: 'Markdown', 
        ...usersKeyboard() 
      });
      states[id] = { type: 'admin_users_menu' };
      return;
    }
    
    // 📨 پیامرسانی
    if (text === '📨 پیامرسانی') {
      await bot.sendMessage(id, '📨 *پیامرسانی:*', { 
        parse_mode: 'Markdown', 
        ...broadcastKeyboard() 
      });
      states[id] = { type: 'admin_broadcast_menu' };
      return;
    }
    
    // 🎮 سیستم امتیازدهی
    if (text === '🎮 سیستم امتیازدهی') {
      await bot.sendMessage(id, '🎮 *سیستم امتیازدهی:*', { 
        parse_mode: 'Markdown', 
        ...scoringManagementKeyboard() 
      });
      states[id] = { type: 'scoring_management_menu' };
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
    
    // 🔄 ریست دیتابیس
    if (text === '🔄 ریست دیتابیس') {
      await bot.sendMessage(id, 
        '⚠️ *هشدار ریست دیتابیس!*\n━━━━━━━━━━━━━━━━\n' +
        '❌ این عمل تمام داده‌ها را پاک می‌کند!\n\n' +
        '⛔ **این عمل غیرقابل برگشت است!**',
        { parse_mode: 'Markdown', ...confirmDangerKeyboard('دیتابیس') }
      );
      states[id] = { type: 'confirm_reset_db' };
      return;
    }
    
    // مدیریت منوی AI (ادمین)
    if (states[id] && states[id].type === 'admin_ai_menu') {
      if (text === '⚙️ تنظیم توکن API') {
        const { rows } = await pool.query('SELECT ai_token FROM settings');
        const currentToken = rows[0]?.ai_token;
        
        let message = '🔑 *تنظیم توکن DeepSeek*\n━━━━━━━━━━━━━━━━\n';
        if (currentToken) {
          const maskedToken = currentToken.substring(0, 10) + '...' + currentToken.substring(currentToken.length - 4);
          message += `*توکن فعلی:* \`${maskedToken}\`\n`;
        } else {
          message += '*توکن فعلی:* تنظیم نشده\n';
        }
        message += '━━━━━━━━━━━━━━━━\nلطفاً توکن جدید را وارد کنید:';
        
        await bot.sendMessage(id, message, { parse_mode: 'Markdown' });
        states[id] = { type: 'set_ai_token' };
        return;
      }
      
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
      
      if (text === '🗑️ حذف پرامپت') {
        await bot.sendMessage(id, '⚠️ *آیا مطمئن هستید؟*', { 
          parse_mode: 'Markdown', 
          ...confirmKeyboard('حذف پرامپت') 
        });
        states[id] = { type: 'confirm_delete_prompt' };
        return;
      }
      
      if (text === '↩️ بازگشت به پنل ادمین') {
        cleanupUserState(id);
        await bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
        return;
      }
    }
    
    // سایر منوهای ادمین
    if (states[id] && states[id].type === 'admin_channels_menu') {
      if (text === '↩️ بازگشت به پنل ادمین') {
        cleanupUserState(id);
        await bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
    }
    
    if (states[id] && states[id].type === 'admin_users_menu') {
      if (text === '↩️ بازگشت به پنل ادمین') {
        cleanupUserState(id);
        await bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
    }
    
    if (states[id] && states[id].type === 'admin_broadcast_menu') {
      if (text === '↩️ بازگشت به پنل ادمین') {
        cleanupUserState(id);
        await bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
    }
    
    if (states[id] && states[id].type === 'scoring_management_menu') {
      if (text === '👤 اعطای دستی امتیاز') {
        await bot.sendMessage(id, 
          '👤 *اعطای دستی امتیاز*\n━━━━━━━━━━━━━━━━\n' +
          'فرمت: `آیدی_کاربر امتیاز`\n\n' +
          '📝 مثال:\n' +
          '`123456789 100`\n\n' +
          'برای لغو: /cancel',
          { parse_mode: 'Markdown' }
        );
        states[id] = { type: 'manual_points' };
        return;
      }
      
      if (text === '↩️ بازگشت به پنل ادمین') {
        cleanupUserState(id);
        await bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
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
  
  // اگر پیام معمولی است
  if (text && !text.startsWith('/')) {
    const registered = await isRegistered(id);
    if (!registered && !states[id]) {
      await bot.sendMessage(id, 
        '👋 به ربات خوش آمدید!\n\n' +
        'لطفاً ابتدا ثبت‌نام کنید.',
        mainKeyboard(false, admin)
      );
    }
  }
});

// -------------------- دستورات ویژه ادمین --------------------
bot.onText(/\/user_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  
  try {
    const { rows: userRows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [uid]);
    const { rows: vipRows } = await pool.query('SELECT * FROM vips WHERE telegram_id = $1', [uid]);
    
    if (userRows.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ کاربر یافت نشد.');
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
    details += `📝 *دستورات مدیریت:*\n`;
    details += `\`/reply_${uid}\` - پاسخ به کاربر\n`;
    details += `\`/archive_user_${uid}\` - بایگانی چت\n`;
    if (!isVip) {
      details += `\`/approve_${uid}\` - تبدیل به VIP\n`;
    }
    
    await bot.sendMessage(msg.chat.id, details, { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ پاسخ', callback_data: `reply_${uid}` }],
          [{ text: '👁️ مشاهده کامل', callback_data: `viewuser_${uid}` }]
        ]
      }
    });
  } catch (err) {
    console.error('❌ خطا در نمایش کاربر:', err);
    await bot.sendMessage(msg.chat.id, '❌ خطا در دریافت اطلاعات کاربر.');
  }
});

bot.onText(/\/viewuser_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  
  try {
    const { rows: userRows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [uid]);
    
    if (userRows.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ کاربر یافت نشد.');
      return;
    }
    
    const user = userRows[0];
    const report = formatUserReport(user, 'مشاهده', user.username);
    
    await bot.sendMessage(msg.chat.id, report, { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ پاسخ', callback_data: `reply_${uid}` }],
          [{ text: '📊 آمار', callback_data: `stats_${uid}` }],
          [{ text: '💎 تبدیل به VIP', callback_data: `makevip_${uid}` }]
        ]
      }
    });
  } catch (err) {
    console.error('❌ خطا در مشاهده کاربر:', err);
    await bot.sendMessage(msg.chat.id, '❌ خطا در دریافت اطلاعات.');
  }
});

bot.onText(/\/reply_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  
  await bot.sendMessage(msg.chat.id, 
    `💬 *پاسخ به کاربر ${uid}*\n━━━━━━━━━━━━━━━━\nپاسخ خود را بنویسید (برای لغو /cancel):`, 
    { parse_mode: 'Markdown' }
  );
  states[msg.chat.id] = { type: 'reply_to_user', userId: uid };
});

bot.onText(/\/approve_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  
  try {
    const endDate = moment().add(1, 'month').toDate();
    await pool.query(
      'UPDATE vips SET approved = TRUE, start_date = NOW(), end_date = $1 WHERE telegram_id = $2',
      [endDate, uid]
    );
    
    const { rows } = await pool.query('SELECT vip_channel FROM settings');
    const vipMessage = `🎉 *عضویت VIP شما تأیید شد!*\n━━━━━━━━━━━━━━━━\n📅 *معتبر تا:* ${moment(endDate).format('jYYYY/jM/jD')}\n📢 *کانال VIP:* ${rows[0]?.vip_channel || 'تنظیم نشده'}\n━━━━━━━━━━━━━━━━\nممنون از اعتماد شما! 💎`;
    
    await bot.sendMessage(uid, vipMessage, { parse_mode: 'Markdown' });
    await addPoints(uid, 'vip_purchase');
    
    const approveReport = `✅ *کاربر به VIP تبدیل شد*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${uid}\n📅 *تأیید در:* ${moment().format('jYYYY/jM/jD HH:mm')}\n📅 *پایان عضویت:* ${moment(endDate).format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━`;
    await bot.sendMessage(ADMIN_CHAT_ID, approveReport, { parse_mode: 'Markdown' });
    
    logActivity(ADMIN_CHAT_ID, 'تأیید VIP', `کاربر ${uid}`);
  } catch (err) {
    console.error('❌ خطا در تأیید VIP:', err);
    await bot.sendMessage(ADMIN_CHAT_ID, '❌ خطا در تأیید VIP.');
  }
});

// -------------------- Webhook Routes --------------------
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'KaniaChatBot',
    timestamp: new Date().toISOString(),
    webhook: WEBHOOK_URL ? 'configured' : 'not-configured'
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message
    });
  }
});

// -------------------- Graceful Shutdown --------------------
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

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

bot.on('error', (err) => console.error('❌ خطای Bot:', err.message));

// -------------------- راه‌اندازی سرور --------------------
app.listen(PORT, async () => {
  console.log('🚀 راه‌اندازی KaniaChatBot...');
  console.log(`🌐 پورت: ${PORT}`);
  console.log(`🤖 توکن: ${BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`👑 ادمین: ${ADMIN_CHAT_ID}`);
  console.log(`🔗 وب‌هوک: ${WEBHOOK_URL ? '✅' : '❌'}`);
  
  await createTables();
  console.log('🗄️ دیتابیس آماده است');
  
  if (WEBHOOK_URL && WEBHOOK_URL.trim() !== '') {
    const webhookUrl = WEBHOOK_URL.trim();
    console.log(`🌍 تنظیم Webhook: ${webhookUrl}`);
    
    try {
      await bot.deleteWebHook();
      await bot.setWebHook(webhookUrl);
      console.log('✅ Webhook تنظیم شد.');
    } catch (err) {
      console.error('❌ خطا در تنظیم webhook:', err.message);
      bot.startPolling();
      console.log('🔁 ربات با polling فعال شد.');
    }
  } else {
    console.log('🌐 فعال‌سازی polling...');
    bot.startPolling();
    console.log('🔁 ربات با polling فعال شد.');
  }
  
  console.log('🎉 KaniaChatBot آماده است! 🚀');
});
