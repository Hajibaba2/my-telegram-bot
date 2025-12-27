const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ==================== تنظیمات ====================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ==================== سیستم لاگینگ ساده ====================
class SimpleLogger {
  static log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logData = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...data
    };
    
    console.log(JSON.stringify(logData));
    
    // همچنین در فایل ذخیره کن
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, `${level}.log`);
    const logLine = `${timestamp} [${level.toUpperCase()}] ${message} ${Object.keys(data).length ? JSON.stringify(data) : ''}\n`;
    
    fs.appendFileSync(logFile, logLine, 'utf8');
  }
  
  static info(message, data = {}) {
    this.log('info', message, data);
  }
  
  static error(message, data = {}) {
    this.log('error', message, data);
  }
  
  static warn(message, data = {}) {
    this.log('warn', message, data);
  }
  
  static debug(message, data = {}) {
    if (NODE_ENV === 'development') {
      this.log('debug', message, data);
    }
  }
}

// Middleware لاگینگ HTTP ساده
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    SimpleLogger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  });
  next();
});

// Middleware خطای سراسری
app.use((err, req, res, next) => {
  SimpleLogger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    status: 'error',
    message: 'خطای داخلی سرور',
    timestamp: new Date().toISOString()
  });
});

// ==================== اعتبارسنجی متغیرهای محیطی ====================
if (!BOT_TOKEN) {
  SimpleLogger.error('Critical: BOT_TOKEN is not set!');
  process.exit(1);
}

if (!ADMIN_CHAT_ID || isNaN(ADMIN_CHAT_ID)) {
  SimpleLogger.error('Critical: ADMIN_CHAT_ID is invalid!');
  process.exit(1);
}

// ==================== اتصال دیتابیس ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  application_name: 'KaniaBot'
});

pool.on('error', (err) => {
  SimpleLogger.error('Unexpected database error', {
    message: err.message,
    stack: err.stack
  });
});

pool.on('connect', () => {
  SimpleLogger.info('Database connection established');
});

// ==================== راه‌اندازی ربات تلگرام ====================
const bot = new TelegramBot(BOT_TOKEN, {
  polling: false,
  filepath: false,
  onlyFirstMatch: true,
  request: {
    agentOptions: {
      keepAlive: true,
      timeout: 60000
    }
  }
});

bot.on('error', (err) => {
  SimpleLogger.error('Telegram Bot Error', {
    message: err.message,
    code: err.code,
    stack: err.stack
  });
});

// ==================== State Management ====================
const userStates = new Map();
const rateLimitCache = new Map();

// ==================== توابع کمکی ====================
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

class AIError extends Error {
  constructor(message, type = 'API_ERROR') {
    super(message);
    this.name = 'AIError';
    this.type = type;
  }
}

// لاگ فعالیت کاربران
function logUserActivity(userId, action, details = {}) {
  SimpleLogger.info('User Activity', {
    userId,
    action,
    details,
    timestamp: new Date().toISOString()
  });
}

// لاگ خطای AI
function logAIError(userId, error, question = '') {
  SimpleLogger.error('AI Error', {
    userId,
    error: error.message,
    type: error.name,
    question: question.substring(0, 500),
    stack: error.stack
  });
}

// Rate Limiting ساده
function checkRateLimit(userId, type = 'general', limit = 10, windowMs = 60000) {
  const key = `${userId}:${type}`;
  const now = Date.now();
  
  if (!rateLimitCache.has(key)) {
    rateLimitCache.set(key, []);
  }
  
  const requests = rateLimitCache.get(key);
  const windowStart = now - windowMs;
  
  // حذف درخواست‌های قدیمی
  const validRequests = requests.filter(time => time > windowStart);
  rateLimitCache.set(key, validRequests);
  
  if (validRequests.length >= limit) {
    SimpleLogger.warn('Rate limit exceeded', { userId, type, limit });
    return false;
  }
  
  validRequests.push(now);
  return true;
}

// مدیریت State کاربر
function setUserState(userId, state) {
  userStates.set(userId, {
    ...state,
    createdAt: Date.now(),
    lastActivity: Date.now()
  });
}

function getUserState(userId) {
  if (userStates.has(userId)) {
    const state = userStates.get(userId);
    state.lastActivity = Date.now();
    return state;
  }
  return null;
}

function clearUserState(userId) {
  if (userStates.has(userId)) {
    const state = userStates.get(userId);
    SimpleLogger.debug('Cleared user state', { userId, stateType: state.type });
    userStates.delete(userId);
  }
}

// اعتبارسنجی ورودی‌ها
function validatePhone(phone) {
  if (!phone) return { valid: true, normalized: null };
  
  const cleaned = phone.replace(/\D/g, '');
  
  if (cleaned === '0') {
    return { valid: true, normalized: null };
  }
  
  if (cleaned.length >= 10 && cleaned.length <= 15) {
    return { valid: true, normalized: cleaned };
  }
  
  return { valid: false, error: 'شماره تلفن باید ۱۰ تا ۱۵ رقم باشد' };
}

function validateAge(age) {
  const ageNum = parseInt(age);
  if (isNaN(ageNum) || ageNum < 1 || ageNum > 120) {
    return { valid: false, error: 'سن باید بین ۱ تا ۱۲۰ باشد' };
  }
  return { valid: true, normalized: ageNum };
}

// Escape Markdown برای تلگرام
function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ایجاد کیبورد
function createReplyKeyboard(keyboardArray, options = {}) {
  return {
    reply_markup: {
      keyboard: keyboardArray,
      resize_keyboard: options.resize !== false,
      one_time_keyboard: !!options.one_time,
      input_field_placeholder: options.placeholder || '',
      selective: options.selective || false
    }
  };
}

// ایجاد Inline Keyboard
function createInlineKeyboard(buttonsArray) {
  return {
    reply_markup: {
      inline_keyboard: buttonsArray
    }
  };
}

// پیشرفت بار
function createProgressBar(percentage, length = 20) {
  const filled = Math.max(0, Math.min(length, Math.round((percentage / 100) * length)));
  const empty = length - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

// ==================== ایجاد جداول دیتابیس (ساده‌شده) ====================
async function initializeDatabase() {
  SimpleLogger.info('Starting database initialization...');
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // جدول کاربران (ساده‌شده)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        name VARCHAR(255),
        age INTEGER,
        city VARCHAR(255),
        region VARCHAR(255),
        gender VARCHAR(50),
        job VARCHAR(255),
        goal TEXT,
        phone VARCHAR(20),
        ai_questions_used INTEGER DEFAULT 0,
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_score INTEGER DEFAULT 0,
        current_level INTEGER DEFAULT 1,
        daily_streak INTEGER DEFAULT 0,
        last_activity_date DATE,
        weekly_ai_questions INTEGER DEFAULT 0,
        weekly_ai_limit INTEGER DEFAULT 5,
        can_send_media BOOLEAN DEFAULT FALSE,
        extra_ai_questions INTEGER DEFAULT 0,
        vip_days_from_points INTEGER DEFAULT 0,
        is_banned BOOLEAN DEFAULT FALSE,
        ban_reason TEXT,
        ban_until TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // جدول VIP (ساده‌شده)
    await client.query(`
      CREATE TABLE IF NOT EXISTS vips (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE REFERENCES users(telegram_id) ON DELETE CASCADE,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        payment_receipt TEXT,
        approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // جدول تنظیمات
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        ai_token TEXT,
        ai_provider VARCHAR(50) DEFAULT 'deepseek',
        ai_model VARCHAR(100) DEFAULT 'deepseek-chat',
        free_channel TEXT,
        vip_channel TEXT,
        membership_fee VARCHAR(100),
        wallet_address TEXT,
        network TEXT,
        prompt_content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;
    `);
    
    // جدول سطوح (ساده‌شده)
    await client.query(`
      CREATE TABLE IF NOT EXISTS levels (
        level_number INTEGER PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        emoji VARCHAR(10) NOT NULL,
        min_score INTEGER NOT NULL,
        benefits TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // داده‌های اولیه سطوح
    await client.query(`
      INSERT INTO levels (level_number, name, emoji, min_score, benefits) VALUES
      (1, 'تازه‌کار', '🥉', 0, '۵ سوال AI رایگان در هفته'),
      (2, 'کنجکاو', '🥈', 500, '+۲ سوال AI در هفته'),
      (3, 'فعال', '🥇', 1500, '+۵ سوال AI در هفته'),
      (4, 'حرفه‌ای', '🏅', 3000, '+۱۰ سوال AI در هفته'),
      (5, 'استاد', '🏆', 6000, 'سوالات نامحدود AI'),
      (6, 'افسانه‌ای', '💎', 10000, 'تمام مزایا + VIP رایگان')
      ON CONFLICT (level_number) DO UPDATE SET
        name = EXCLUDED.name,
        emoji = EXCLUDED.emoji,
        min_score = EXCLUDED.min_score,
        benefits = EXCLUDED.benefits;
    `);
    
    // جدول خریدهای فروشگاه (ساده‌شده)
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id SERIAL PRIMARY KEY,
        item_code VARCHAR(50) UNIQUE NOT NULL,
        item_name VARCHAR(200) NOT NULL,
        description TEXT,
        price INTEGER NOT NULL,
        benefit_type VARCHAR(50) NOT NULL,
        benefit_value INTEGER,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // داده‌های اولیه فروشگاه
    await client.query(`
      INSERT INTO shop_items (item_code, item_name, description, price, benefit_type, benefit_value) VALUES
      ('ai_2_extra', '۲ سوال AI اضافی', 'خرید ۲ سوال اضافی برای چت با هوش مصنوعی', 50, 'ai_questions', 2),
      ('ai_5_extra', '۵ سوال AI اضافی', '۵ سوال اضافی برای چت با هوش مصنوعی', 100, 'ai_questions', 5),
      ('media_access', 'دسترسی ارسال مدیا', 'اجازه ارسال عکس و ویدیو در چت', 150, 'media_access', 1),
      ('vip_1_day', '۱ روز VIP رایگان', '۱ روز عضویت رایگان در کانال VIP', 200, 'vip_days', 1),
      ('vip_3_days', '۳ روز VIP رایگان', '۳ روز عضویت رایگان در کانال VIP', 500, 'vip_days', 3)
      ON CONFLICT (item_code) DO UPDATE SET
        item_name = EXCLUDED.item_name,
        description = EXCLUDED.description,
        price = EXCLUDED.price,
        benefit_type = EXCLUDED.benefit_type,
        benefit_value = EXCLUDED.benefit_value;
    `);
    
    // جدول تراکنش‌ها
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_transactions (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
        item_code VARCHAR(50),
        price_paid INTEGER NOT NULL,
        status VARCHAR(50) DEFAULT 'completed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // جدول لاگ AI
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_logs (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
        user_question TEXT NOT NULL,
        ai_response TEXT,
        model VARCHAR(100),
        success BOOLEAN DEFAULT TRUE,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query('COMMIT');
    SimpleLogger.info('Database tables created/verified successfully');
    
  } catch (error) {
    await client.query('ROLLBACK');
    SimpleLogger.error('Failed to initialize database', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  } finally {
    client.release();
  }
}

// ==================== سیستم امتیازدهی (ساده‌شده) ====================
class PointSystem {
  static async awardPoints(userId, action) {
    const pointValues = {
      'first_login': 100,
      'daily_login': 50,
      'complete_profile': 100,
      'add_phone': 50,
      'ai_chat': 10,
      'message_admin': 15,
      'vip_purchase': 500,
      'story_post': 300,
      'shop_purchase': 5
    };
    
    const points = pointValues[action] || 0;
    if (points <= 0) return false;
    
    try {
      await pool.query(
        `UPDATE users 
         SET total_score = COALESCE(total_score, 0) + $1,
             last_seen = NOW()
         WHERE telegram_id = $2`,
        [points, userId]
      );
      
      // بررسی ارتقا سطح
      await this.checkLevelUp(userId);
      
      logUserActivity(userId, 'points_awarded', {
        action,
        points
      });
      
      return true;
      
    } catch (error) {
      SimpleLogger.error('Failed to award points', {
        userId,
        action,
        error: error.message
      });
      return false;
    }
  }
  
  static async checkLevelUp(userId) {
    try {
      const { rows: userRows } = await pool.query(
        'SELECT total_score, current_level FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      if (userRows.length === 0) return false;
      
      const userScore = userRows[0].total_score || 0;
      const currentLevel = userRows[0].current_level || 1;
      
      const { rows: levelRows } = await pool.query(
        'SELECT level_number FROM levels WHERE min_score <= $1 ORDER BY level_number DESC LIMIT 1',
        [userScore]
      );
      
      if (levelRows.length === 0) return false;
      
      const newLevel = levelRows[0].level_number;
      
      if (newLevel > currentLevel) {
        await pool.query(
          'UPDATE users SET current_level = $1 WHERE telegram_id = $2',
          [newLevel, userId]
        );
        
        // ارسال پیام تبریک
        const { rows: levelInfo } = await pool.query(
          'SELECT name, benefits FROM levels WHERE level_number = $1',
          [newLevel]
        );
        
        if (levelInfo.length > 0) {
          try {
            await bot.sendMessage(userId,
              `🎉 *تبریک! شما به سطح ${newLevel} (${levelInfo[0].name}) ارتقا یافتید!* 🎉\n\n` +
              `🏆 *مزایای جدید:* ${levelInfo[0].benefits}`,
              { parse_mode: 'Markdown' }
            );
          } catch (error) {
            SimpleLogger.error('Failed to send level up message', { userId, error: error.message });
          }
        }
        
        logUserActivity(userId, 'level_up', {
          from_level: currentLevel,
          to_level: newLevel,
          score: userScore
        });
        
        return true;
      }
      
      return false;
      
    } catch (error) {
      SimpleLogger.error('Failed to check level up', {
        userId,
        error: error.message
      });
      return false;
    }
  }
  
  static async getUserStats(userId) {
    try {
      const { rows: userRows } = await pool.query(
        `SELECT u.*, 
                (SELECT COUNT(*) FROM vips WHERE telegram_id = u.telegram_id AND approved AND end_date > NOW()) as vip_active,
                (SELECT end_date FROM vips WHERE telegram_id = u.telegram_id AND approved AND end_date > NOW() LIMIT 1) as vip_end_date
         FROM users u WHERE telegram_id = $1`,
        [userId]
      );
      
      if (userRows.length === 0) return null;
      
      const user = userRows[0];
      
      // محاسبه اطلاعات سطح
      const { rows: currentLevelRows } = await pool.query(
        'SELECT * FROM levels WHERE min_score <= $1 ORDER BY level_number DESC LIMIT 1',
        [user.total_score]
      );
      
      const { rows: nextLevelRows } = await pool.query(
        'SELECT * FROM levels WHERE min_score > $1 ORDER BY min_score ASC LIMIT 1',
        [user.total_score]
      );
      
      const currentLevel = currentLevelRows[0] || { level_number: 1, name: 'تازه‌کار', emoji: '👶' };
      const nextLevel = nextLevelRows[0];
      
      // محاسبه پیشرفت
      const progress = nextLevel ? 
        Math.min(100, Math.round(((user.total_score - currentLevel.min_score) / 
                (nextLevel.min_score - currentLevel.min_score)) * 100)) : 100;
      
      // محاسبه سوالات باقی‌مانده AI
      const vipActive = user.vip_active > 0;
      const weeklyLimit = vipActive ? 999 : (user.weekly_ai_limit || 5);
      const aiQuestionsLeft = Math.max(0, weeklyLimit - user.weekly_ai_questions);
      
      return {
        user: {
          id: user.telegram_id,
          name: user.name,
          username: user.username,
          score: user.total_score || 0,
          level: user.current_level || 1,
          vip: vipActive,
          vip_until: user.vip_end_date,
          can_send_media: user.can_send_media,
          extra_ai_questions: user.extra_ai_questions || 0
        },
        level: {
          current: {
            number: currentLevel.level_number,
            name: currentLevel.name,
            emoji: currentLevel.emoji,
            min_score: currentLevel.min_score,
            benefits: currentLevel.benefits || ''
          },
          next: nextLevel ? {
            number: nextLevel.level_number,
            name: nextLevel.name,
            min_score: nextLevel.min_score,
            needed: nextLevel.min_score - user.total_score
          } : null,
          progress,
          progress_bar: createProgressBar(progress)
        },
        limits: {
          ai_weekly: {
            used: user.weekly_ai_questions || 0,
            limit: weeklyLimit,
            remaining: aiQuestionsLeft
          },
          ai_total_used: user.ai_questions_used || 0
        }
      };
      
    } catch (error) {
      SimpleLogger.error('Failed to get user stats', {
        userId,
        error: error.message
      });
      return null;
    }
  }
}

// ==================== سیستم AI (ساده‌شده) ====================
class AIService {
  static async generateResponse(userId, question) {
    if (!checkRateLimit(userId, 'ai', 3, 60000)) {
      throw new AIError('درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.', 'RATE_LIMIT');
    }
    
    try {
      // دریافت تنظیمات AI
      const { rows: settings } = await pool.query(
        'SELECT ai_token, ai_model, prompt_content FROM settings WHERE id = 1'
      );
      
      if (!settings[0]?.ai_token) {
        throw new AIError('هوش مصنوعی توسط ادمین تنظیم نشده است.', 'CONFIG_ERROR');
      }
      
      const config = settings[0];
      
      // بررسی محدودیت کاربر
      const { rows: vipRows } = await pool.query(
        'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved = TRUE AND end_date > NOW()',
        [userId]
      );
      
      const isVip = vipRows.length > 0;
      
      if (!isVip) {
        const { rows: userRows } = await pool.query(
          'SELECT weekly_ai_questions, weekly_ai_limit, extra_ai_questions FROM users WHERE telegram_id = $1',
          [userId]
        );
        
        if (userRows.length > 0) {
          const user = userRows[0];
          const weeklyUsed = user.weekly_ai_questions || 0;
          const weeklyLimit = user.weekly_ai_limit || 5;
          const extra = user.extra_ai_questions || 0;
          
          if (weeklyUsed >= weeklyLimit + extra) {
            throw new AIError('تعداد سوالات هفتگی شما تمام شده است.', 'QUOTA_EXCEEDED');
          }
        }
      }
      
      // ساخت پیام‌ها
      const messages = [];
      
      if (config.prompt_content) {
        messages.push({
          role: 'system',
          content: config.prompt_content
        });
      }
      
      messages.push({ role: 'user', content: question });
      
      // فراخوانی API
      const response = await this.callDeepSeekAPI(config.ai_token, messages, config.ai_model);
      
      if (!response) {
        throw new AIError('هوش مصنوعی پاسخی نداد', 'EMPTY_RESPONSE');
      }
      
      // به‌روزرسانی تعداد سوالات کاربر
      if (!isVip) {
        await pool.query(
          `UPDATE users 
           SET weekly_ai_questions = weekly_ai_questions + 1,
               ai_questions_used = COALESCE(ai_questions_used, 0) + 1
           WHERE telegram_id = $1`,
          [userId]
        );
      } else {
        await pool.query(
          'UPDATE users SET ai_questions_used = COALESCE(ai_questions_used, 0) + 1 WHERE telegram_id = $1',
          [userId]
        );
      }
      
      // ثبت در لاگ
      await pool.query(
        `INSERT INTO ai_logs (telegram_id, user_question, ai_response, model, success)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [userId, question.substring(0, 2000), response.substring(0, 4000), config.ai_model]
      );
      
      // اهدای امتیاز
      await PointSystem.awardPoints(userId, 'ai_chat');
      
      return response;
      
    } catch (error) {
      // ثبت خطا
      logAIError(userId, error, question);
      
      await pool.query(
        `INSERT INTO ai_logs (telegram_id, user_question, success, error_message)
         VALUES ($1, $2, FALSE, $3)`,
        [userId, question.substring(0, 1000), error.message]
      );
      
      // ارجاع به ادمین برای خطاهای خاص
      if (error.type !== 'QUOTA_EXCEEDED' && error.type !== 'RATE_LIMIT') {
        await this.referToAdmin(userId, question, error);
      }
      
      throw error;
    }
  }
  
  static async callDeepSeekAPI(apiKey, messages, model = 'deepseek-chat') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
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
          temperature: 0.7,
          max_tokens: 2000,
          stream: false
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new AIError(`API error ${response.status}: ${errorText.substring(0, 200)}`, 'API_ERROR');
      }
      
      const data = await response.json();
      return data.choices[0]?.message?.content || null;
      
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw new AIError('زمان پاسخگویی هوش مصنوعی به پایان رسید', 'TIMEOUT');
      }
      throw new AIError(`خطای شبکه: ${error.message}`, 'NETWORK_ERROR');
    }
  }
  
  static async referToAdmin(userId, question, error) {
    try {
      const { rows: userRows } = await pool.query(
        'SELECT name, username FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      const user = userRows[0] || {};
      
      const message = `🤖↩️ *ارجاع از هوش مصنوعی*\n━━━━━━━━━━━━━━━━\n` +
        `👤 *کاربر:* ${escapeMarkdown(user.name || 'نامشخص')}\n` +
        `🆔 *آیدی:* ${userId}\n` +
        `👤 *یوزرنیم:* ${user.username ? '@' + user.username : 'ندارد'}\n` +
        `📅 *زمان:* ${moment().format('jYYYY/jM/jD HH:mm')}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `❓ *سوال کاربر:*\n${escapeMarkdown(question.substring(0, 300))}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🚫 *خطا:* ${escapeMarkdown(error.message || 'خطای نامشخص')}\n` +
        `━━━━━━━━━━━━━━━━`;
      
      await bot.sendMessage(ADMIN_CHAT_ID, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 پاسخ به کاربر", callback_data: `ai_reply_${userId}` },
              { text: "👁️ مشاهده کاربر", callback_data: `viewuser_${userId}` }
            ]
          ]
        }
      });
      
      await bot.sendMessage(userId,
        `⚠️ *متأسفانه در حال حاضر سیستم هوش مصنوعی پاسخگو نیست.*\n\n` +
        `سوال شما به ادمین ارجاع داده شد و در اسرع وقت پاسخ دریافت خواهید کرد.\n\n` +
        `با تشکر از صبر و شکیبایی شما 🙏`,
        { parse_mode: 'Markdown' }
      );
      
      return true;
      
    } catch (err) {
      SimpleLogger.error('Failed to refer to admin', {
        userId,
        error: err.message
      });
      return false;
    }
  }
}

// ==================== سیستم فروشگاه (ساده‌شده) ====================
class ShopService {
  static async getShopItems(userId) {
    try {
      const { rows: items } = await pool.query(
        `SELECT * FROM shop_items WHERE is_active = TRUE ORDER BY price`
      );
      
      const { rows: userRows } = await pool.query(
        'SELECT total_score FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      const userScore = userRows[0]?.total_score || 0;
      
      return {
        items: items.map(item => ({
          ...item,
          can_purchase: userScore >= item.price
        })),
        user_score: userScore
      };
      
    } catch (error) {
      SimpleLogger.error('Failed to get shop items', {
        userId,
        error: error.message
      });
      throw error;
    }
  }
  
  static async purchaseItem(userId, itemCode) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // دریافت اطلاعات آیتم
      const { rows: itemRows } = await client.query(
        'SELECT * FROM shop_items WHERE item_code = $1 AND is_active = TRUE',
        [itemCode]
      );
      
      if (itemRows.length === 0) {
        throw new ValidationError('آیتم مورد نظر یافت نشد یا غیرفعال است');
      }
      
      const item = itemRows[0];
      
      // بررسی موجودی کاربر
      const { rows: userRows } = await client.query(
        'SELECT total_score FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      if (userRows.length === 0) {
        throw new ValidationError('کاربر یافت نشد');
      }
      
      const userScore = userRows[0].total_score || 0;
      
      if (userScore < item.price) {
        throw new ValidationError('امتیاز کافی ندارید');
      }
      
      // کسر امتیاز
      await client.query(
        'UPDATE users SET total_score = total_score - $1 WHERE telegram_id = $2',
        [item.price, userId]
      );
      
      // ایجاد تراکنش
      await client.query(
        `INSERT INTO shop_transactions (telegram_id, item_code, price_paid)
         VALUES ($1, $2, $3)`,
        [userId, itemCode, item.price]
      );
      
      // اعمال مزایا
      await this.applyItemBenefits(userId, item, client);
      
      await client.query('COMMIT');
      
      logUserActivity(userId, 'shop_purchase', {
        item_code: itemCode,
        item_name: item.item_name,
        price: item.price
      });
      
      return {
        success: true,
        item: item,
        remaining_score: userScore - item.price
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      
      SimpleLogger.error('Purchase failed', {
        userId,
        itemCode,
        error: error.message
      });
      
      return {
        success: false,
        error: error.message,
        error_type: error.name
      };
      
    } finally {
      client.release();
    }
  }
  
  static async applyItemBenefits(userId, item, client) {
    try {
      switch (item.benefit_type) {
        case 'ai_questions':
          await client.query(
            'UPDATE users SET extra_ai_questions = COALESCE(extra_ai_questions, 0) + $1 WHERE telegram_id = $2',
            [item.benefit_value, userId]
          );
          break;
          
        case 'media_access':
          await client.query(
            'UPDATE users SET can_send_media = TRUE WHERE telegram_id = $1',
            [userId]
          );
          break;
          
        case 'vip_days':
          if (item.benefit_value > 0) {
            const startDate = new Date();
            const endDate = new Date(startDate.getTime() + item.benefit_value * 24 * 60 * 60 * 1000);
            
            await client.query(
              `INSERT INTO vips (telegram_id, start_date, end_date, approved)
               VALUES ($1, $2, $3, TRUE)
               ON CONFLICT (telegram_id) 
               DO UPDATE SET 
                 start_date = CASE WHEN vips.end_date < NOW() THEN $2 ELSE vips.start_date END,
                 end_date = CASE 
                   WHEN vips.end_date < NOW() THEN $3 
                   ELSE vips.end_date + INTERVAL '${item.benefit_value} days'
                 END,
                 approved = TRUE`,
              [userId, startDate, endDate]
            );
          }
          break;
      }
      
    } catch (error) {
      SimpleLogger.error('Failed to apply item benefits', {
        userId,
        item: item.item_code,
        error: error.message
      });
      throw error;
    }
  }
}

// ==================== Keyboards ====================
const Keyboards = {
  main: (registered, isAdmin) => {
    const keyboard = [
      [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
      [{ text: '💬 ارسال پیام به ادمین' }, { text: '🤖 چت با هوش مصنوعی' }],
      [{ text: registered ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
      [{ text: '📊 آمار من' }, { text: '🛒 فروشگاه امتیاز' }]
    ];
    
    if (isAdmin) {
      keyboard.push([{ text: '🛡️ پنل ادمین' }]);
    }
    
    return createReplyKeyboard(keyboard, { 
      placeholder: 'گزینه مورد نظر را انتخاب کنید',
      resize: true
    });
  },
  
  stats: () => createReplyKeyboard([
    [{ text: '📊 آمار کامل' }],
    [{ text: '↩️ بازگشت به منو اصلی' }]
  ]),
  
  back: () => createReplyKeyboard([[{ text: '↩️ بازگشت' }]], { one_time: true })
};

// ==================== Handlers ====================
async function handleStartCommand(msg) {
  const userId = msg.chat.id;
  const username = msg.from.username ? `@${msg.from.username}` : null;
  const firstName = msg.from.first_name || '';
  const lastName = msg.from.last_name || '';
  
  logUserActivity(userId, 'start_command', {
    username,
    firstName,
    lastName
  });
  
  try {
    if (!checkRateLimit(userId, 'start', 3, 30000)) {
      await bot.sendMessage(userId, '⏳ درخواست‌های شما زیاد است. لطفاً ۳۰ ثانیه صبر کنید.');
      return;
    }
    
    // بررسی وضعیت بن
    const { rows: banRows } = await pool.query(
      'SELECT is_banned FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (banRows.length > 0 && banRows[0].is_banned) {
      await bot.sendMessage(userId, '🚫 حساب شما مسدود شده است. برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.');
      return;
    }
    
    // به‌روزرسانی یا ایجاد کاربر
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    const isFirstLogin = existing.length === 0;
    
    await pool.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name, last_seen)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (telegram_id) 
       DO UPDATE SET 
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         last_seen = NOW()`,
      [userId, username, firstName, lastName]
    );
    
    // اهدای امتیاز برای اولین ورود
    if (isFirstLogin) {
      await PointSystem.awardPoints(userId, 'first_login');
    }
    
    // بررسی وضعیت ثبت‌نام
    const { rows: userRows } = await pool.query(
      'SELECT name FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    const registered = userRows.length > 0 && userRows[0].name != null;
    const isAdmin = userId === ADMIN_CHAT_ID;
    
    // ارسال پیام خوش‌آمد
    let welcomeMessage = `🌟 *به ربات KaniaChatBot خوش آمدید!* 🌟\n\n`;
    
    if (isFirstLogin) {
      welcomeMessage += `🎉 *ثبت‌نام اولیه شما با موفقیت انجام شد!*\n`;
      welcomeMessage += `💎 *امتیاز هدیه:* ۱۰۰ امتیاز برای اولین ورود\n\n`;
    }
    
    welcomeMessage += `📌 *امکانات ربات:*\n`;
    welcomeMessage += `• 🤖 چت با هوش مصنوعی\n`;
    welcomeMessage += `• 📺 کانال‌های آموزشی\n`;
    welcomeMessage += `• 💎 سیستم عضویت VIP\n`;
    welcomeMessage += `• 🎮 سیستم امتیاز و سطح‌بندی\n`;
    welcomeMessage += `• 🛒 فروشگاه امتیازی\n\n`;
    
    if (!registered) {
      welcomeMessage += `📝 *برای استفاده کامل از امکانات، لطفاً ثبت‌نام کامل را انجام دهید.*\n\n`;
    }
    
    welcomeMessage += `لطفاً از منوی زیر استفاده کنید 👇`;
    
    await bot.sendMessage(userId, welcomeMessage, {
      parse_mode: 'Markdown',
      ...Keyboards.main(registered, isAdmin)
    });
    
    SimpleLogger.info('User started bot', { userId, username, isFirstLogin });
    
  } catch (error) {
    SimpleLogger.error('Failed to handle start command', {
      userId,
      error: error.message,
      stack: error.stack
    });
    
    await bot.sendMessage(userId,
      '❌ خطایی در پردازش درخواست شما رخ داد. لطفاً دوباره تلاش کنید.',
      { parse_mode: 'Markdown' }
    );
  }
}

async function handleMessage(msg) {
  const userId = msg.chat.id;
  const text = msg.text || '';
  const isAdmin = userId === ADMIN_CHAT_ID;
  
  SimpleLogger.debug('Received message', {
    userId,
    text: text.substring(0, 100)
  });
  
  try {
    if (!checkRateLimit(userId, 'message', 15, 60000)) {
      await bot.sendMessage(userId, '⚠️ درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.');
      return;
    }
    
    // بررسی وضعیت کاربر
    const { rows: userRows } = await pool.query(
      'SELECT is_banned FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userRows.length > 0 && userRows[0].is_banned) {
      await bot.sendMessage(userId, '🚫 حساب شما مسدود شده است.');
      return;
    }
    
    // به‌روزرسانی آخرین فعالیت
    await pool.query(
      'UPDATE users SET last_seen = NOW() WHERE telegram_id = $1',
      [userId]
    );
    
    // بررسی State کاربر
    const userState = getUserState(userId);
    
    if (userState) {
      // مدیریت state (ساده‌شده)
      clearUserState(userId);
      await bot.sendMessage(userId, '🔄 وضعیت شما بازنشانی شد. لطفاً دوباره تلاش کنید.', 
        Keyboards.main(true, isAdmin));
      return;
    }
    
    // 📊 آمار من
    if (text === '📊 آمار من') {
      try {
        const stats = await PointSystem.getUserStats(userId);
        if (stats) {
          let statsMessage = `📊 *آمار شما*\n━━━━━━━━━━━━━━━━\n`;
          statsMessage += `${stats.level.current.emoji} *سطح ${stats.level.current.number}: ${stats.level.current.name}*\n`;
          statsMessage += `⭐ *امتیاز کل:* ${stats.user.score.toLocaleString('fa-IR')}\n`;
          statsMessage += `📈 *پیشرفت به سطح بعدی:* ${stats.level.progress}%\n`;
          statsMessage += `${stats.level.progress_bar}\n`;
          
          if (stats.level.next) {
            statsMessage += `🎯 *برای سطح بعدی:* ${stats.level.next.needed.toLocaleString('fa-IR')} امتیاز دیگر\n`;
          } else {
            statsMessage += `🏆 *شما به بالاترین سطح رسیده‌اید!*\n`;
          }
          
          statsMessage += `\n🤖 *سوالات AI این هفته:* ${stats.limits.ai_weekly.remaining} باقی‌مانده\n`;
          statsMessage += `📸 *ارسال مدیا:* ${stats.user.can_send_media ? '✅ فعال' : '❌ غیرفعال'}\n`;
          
          if (stats.user.vip) {
            statsMessage += `💎 *وضعیت VIP:* ✅ تا ${moment(stats.user.vip_until).format('jYYYY/jM/jD')}\n`;
          } else {
            statsMessage += `💎 *وضعیت VIP:* ❌ غیرفعال\n`;
          }
          
          statsMessage += `\n━━━━━━━━━━━━━━━━\n`;
          statsMessage += `🏆 *مزایای سطح فعلی:*\n${stats.level.current.benefits}`;
          
          await bot.sendMessage(userId, statsMessage, {
            parse_mode: 'Markdown',
            ...Keyboards.stats()
          });
        } else {
          await bot.sendMessage(userId, '⚠️ ابتدا ثبت‌نام کنید.', Keyboards.main(false, isAdmin));
        }
      } catch (error) {
        SimpleLogger.error('Failed to show stats', { userId, error: error.message });
        await bot.sendMessage(userId, '❌ خطا در بارگذاری آمار.');
      }
      return;
    }
    
    // 🛒 فروشگاه امتیاز
    if (text === '🛒 فروشگاه امتیاز') {
      try {
        const shopData = await ShopService.getShopItems(userId);
        
        let shopMessage = `🛒 *فروشگاه امتیازی*\n━━━━━━━━━━━━━━━━\n`;
        shopMessage += `💰 *موجودی شما:* ${shopData.user_score.toLocaleString('fa-IR')} امتیاز\n\n`;
        shopMessage += `*موجودی کالاها:*\n`;
        
        shopData.items.forEach((item, index) => {
          const canBuy = item.can_purchase;
          const status = canBuy ? '✅' : '❌';
          
          shopMessage += `${index + 1}. *${item.item_name}*\n`;
          shopMessage += `   📝 ${item.description}\n`;
          shopMessage += `   💰 ${item.price.toLocaleString('fa-IR')} امتیاز ${status}\n`;
          shopMessage += `   🔸 کد خرید: \`/buy_${item.item_code}\`\n`;
          shopMessage += `   ──────────────\n`;
        });
        
        shopMessage += `\nبرای خرید، کد آیتم مورد نظر را ارسال کنید.`;
        
        await bot.sendMessage(userId, shopMessage, {
          parse_mode: 'Markdown',
          ...Keyboards.back()
        });
        
        setUserState(userId, { type: 'shop_browsing' });
        
      } catch (error) {
        SimpleLogger.error('Failed to show shop', { userId, error: error.message });
        await bot.sendMessage(userId, '❌ خطا در بارگذاری فروشگاه.');
      }
      return;
    }
    
    // خرید آیتم
    if (text.startsWith('/buy_')) {
      const itemCode = text.replace('/buy_', '');
      
      await bot.sendMessage(userId, '⏳ در حال پردازش خرید...');
      
      const result = await ShopService.purchaseItem(userId, itemCode);
      
      if (result.success) {
        const message = `✅ *خرید موفقیت‌آمیز!*\n\n` +
          `🎁 *آیتم:* ${result.item.item_name}\n` +
          `💰 *هزینه:* ${result.item.price.toLocaleString('fa-IR')} امتیاز\n` +
          `💳 *موجودی جدید:* ${result.remaining_score.toLocaleString('fa-IR')} امتیاز\n\n` +
          `مزایای خرید در حساب شما اعمال شدند.`;
        
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(userId, 
          `❌ *خرید ناموفق*\n\n` +
          `دلیل: ${result.error}\n\n` +
          `لطفاً دوباره تلاش کنید.`,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }
    
    // 🤖 چت با هوش مصنوعی
    if (text === '🤖 چت با هوش مصنوعی') {
      try {
        const { rows } = await pool.query('SELECT ai_token FROM settings WHERE id = 1');
        if (!rows[0]?.ai_token) {
          await bot.sendMessage(userId, '⚠️ هوش مصنوعی توسط ادمین تنظیم نشده است.');
          return;
        }
        await bot.sendMessage(userId, '🧠 سوال خود را بپرسید:', Keyboards.back());
        setUserState(userId, { type: 'ai_chat' });
      } catch (error) {
        SimpleLogger.error('Failed to start AI chat', { userId, error: error.message });
        await bot.sendMessage(userId, '❌ خطا در راه‌اندازی چت.');
      }
      return;
    }
    
    // 📺 کانال رایگان
    if (text === '📺 کانال رایگان') {
      try {
        const { rows } = await pool.query('SELECT free_channel FROM settings WHERE id = 1');
        await bot.sendMessage(userId, 
          `📢 *کانال رایگان*\n━━━━━━━━━━━━━━━━\n${rows[0]?.free_channel || 'تنظیم نشده ⚠️'}\n━━━━━━━━━━━━━━━━`, 
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        SimpleLogger.error('Failed to show free channel', { userId, error: error.message });
        await bot.sendMessage(userId, '❌ خطا در بارگذاری اطلاعات کانال.');
      }
      return;
    }
    
    // ↩️ بازگشت
    if (text === '↩️ بازگشت' || text === '↩️ بازگشت به منو اصلی') {
      clearUserState(userId);
      const { rows: userRows } = await pool.query(
        'SELECT name FROM users WHERE telegram_id = $1',
        [userId]
      );
      const registered = userRows.length > 0 && userRows[0].name != null;
      await bot.sendMessage(userId, '↩️ بازگشت به منو اصلی', Keyboards.main(registered, isAdmin));
      return;
    }
    
    // سایر پیام‌ها (آغاز چت AI)
    if (userStates.has(userId)) {
      const state = userStates.get(userId);
      if (state.type === 'ai_chat') {
        try {
          const response = await AIService.generateResponse(userId, text);
          await bot.sendMessage(userId, response, Keyboards.back());
        } catch (error) {
          if (error.type === 'QUOTA_EXCEEDED') {
            await bot.sendMessage(userId,
              '⚠️ *تعداد سوالات شما تمام شده است.*\n\n' +
              '🛒 برای خرید سوال بیشتر به فروشگاه امتیاز مراجعه کنید.\n' +
              '💎 یا با عضویت VIP از سوالات نامحدود بهره‌مند شوید.',
              { parse_mode: 'Markdown', ...Keyboards.main(true, isAdmin) }
            );
          } else if (error.type !== 'RATE_LIMIT') {
            await bot.sendMessage(userId,
              '❌ خطا در ارتباط با هوش مصنوعی. لطفاً بعداً تلاش کنید.',
              { parse_mode: 'Markdown' }
            );
          }
          clearUserState(userId);
        }
        return;
      }
    }
    
    // اگر پیام شناسایی نشد
    if (text && !text.startsWith('/')) {
      const { rows: userRows } = await pool.query(
        'SELECT name FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      const registered = userRows.length > 0 && userRows[0].name != null;
      
      await bot.sendMessage(userId,
        '🤔 متوجه پیام شما نشدم.\n\n' +
        'لطفاً از منوی زیر استفاده کنید:',
        Keyboards.main(registered, isAdmin)
      );
    }
    
  } catch (error) {
    SimpleLogger.error('Failed to handle message', {
      userId,
      text: text.substring(0, 100),
      error: error.message,
      stack: error.stack
    });
    
    await bot.sendMessage(userId,
      '❌ خطایی در پردازش پیام شما رخ داد. لطفاً دوباره تلاش کنید.',
      { parse_mode: 'Markdown' }
    );
  }
}

// ==================== Callback Query Handler ====================
async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;
  const chatId = callbackQuery.message.chat.id;
  
  SimpleLogger.debug('Callback received', { userId, data });
  
  try {
    // پاسخ به کاربر (ارجاع از AI)
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
        `🤖↩️ *پاسخ به کاربر ${targetUserId}*\n━━━━━━━━━━━━━━━━\nپاسخ خود را بنویسید (برای لغو /cancel):`, 
        { parse_mode: 'Markdown' }
      );
      
      setUserState(userId, { type: 'ai_reply_to_user', targetUserId });
      
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    
    // مشاهده کاربر
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
      
      let details = `👤 *جزئیات کاربر*\n━━━━━━━━━━━━━━━━\n`;
      details += `🆔 *آیدی:* \`${targetUserId}\`\n`;
      details += `👤 *یوزرنیم:* @${user.username || 'ندارد'}\n`;
      details += `📛 *نام:* ${escapeMarkdown(user.name || 'نامشخص')}\n`;
      details += `🎂 *سن:* ${user.age || 'نامشخص'}\n`;
      details += `🏙️ *شهر:* ${escapeMarkdown(user.city || 'نامشخص')}\n`;
      details += `📱 *شماره:* ${user.phone || 'نامشخص'}\n`;
      details += `🤖 *سوالات AI:* ${user.ai_questions_used || 0}\n`;
      details += `⭐ *امتیاز:* ${user.total_score || 0}\n`;
      details += `📊 *سطح:* ${user.current_level || 0}\n`;
      
      if (isVip) {
        const vip = vipRows[0];
        details += `\n💎 *وضعیت VIP:* ✅ فعال\n`;
        details += `   🏁 *پایان:* ${vip.end_date ? moment(vip.end_date).format('jYYYY/jM/jD HH:mm') : 'ندارد'}\n`;
      } else {
        details += `\n💎 *وضعیت VIP:* ❌ غیرفعال\n`;
      }
      
      details += `━━━━━━━━━━━━━━━━\n`;
      
      await bot.sendMessage(userId, details, {
        parse_mode: 'Markdown'
      });
      
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    
    await bot.answerCallbackQuery(callbackQuery.id);
    
  } catch (error) {
    SimpleLogger.error('Failed to handle callback', {
      userId,
      data,
      error: error.message,
      stack: error.stack
    });
    
    await bot.answerCallbackQuery(callbackQuery.id, { 
      text: '❌ خطا در پردازش درخواست!', 
      show_alert: true 
    });
  }
}

// ==================== راه‌اندازی سرور ====================
async function startServer() {
  try {
    SimpleLogger.info('🚀 Starting KaniaChatBot...');
    SimpleLogger.info(`🌐 Port: ${PORT}`);
    SimpleLogger.info(`🤖 Token: ${BOT_TOKEN ? '✅' : '❌'}`);
    SimpleLogger.info(`👑 Admin: ${ADMIN_CHAT_ID}`);
    SimpleLogger.info(`🔗 Webhook: ${WEBHOOK_URL ? '✅' : '❌'}`);
    
    // راه‌اندازی دیتابیس
    await initializeDatabase();
    SimpleLogger.info('🗄️ Database initialized');
    
    // Route وب‌هوک
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    
    // Route سلامت
    app.get('/health', async (req, res) => {
      try {
        await pool.query('SELECT 1');
        res.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          service: 'KaniaChatBot',
          version: '2.0.0'
        });
      } catch (error) {
        SimpleLogger.error('Health check failed', { error: error.message });
        res.status(500).json({
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    // Route اصلی
    app.get('/', (req, res) => {
      res.json({
        service: 'KaniaChatBot',
        status: 'online',
        timestamp: new Date().toISOString(),
        endpoints: {
          health: '/health',
          webhook: `/bot${BOT_TOKEN}`
        }
      });
    });
    
    // شروع سرور
    app.listen(PORT, async () => {
      SimpleLogger.info(`Server is running on port ${PORT}`);
      
      // تنظیم Webhook یا Polling
      if (WEBHOOK_URL && WEBHOOK_URL.trim() !== '') {
        try {
          await bot.deleteWebHook();
          await bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
          SimpleLogger.info(`Webhook set to: ${WEBHOOK_URL}`);
        } catch (error) {
          SimpleLogger.error('Failed to set webhook', { error: error.message });
          bot.startPolling();
          SimpleLogger.info('Fallback to polling mode');
        }
      } else {
        bot.startPolling();
        SimpleLogger.info('Bot started in polling mode');
      }
      
      // ثبت دستورات
      bot.onText(/\/start/, handleStartCommand);
      bot.on('message', handleMessage);
      bot.on('callback_query', handleCallbackQuery);
      
      SimpleLogger.info('🎉 KaniaChatBot is ready!');
      
      // ارسال اطلاع به ادمین
      if (ADMIN_CHAT_ID) {
        try {
          await bot.sendMessage(ADMIN_CHAT_ID,
            `🟢 *ربات راه‌اندازی شد*\n\n` +
            `⏰ زمان: ${moment().format('jYYYY/jM/jD HH:mm:ss')}\n` +
            `🌐 حالت: ${WEBHOOK_URL ? 'Webhook' : 'Polling'}\n` +
            `🗄️ دیتابیس: فعال\n\n` +
            `ربات آماده دریافت درخواست‌ها است.`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          SimpleLogger.error('Failed to send startup notification to admin', { error: error.message });
        }
      }
    });
    
    // مدیریت خاموشی
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
    
    process.on('unhandledRejection', (reason, promise) => {
      SimpleLogger.error('Unhandled Rejection', {
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : undefined
      });
    });
    
    process.on('uncaughtException', (error) => {
      SimpleLogger.error('Uncaught Exception', {
        error: error.message,
        stack: error.stack
      });
      
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    });
    
  } catch (error) {
    SimpleLogger.error('Failed to start server', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// تابع خاموشی
async function gracefulShutdown() {
  SimpleLogger.info('🛑 Starting graceful shutdown...');
  
  try {
    if (bot.isPolling()) {
      bot.stopPolling();
      SimpleLogger.info('⏹️ Bot polling stopped');
    }
    
    try {
      await bot.deleteWebHook();
      SimpleLogger.info('🗑️ Webhook deleted');
    } catch (error) {
      SimpleLogger.error('Failed to delete webhook', { error: error.message });
    }
    
    await pool.end();
    SimpleLogger.info('🔌 Database connections closed');
    
    SimpleLogger.info('👋 Shutdown completed');
    
    process.exit(0);
    
  } catch (error) {
    SimpleLogger.error('Error during shutdown', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// شروع برنامه
startServer();
