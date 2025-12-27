const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const morgan = require('morgan');


// ==================== تنظیمات ====================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ENV = process.env.NODE_ENV || 'development';

// ==================== لاگر پیشرفته ====================
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'kania-bot' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
          const stackStr = stack ? `\n${stack}` : '';
          return `${timestamp} [${level}]: ${message} ${metaStr}${stackStr}`;
        })
      )
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

// Middleware لاگینگ HTTP
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Middleware خطای سراسری
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', {
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
  logger.error('Critical: BOT_TOKEN is not set!');
  process.exit(1);
}

if (!ADMIN_CHAT_ID || isNaN(ADMIN_CHAT_ID)) {
  logger.error('Critical: ADMIN_CHAT_ID is invalid!');
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
  logger.error('Unexpected database error:', {
    message: err.message,
    stack: err.stack
  });
});

pool.on('connect', () => {
  logger.info('Database connection established');
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
  logger.error('Telegram Bot Error:', {
    message: err.message,
    code: err.code,
    stack: err.stack
  });
});

// ==================== State Management ====================
const userStates = new Map();
const rateLimitCache = new Map();
const tempFiles = new Map();
const userSessions = new Map();

// ==================== توابع کمکی پیشرفته ====================
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
function logUserActivity(userId, action, details = {}, level = 'info') {
  const logData = {
    userId,
    action,
    details,
    timestamp: new Date().toISOString(),
    ip: 'telegram'
  };
  
  logger.log(level, 'User Activity', logData);
}

// لاگ خطای AI
function logAIError(userId, error, question = '') {
  logger.error('AI Error:', {
    userId,
    error: error.message,
    type: error.name,
    question: question.substring(0, 500),
    stack: error.stack
  });
}

// Rate Limiting پیشرفته
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
    logger.warn('Rate limit exceeded:', { userId, type, limit });
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
  
  // تمیز کردن State قدیمی بعد از 10 دقیقه
  setTimeout(() => {
    if (userStates.has(userId)) {
      const userState = userStates.get(userId);
      if (Date.now() - userState.lastActivity > 600000) {
        userStates.delete(userId);
        logger.debug('Cleaned up stale state', { userId });
      }
    }
  }, 600000);
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
    logger.debug('Cleared user state', { userId, stateType: state.type });
    userStates.delete(userId);
  }
}

// اعتبارسنجی ورودی‌ها
function validatePhone(phone) {
  if (!phone) return { valid: true, normalized: null };
  
  // حذف کاراکترهای غیرعددی
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

// مدیریت فایل موقت
function saveTempFile(userId, content, ext = '.txt') {
  try {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const filename = path.join(tempDir, `${userId}_${Date.now()}${ext}`);
    fs.writeFileSync(filename, content, 'utf8');
    
    if (!tempFiles.has(userId)) {
      tempFiles.set(userId, []);
    }
    
    const userFiles = tempFiles.get(userId);
    userFiles.push(filename);
    
    // حذف خودکار بعد از 5 دقیقه
    setTimeout(() => {
      if (fs.existsSync(filename)) {
        try {
          fs.unlinkSync(filename);
          const updatedFiles = userFiles.filter(f => f !== filename);
          tempFiles.set(userId, updatedFiles);
        } catch (err) {
          logger.error('Failed to delete temp file:', { filename, error: err.message });
        }
      }
    }, 5 * 60 * 1000);
    
    return filename;
  } catch (err) {
    logger.error('Failed to save temp file:', { userId, error: err.message });
    return null;
  }
}

// ==================== ایجاد جداول دیتابیس ====================
async function initializeDatabase() {
  logger.info('Starting database initialization...');
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // جدول کاربران
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        name VARCHAR(255),
        age INTEGER CHECK (age BETWEEN 1 AND 120),
        city VARCHAR(255),
        region VARCHAR(255),
        gender VARCHAR(50),
        job VARCHAR(255),
        goal TEXT,
        phone VARCHAR(20),
        ai_questions_used INTEGER DEFAULT 0,
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_score INTEGER DEFAULT 0 CHECK (total_score >= 0),
        current_level INTEGER DEFAULT 1 CHECK (current_level >= 1),
        daily_streak INTEGER DEFAULT 0 CHECK (daily_streak >= 0),
        last_activity_date DATE,
        weekly_ai_questions INTEGER DEFAULT 0 CHECK (weekly_ai_questions >= 0),
        weekly_ai_limit INTEGER DEFAULT 5 CHECK (weekly_ai_limit >= 0),
        can_send_media BOOLEAN DEFAULT FALSE,
        extra_ai_questions INTEGER DEFAULT 0 CHECK (extra_ai_questions >= 0),
        vip_days_from_points INTEGER DEFAULT 0 CHECK (vip_days_from_points >= 0),
        is_banned BOOLEAN DEFAULT FALSE,
        ban_reason TEXT,
        ban_until TIMESTAMP,
        settings JSONB DEFAULT '{"notifications": true, "language": "fa"}',
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_phone CHECK (phone IS NULL OR phone ~ '^\\d{10,15}$')
      );
    `);
    
    // ایندکس‌ها
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_total_score ON users(total_score DESC);
      CREATE INDEX IF NOT EXISTS idx_users_registration_date ON users(registration_date DESC);
      CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen DESC);
    `);
    
    // جدول VIP
    await client.query(`
      CREATE TABLE IF NOT EXISTS vips (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE REFERENCES users(telegram_id) ON DELETE CASCADE,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        payment_receipt TEXT,
        approved BOOLEAN DEFAULT FALSE,
        approved_by BIGINT REFERENCES users(telegram_id),
        approved_at TIMESTAMP,
        transaction_id VARCHAR(100),
        amount DECIMAL(10, 2),
        currency VARCHAR(10) DEFAULT 'IRT',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (end_date > start_date)
      );
      
      CREATE INDEX IF NOT EXISTS idx_vips_telegram_id ON vips(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_vips_end_date ON vips(end_date);
      CREATE INDEX IF NOT EXISTS idx_vips_approved ON vips(approved);
    `);
    
    // جدول تنظیمات
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        ai_token TEXT,
        ai_provider VARCHAR(50) DEFAULT 'deepseek',
        ai_model VARCHAR(100) DEFAULT 'deepseek-chat',
        ai_temperature DECIMAL(3,2) DEFAULT 0.7,
        ai_max_tokens INTEGER DEFAULT 2000,
        free_channel TEXT,
        vip_channel TEXT,
        membership_fee VARCHAR(100),
        wallet_address TEXT,
        network TEXT,
        prompt_content TEXT,
        maintenance_mode BOOLEAN DEFAULT FALSE,
        maintenance_message TEXT,
        point_multiplier DECIMAL(5,2) DEFAULT 1.0,
        daily_login_points INTEGER DEFAULT 50,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;
    `);
    
    // جدول سطوح
    await client.query(`
      CREATE TABLE IF NOT EXISTS levels (
        level_number INTEGER PRIMARY KEY CHECK (level_number >= 1),
        name VARCHAR(100) NOT NULL,
        emoji VARCHAR(10) NOT NULL,
        min_score INTEGER NOT NULL CHECK (min_score >= 0),
        benefits JSONB NOT NULL DEFAULT '[]',
        badge_url TEXT,
        color_hex VARCHAR(7),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_levels_min_score ON levels(min_score);
    `);
    
    // داده‌های اولیه سطوح
    await client.query(`
      INSERT INTO levels (level_number, name, emoji, min_score, benefits) VALUES
      (1, 'تازه‌کار', '🥉', 0, '["۵ سوال AI رایگان در هفته", "دسترسی به کانال رایگان"]'),
      (2, 'کنجکاو', '🥈', 500, '["+۲ سوال AI در هفته", "تخفیف ۱۰٪ فروشگاه"]'),
      (3, 'فعال', '🥇', 1500, '["+۵ سوال AI در هفته", "تخفیف ۲۰٪ فروشگاه", "نمایش آواتار ویژه"]'),
      (4, 'حرفه‌ای', '🏅', 3000, '["+۱۰ سوال AI در هفته", "تخفیف ۳۰٪ فروشگاه", "دسترسی زودهنگام به ویژگی‌های جدید"]'),
      (5, 'استاد', '🏆', 6000, '["سوالات نامحدود AI", "تخفیف ۵۰٪ فروشگاه", "۱ هفته عضویت VIP رایگان", "مشاوره رایگان"]'),
      (6, 'افسانه‌ای', '💎', 10000, '["تمام مزایای سطح ۵", "عضویت مادام‌العمر در کانال VIP", "طرح اختصاصی", "دسترسی کامل به تمام ویژگی‌ها"]')
      ON CONFLICT (level_number) DO UPDATE SET
        name = EXCLUDED.name,
        emoji = EXCLUDED.emoji,
        min_score = EXCLUDED.min_score,
        benefits = EXCLUDED.benefits;
    `);
    
    // جدول خریدهای فروشگاه
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id SERIAL PRIMARY KEY,
        item_code VARCHAR(50) UNIQUE NOT NULL,
        item_name VARCHAR(200) NOT NULL,
        description TEXT,
        price INTEGER NOT NULL CHECK (price >= 0),
        benefit_type VARCHAR(50) NOT NULL,
        benefit_value JSONB NOT NULL,
        stock INTEGER DEFAULT NULL,
        max_per_user INTEGER DEFAULT 1,
        is_active BOOLEAN DEFAULT TRUE,
        category VARCHAR(50) DEFAULT 'general',
        icon VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_shop_items_active ON shop_items(is_active);
      CREATE INDEX IF NOT EXISTS idx_shop_items_category ON shop_items(category);
    `);
    
    // داده‌های اولیه فروشگاه
    await client.query(`
      INSERT INTO shop_items (item_code, item_name, description, price, benefit_type, benefit_value, category, icon) VALUES
      ('ai_2_extra', '۲ سوال AI اضافی', 'خرید ۲ سوال اضافی برای استفاده در چت با هوش مصنوعی', 50, 'ai_questions', '{"count": 2}', 'ai', '🤖'),
      ('ai_5_extra', '۵ سوال AI اضافی', '۵ سوال اضافی برای چت با هوش مصنوعی', 100, 'ai_questions', '{"count": 5}', 'ai', '🧠'),
      ('ai_10_extra', '۱۰ سوال AI اضافی', '۱۰ سوال اضافی با ۲۰٪ تخفیف', 180, 'ai_questions', '{"count": 10}', 'ai', '🌟'),
      ('media_access', 'دسترسی ارسال مدیا', 'اجازه ارسال عکس، ویدیو و فایل در چت با ادمین', 150, 'media_access', '{"enabled": true}', 'feature', '📸'),
      ('vip_1_day', '۱ روز VIP رایگان', '۱ روز عضویت رایگان در کانال VIP', 200, 'vip_days', '{"days": 1}', 'vip', '💎'),
      ('vip_3_days', '۳ روز VIP رایگان', '۳ روز عضویت رایگان در کانال VIP', 500, 'vip_days', '{"days": 3}', 'vip', '💎💎'),
      ('vip_7_days', '۷ روز VIP رایگان', '۱ هفته عضویت رایگان در کانال VIP', 900, 'vip_days', '{"days": 7}', 'vip', '💎💎💎'),
      ('double_points_1d', 'دو برابر امتیاز (۲۴ ساعت)', 'تمام امتیازهای دریافتی شما برای ۲۴ ساعت دوبرابر می‌شود', 300, 'point_multiplier', '{"multiplier": 2, "hours": 24}', 'boost', '⚡'),
      ('custom_title', 'عنوان اختصاصی', 'یک عنوان اختصاصی در پروفایل شما نمایش داده می‌شود', 400, 'custom_title', '{"title": "ویژه"}', 'cosmetic', '🏷️'),
      ('priority_support', 'پشتیبانی اولویت‌دار', 'پیام‌های شما در صف پشتیبانی اولویت می‌گیرند', 250, 'priority_support', '{"enabled": true}', 'feature', '🚀')
      ON CONFLICT (item_code) DO UPDATE SET
        item_name = EXCLUDED.item_name,
        description = EXCLUDED.description,
        price = EXCLUDED.price,
        benefit_type = EXCLUDED.benefit_type,
        benefit_value = EXCLUDED.benefit_value,
        category = EXCLUDED.category,
        icon = EXCLUDED.icon,
        is_active = EXCLUDED.is_active;
    `);
    
    // جدول تراکنش‌های فروشگاه
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_transactions (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
        item_code VARCHAR(50) REFERENCES shop_items(item_code),
        price_paid INTEGER NOT NULL CHECK (price_paid >= 0),
        status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
        transaction_id VARCHAR(100) UNIQUE,
        benefit_applied BOOLEAN DEFAULT FALSE,
        applied_at TIMESTAMP,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_shop_transactions_user ON shop_transactions(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_shop_transactions_status ON shop_transactions(status);
      CREATE INDEX IF NOT EXISTS idx_shop_transactions_created ON shop_transactions(created_at DESC);
    `);
    
    // جدول پاداش‌های سطح
    await client.query(`
      CREATE TABLE IF NOT EXISTS level_rewards (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        level_number INTEGER REFERENCES levels(level_number),
        reward_type VARCHAR(50) NOT NULL,
        reward_value JSONB NOT NULL,
        claimed BOOLEAN DEFAULT FALSE,
        claimed_at TIMESTAMP,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(telegram_id, level_number, reward_type)
      );
      
      CREATE INDEX IF NOT EXISTS idx_level_rewards_user ON level_rewards(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_level_rewards_claimed ON level_rewards(claimed);
    `);
    
    // جدول لاگ AI
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_logs (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
        user_question TEXT NOT NULL,
        ai_response TEXT,
        model VARCHAR(100),
        tokens_used INTEGER,
        response_time_ms INTEGER,
        success BOOLEAN DEFAULT TRUE,
        error_message TEXT,
        cost DECIMAL(10, 6),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_ai_logs_user ON ai_logs(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_ai_logs_created ON ai_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_logs_success ON ai_logs(success);
    `);
    
    // جدول فعالیت‌های روزانه
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_activities (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        activity_date DATE NOT NULL,
        login_count INTEGER DEFAULT 1 CHECK (login_count >= 0),
        ai_questions INTEGER DEFAULT 0 CHECK (ai_questions >= 0),
        messages_sent INTEGER DEFAULT 0 CHECK (messages_sent >= 0),
        points_earned INTEGER DEFAULT 0 CHECK (points_earned >= 0),
        streaks_maintained BOOLEAN DEFAULT FALSE,
        daily_bonus_claimed BOOLEAN DEFAULT FALSE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(telegram_id, activity_date)
      );
      
      CREATE INDEX IF NOT EXISTS idx_daily_activities_date ON daily_activities(activity_date);
      CREATE INDEX IF NOT EXISTS idx_daily_activities_user_date ON daily_activities(telegram_id, activity_date DESC);
    `);
    
    // جدول تیکت‌های پشتیبانی
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        ticket_number VARCHAR(20) UNIQUE NOT NULL,
        subject VARCHAR(200) NOT NULL,
        description TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'general',
        priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
        assigned_to BIGINT REFERENCES users(telegram_id),
        resolved_at TIMESTAMP,
        resolution_notes TEXT,
        user_rating INTEGER CHECK (user_rating >= 1 AND user_rating <= 5),
        user_feedback TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_number ON support_tickets(ticket_number);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at DESC);
    `);
    
    // جدول پیام‌های تیکت
    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_messages (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
        message_text TEXT,
        message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'photo', 'video', 'document', 'voice')),
        file_id TEXT,
        is_from_user BOOLEAN DEFAULT TRUE,
        read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMP,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_ticket_messages_created ON ticket_messages(created_at);
    `);
    
    // جدول لاگ خطاهای سیستم
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id SERIAL PRIMARY KEY,
        level VARCHAR(20) NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
        service VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        error_stack TEXT,
        user_id BIGINT,
        request_id VARCHAR(100),
        ip_address INET,
        user_agent TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
      CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_system_logs_service ON system_logs(service);
    `);
    
    await client.query('COMMIT');
    logger.info('Database tables created/verified successfully');
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to initialize database:', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  } finally {
    client.release();
  }
}

// ==================== سیستم امتیازدهی ====================
class PointSystem {
  static async awardPoints(userId, action, metadata = {}) {
    const pointValues = {
      'first_login': 100,
      'daily_login': 50,
      'complete_profile': 100,
      'add_phone': 50,
      'ai_chat': 10,
      'message_admin': 15,
      'vip_purchase': 500,
      'story_post': 300,
      'shop_purchase': 5,
      'level_up': 200,
      'referral': 100,
      'feedback': 50,
      'bug_report': 100,
      'ticket_resolved': 150
    };
    
    const points = pointValues[action] || 0;
    if (points <= 0) return false;
    
    try {
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // دریافت تنظیمات ضریب امتیاز
        const { rows: settings } = await client.query(
          'SELECT point_multiplier FROM settings WHERE id = 1'
        );
        const multiplier = settings[0]?.point_multiplier || 1.0;
        const finalPoints = Math.round(points * multiplier);
        
        // بررسی وجود بونوس دوبرابری
        const { rows: bonuses } = await client.query(
          `SELECT metadata FROM shop_transactions 
           WHERE telegram_id = $1 AND status = 'completed' 
           AND benefit_type = 'point_multiplier' 
           AND applied_at IS NOT NULL 
           AND (metadata->>'expires_at')::TIMESTAMP > NOW()`,
          [userId]
        );
        
        let bonusMultiplier = 1;
        if (bonuses.length > 0) {
          bonusMultiplier = bonuses[0].metadata.multiplier || 1;
        }
        
        const totalPoints = Math.round(finalPoints * bonusMultiplier);
        
        // افزودن امتیاز
        await client.query(
          `UPDATE users 
           SET total_score = COALESCE(total_score, 0) + $1,
               last_seen = NOW()
           WHERE telegram_id = $2`,
          [totalPoints, userId]
        );
        
        // ثبت در لاگ فعالیت روزانه
        const today = new Date().toISOString().split('T')[0];
        await client.query(
          `INSERT INTO daily_activities (telegram_id, activity_date, points_earned)
           VALUES ($1, $2, $3)
           ON CONFLICT (telegram_id, activity_date) 
           DO UPDATE SET points_earned = daily_activities.points_earned + $3,
                        updated_at = NOW()`,
          [userId, today, totalPoints]
        );
        
        // بررسی ارتقا سطح
        await this.checkLevelUp(userId, client);
        
        // ثبت در لاگ سیستم
        await client.query(
          `INSERT INTO system_logs (level, service, message, user_id, metadata)
           VALUES ('info', 'point_system', $1, $2, $3)`,
          [`User ${userId} earned ${totalPoints} points for ${action}`, userId, metadata]
        );
        
        await client.query('COMMIT');
        
        logUserActivity(userId, 'points_awarded', {
          action,
          base_points: points,
          multiplier,
          bonus_multiplier: bonusMultiplier,
          total_points: totalPoints,
          metadata
        });
        
        return { success: true, points: totalPoints, action };
        
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      
    } catch (error) {
      logger.error('Failed to award points:', {
        userId,
        action,
        error: error.message,
        stack: error.stack
      });
      return false;
    }
  }
  
  static async checkLevelUp(userId, client = null) {
    const useExternalClient = !!client;
    if (!client) {
      client = await pool.connect();
    }
    
    try {
      // دریافت امتیاز کاربر
      const { rows: userRows } = await client.query(
        'SELECT total_score, current_level FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      if (userRows.length === 0) return false;
      
      const userScore = userRows[0].total_score || 0;
      const currentLevel = userRows[0].current_level || 1;
      
      // پیدا کردن سطح جدید
      const { rows: levelRows } = await client.query(
        'SELECT level_number FROM levels WHERE min_score <= $1 ORDER BY level_number DESC LIMIT 1',
        [userScore]
      );
      
      if (levelRows.length === 0) return false;
      
      const newLevel = levelRows[0].level_number;
      
      if (newLevel > currentLevel) {
        // ارتقا سطح
        await client.query(
          'UPDATE users SET current_level = $1 WHERE telegram_id = $2',
          [newLevel, userId]
        );
        
        // ثبت پاداش‌های سطح
        const { rows: rewards } = await client.query(
          'SELECT * FROM levels WHERE level_number = $1',
          [newLevel]
        );
        
        if (rewards.length > 0) {
          const level = rewards[0];
          
          // ارسال پیام تبریک
          try {
            await bot.sendMessage(userId,
              `🎉 *تبریک! شما به سطح ${newLevel} (${level.name}) ارتقا یافتید!* 🎉\n\n` +
              `🏆 *مزایای جدید شما:*\n` +
              level.benefits.map(b => `• ${b}`).join('\n') + `\n\n` +
              `برای مشاهده پاداش‌های خود از منوی آمار استفاده کنید.`,
              { parse_mode: 'Markdown' }
            );
          } catch (error) {
            logger.error('Failed to send level up message:', { userId, error: error.message });
          }
          
          // اهدای امتیاز برای ارتقا سطح
          await this.awardPoints(userId, 'level_up', { from_level: currentLevel, to_level: newLevel });
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
      logger.error('Failed to check level up:', {
        userId,
        error: error.message,
        stack: error.stack
      });
      return false;
    } finally {
      if (!useExternalClient && client) {
        client.release();
      }
    }
  }
  
  static async getUserStats(userId) {
    try {
      const { rows: userRows } = await pool.query(
        `SELECT u.*, 
                (SELECT COUNT(*) FROM vips WHERE telegram_id = u.telegram_id AND approved AND end_date > NOW()) as vip_active,
                (SELECT end_date FROM vips WHERE telegram_id = u.telegram_id AND approved AND end_date > NOW() LIMIT 1) as vip_end_date,
                (SELECT COUNT(*) FROM shop_transactions WHERE telegram_id = u.telegram_id AND status = 'completed') as total_purchases,
                (SELECT COALESCE(SUM(price_paid), 0) FROM shop_transactions WHERE telegram_id = u.telegram_id AND status = 'completed') as total_spent
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
      
      // استرک روزانه
      const today = new Date().toISOString().split('T')[0];
      const { rows: streakRows } = await pool.query(
        `SELECT COUNT(*) as streak
         FROM daily_activities 
         WHERE telegram_id = $1 
         AND activity_date >= CURRENT_DATE - INTERVAL '30 days'
         AND login_count > 0`,
        [userId]
      );
      
      const streak = streakRows[0]?.streak || 0;
      
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
            benefits: currentLevel.benefits || []
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
        },
        streak: {
          days: streak,
          daily_bonus_available: streak >= 3
        },
        shop: {
          total_purchases: user.total_purchases || 0,
          total_spent: user.total_spent || 0
        }
      };
      
    } catch (error) {
      logger.error('Failed to get user stats:', {
        userId,
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }
}

// ==================== سیستم AI ====================
class AIService {
  static async generateResponse(userId, question, context = {}) {
    if (!checkRateLimit(userId, 'ai', 3, 60000)) {
      throw new AIError('درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.', 'RATE_LIMIT');
    }
    
    try {
      // دریافت تنظیمات AI
      const { rows: settings } = await pool.query(
        'SELECT ai_token, ai_provider, ai_model, ai_temperature, ai_max_tokens, prompt_content FROM settings WHERE id = 1'
      );
      
      if (!settings[0]?.ai_token) {
        throw new AIError('هوش مصنوعی توسط ادمین تنظیم نشده است.', 'CONFIG_ERROR');
      }
      
      const config = settings[0];
      
      // بررسی محدودیت کاربر
      const vip = await this.isUserVIP(userId);
      if (!vip) {
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
      
      // اضافه کردن پرامپت سیستم
      if (config.prompt_content) {
        messages.push({
          role: 'system',
          content: config.prompt_content
        });
      }
      
      // اضافه کردن تاریخچه مکالمه (آخرین ۵ پیام)
      const { rows: history } = await pool.query(
        `SELECT user_question, ai_response 
         FROM ai_logs 
         WHERE telegram_id = $1 AND success = TRUE 
         ORDER BY created_at DESC 
         LIMIT 5`,
        [userId]
      );
      
      // اضافه کردن تاریخچه به ترتیب معکوس
      history.reverse().forEach(item => {
        messages.push({ role: 'user', content: item.user_question.substring(0, 500) });
        if (item.ai_response) {
          messages.push({ role: 'assistant', content: item.ai_response.substring(0, 1000) });
        }
      });
      
      // اضافه کردن سوال فعلی
      messages.push({ role: 'user', content: question });
      
      // فراخوانی API
      const startTime = Date.now();
      let response;
      
      switch (config.ai_provider) {
        case 'deepseek':
          response = await this.callDeepSeekAPI(config, messages);
          break;
        case 'openai':
          response = await this.callOpenAIAPI(config, messages);
          break;
        default:
          throw new AIError(`Provider ${config.ai_provider} not supported`, 'UNSUPPORTED_PROVIDER');
      }
      
      const responseTime = Date.now() - startTime;
      
      if (!response) {
        throw new AIError('هوش مصنوعی پاسخی نداد', 'EMPTY_RESPONSE');
      }
      
      // به‌روزرسانی تعداد سوالات کاربر
      if (!vip) {
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
        `INSERT INTO ai_logs (telegram_id, user_question, ai_response, model, response_time_ms, success, metadata)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
        [userId, question.substring(0, 2000), response.substring(0, 4000), config.ai_model, 
         responseTime, JSON.stringify(context)]
      );
      
      // اهدای امتیاز
      await PointSystem.awardPoints(userId, 'ai_chat', {
        question_length: question.length,
        response_length: response.length,
        response_time: responseTime
      });
      
      return response;
      
    } catch (error) {
      // ثبت خطا
      logAIError(userId, error, question);
      
      await pool.query(
        `INSERT INTO ai_logs (telegram_id, user_question, success, error_message, metadata)
         VALUES ($1, $2, FALSE, $3, $4)`,
        [userId, question.substring(0, 1000), error.message, JSON.stringify(context)]
      );
      
      // ارجاع به ادمین برای خطاهای خاص
      if (error.type !== 'QUOTA_EXCEEDED' && error.type !== 'RATE_LIMIT') {
        await this.referToAdmin(userId, question, error);
      }
      
      throw error;
    }
  }
  
  static async callDeepSeekAPI(config, messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ai_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.ai_model || 'deepseek-chat',
          messages: messages,
          temperature: config.ai_temperature || 0.7,
          max_tokens: config.ai_max_tokens || 2000,
          stream: false
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new AIError(
          `API error ${response.status}: ${errorText.substring(0, 200)}`,
          'API_ERROR'
        );
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
  
  static async callOpenAIAPI(config, messages) {
    // پیاده‌سازی مشابه برای OpenAI
    throw new AIError('OpenAI provider not implemented yet', 'NOT_IMPLEMENTED');
  }
  
  static async isUserVIP(userId) {
    try {
      const { rows } = await pool.query(
        'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved = TRUE AND end_date > NOW()',
        [userId]
      );
      return rows.length > 0;
    } catch (error) {
      logger.error('Failed to check VIP status:', { userId, error: error.message });
      return false;
    }
  }
  
  static async referToAdmin(userId, question, error) {
    try {
      // دریافت اطلاعات کاربر
      const { rows: userRows } = await pool.query(
        'SELECT name, username FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      const user = userRows[0] || {};
      
      // ارسال به ادمین
      const message = `🤖↩️ *ارجاع از هوش مصنوعی*\n━━━━━━━━━━━━━━━━\n` +
        `👤 *کاربر:* ${escapeMarkdown(user.name || 'نامشخص')}\n` +
        `🆔 *آیدی:* ${userId}\n` +
        `👤 *یوزرنیم:* ${user.username ? '@' + user.username : 'ندارد'}\n` +
        `📅 *زمان:* ${moment().format('jYYYY/jM/jD HH:mm')}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `❓ *سوال کاربر:*\n${escapeMarkdown(question.substring(0, 300))}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🚫 *خطا:* ${escapeMarkdown(error.message || 'خطای نامشخص')}\n` +
        `🔧 *نوع:* ${error.type || 'UNKNOWN'}\n` +
        `━━━━━━━━━━━━━━━━`;
      
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
      logger.error('Failed to refer to admin:', {
        userId,
        error: err.message,
        stack: err.stack
      });
      return false;
    }
  }
}

// ==================== سیستم فروشگاه ====================
class ShopService {
  static async getShopItems(userId) {
    try {
      const { rows: items } = await pool.query(
        `SELECT si.*, 
                (SELECT COUNT(*) FROM shop_transactions st 
                 WHERE st.item_code = si.item_code AND st.telegram_id = $1 AND st.status = 'completed') as user_purchased
         FROM shop_items si 
         WHERE si.is_active = TRUE 
         ORDER BY si.category, si.price`,
        [userId]
      );
      
      const { rows: userRows } = await pool.query(
        'SELECT total_score FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      const userScore = userRows[0]?.total_score || 0;
      
      return {
        items: items.map(item => ({
          ...item,
          can_purchase: userScore >= item.price && 
                       (item.max_per_user === null || item.user_purchased < item.max_per_user) &&
                       (item.stock === null || item.stock > 0),
          user_purchased: item.user_purchased || 0
        })),
        user_score: userScore
      };
      
    } catch (error) {
      logger.error('Failed to get shop items:', {
        userId,
        error: error.message,
        stack: error.stack
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
        'SELECT * FROM shop_items WHERE item_code = $1 AND is_active = TRUE FOR UPDATE',
        [itemCode]
      );
      
      if (itemRows.length === 0) {
        throw new ValidationError('آیتم مورد نظر یافت نشد یا غیرفعال است');
      }
      
      const item = itemRows[0];
      
      // بررسی موجودی کاربر
      const { rows: userRows } = await client.query(
        'SELECT total_score FROM users WHERE telegram_id = $1 FOR UPDATE',
        [userId]
      );
      
      if (userRows.length === 0) {
        throw new ValidationError('کاربر یافت نشد');
      }
      
      const userScore = userRows[0].total_score || 0;
      
      if (userScore < item.price) {
        throw new ValidationError('امتیاز کافی ندارید');
      }
      
      // بررسی محدودیت تعداد خرید
      if (item.max_per_user !== null) {
        const { rows: purchaseRows } = await client.query(
          'SELECT COUNT(*) as count FROM shop_transactions WHERE telegram_id = $1 AND item_code = $2 AND status = $3',
          [userId, itemCode, 'completed']
        );
        
        if (purchaseRows[0].count >= item.max_per_user) {
          throw new ValidationError('شما بیش از حد مجاز از این آیتم خرید کرده‌اید');
        }
      }
      
      // بررسی موجودی انبار
      if (item.stock !== null && item.stock <= 0) {
        throw new ValidationError('موجودی این آیتم به پایان رسیده است');
      }
      
      // کسر امتیاز
      await client.query(
        'UPDATE users SET total_score = total_score - $1 WHERE telegram_id = $2',
        [item.price, userId]
      );
      
      // کاهش موجودی انبار
      if (item.stock !== null) {
        await client.query(
          'UPDATE shop_items SET stock = stock - 1 WHERE item_code = $1',
          [itemCode]
        );
      }
      
      // ایجاد تراکنش
      const transactionId = `TRX-${Date.now()}-${userId}`;
      
      const { rows: transactionRows } = await client.query(
        `INSERT INTO shop_transactions 
         (telegram_id, item_code, price_paid, status, transaction_id, metadata)
         VALUES ($1, $2, $3, 'completed', $4, $5)
         RETURNING id`,
        [userId, itemCode, item.price, transactionId, 
         JSON.stringify({ item_name: item.item_name, category: item.category })]
      );
      
      const transactionIdNum = transactionRows[0].id;
      
      // اعمال مزایا
      await this.applyItemBenefits(userId, item, transactionIdNum, client);
      
      // به‌روزرسانی وضعیت تراکنش
      await client.query(
        'UPDATE shop_transactions SET benefit_applied = TRUE, applied_at = NOW(), completed_at = NOW() WHERE id = $1',
        [transactionIdNum]
      );
      
      // اهدای امتیاز برای خرید
      await PointSystem.awardPoints(userId, 'shop_purchase', {
        item_code: itemCode,
        price: item.price,
        transaction_id: transactionId
      });
      
      await client.query('COMMIT');
      
      logUserActivity(userId, 'shop_purchase', {
        item_code: itemCode,
        item_name: item.item_name,
        price: item.price,
        transaction_id: transactionId
      });
      
      return {
        success: true,
        transaction_id: transactionId,
        item: item,
        remaining_score: userScore - item.price
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      
      logger.error('Purchase failed:', {
        userId,
        itemCode,
        error: error.message,
        stack: error.stack
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
  
  static async applyItemBenefits(userId, item, transactionId, client) {
    try {
      switch (item.benefit_type) {
        case 'ai_questions':
          const count = item.benefit_value.count || 0;
          await client.query(
            'UPDATE users SET extra_ai_questions = COALESCE(extra_ai_questions, 0) + $1 WHERE telegram_id = $2',
            [count, userId]
          );
          break;
          
        case 'media_access':
          await client.query(
            'UPDATE users SET can_send_media = TRUE WHERE telegram_id = $1',
            [userId]
          );
          break;
          
        case 'vip_days':
          const days = item.benefit_value.days || 0;
          if (days > 0) {
            const startDate = new Date();
            const endDate = new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);
            
            await client.query(
              `INSERT INTO vips (telegram_id, start_date, end_date, approved, approved_by, approved_at, transaction_id)
               VALUES ($1, $2, $3, TRUE, $4, NOW(), $5)
               ON CONFLICT (telegram_id) 
               DO UPDATE SET 
                 start_date = CASE WHEN vips.end_date < NOW() THEN $2 ELSE vips.start_date END,
                 end_date = CASE 
                   WHEN vips.end_date < NOW() THEN $3 
                   ELSE vips.end_date + INTERVAL '${days} days'
                 END,
                 approved = TRUE,
                 approved_at = NOW(),
                 transaction_id = $5`,
              [userId, startDate, endDate, ADMIN_CHAT_ID, `shop-${transactionId}`]
            );
          }
          break;
          
        case 'point_multiplier':
          const multiplier = item.benefit_value.multiplier || 1;
          const hours = item.benefit_value.hours || 24;
          const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
          
          await client.query(
            `UPDATE shop_transactions 
             SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{expires_at}', $1)
             WHERE id = $2`,
            [`"${expiresAt.toISOString()}"`, transactionId]
          );
          break;
          
        case 'custom_title':
          const title = item.benefit_value.title || 'ویژه';
          await client.query(
            `UPDATE users 
             SET settings = jsonb_set(
               COALESCE(settings, '{}'), 
               '{custom_title}', 
               $1
             )
             WHERE telegram_id = $2`,
            [`"${title}"`, userId]
          );
          break;
          
        case 'priority_support':
          await client.query(
            `UPDATE users 
             SET settings = jsonb_set(
               COALESCE(settings, '{}'), 
               '{priority_support}', 
               'true'
             )
             WHERE telegram_id = $1`,
            [userId]
          );
          break;
      }
      
    } catch (error) {
      logger.error('Failed to apply item benefits:', {
        userId,
        item: item.item_code,
        error: error.message,
        stack: error.stack
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
      [{ text: '💬 ارسال پیام به کانیا' }, { text: '🤖 چت با هوش مصنوعی' }],
      [{ text: registered ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
      [{ text: '📊 آمار من' }, { text: '🎁 دریافت امتیاز با استوری' }],
      [{ text: '🛒 فروشگاه امتیاز' }]
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
    [{ text: '📊 آمار کامل' }, { text: '🏆 رتبه در جدول' }],
    [{ text: '📈 تاریخچه امتیاز' }, { text: '🎁 پاداش‌های سطح' }],
    [{ text: '↩️ بازگشت به منو اصلی' }]
  ]),
  
  admin: () => createReplyKeyboard([
    [{ text: '🤖 هوش مصنوعی' }, { text: '📺 کانال‌ها' }],
    [{ text: '👥 مدیریت کاربران' }, { text: '📨 پیامرسانی' }],
    [{ text: '🎮 سیستم امتیازدهی' }, { text: '🛒 مدیریت فروشگاه' }],
    [{ text: '📊 آمار و گزارشات' }, { text: '⚙️ تنظیمات سیستم' }],
    [{ text: '🔧 ابزارهای فنی' }, { text: '↩️ بازگشت به منو اصلی' }]
  ]),
  
  aiAdmin: () => createReplyKeyboard([
    [{ text: '⚙️ تنظیم توکن API' }, { text: '🔧 تنظیمات مدل' }],
    [{ text: '📂 مدیریت پرامپت' }, { text: '📊 آمار استفاده AI' }],
    [{ text: '🚨 لاگ خطاها' }, { text: '🧪 تست ارتباط' }],
    [{ text: '↩️ بازگشت به پنل ادمین' }]
  ]),
  
  editProfile: () => createReplyKeyboard([
    [{ text: '👤 نام' }, { text: '🎂 سن' }],
    [{ text: '🏙️ شهر' }, { text: '🌍 منطقه' }],
    [{ text: '⚧️ جنسیت' }, { text: '💼 شغل' }],
    [{ text: '🎯 هدف' }, { text: '📱 شماره تماس' }],
    [{ text: '↩️ بازگشت به منو اصلی' }]
  ]),
  
  vip: () => createReplyKeyboard([
    [{ text: '💰 مشاهده اطلاعات پرداخت' }],
    [{ text: '📸 ارسال رسید پرداخت' }],
    [{ text: '❓ راهنمای عضویت' }],
    [{ text: '❌ انصراف' }]
  ], { one_time: true }),
  
  story: () => createReplyKeyboard([
    [{ text: '📨 درخواست بنر و لینک' }],
    [{ text: '📸 ارسال اسکرین‌شات' }],
    [{ text: '📋 قوانین و شرایط' }],
    [{ text: '❌ انصراف' }]
  ], { one_time: true }),
  
  shop: () => createReplyKeyboard([
    [{ text: '🛍️ مشاهده تمام آیتم‌ها' }],
    [{ text: '💎 ویژه‌های VIP' }],
    [{ text: '🤖 پکیج‌های AI' }],
    [{ text: '📈 تقویت‌کننده‌ها' }],
    [{ text: '↩️ بازگشت' }]
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
    // بررسی Rate Limit
    if (!checkRateLimit(userId, 'start', 3, 30000)) {
      await bot.sendMessage(userId, '⏳ درخواست‌های شما زیاد است. لطفاً ۳۰ ثانیه صبر کنید.');
      return;
    }
    
    // بررسی وضعیت بن
    const { rows: banRows } = await pool.query(
      'SELECT is_banned, ban_until, ban_reason FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (banRows.length > 0 && banRows[0].is_banned) {
      const banUntil = banRows[0].ban_until;
      const banReason = banRows[0].ban_reason || 'دلیل نامشخص';
      
      if (banUntil && new Date(banUntil) > new Date()) {
        const remaining = Math.ceil((new Date(banUntil) - new Date()) / (1000 * 60 * 60 * 24));
        await bot.sendMessage(userId,
          `🚫 *حساب شما مسدود شده است*\n\n` +
          `📋 *دلیل:* ${banReason}\n` +
          `⏳ *تا:* ${moment(banUntil).format('jYYYY/jM/jD')}\n` +
          `📅 *مانده:* ${remaining} روز\n\n` +
          `برای درخواست بررسی مجدد با پشتیبانی تماس بگیرید.`,
          { parse_mode: 'Markdown' }
        );
        return;
      } else {
        // آزادسازی کاربر
        await pool.query(
          'UPDATE users SET is_banned = FALSE, ban_reason = NULL, ban_until = NULL WHERE telegram_id = $1',
          [userId]
        );
      }
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
    
    // ثبت فعالیت روزانه
    const today = new Date().toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO daily_activities (telegram_id, activity_date, login_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (telegram_id, activity_date) 
       DO UPDATE SET login_count = daily_activities.login_count + 1,
                     updated_at = NOW()`,
      [userId, today]
    );
    
    // اهدای امتیاز برای اولین ورود
    if (isFirstLogin) {
      await PointSystem.awardPoints(userId, 'first_login');
    } else {
      // اهدای امتیاز روزانه برای ورودهای بعدی
      const { rows: todayLogin } = await pool.query(
        'SELECT 1 FROM daily_activities WHERE telegram_id = $1 AND activity_date = $2 AND daily_bonus_claimed = FALSE',
        [userId, today]
      );
      
      if (todayLogin.length === 0) {
        await PointSystem.awardPoints(userId, 'daily_login');
      }
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
      welcomeMessage += `🎉 *ثبت‌نام اولیه شما با موفقیت انجام شد!*\n\n`;
      welcomeMessage += `💎 *امتیاز هدیه:* ۱۰۰ امتیاز برای اولین ورود\n\n`;
    }
    
    welcomeMessage += `📌 *امکانات ربات:*\n`;
    welcomeMessage += `• 💬 چت با هوش مصنوعی\n`;
    welcomeMessage += `• 📺 دسترسی به کانال‌های آموزشی\n`;
    welcomeMessage += `• 💎 سیستم عضویت VIP\n`;
    welcomeMessage += `• 🎮 سیستم امتیاز و سطح‌بندی\n`;
    welcomeMessage += `• 🛒 فروشگاه امتیازی\n`;
    welcomeMessage += `• 🎁 دریافت امتیاز با انتشار استوری\n\n`;
    
    if (!registered) {
      welcomeMessage += `📝 *برای استفاده کامل از امکانات، لطفاً ثبت‌نام کامل را انجام دهید.*\n\n`;
    }
    
    welcomeMessage += `لطفاً از منوی زیر استفاده کنید 👇`;
    
    await bot.sendMessage(userId, welcomeMessage, {
      parse_mode: 'Markdown',
      ...Keyboards.main(registered, isAdmin)
    });
    
    logger.info('User started bot', { userId, username, isFirstLogin });
    
  } catch (error) {
    logger.error('Failed to handle start command:', {
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
  
  // لاگ پیام دریافتی
  logger.debug('Received message', {
    userId,
    text: text.substring(0, 100),
    hasPhoto: !!msg.photo,
    hasDocument: !!msg.document
  });
  
  try {
    // بررسی Rate Limit
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
      await bot.sendMessage(userId, '🚫 حساب شما مسدود شده است. برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.');
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
      await handleUserState(userId, text, msg, userState);
      return;
    }
    
    // ---------- منوی اصلی ----------
    
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
          
          statsMessage += `\n📅 *فعالیت روزانه:* ${stats.streak.days} روز متوالی\n`;
          statsMessage += `🤖 *سوالات AI این هفته:* ${stats.limits.ai_weekly.remaining} باقی‌مانده\n`;
          statsMessage += `📸 *ارسال مدیا:* ${stats.user.can_send_media ? '✅ فعال' : '❌ غیرفعال'}\n`;
          
          if (stats.user.vip) {
            statsMessage += `💎 *وضعیت VIP:* ✅ تا ${moment(stats.user.vip_until).format('jYYYY/jM/jD')}\n`;
          } else {
            statsMessage += `💎 *وضعیت VIP:* ❌ غیرفعال\n`;
          }
          
          statsMessage += `\n🛒 *فروشگاه:*\n`;
          statsMessage += `• خریدها: ${stats.shop.total_purchases}\n`;
          statsMessage += `• هزینه‌کرد: ${stats.shop.total_spent.toLocaleString('fa-IR')} امتیاز\n`;
          
          statsMessage += `\n━━━━━━━━━━━━━━━━\n`;
          
          await bot.sendMessage(userId, statsMessage, {
            parse_mode: 'Markdown',
            ...Keyboards.stats()
          });
        } else {
          await bot.sendMessage(userId, '⚠️ ابتدا ثبت‌نام کنید.', Keyboards.main(false, isAdmin));
        }
      } catch (error) {
        logger.error('Failed to show stats:', { userId, error: error.message });
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
        
        // گروه‌بندی آیتم‌ها بر اساس دسته‌بندی
        const categories = {};
        shopData.items.forEach(item => {
          if (!categories[item.category]) {
            categories[item.category] = [];
          }
          categories[item.category].push(item);
        });
        
        Object.entries(categories).forEach(([category, items]) => {
          shopMessage += `*${getCategoryName(category)}:*\n`;
          
          items.forEach(item => {
            const canBuy = item.can_purchase;
            const icon = item.icon || '🔹';
            const status = canBuy ? '✅' : '❌';
            
            shopMessage += `${icon} *${item.item_name}*\n`;
            shopMessage += `   📝 ${item.description}\n`;
            shopMessage += `   💰 ${item.price.toLocaleString('fa-IR')} امتیاز ${status}\n`;
            
            if (item.max_per_user) {
              shopMessage += `   🎫 ${item.user_purchased}/${item.max_per_user} خرید\n`;
            }
            
            if (item.stock !== null) {
              shopMessage += `   📦 موجودی: ${item.stock}\n`;
            }
            
            shopMessage += `   🔸 کد خرید: \`/buy_${item.item_code}\`\n`;
            shopMessage += `   ──────────────\n`;
          });
        });
        
        shopMessage += `\nبرای خرید، کد آیتم مورد نظر را ارسال کنید.`;
        
        await bot.sendMessage(userId, shopMessage, {
          parse_mode: 'Markdown',
          ...Keyboards.shop()
        });
        
        setUserState(userId, { type: 'shop_browsing' });
        
      } catch (error) {
        logger.error('Failed to show shop:', { userId, error: error.message });
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
          `📋 *کد تراکنش:* ${result.transaction_id}\n` +
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
    
    // سایر دستورات منوی اصلی...
    // (بقیه کد مشابه قبل اما با لاگینگ بهتر)
    
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
    logger.error('Failed to handle message:', {
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

// تابع کمکی برای نام دسته‌بندی
function getCategoryName(category) {
  const names = {
    'ai': '🤖 هوش مصنوعی',
    'vip': '💎 عضویت VIP',
    'feature': '✨ ویژگی‌ها',
    'boost': '⚡ تقویت‌کننده‌ها',
    'cosmetic': '🎨 ظاهری',
    'general': '🛍️ عمومی'
  };
  return names[category] || category;
}

// ==================== راه‌اندازی سرور ====================
async function startServer() {
  try {
    logger.info('🚀 Starting KaniaChatBot...');
    logger.info(`🌐 Port: ${PORT}`);
    logger.info(`🤖 Token: ${BOT_TOKEN ? '✅' : '❌'}`);
    logger.info(`👑 Admin: ${ADMIN_CHAT_ID}`);
    logger.info(`🔗 Webhook: ${WEBHOOK_URL ? '✅' : '❌'}`);
    logger.info(`📊 Log Level: ${LOG_LEVEL}`);
    
    // ایجاد پوشه لاگ
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // ایجاد پوشه temp
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // راه‌اندازی دیتابیس
    await initializeDatabase();
    logger.info('🗄️ Database initialized');
    
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
        logger.error('Health check failed:', { error: error.message });
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
    
    // Route لاگ‌ها (فقط برای ادمین)
    app.get('/logs/:type', async (req, res) => {
      const type = req.params.type;
      const auth = req.headers.authorization;
      
      if (auth !== `Bearer ${BOT_TOKEN}`) {
        return res.status(403).json({ error: 'Unauthorized' });
      }
      
      try {
        let logs;
        switch (type) {
          case 'errors':
            logs = fs.readFileSync(path.join(__dirname, 'logs/error.log'), 'utf8');
            break;
          case 'system':
            const { rows } = await pool.query(
              'SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 100'
            );
            logs = rows;
            break;
          default:
            return res.status(400).json({ error: 'Invalid log type' });
        }
        
        res.json({
          type,
          count: Array.isArray(logs) ? logs.length : logs.split('\n').filter(l => l).length,
          logs: Array.isArray(logs) ? logs : logs.split('\n').filter(l => l)
        });
      } catch (error) {
        logger.error('Failed to fetch logs:', { type, error: error.message });
        res.status(500).json({ error: error.message });
      }
    });
    
    // شروع سرور
    app.listen(PORT, async () => {
      logger.info(`Server is running on port ${PORT}`);
      
      // تنظیم Webhook یا Polling
      if (WEBHOOK_URL && WEBHOOK_URL.trim() !== '') {
        try {
          await bot.deleteWebHook();
          await bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
          logger.info(`Webhook set to: ${WEBHOOK_URL}`);
        } catch (error) {
          logger.error('Failed to set webhook:', { error: error.message });
          bot.startPolling();
          logger.info('Fallback to polling mode');
        }
      } else {
        bot.startPolling();
        logger.info('Bot started in polling mode');
      }
      
      // ثبت دستورات
      bot.onText(/\/start/, handleStartCommand);
      bot.on('message', handleMessage);
      
      logger.info('🎉 KaniaChatBot is ready!');
      
      // ارسال اطلاع به ادمین
      if (ADMIN_CHAT_ID) {
        try {
          await bot.sendMessage(ADMIN_CHAT_ID,
            `🟢 *ربات راه‌اندازی شد*\n\n` +
            `⏰ زمان: ${moment().format('jYYYY/jM/jD HH:mm:ss')}\n` +
            `🌐 حالت: ${WEBHOOK_URL ? 'Webhook' : 'Polling'}\n` +
            `📊 لاگ‌ها: آماده\n` +
            `🗄️ دیتابیس: فعال\n\n` +
            `ربات آماده دریافت درخواست‌ها است.`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          logger.error('Failed to send startup notification to admin:', { error: error.message });
        }
      }
    });
    
    // مدیریت خاموشی گران
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection:', {
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : undefined,
        promise
      });
    });
    
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', {
        error: error.message,
        stack: error.stack
      });
      
      // پس از ثبت خطا، برنامه را به آرامی ببندید
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    });
    
  } catch (error) {
    logger.error('Failed to start server:', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// تابع خاموشی گران
async function gracefulShutdown() {
  logger.info('🛑 Starting graceful shutdown...');
  
  try {
    // توقف ربات
    if (bot.isPolling()) {
      bot.stopPolling();
      logger.info('⏹️ Bot polling stopped');
    }
    
    // حذف وب‌هوک
    try {
      await bot.deleteWebHook();
      logger.info('🗑️ Webhook deleted');
    } catch (error) {
      logger.error('Failed to delete webhook:', { error: error.message });
    }
    
    // بستن اتصال دیتابیس
    await pool.end();
    logger.info('🔌 Database connections closed');
    
    // پاکسازی فایل‌های موقت
    tempFiles.forEach((files, userId) => {
      files.forEach(file => {
        if (fs.existsSync(file)) {
          try {
            fs.unlinkSync(file);
          } catch (err) {
            logger.error('Failed to delete temp file:', { file, error: err.message });
          }
        }
      });
    });
    
    logger.info('🧹 Temporary files cleaned');
    logger.info('👋 Shutdown completed');
    
    process.exit(0);
    
  } catch (error) {
    logger.error('Error during shutdown:', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// شروع برنامه
startServer();
