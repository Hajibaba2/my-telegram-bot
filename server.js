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
const logger = {
  log: (level, message, data = {}) => {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...data
    };
    
    console.log(JSON.stringify(logEntry));
    
    if (level === 'error' && data.error && data.error.stack) {
      console.error('Stack Trace:', data.error.stack);
    }
  },
  
  info: (message, data = {}) => logger.log('info', message, data),
  error: (message, data = {}) => logger.log('error', message, data),
  warn: (message, data = {}) => logger.log('warn', message, data),
  debug: (message, data = {}) => {
    if (NODE_ENV === 'development') {
      logger.log('debug', message, data);
    }
  }
};

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
let pool;
try {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  logger.info('Database connection string:', { 
    hasConnectionString: !!connectionString,
    stringLength: connectionString ? connectionString.length : 0
  });
  
  pool = new Pool({
    connectionString: connectionString,
    ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    logger.error('Unexpected database error', { error: err.message });
  });

  pool.on('connect', () => {
    logger.info('Database connection established');
  });
} catch (err) {
  logger.error('Failed to create database pool', { error: err.message });
  process.exit(1);
}

// ==================== راه‌اندازی ربات تلگرام ====================
const bot = new TelegramBot(BOT_TOKEN, {
  polling: false,
  filepath: false
});

bot.on('error', (err) => {
  logger.error('Telegram Bot Error', { error: err.message });
});

// ==================== ایجاد جداول دیتابیس (با اشکال‌زدایی) ====================
async function initializeDatabase() {
  logger.info('Starting database initialization...');
  
  const client = await pool.connect();
  
  try {
    // ابتدا یک کوئری ساده برای تست اتصال
    const testResult = await client.query('SELECT version()');
    logger.info('Database connection test successful', { 
      version: testResult.rows[0]?.version?.substring(0, 50) || 'Unknown'
    });
    
    await client.query('BEGIN');
    
    logger.info('Creating users table...');
    // جدول کاربران - بسیار ساده‌شده
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        name VARCHAR(255),
        total_score INTEGER DEFAULT 0,
        current_level INTEGER DEFAULT 1,
        ai_questions_used INTEGER DEFAULT 0,
        weekly_ai_questions INTEGER DEFAULT 0,
        can_send_media BOOLEAN DEFAULT FALSE,
        extra_ai_questions INTEGER DEFAULT 0,
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logger.info('Users table created');
    
    logger.info('Creating vips table...');
    // جدول VIP - بسیار ساده‌شده
    await client.query(`
      CREATE TABLE IF NOT EXISTS vips (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE REFERENCES users(telegram_id) ON DELETE CASCADE,
        approved BOOLEAN DEFAULT FALSE,
        end_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logger.info('Vips table created');
    
    logger.info('Creating settings table...');
    // جدول تنظیمات
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        ai_token TEXT,
        free_channel TEXT,
        vip_channel TEXT,
        membership_fee VARCHAR(100),
        wallet_address TEXT,
        network TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      INSERT INTO settings (id) VALUES (1) 
      ON CONFLICT (id) DO NOTHING;
    `);
    logger.info('Settings table created');
    
    logger.info('Creating shop_items table...');
    // جدول فروشگاه
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
    logger.info('Shop items table created');
    
    logger.info('Inserting default shop items...');
    // داده‌های اولیه فروشگاه
    await client.query(`
      INSERT INTO shop_items (item_code, item_name, description, price, benefit_type, benefit_value) VALUES
      ('ai_2_extra', '۲ سوال AI اضافی', 'خرید ۲ سوال اضافی', 50, 'ai_questions', 2),
      ('ai_5_extra', '۵ سوال AI اضافی', '۵ سوال اضافی', 100, 'ai_questions', 5),
      ('media_access', 'دسترسی ارسال مدیا', 'اجازه ارسال عکس', 150, 'media_access', 1)
      ON CONFLICT (item_code) DO NOTHING;
    `);
    logger.info('Default shop items inserted');
    
    await client.query('COMMIT');
    logger.info('Database initialization completed successfully');
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to initialize database', { 
      error: error.message,
      stack: error.stack,
      code: error.code,
      detail: error.detail,
      table: error.table,
      constraint: error.constraint,
      column: error.column,
      dataType: error.dataType
    });
    
    // اگر خطا از نوع جدول تکراری است، ادامه بده
    if (error.code === '42P07') { // duplicate_table
      logger.warn('Tables already exist, continuing...');
      return true;
    }
    
    throw error;
  } finally {
    client.release();
  }
  
  return true;
}

// ==================== توابع اصلی ====================
const userStates = new Map();

function createReplyKeyboard(keyboardArray, options = {}) {
  return {
    reply_markup: {
      keyboard: keyboardArray,
      resize_keyboard: true,
      one_time_keyboard: !!options.one_time,
      input_field_placeholder: options.placeholder || ''
    }
  };
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function handleStartCommand(msg) {
  const userId = msg.chat.id;
  const username = msg.from.username || '';
  
  logger.info('Start command received', { userId, username });
  
  try {
    // ذخیره/به‌روزرسانی کاربر
    await pool.query(
      `INSERT INTO users (telegram_id, username, last_seen) 
       VALUES ($1, $2, NOW())
       ON CONFLICT (telegram_id) 
       DO UPDATE SET username = $2, last_seen = NOW()`,
      [userId, username]
    );
    
    const isAdmin = userId === ADMIN_CHAT_ID;
    const keyboard = createReplyKeyboard([
      [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
      [{ text: '🤖 چت با هوش مصنوعی' }],
      [{ text: '📊 آمار من' }, { text: '🛒 فروشگاه امتیاز' }],
      ...(isAdmin ? [[{ text: '🛡️ پنل ادمین' }]] : [])
    ]);
    
    await bot.sendMessage(userId,
      `🌟 به ربات KaniaChatBot خوش آمدید! 🌟\n\n` +
      `لطفاً از منوی زیر استفاده کنید 👇`,
      keyboard
    );
    
  } catch (error) {
    logger.error('Error in start command', { userId, error: error.message });
    await bot.sendMessage(userId, '❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
  }
}

async function showUserStats(userId) {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userRows.length === 0) {
      return '⚠️ ابتدا ثبت‌نام کنید.';
    }
    
    const user = userRows[0];
    const { rows: vipRows } = await pool.query(
      'SELECT 1 FROM vips WHERE telegram_id = $1 AND approved AND end_date > NOW()',
      [userId]
    );
    
    const isVip = vipRows.length > 0;
    
    let message = `📊 *آمار شما*\n━━━━━━━━━━━━━━━━\n`;
    message += `👤 *آیدی:* ${userId}\n`;
    message += `⭐ *امتیاز:* ${user.total_score || 0}\n`;
    message += `📊 *سطح:* ${user.current_level || 1}\n`;
    message += `🤖 *سوالات AI:* ${user.ai_questions_used || 0}\n`;
    message += `💎 *VIP:* ${isVip ? '✅ فعال' : '❌ غیرفعال'}\n`;
    message += `📸 *ارسال مدیا:* ${user.can_send_media ? '✅' : '❌'}\n`;
    message += `━━━━━━━━━━━━━━━━`;
    
    return message;
    
  } catch (error) {
    logger.error('Error showing stats', { userId, error: error.message });
    return '❌ خطا در بارگذاری آمار.';
  }
}

async function showShop(userId) {
  try {
    const { rows: items } = await pool.query(
      'SELECT * FROM shop_items WHERE is_active = TRUE ORDER BY price'
    );
    
    const { rows: userRows } = await pool.query(
      'SELECT total_score FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    const userScore = userRows[0]?.total_score || 0;
    
    let message = `🛒 *فروشگاه امتیازی*\n━━━━━━━━━━━━━━━━\n`;
    message += `💰 *موجودی:* ${userScore} امتیاز\n\n`;
    
    items.forEach((item, index) => {
      const canBuy = userScore >= item.price;
      message += `${index + 1}. *${item.item_name}*\n`;
      message += `   ${item.description}\n`;
      message += `   💰 ${item.price} امتیاز ${canBuy ? '✅' : '❌'}\n`;
      message += `   🔹 کد: \`/buy_${item.item_code}\`\n`;
      message += `   ──────────────\n`;
    });
    
    return message;
    
  } catch (error) {
    logger.error('Error showing shop', { userId, error: error.message });
    return '❌ خطا در بارگذاری فروشگاه.';
  }
}

async function handlePurchase(userId, itemCode) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // دریافت آیتم
    const { rows: itemRows } = await client.query(
      'SELECT * FROM shop_items WHERE item_code = $1 AND is_active = TRUE',
      [itemCode]
    );
    
    if (itemRows.length === 0) {
      throw new Error('آیتم یافت نشد');
    }
    
    const item = itemRows[0];
    
    // بررسی موجودی کاربر
    const { rows: userRows } = await client.query(
      'SELECT total_score FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userRows.length === 0) {
      throw new Error('کاربر یافت نشد');
    }
    
    const userScore = userRows[0].total_score || 0;
    
    if (userScore < item.price) {
      throw new Error('امتیاز کافی ندارید');
    }
    
    // کسر امتیاز
    await client.query(
      'UPDATE users SET total_score = total_score - $1 WHERE telegram_id = $2',
      [item.price, userId]
    );
    
    // اعمال مزایا
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
    }
    
    await client.query('COMMIT');
    
    return {
      success: true,
      item: item,
      remaining: userScore - item.price
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Purchase failed', { userId, itemCode, error: error.message });
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

async function handleMessage(msg) {
  const userId = msg.chat.id;
  const text = msg.text || '';
  
  logger.debug('Message received', { userId, text: text.substring(0, 50) });
  
  try {
    // به‌روزرسانی آخرین فعالیت
    await pool.query(
      'UPDATE users SET last_seen = NOW() WHERE telegram_id = $1',
      [userId]
    );
    
    // 📊 آمار من
    if (text === '📊 آمار من') {
      const stats = await showUserStats(userId);
      await bot.sendMessage(userId, stats, { 
        parse_mode: 'Markdown',
        ...createReplyKeyboard([[{ text: '↩️ بازگشت' }]])
      });
      return;
    }
    
    // 🛒 فروشگاه امتیاز
    if (text === '🛒 فروشگاه امتیاز') {
      const shopMessage = await showShop(userId);
      await bot.sendMessage(userId, shopMessage, { 
        parse_mode: 'Markdown',
        ...createReplyKeyboard([[{ text: '↩️ بازگشت' }]])
      });
      return;
    }
    
    // خرید آیتم
    if (text.startsWith('/buy_')) {
      const itemCode = text.replace('/buy_', '');
      const result = await handlePurchase(userId, itemCode);
      
      if (result.success) {
        await bot.sendMessage(userId,
          `✅ *خرید موفقیت‌آمیز!*\n\n` +
          `🎁 ${result.item.item_name}\n` +
          `💰 ${result.item.price} امتیاز\n` +
          `💳 باقی‌مانده: ${result.remaining} امتیاز`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(userId,
          `❌ *خرید ناموفق*\n\n${result.error}`,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }
    
    // 🤖 چت با هوش مصنوعی
    if (text === '🤖 چت با هوش مصنوعی') {
      const { rows } = await pool.query('SELECT ai_token FROM settings WHERE id = 1');
      
      if (!rows[0]?.ai_token) {
        await bot.sendMessage(userId, '⚠️ هوش مصنوعی تنظیم نشده است.');
        return;
      }
      
      await bot.sendMessage(userId, '🧠 سوال خود را بپرسید:', 
        createReplyKeyboard([[{ text: '↩️ بازگشت' }]], { one_time: true })
      );
      userStates.set(userId, { type: 'ai_chat' });
      return;
    }
    
    // اگر کاربر در حالت چت AI است
    if (userStates.has(userId) && userStates.get(userId).type === 'ai_chat') {
      if (text === '↩️ بازگشت') {
        userStates.delete(userId);
        await bot.sendMessage(userId, '↩️ بازگشت به منوی اصلی', 
          createReplyKeyboard([
            [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
            [{ text: '🤖 چت با هوش مصنوعی' }],
            [{ text: '📊 آمار من' }, { text: '🛒 فروشگاه امتیاز' }]
          ])
        );
        return;
      }
      
      try {
        const { rows } = await pool.query('SELECT ai_token FROM settings WHERE id = 1');
        const apiKey = rows[0].ai_token;
        
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: text }],
            temperature: 0.7,
            max_tokens: 1000
          })
        });
        
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        const aiResponse = data.choices[0]?.message?.content || 'پاسخی دریافت نشد';
        
        // ثبت استفاده
        await pool.query(
          'UPDATE users SET ai_questions_used = COALESCE(ai_questions_used, 0) + 1 WHERE telegram_id = $1',
          [userId]
        );
        
        await bot.sendMessage(userId, aiResponse, 
          createReplyKeyboard([[{ text: '↩️ بازگشت' }]], { one_time: true })
        );
        
      } catch (error) {
        logger.error('AI chat error', { userId, error: error.message });
        await bot.sendMessage(userId, 
          '❌ خطا در ارتباط با هوش مصنوعی. لطفاً بعداً تلاش کنید.',
          createReplyKeyboard([[{ text: '↩️ بازگشت' }]])
        );
        userStates.delete(userId);
      }
      return;
    }
    
    // ↩️ بازگشت
    if (text === '↩️ بازگشت') {
      userStates.delete(userId);
      const isAdmin = userId === ADMIN_CHAT_ID;
      await bot.sendMessage(userId, '↩️ بازگشت به منوی اصلی', 
        createReplyKeyboard([
          [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
          [{ text: '🤖 چت با هوش مصنوعی' }],
          [{ text: '📊 آمار من' }, { text: '🛒 فروشگاه امتیاز' }],
          ...(isAdmin ? [[{ text: '🛡️ پنل ادمین' }]] : [])
        ])
      );
      return;
    }
    
    // 📺 کانال رایگان
    if (text === '📺 کانال رایگان') {
      const { rows } = await pool.query('SELECT free_channel FROM settings WHERE id = 1');
      await bot.sendMessage(userId, 
        `📢 *کانال رایگان*\n━━━━━━━━━━━━━━━━\n${rows[0]?.free_channel || 'تنظیم نشده'}\n━━━━━━━━━━━━━━━━`, 
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // 💎 عضویت VIP
    if (text === '💎 عضویت VIP') {
      const { rows } = await pool.query('SELECT membership_fee, wallet_address, network FROM settings WHERE id = 1');
      const s = rows[0];
      
      if (s?.membership_fee && s?.wallet_address) {
        const message = `💎 *عضویت VIP*\n━━━━━━━━━━━━━━━━\n💰 *مبلغ:* ${s.membership_fee}\n\n👛 *آدرس:*\n\`${s.wallet_address}\`\n\n🌐 *شبکه:* ${s.network || 'TRC20'}\n━━━━━━━━━━━━━━━━`;
        await bot.sendMessage(userId, escapeMarkdown(message), { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(userId, '⚠️ اطلاعات VIP تنظیم نشده است.');
      }
      return;
    }
    
    // 🛡️ پنل ادمین
    if (text === '🛡️ پنل ادمین' && userId === ADMIN_CHAT_ID) {
      const keyboard = createReplyKeyboard([
        [{ text: '⚙️ تنظیم توکن AI' }, { text: '📺 تنظیم کانال' }],
        [{ text: '💰 تنظیم VIP' }, { text: '📊 آمار سیستم' }],
        [{ text: '↩️ بازگشت' }]
      ]);
      
      await bot.sendMessage(userId, '🛡️ *پنل ادمین فعال شد*', { 
        parse_mode: 'Markdown', 
        ...keyboard 
      });
      return;
    }
    
    // اگر پیام دیگری بود
    const isAdmin = userId === ADMIN_CHAT_ID;
    await bot.sendMessage(userId,
      'لطفاً از منوی زیر استفاده کنید:',
      createReplyKeyboard([
        [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
        [{ text: '🤖 چت با هوش مصنوعی' }],
        [{ text: '📊 آمار من' }, { text: '🛒 فروشگاه امتیاز' }],
        ...(isAdmin ? [[{ text: '🛡️ پنل ادمین' }]] : [])
      ])
    );
    
  } catch (error) {
    logger.error('Error handling message', { userId, error: error.message });
    await bot.sendMessage(userId, '❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
  }
}

// ==================== راه‌اندازی سرور ====================
async function startServer() {
  try {
    logger.info('🚀 Starting KaniaChatBot...');
    logger.info(`🌐 Port: ${PORT}`);
    logger.info(`🤖 Token: ${BOT_TOKEN ? '✅' : '❌'}`);
    logger.info(`👑 Admin: ${ADMIN_CHAT_ID}`);
    logger.info(`🔗 Webhook: ${WEBHOOK_URL ? '✅' : '❌'}`);
    
    // تست اتصال دیتابیس
    try {
      const testResult = await pool.query('SELECT 1 as test');
      logger.info('Database connection test passed', { test: testResult.rows[0]?.test });
    } catch (dbError) {
      logger.error('Database connection test failed', { error: dbError.message });
      // ادامه می‌دهیم حتی اگر دیتابیس مشکل داشته باشد
    }
    
    // راه‌اندازی دیتابیس (با تلاش مجدد)
    let dbInitialized = false;
    let retries = 3;
    
    while (!dbInitialized && retries > 0) {
      try {
        await initializeDatabase();
        dbInitialized = true;
        logger.info('Database initialized successfully');
      } catch (dbError) {
        retries--;
        logger.error(`Database init failed, ${retries} retries left`, { error: dbError.message });
        
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    if (!dbInitialized) {
      logger.warn('Continuing without full database initialization');
    }
    
    // Route وب‌هوک
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
      logger.info('Webhook received', { body: req.body });
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    
    // Route سلامت (ساده‌شده)
    app.get('/health', async (req, res) => {
      try {
        // فقط یک تست ساده
        await pool.query('SELECT 1');
        res.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          database: 'connected'
        });
      } catch (error) {
        res.status(500).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: error.message
        });
      }
    });
    
    // Route اصلی
    app.get('/', (req, res) => {
      res.json({
        service: 'KaniaChatBot',
        status: 'online',
        timestamp: new Date().toISOString()
      });
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
          logger.error('Failed to set webhook', { error: error.message });
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
      try {
        await bot.sendMessage(ADMIN_CHAT_ID,
          `🟢 *ربات راه‌اندازی شد*\n\n` +
          `⏰ زمان: ${moment().format('jYYYY/jM/jD HH:mm:ss')}\n` +
          `🌐 پورت: ${PORT}\n` +
          `🗄️ دیتابیس: ${dbInitialized ? '✅' : '⚠️'}\n\n` +
          `ربات آماده دریافت درخواست‌ها است.`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        logger.error('Failed to send startup notification', { error: error.message });
      }
    });
    
    // مدیریت خاموشی
    process.on('SIGTERM', async () => {
      logger.info('🛑 Shutdown signal received');
      try {
        if (bot.isPolling()) bot.stopPolling();
        await pool.end();
        logger.info('👋 Shutdown completed');
      } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
      }
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Failed to start server', { 
      error: error.message,
      stack: error.stack 
    });
    
    // تلاش برای اطلاع به ادمین
    try {
      await bot.sendMessage(ADMIN_CHAT_ID,
        `🔴 *خطا در راه‌اندازی ربات*\n\n` +
        `⏰ زمان: ${moment().format('jYYYY/jM/jD HH:mm:ss')}\n` +
        `🚫 خطا: ${error.message.substring(0, 200)}\n\n` +
        `لطفاً لاگ‌ها را بررسی کنید.`,
        { parse_mode: 'Markdown' }
      );
    } catch (botError) {
      logger.error('Could not notify admin', { error: botError.message });
    }
    
    process.exit(1);
  }
}

// شروع برنامه
startServer();
