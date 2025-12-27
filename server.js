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

async function createTables() {
  console.log('🗄️ شروع ایجاد/بررسی جدول‌ها...');
  
  try {
    // 1. ابتدا جدول users با حداقل فیلدها
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
    console.log('✅ جدول users ایجاد/بررسی شد');
    
    // 2. اضافه کردن فیلدهای جدید به users (اگر وجود ندارند)
    const userColumns = [
      'total_score INTEGER DEFAULT 0',
      'current_level INTEGER DEFAULT 0',
      'daily_streak INTEGER DEFAULT 0',
      'last_activity_date DATE',
      'weekly_ai_questions INTEGER DEFAULT 0',
      'weekly_ai_limit INTEGER DEFAULT 5',
      'can_send_media BOOLEAN DEFAULT FALSE',
      'extra_ai_questions INTEGER DEFAULT 0',
      'vip_days_from_points INTEGER DEFAULT 0',
      'score INTEGER DEFAULT 0',
      'level INTEGER DEFAULT 1'
    ];
    
    for (const column of userColumns) {
      const [colName] = column.split(' ');
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${column}`);
        console.log(`   ✓ ${colName}`);
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('duplicate column')) {
          console.log(`   ⚠️ ${colName}: ${err.message.substring(0, 50)}`);
        }
      }
    }
    
    // 3. جدول vips
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
    
    // 4. جدول settings
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
    
    // 5. جدول levels
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
    
    // 6. درج داده‌های اولیه levels
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
    
    // 7. بقیه جداول
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
    
    // 8. داده‌های اولیه فروشگاه
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
    console.error('جزئیات خطا:', err);
    return false;
  }
}

// -------------------- سیستم امتیازدهی --------------------
async function addPoints(userId, actionCode, details = {}) {
  try {
    // تنظیمات امتیازدهی
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

    // افزودن امتیاز
    await pool.query(
      'UPDATE users SET total_score = COALESCE(total_score, 0) + $1 WHERE telegram_id = $2',
      [points, userId]
    );

    // بررسی ارتقاء سطح
    await checkLevelUp(userId);

    // ثبت در فعالیت روزانه
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

    // پیدا کردن سطح جدید
    const { rows: newLevelRows } = await pool.query(
      'SELECT * FROM levels WHERE min_score <= $1 ORDER BY level_number DESC LIMIT 1',
      [userScore]
    );

    if (newLevelRows.length === 0) return;

    const newLevel = newLevelRows[0].level_number;

    if (newLevel > currentLevel) {
      // آپدیت سطح کاربر
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

async function checkAndShowLevelRewards(userId) {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT total_score, current_level FROM users WHERE telegram_id = $1',
      [userId]
    );

    if (userRows.length === 0) return [];

    const currentLevel = userRows[0].current_level;

    // دریافت جوایز دریافت شده
    const { rows: claimedRewards } = await pool.query(
      'SELECT level_number FROM level_rewards_claimed WHERE telegram_id = $1',
      [userId]
    );

    const claimedLevels = claimedRewards.map(r => r.level_number);

    // پیدا کردن سطح‌هایی که جوایزش دریافت نشده
    const { rows: eligibleLevels } = await pool.query(
      `SELECT * FROM levels 
       WHERE level_number <= $1 
       AND level_number > 0 
       AND NOT level_number = ANY($2::int[])
       ORDER BY level_number ASC`,
      [currentLevel, claimedLevels]
    );

    return eligibleLevels;
  } catch (err) {
    console.error('❌ خطا در بررسی جوایز:', err.message);
    return [];
  }
}

async function applyLevelBenefit(userId, levelNumber, benefit) {
  try {
    if (benefit.includes('سوال AI')) {
      const match = benefit.match(/\+(\d+)\s+سوال/);
      if (match) {
        const extraQuestions = parseInt(match[1]);
        await pool.query(
          'UPDATE users SET weekly_ai_limit = weekly_ai_limit + $1 WHERE telegram_id = $2',
          [extraQuestions, userId]
        );
        return true;
      }
    }
    
    else if (benefit.includes('آخرین پست کانال VIP')) {
      const { rows: settings } = await pool.query('SELECT vip_channel FROM settings');
      if (settings[0]?.vip_channel) {
        await bot.sendMessage(userId, 
          `📢 *آخرین پست کانال VIP*\n\n` +
          `🔗 لینک کانال: ${settings[0].vip_channel}\n\n` +
          `این مزایای سطح ${levelNumber} شماست!`,
          { parse_mode: 'Markdown' }
        );
        return true;
      }
    }
    
    else if (benefit.includes('عضویت VIP')) {
      const timeMatch = benefit.match(/(\d+)\s*(ماه|هفته|روز)/);
      if (timeMatch) {
        const amount = parseInt(timeMatch[1]);
        const unit = timeMatch[2];
        
        let addDays = 0;
        switch (unit) {
          case 'ماه': addDays = amount * 30; break;
          case 'هفته': addDays = amount * 7; break;
          case 'روز': addDays = amount; break;
        }
        
        const endDate = moment().add(addDays, 'days').toDate();
        await pool.query(
          `INSERT INTO vips (telegram_id, approved, start_date, end_date)
           VALUES ($1, TRUE, NOW(), $2)
           ON CONFLICT (telegram_id) 
           DO UPDATE SET approved = TRUE, 
                        start_date = CASE WHEN vips.end_date < NOW() THEN NOW() ELSE vips.start_date END,
                        end_date = CASE 
                          WHEN vips.end_date < NOW() THEN $2 
                          ELSE vips.end_date + INTERVAL '${addDays} days'
                        END`,
          [userId, endDate]
        );
        
        await bot.sendMessage(userId,
          `🎉 *عضویت VIP فعال شد!*\n\n` +
          `مدت زمان: ${amount} ${unit}\n` +
          `پایان: ${moment(endDate).format('jYYYY/jM/jD')}\n\n` +
          `از مزایای VIP لذت ببرید!`,
          { parse_mode: 'Markdown' }
        );
        return true;
      }
    }
    
    else if (benefit.includes('ارسال مدیا')) {
      await pool.query(
        'UPDATE users SET can_send_media = TRUE WHERE telegram_id = $1',
        [userId]
      );
      
      await bot.sendMessage(userId,
        `📸 *دسترسی ارسال مدیا فعال شد!*\n\n` +
        `اکنون می‌توانید عکس، ویدیو و فایل برای ادمین ارسال کنید.`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }
    
    return false;
  } catch (err) {
    console.error('خطا در اعمال جایزه:', err);
    return false;
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
    
    // کسر امتیاز
    await pool.query(
      'UPDATE users SET total_score = total_score - $1 WHERE telegram_id = $2',
      [item.price, userId]
    );
    
    // ثبت خرید
    await pool.query(
      'INSERT INTO user_purchases (telegram_id, item_code, price_paid) VALUES ($1, $2, $3)',
      [userId, itemCode, item.price]
    );
    
    // اعمال سود
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
    
    // آپدیت خرید
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

// -------------------- سیستم استوری --------------------
async function handleStoryRequest(userId, step, data) {
  try {
    switch (step) {
      case 'request':
        await bot.sendMessage(
          ADMIN_CHAT_ID,
          `📢 *درخواست استوری جدید*\n━━━━━━━━━━━━━━━━\n👤 کاربر: ${userId}\n📅 زمان: ${moment().format('jYYYY/jM/jD HH:mm')}\n━━━━━━━━━━━━━━━━\nلطفاً بنر و لینک را ارسال کنید:`,
          { parse_mode: 'Markdown' }
        );
        states[ADMIN_CHAT_ID] = { type: 'story_banner', userId };
        break;
        
      case 'submit_screenshot':
        await pool.query(
          `UPDATE story_requests 
           SET story_screenshot = $1, submitted_at = NOW(), status = 'submitted'
           WHERE telegram_id = $2 AND status = 'banner_sent'`,
          [data.fileId, userId]
        );
        
        await bot.sendPhoto(
          ADMIN_CHAT_ID,
          data.fileId,
          {
            caption: `📸 *اسکرین‌شات استوری*\n━━━━━━━━━━━━━━━━\n👤 کاربر: ${userId}\nبرای تأیید /approve_story_${userId}\nبرای رد /reject_story_${userId}`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ تأیید', callback_data: `approve_story_${userId}` }],
                [{ text: '❌ رد', callback_data: `reject_story_${userId}` }]
              ]
            }
          }
        );
        break;
    }
    return true;
  } catch (err) {
    console.error('❌ خطا در پردازش استوری:', err.message);
    return false;
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
    
    // سطح فعلی
    const { rows: currentLevelRows } = await pool.query(
      'SELECT * FROM levels WHERE min_score <= $1 ORDER BY level_number DESC LIMIT 1',
      [user.total_score]
    );
    
    const currentLevel = currentLevelRows[0] || { level_number: 0, name: 'شروع', emoji: '👶', benefits: [], min_score: 0 };
    
    // سطح بعدی
    const { rows: nextLevelRows } = await pool.query(
      'SELECT * FROM levels WHERE min_score > $1 ORDER BY min_score ASC LIMIT 1',
      [user.total_score]
    );
    
    const nextLevel = nextLevelRows[0];
    
    // نوار پیشرفت
    const progress = nextLevel ? 
      Math.min(100, Math.round((user.total_score - currentLevel.min_score) / 
              (nextLevel.min_score - currentLevel.min_score) * 100)) : 100;
    
    const progressBar = createProgressBar(progress);
    
    // سوالات AI باقی‌مانده
    const weeklyLimit = vip ? 999 : (5 + user.weekly_ai_limit);
    const aiQuestionsLeft = Math.max(0, weeklyLimit - user.weekly_ai_questions);
    
    // ساخت پیام
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
    
    // بررسی جوایز قابل دریافت
    const eligibleLevels = await checkAndShowLevelRewards(userId);
    if (eligibleLevels.length > 0) {
      stats += `\n🎁 *جوایز قابل دریافت:*\n`;
      stats += `━━━━━━━━━━━━━━━━\n`;
      
      eligibleLevels.forEach(level => {
        stats += `${level.emoji} *سطح ${level.level_number}:*\n`;
        level.benefits.forEach((benefit, index) => {
          stats += `   ${index + 1}. ${benefit}\n`;
        });
      });
      
      stats += `\nبرای دریافت جوایز دستور زیر را ارسال کنید:\n`;
      stats += `\`/claim_rewards\`\n`;
      stats += `━━━━━━━━━━━━━━━━\n`;
    }
    
    return stats;
  } catch (err) {
    console.error('❌ خطا در ساخت آمار:', err.message);
    return null;
  }
}

// -------------------- فرمت‌بندی کاربران --------------------
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
      list += `   📝 مشاهده: \`/viewuser_${user.telegram_id}\`\n`;
      list += `   💬 پاسخ: \`/reply_${user.telegram_id}\`\n`;
      list += `   ──────────────\n`;
    });
  }
  
  list += `━━━━━━━━━━━━━━━━\n`;
  list += `📊 تعداد: ${users.length} کاربر`;
  
  return list;
}

// -------------------- مدیریت State --------------------
async function handleState(id, text, msg) {
  const state = states[id];
  const admin = id === ADMIN_CHAT_ID;
  
  try {
    // مدیریت ویرایش اطلاعات
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
      await addPoints(id, 'complete_profile');
      
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
          
          // ارسال گزارش به ادمین
          const report = formatUserReport(user, 'ثبت‌نام', username);
          await bot.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: 'Markdown' });
        }
        
        bot.sendMessage(id, '✅ *ثبت‌نام با موفقیت انجام شد!* 🎉', { parse_mode: 'Markdown', ...mainKeyboard(true, admin) });
        await addPoints(id, 'complete_profile');
        
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
      const { rows: userRows } = await pool.query(
        'SELECT can_send_media FROM users WHERE telegram_id = $1',
        [id]
      );
      const canSendMedia = userRows[0]?.can_send_media || false;
      
      // بررسی اجازه ارسال مدیا
      if ((msg.photo || msg.video || msg.document || msg.animation) && !canSendMedia) {
        bot.sendMessage(id, 
          `⚠️ *شما اجازه ارسال مدیا ندارید!*\n\n`
          + `برای خرید دسترسی ارسال مدیا:\n`
          + `۱. به منوی 📊 آمار من بروید\n`
          + `۲. گزینه 🛒 فروشگاه امتیاز را انتخاب کنید\n`
          + `۳. دسترسی مدیا را با ۱۰۰ امتیاز خریداری کنید`,
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
      
      bot.sendMessage(id, '✅ *پیام شما با موفقیت ارسال شد.*', { parse_mode: 'Markdown', ...mainKeyboard(true, admin) });
      
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video?.file_id || msg.document?.file_id || msg.animation?.file_id || null;
      
      await pool.query(`
        INSERT INTO user_messages (telegram_id, message_text, media_type, media_file_id, is_from_user)
        VALUES ($1, $2, $3, $4, TRUE)
      `, [id, msg.caption || text, msg.photo ? 'photo' : msg.video ? 'video' : msg.document ? 'document' : msg.animation ? 'animation' : 'text', fileId]);
      
      await addPoints(id, 'message_admin');
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
      const { rows: usedRows } = await pool.query('SELECT ai_questions_used, weekly_ai_questions, weekly_ai_limit, extra_ai_questions FROM users WHERE telegram_id = $1', [id]);
      const used = usedRows[0]?.ai_questions_used || 0;
      const weeklyUsed = usedRows[0]?.weekly_ai_questions || 0;
      const weeklyLimit = usedRows[0]?.weekly_ai_limit || 5;
      const extraQuestions = usedRows[0]?.extra_ai_questions || 0;
      
      // محاسبه سوالات باقی‌مانده
      const totalQuestionsLeft = vip ? 999 : (weeklyLimit - weeklyUsed + extraQuestions);
      
      if (!vip && totalQuestionsLeft <= 0) {
        bot.sendMessage(id, '⚠️ *تعداد سوالات شما تمام شده است.*\n\n' +
          '🛒 برای خرید سوال بیشتر به فروشگاه امتیاز مراجعه کنید.\n' +
          '💎 یا با عضویت VIP از سوالات نامحدود بهره‌مند شوید.',
          { parse_mode: 'Markdown', ...mainKeyboard(true, admin) }
        );
        
        const alert = `⚠️ *کاربر سوالاتش تمام شد*\n━━━━━━━━━━━━━━━━\n👤 *کاربر:* ${id}\n📛 *نام:* ${usedRows[0]?.name || 'نامشخص'}\n🤖 *سوالات استفاده شده:* ${used}\n━━━━━━━━━━━━━━━━`;
        bot.sendMessage(ADMIN_CHAT_ID, alert, { parse_mode: 'Markdown' });
        delete states[id];
        return;
      }
      
      const { rows } = await pool.query('SELECT ai_token, prompt_content, ai_model FROM settings');
      if (!rows[0]?.ai_token) {
        bot.sendMessage(id, '⚠️ هوش مصنوعی تنظیم نشده است.', mainKeyboard(true, admin));
        delete states[id];
        return;
      }
      
      const messages = rows[0].prompt_content ? [{ role: 'system', content: rows[0].prompt_content }] : [];
      messages.push({ role: 'user', content: text });
      
      try {
        const reply = await callDeepSeekAI(rows[0].ai_token, messages, rows[0].ai_model);
        
        bot.sendMessage(id, reply, backKeyboard());
        
        // آپدیت شمارنده سوالات
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
        bot.sendMessage(id, '❌ خطا در ارتباط با هوش مصنوعی.', mainKeyboard(true, admin));
        delete states[id];
      }
      return;
    }
    
    // درخواست استوری
    if (state.type === 'story_request') {
      await handleStoryRequest(id, 'request');
      delete states[id];
      bot.sendMessage(id, '✅ درخواست شما ثبت شد. منتظر پاسخ ادمین باشید.', mainKeyboard(true, admin));
      return;
    }
    
    // مدیریت ادمین - هوش مصنوعی
    if (state.type === 'admin_ai_menu') {
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
    
    // مدیریت ادمین - کانال‌ها
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
    
    // مدیریت ادمین - کاربران
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
    
    // مدیریت ادمین - پیام‌رسانی
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
      
      let success = 0, failed = 0;
      for (const uid of userIds) {
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
            await bot.sendMessage(uid, text);
          }
          success++;
        } catch (e) {
          failed++;
        }
        await new Promise(r => setTimeout(r, 50)); // تاخیر برای جلوگیری از محدودیت
      }
      
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
    
    // مدیریت ادمین - سیستم امتیازدهی
    if (state.type === 'scoring_management_menu') {
      if (text === '📊 تنظیمات امتیازدهی') {
        let message = `⚙️ *تنظیمات امتیازدهی فعلی:*\n━━━━━━━━━━━━━━━━\n`;
        const pointRules = {
          'first_login': 'اولین ورود به ربات',
          'complete_profile': 'ثبت‌نام کامل',
          'ai_chat': 'چت با هوش مصنوعی',
          'message_admin': 'ارسال پیام به کانیا',
          'vip_purchase': 'ثبت‌نام VIP',
          'post_story': 'ثبت استوری',
          'daily_activity': 'فعالیت روزانه',
          'add_phone': 'ثبت شماره تلفن'
        };
        
        const pointValues = {
          'first_login': 100,
          'complete_profile': 100,
          'ai_chat': 10,
          'message_admin': 10,
          'vip_purchase': 500,
          'post_story': 300,
          'daily_activity': 50,
          'add_phone': 50
        };
        
        Object.entries(pointRules).forEach(([code, name]) => {
          message += `• ${name}: ${pointValues[code]} امتیاز\n`;
        });
        
        message += `━━━━━━━━━━━━━━━━\nبرای تغییر، پیام جدید ارسال کنید.`;
        bot.sendMessage(id, message, { parse_mode: 'Markdown' });
      } else if (text === '🎮 مدیریت Level‌ها') {
        const { rows: levels } = await pool.query('SELECT * FROM levels ORDER BY level_number ASC');
        
        let message = `🎮 *مدیریت سطوح*\n━━━━━━━━━━━━━━━━\n`;
        levels.forEach(level => {
          message += `${level.emoji} *سطح ${level.level_number}: ${level.name}*\n`;
          message += `   🎯 حداقل امتیاز: ${level.min_score}\n`;
          message += `   🎁 مزایا:\n`;
          level.benefits.forEach((benefit, idx) => {
            message += `     ${idx + 1}. ${benefit}\n`;
          });
          message += `   ✏️ ویرایش: \`/editlevel_${level.level_number}\`\n`;
          message += `   ──────────────\n`;
        });
        
        message += `━━━━━━━━━━━━━━━━\n`;
        message += `برای افزودن سطح جدید: \`/addlevel\``;
        
        bot.sendMessage(id, message, { parse_mode: 'Markdown' });
      } else if (text === '👤 اعطای دستی امتیاز') {
        bot.sendMessage(id, '👤 *اعطای دستی امتیاز*\n━━━━━━━━━━━━━━━━\nلطفاً آیدی کاربر و تعداد امتیاز را به فرمت زیر وارد کنید:\n\`آیدی_کاربر تعداد_امتیاز\`\n\nمثال:\n\`123456789 100\`', { parse_mode: 'Markdown' });
        states[id] = { type: 'manual_points' };
      } else if (text === '📈 گزارش‌گیری') {
        const { rows: topUsers } = await pool.query(
          'SELECT telegram_id, name, total_score, current_level FROM users ORDER BY total_score DESC LIMIT 10'
        );
        
        let report = `📈 *گزارش برترین کاربران*\n━━━━━━━━━━━━━━━━\n`;
        topUsers.forEach((user, index) => {
          const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
          report += `${medals[index] || `${index + 1}.`} ${user.name || 'نامشخص'}\n`;
          report += `   🆔: \`${user.telegram_id}\`\n`;
          report += `   ⭐ امتیاز: ${user.total_score}\n`;
          report += `   📊 سطح: ${user.current_level}\n`;
          report += `   ──────────────\n`;
        });
        
        report += `━━━━━━━━━━━━━━━━\n`;
        report += `برای مشاهده جزئیات: \`/user_آیدی\``;
        
        bot.sendMessage(id, report, { parse_mode: 'Markdown' });
      } else if (text === '↩️ بازگشت به پنل ادمین') {
        delete states[id];
        bot.sendMessage(id, '↩️ بازگشت به پنل ادمین', adminKeyboard());
      }
      return;
    }
    
    if (state.type === 'manual_points') {
      const parts = text.split(' ');
      if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
        bot.sendMessage(id, '❌ فرمت اشتباه. لطفاً مطابق مثال وارد کنید.');
        return;
      }
      
      const userId = parseInt(parts[0]);
      const points = parseInt(parts[1]);
      
      await pool.query(
        'UPDATE users SET total_score = COALESCE(total_score, 0) + $1 WHERE telegram_id = $2',
        [points, userId]
      );
      
      await checkLevelUp(userId);
      
      bot.sendMessage(id, `✅ ${points} امتیاز به کاربر ${userId} اضافه شد.`);
      delete states[id];
      bot.sendMessage(id, '🎮 *سیستم امتیازدهی:*', { parse_mode: 'Markdown', ...scoringManagementKeyboard() });
      states[id] = { type: 'scoring_management_menu' };
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

// -------------------- دستورات اصلی --------------------
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  
  if (!checkRateLimit(id)) {
    bot.sendMessage(id, '⚠️ درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.');
    return;
  }
  
  const username = msg.from.username ? `@${msg.from.username}` : null;
  try {
    // بررسی اولین ورود
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
    
    // امتیاز اولین ورود
    if (isFirstLogin) {
      await addPoints(id, 'first_login');
    }
    
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

bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text || '';
  const admin = id === ADMIN_CHAT_ID;
  
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
    const stats = await formatUserStats(id);
    if (stats) {
      bot.sendMessage(id, stats, { parse_mode: 'Markdown', ...statsKeyboard() });
    } else {
      bot.sendMessage(id, '⚠️ ابتدا ثبت‌نام کنید.');
    }
    return;
  }
  
  if (text === '🛒 فروشگاه امتیاز') {
    const shopMessage = await showPointShop(id);
    bot.sendMessage(id, shopMessage, { parse_mode: 'Markdown', ...backKeyboard() });
    states[id] = { type: 'point_shop' };
    return;
  }
  
  if (text === '📢 درخواست استوری') {
    bot.sendMessage(id, 
      '📢 *درخواست استوری*\n\n' +
      'برای درخواست استوری:\n' +
      '۱. درخواست خود را ارسال کنید\n' +
      '۲. ادمین بنر و لینک را ارسال می‌کند\n' +
      '۳. شما استوری را منتشر می‌کنید\n' +
      '۴. بعد از ۲۴ ساعت اسکرین‌شات ارسال می‌کنید\n' +
      '۵. پس از تأیید، ۳۰۰ امتیاز دریافت می‌کنید\n\n' +
      'آیا ادامه می‌دهید؟',
      { parse_mode: 'Markdown', ...confirmKeyboard('درخواست استوری') }
    );
    states[id] = { type: 'confirm_story_request' };
    return;
  }
  
  if (text === '📺 کانال رایگان') {
    const { rows } = await pool.query('SELECT free_channel FROM settings');
    bot.sendMessage(id, `📢 *کانال رایگان*\n━━━━━━━━━━━━━━━━\n${rows[0]?.free_channel || 'تنظیم نشده ⚠️'}\n━━━━━━━━━━━━━━━━`, { parse_mode: 'Markdown' });
    return;
  }
  
  if (text === '💎 عضویت VIP') {
    const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings');
    const s = rows[0];
    
    if (s?.membership_fee && s?.wallet_address && s?.network) {
      const msgText = `💎 *عضویت VIP* 💎\n━━━━━━━━━━━━━━━━\n💰 *مبلغ:* ${s.membership_fee}\n\n👛 *آدرس کیف پول:*\n\`${s.wallet_address}\`\n\n🌐 *شبکه:* ${s.network}\n━━━━━━━━━━━━━━━━\n📸 پس از واریز، عکس فیش را ارسال کنید.`;
      bot.sendMessage(id, msgText, { parse_mode: 'Markdown', ...vipKeyboard() });
      states[id] = { type: 'vip_waiting' };
    } else {
      bot.sendMessage(id, '⚠️ اطلاعات VIP توسط ادمین تنظیم نشده است.');
    }
    return;
  }
  
  if (text === '💬 ارسال پیام به کانیا') {
    bot.sendMessage(id, '💬 پیام خود را بنویسید (متن، عکس، ویدیو، فایل یا گیف).');
    states[id] = { type: 'chat_admin' };
    return;
  }
  
  if (text === '🤖 چت با هوش مصنوعی') {
    const { rows } = await pool.query('SELECT ai_token FROM settings');
    if (!rows[0]?.ai_token) {
      bot.sendMessage(id, '⚠️ هوش مصنوعی توسط ادمین تنظیم نشده است.');
      return;
    }
    bot.sendMessage(id, '🧠 سوال خود را بپرسید.', backKeyboard());
    states[id] = { type: 'ai_chat' };
    return;
  }
  
  if (text === '📝 ثبت‌نام' || text === '✏️ ویرایش اطلاعات') {
    const registered = await isRegistered(id);
    if (!registered) {
      states[id] = { type: 'register_full', step: 0, data: {} };
      bot.sendMessage(id, '📝 *ثبت‌نام جدید*\n━━━━━━━━━━━━━━━━\n👤 نام خود را وارد کنید:', { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(id, '✏️ کدام فیلد را می‌خواهید ویرایش کنید؟', editKeyboard());
      states[id] = { type: 'edit_menu' };
    }
    return;
  }
  
  if (text === '↩️ بازگشت به منو اصلی') {
    delete states[id];
    const registered = await isRegistered(id);
    bot.sendMessage(id, '↩️ بازگشت به منو اصلی', mainKeyboard(registered, admin));
    return;
  }
  
  if (text === '↩️ بازگشت') {
    delete states[id];
    const registered = await isRegistered(id);
    bot.sendMessage(id, '↩️ بازگشت', mainKeyboard(registered, admin));
    return;
  }
  
  // دستورات خرید
  if (text.startsWith('/buy_')) {
    const itemCode = text.replace('/buy_', '');
    const result = await handlePurchase(id, itemCode);
    
    if (result.success) {
      bot.sendMessage(id, 
        `✅ *خرید موفقیت‌آمیز!*\n\n` +
        `🎁 *آیتم:* ${result.item.item_name}\n` +
        `💰 *هزینه:* ${result.item.price} امتیاز\n\n` +
        `مزایا در حساب شما اعمال شدند.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      bot.sendMessage(id, 
        `❌ *خرید ناموفق!*\n\n` +
        `دلیل: ${result.reason}\n\n` +
        `لطفاً موجودی خود را بررسی کنید.`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }
  
  // منوی ادمین
  if (admin) {
    if (text === '🛡️ پنل ادمین') {
      bot.sendMessage(id, '🛡️ *پنل ادمین فعال شد*', { parse_mode: 'Markdown', ...adminKeyboard() });
      return;
    }
    
    if (text === '🤖 هوش مصنوعی') {
      bot.sendMessage(id, '🤖 *مدیریت هوش مصنوعی:*', { parse_mode: 'Markdown', ...aiAdminKeyboard() });
      states[id] = { type: 'admin_ai_menu' };
      return;
    }
    
    if (text === '📺 کانال‌ها') {
      bot.sendMessage(id, '⚙️ *تنظیمات کانال‌ها و VIP:*', { parse_mode: 'Markdown', ...channelsKeyboard() });
      states[id] = { type: 'admin_channels_menu' };
      return;
    }
    
    if (text === '👥 کاربران') {
      bot.sendMessage(id, '👥 *مدیریت کاربران:*', { parse_mode: 'Markdown', ...usersKeyboard() });
      states[id] = { type: 'admin_users_menu' };
      return;
    }
    
    if (text === '📨 پیامرسانی') {
      bot.sendMessage(id, '📨 *پیامرسانی:*', { parse_mode: 'Markdown', ...broadcastKeyboard() });
      states[id] = { type: 'admin_broadcast_menu' };
      return;
    }
    
    if (text === '🎮 سیستم امتیازدهی') {
      bot.sendMessage(id, '🎮 *سیستم امتیازدهی:*', { parse_mode: 'Markdown', ...scoringManagementKeyboard() });
      states[id] = { type: 'scoring_management_menu' };
      return;
    }
    
    if (text === '📊 آمار') {
      const { rows: total } = await pool.query('SELECT COUNT(*) FROM users');
      const { rows: vipCount } = await pool.query('SELECT COUNT(*) FROM vips WHERE approved AND end_date > NOW()');
      const { rows: dailyActive } = await pool.query(
        'SELECT COUNT(DISTINCT telegram_id) FROM daily_activities WHERE activity_date = CURRENT_DATE'
      );
      
      const stats = `📊 *آمار کلی*\n━━━━━━━━━━━━━━━━\n👥 *کل کاربران:* ${total[0].count}\n💎 *کاربران VIP فعال:* ${vipCount[0].count}\n📈 *نسبت VIP:* ${((vipCount[0].count / total[0].count) * 100 || 0).toFixed(1)}%\n📅 *کاربران فعال امروز:* ${dailyActive[0].count || 0}\n━━━━━━━━━━━━━━━━`;
      bot.sendMessage(id, stats, { parse_mode: 'Markdown' });
      return;
    }
    
    if (text === '🔄 ریست دیتابیس') {
      bot.sendMessage(id, '⚠️ *آیا مطمئن هستید؟* تمام داده‌ها پاک می‌شود!', { parse_mode: 'Markdown', ...confirmKeyboard('ریست دیتابیس') });
      states[id] = { type: 'confirm_reset_db' };
      return;
    }
  }
  
  // تایید استوری
  if (states[id] && states[id].type === 'confirm_story_request') {
    if (text.startsWith('✅ تأیید درخواست استوری')) {
      states[id] = { type: 'story_request' };
      await handleState(id, text, msg);
    } else if (text === '❌ لغو') {
      delete states[id];
      bot.sendMessage(id, '❌ درخواست استوری لغو شد.', mainKeyboard(true, admin));
    }
    return;
  }
  
  // تایید ریست دیتابیس
  if (states[id] && states[id].type === 'confirm_reset_db') {
    if (text.startsWith('✅ تأیید ریست دیتابیس')) {
      await pool.query('DROP TABLE IF EXISTS broadcast_messages CASCADE');
      await pool.query('DROP TABLE IF EXISTS ai_chats CASCADE');
      await pool.query('DROP TABLE IF EXISTS user_messages CASCADE');
      await pool.query('DROP TABLE IF EXISTS user_purchases CASCADE');
      await pool.query('DROP TABLE IF EXISTS point_shop_items CASCADE');
      await pool.query('DROP TABLE IF EXISTS level_rewards_claimed CASCADE');
      await pool.query('DROP TABLE IF EXISTS story_requests CASCADE');
      await pool.query('DROP TABLE IF EXISTS daily_activities CASCADE');
      await pool.query('DROP TABLE IF EXISTS vips CASCADE');
      await pool.query('DROP TABLE IF EXISTS users CASCADE');
      await pool.query('DROP TABLE IF EXISTS settings CASCADE');
      await pool.query('DROP TABLE IF EXISTS levels CASCADE');
      
      await createTables();
      bot.sendMessage(id, '🔄 *دیتابیس ریست شد.*', { parse_mode: 'Markdown' });
    } else if (text === '❌ لغو') {
      bot.sendMessage(id, '❌ عملیات لغو شد.');
    }
    delete states[id];
    bot.sendMessage(id, '🛡️ *پنل ادمین*', { parse_mode: 'Markdown', ...adminKeyboard() });
    return;
  }
});

// -------------------- دستورات ویژه ادمین --------------------
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
  
  bot.sendMessage(msg.chat.id, details, { 
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ پاسخ', callback_data: `reply_${uid}` }],
        [{ text: '👁️ مشاهده کامل', callback_data: `viewuser_${uid}` }]
      ]
    }
  });
});

bot.onText(/\/viewuser_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = match[1];
  
  const { rows: userRows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [uid]);
  
  if (userRows.length === 0) {
    bot.sendMessage(msg.chat.id, '❌ کاربر یافت نشد.');
    return;
  }
  
  const user = userRows[0];
  const report = formatUserReport(user, 'مشاهده', user.username);
  
  bot.sendMessage(msg.chat.id, report, { 
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ پاسخ', callback_data: `reply_${uid}` }],
        [{ text: '📊 آمار', callback_data: `stats_${uid}` }],
        [{ text: '💎 تبدیل به VIP', callback_data: `makevip_${uid}` }]
      ]
    }
  });
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
  await addPoints(uid, 'vip_purchase');
  
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

bot.onText(/\/approve_story_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  
  await pool.query(
    `UPDATE story_requests 
     SET approved_by_admin = $1, approved_at = NOW(), status = 'approved', points_awarded = 300
     WHERE telegram_id = $2 AND status = 'submitted'`,
    [ADMIN_CHAT_ID, uid]
  );
  
  await addPoints(uid, 'post_story');
  
  bot.sendMessage(uid,
    `🎉 *استوری شما تأیید شد!*\n\n` +
    `✅ ۳۰۰ امتیاز به حساب شما اضافه شد.\n` +
    `🏆 امتیاز خود را در بخش آمار مشاهده کنید.`,
    { parse_mode: 'Markdown' }
  );
  
  bot.sendMessage(ADMIN_CHAT_ID, `✅ استوری کاربر ${uid} تأیید و ۳۰۰ امتیاز به او اعطا شد.`);
});

bot.onText(/\/reject_story_(\d+)/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const uid = parseInt(match[1]);
  
  await pool.query(
    `UPDATE story_requests 
     SET status = 'rejected'
     WHERE telegram_id = $1 AND status = 'submitted'`,
    [uid]
  );
  
  bot.sendMessage(uid,
    `❌ *استوری شما تأیید نشد.*\n\n` +
    `لطفاً مطمئن شوید که:\n` +
    `۱. استوری را به درستی منتشر کرده‌اید\n` +
    `۲. اسکرین‌شات واضح است\n` +
    `۳. حداقل ۲۴ ساعت از انتشار گذشته باشد`,
    { parse_mode: 'Markdown' }
  );
  
  bot.sendMessage(ADMIN_CHAT_ID, `❌ استوری کاربر ${uid} رد شد.`);
});

// -------------------- دستورات کاربران --------------------
bot.onText(/\/claim_rewards/, async (msg) => {
  const userId = msg.chat.id;
  
  const eligibleLevels = await checkAndShowLevelRewards(userId);
  
  if (eligibleLevels.length === 0) {
    bot.sendMessage(userId, '⚠️ هیچ جایزه‌ای برای دریافت ندارید.');
    return;
  }
  
  // ایجاد دکمه‌های اینلاین برای انتخاب جایزه
  const inlineKeyboard = [];
  
  eligibleLevels.forEach(level => {
    level.benefits.forEach((benefit, index) => {
      const callbackData = `claim_${userId}_${level.level_number}_${index}`;
      inlineKeyboard.push([
        {
          text: `${level.emoji} سطح ${level.level_number}: ${benefit.substring(0, 30)}...`,
          callback_data: callbackData
        }
      ]);
    });
  });
  
  bot.sendMessage(
    userId,
    `🎁 *جوایز قابل دریافت*\n\nلطفاً جایزه مورد نظر خود را انتخاب کنید:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          ...inlineKeyboard,
          [{ text: '❌ لغو', callback_data: `cancel_claim_${userId}` }]
        ]
      }
    }
  );
});

// -------------------- مدیریت Callback Query --------------------
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  
  if (data.startsWith('claim_')) {
    const parts = data.split('_');
    const targetUserId = parseInt(parts[1]);
    const levelNumber = parseInt(parts[2]);
    const benefitIndex = parseInt(parts[3]);
    
    if (userId !== targetUserId) {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'این جایزه برای شما نیست!', show_alert: true });
      return;
    }
    
    // دریافت اطلاعات سطح
    const { rows: levelRows } = await pool.query(
      'SELECT * FROM levels WHERE level_number = $1',
      [levelNumber]
    );
    
    if (levelRows.length === 0) {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'سطح یافت نشد!', show_alert: true });
      return;
    }
    
    const level = levelRows[0];
    const benefit = level.benefits[benefitIndex];
    
    // اعمال جایزه
    const success = await applyLevelBenefit(userId, levelNumber, benefit);
    
    if (success) {
      // ثبت دریافت جایزه
      await pool.query(
        'INSERT INTO level_rewards_claimed (telegram_id, level_number, reward_type, reward_value) VALUES ($1, $2, $3, $4)',
        [userId, levelNumber, getRewardTypeFromBenefit(benefit), benefit]
      );
      
      bot.answerCallbackQuery(callbackQuery.id, { 
        text: `✅ جایزه "${benefit.substring(0, 30)}..." دریافت شد!`, 
        show_alert: true 
      });
      
      // آپدیت پیام
      bot.editMessageText(
        `🎉 *جایزه دریافت شد!*\n\n` +
        `✅ ${benefit}\n\n` +
        `مزایا در حساب شما اعمال شدند.`,
        {
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          parse_mode: 'Markdown'
        }
      );
    } else {
      bot.answerCallbackQuery(callbackQuery.id, { 
        text: '❌ خطا در دریافت جایزه!', 
        show_alert: true 
      });
    }
    return;
  }
  
  if (data.startsWith('cancel_claim_')) {
    bot.answerCallbackQuery(callbackQuery.id);
    bot.editMessageText(
      '❌ دریافت جوایز لغو شد.',
      {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id
      }
    );
    return;
  }
  
  if (data.startsWith('reply_')) {
    const uid = data.replace('reply_', '');
    bot.answerCallbackQuery(callbackQuery.id);
    
    bot.sendMessage(userId, `💬 *پاسخ به کاربر ${uid}*\n━━━━━━━━━━━━━━━━\nپاسخ خود را بنویسید (برای لغو /cancel):`, { parse_mode: 'Markdown' });
    states[userId] = { type: 'reply_to_user', userId: uid };
    return;
  }
  
  if (data.startsWith('viewuser_')) {
    const uid = data.replace('viewuser_', '');
    bot.answerCallbackQuery(callbackQuery.id);
    
    // اجرای دستور مشاهده کاربر
    const event = { chat: { id: userId } };
    const match = [null, uid];
    await module.exports.onText['/viewuser_(\\d+)'](event, match);
    return;
  }
  
  if (data.startsWith('approve_story_')) {
    const uid = data.replace('approve_story_', '');
    bot.answerCallbackQuery(callbackQuery.id);
    
    // اجرای دستور تأیید استوری
    const event = { chat: { id: userId } };
    const match = [null, uid];
    await module.exports.onText['/approve_story_(\\d+)'](event, match);
    return;
  }
  
  if (data.startsWith('reject_story_')) {
    const uid = data.replace('reject_story_', '');
    bot.answerCallbackQuery(callbackQuery.id);
    
    // اجرای دستور رد استوری
    const event = { chat: { id: userId } };
    const match = [null, uid];
    await module.exports.onText['/reject_story_(\\d+)'](event, match);
    return;
  }
  
  bot.answerCallbackQuery(callbackQuery.id);
});

function getRewardTypeFromBenefit(benefit) {
  if (benefit.includes('سوال AI')) return 'ai_questions';
  if (benefit.includes('کانال VIP')) return 'vip_channel_access';
  if (benefit.includes('عضویت VIP')) return 'vip_membership';
  if (benefit.includes('ارسال مدیا')) return 'media_access';
  return 'other';
}

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
    webhook: WEBHOOK_URL ? 'configured' : 'not-configured',
    mode: bot.hasOpenWebHook?.() ? 'webhook' : 'polling'
  });
});

app.get('/health', async (req, res) => {
  try {
    // چک دیتابیس
    await pool.query('SELECT 1');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
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
  
  try {
    // فقط createTables رو صدا بزن
    const tablesCreated = await createTables();
    
    if (!tablesCreated) {
      console.error('❌ ایجاد جدول‌ها ناموفق بود.');
      process.exit(1);
    }
    
    console.log(`🌐 پورت: ${PORT}`);
    console.log(`🤖 توکن: ${BOT_TOKEN ? '✅' : '❌'}`);
    console.log(`👑 ادمین: ${ADMIN_CHAT_ID}`);
    console.log(`🔗 وب‌هوک: ${WEBHOOK_URL ? '✅' : '❌'}`);
  
  // اولویت با WEBHOOK_URL
  if (WEBHOOK_URL && WEBHOOK_URL.trim() !== '') {
    const webhookUrl = WEBHOOK_URL.trim();
    console.log(`🌍 تنظیم Webhook از متغیر محیطی: ${webhookUrl}`);
    
  
      // حذف Webhook قبلی
      try {
        await bot.deleteWebHook();
        console.log('🧹 Webhook قبلی پاک شد.');
      } catch (e) {}
      
      await bot.setWebHook(webhookUrl);
      console.log('✅ Webhook با موفقیت تنظیم شد.');
      
      const webhookInfo = await bot.getWebHookInfo();
      console.log(`📊 وضعیت Webhook:
      - URL: ${webhookInfo.url}
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
