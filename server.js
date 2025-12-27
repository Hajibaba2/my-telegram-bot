const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');
const fetch = require('node-fetch');

// ==================== تنظیمات ====================
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ==================== لاگر ساده ====================
const logger = {
  info: (msg, data = {}) => console.log(JSON.stringify({ level: 'INFO', time: new Date().toISOString(), message: msg, ...data })),
  error: (msg, data = {}) => console.error(JSON.stringify({ level: 'ERROR', time: new Date().toISOString(), message: msg, ...data })),
  warn: (msg, data = {}) => console.warn(JSON.stringify({ level: 'WARN', time: new Date().toISOString(), message: msg, ...data }))
};

// ==================== اعتبارسنجی ====================
if (!BOT_TOKEN) {
  logger.error('BOT_TOKEN is required!');
  process.exit(1);
}

if (!ADMIN_CHAT_ID || isNaN(ADMIN_CHAT_ID)) {
  logger.error('ADMIN_CHAT_ID is invalid!');
  process.exit(1);
}

logger.info('Config loaded', { 
  hasToken: !!BOT_TOKEN, 
  adminId: ADMIN_CHAT_ID,
  port: PORT,
  hasWebhook: !!WEBHOOK_URL,
  webhookUrl: WEBHOOK_URL || 'none'
});

// ==================== اتصال دیتابیس (ساده) ====================
let pool;
try {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  logger.info('Connecting to database...', { 
    hasConnectionString: !!connectionString 
  });

  pool = new Pool({
    connectionString: connectionString,
    ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
  });

  pool.on('connect', () => logger.info('Database connected'));
  pool.on('error', (err) => logger.error('Database error', { error: err.message }));
} catch (err) {
  logger.error('Failed to create pool', { error: err.message });
  // ادامه بدون دیتابیس
}

// ==================== ایجاد ربات ====================
logger.info('Creating Telegram bot...');
const bot = new TelegramBot(BOT_TOKEN);

// تنظیمات ربات
bot.on('error', (error) => {
  logger.error('Bot error', { error: error.message, code: error.code });
});

bot.on('polling_error', (error) => {
  logger.error('Polling error', { error: error.message });
});

// ==================== توابع کمکی ====================
function createKeyboard(buttons, options = {}) {
  return {
    reply_markup: {
      keyboard: buttons,
      resize_keyboard: true,
      one_time_keyboard: !!options.one_time
    }
  };
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ==================== مدیریت دستورات ====================

// دستور /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || '';
  
  logger.info('/start received', { chatId, username });
  
  try {
    // ذخیره کاربر در دیتابیس اگر موجود باشد
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO users (telegram_id, username) 
           VALUES ($1, $2) 
           ON CONFLICT (telegram_id) 
           DO UPDATE SET username = $2`,
          [chatId, username]
        );
      } catch (dbError) {
        logger.error('Database error in /start', { error: dbError.message });
      }
    }
    
    const isAdmin = chatId === ADMIN_CHAT_ID;
    const keyboard = createKeyboard([
      [{ text: '🤖 چت با AI' }, { text: '📊 آمار من' }],
      [{ text: '🛒 فروشگاه' }, { text: '💎 VIP' }],
      ...(isAdmin ? [[{ text: '🛡️ ادمین' }]] : [])
    ]);
    
    await bot.sendMessage(chatId,
      `🌟 *سلام! به ربات خوش آمدید* 🌟\n\n` +
      `من یک ربات هوش مصنوعی هستم که می‌تونم:\n` +
      `• به سوالاتت پاسخ بدم 🤖\n` +
      `• امتیاز بهت بدم ⭐\n` +
      `• و کلی کارای دیگه! 🎉\n\n` +
      `از منوی زیر انتخاب کن:`,
      { 
        parse_mode: 'Markdown',
        ...keyboard
      }
    );
    
  } catch (error) {
    logger.error('Error in /start', { chatId, error: error.message });
    try {
      await bot.sendMessage(chatId, '❌ مشکلی پیش اومد. دوباره تلاش کن!');
    } catch (sendError) {
      logger.error('Could not send error message', { error: sendError.message });
    }
  }
});

// دستور /help
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId,
    `📖 *راهنمای ربات*\n\n` +
    `*/start* - شروع کار با ربات\n` +
    `*/help* - این راهنما\n` +
    `*/stats* - مشاهده آمار\n` +
    `*/shop* - فروشگاه امتیازی\n\n` +
    `💡 *نکته:* می‌تونی از دکمه‌های منو هم استفاده کنی!`,
    { parse_mode: 'Markdown' }
  );
});

// دستور /stats
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  
  let score = 0;
  let level = 1;
  
  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT total_score, current_level FROM users WHERE telegram_id = $1',
        [chatId]
      );
      if (rows.length > 0) {
        score = rows[0].total_score || 0;
        level = rows[0].current_level || 1;
      }
    } catch (error) {
      logger.error('Database error in /stats', { error: error.message });
    }
  }
  
  await bot.sendMessage(chatId,
    `📊 *آمار شما*\n\n` +
    `⭐ امتیاز: ${score}\n` +
    `📈 سطح: ${level}\n` +
    `🆔 آیدی: ${chatId}\n\n` +
    `با امتیاز بیشتر می‌تونی از فروشگاه خرید کنی!`,
    { parse_mode: 'Markdown' }
  );
});

// دستور /shop
bot.onText(/\/shop/, async (msg) => {
  const chatId = msg.chat.id;
  
  const items = [
    { name: '۲ سوال AI اضافی', price: 50, code: 'ai2' },
    { name: '۵ سوال AI اضافی', price: 100, code: 'ai5' },
    { name: 'دسترسی ارسال مدیا', price: 150, code: 'media' },
    { name: '۱ روز VIP', price: 200, code: 'vip1' }
  ];
  
  let message = `🛒 *فروشگاه امتیازی*\n\n`;
  items.forEach((item, index) => {
    message += `${index + 1}. *${item.name}*\n`;
    message += `   💰 ${item.price} امتیاز\n`;
    message += `   🛍️ کد: /buy_${item.code}\n\n`;
  });
  
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// مدیریت پیام‌های متنی
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  
  // نادیده گرفتن دستورات (با اسلش شروع می‌شوند)
  if (text.startsWith('/')) return;
  
  logger.info('Message received', { chatId, text: text.substring(0, 50) });
  
  // پاسخ به دکمه‌های منو
  if (text === '🤖 چت با AI') {
    await bot.sendMessage(chatId,
      '🤖 *چت با هوش مصنوعی*\n\n' +
      'سوال خودت رو بپرس یا برای تنظیم توکن AI به ادمین پیام بده.\n\n' +
      'آماده پاسخگویی هستم! ✨',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  if (text === '📊 آمار من') {
    await bot.sendMessage(chatId, '📊 در حال محاسبه آمار...');
    // اجرای دستور /stats
    const fakeMsg = { ...msg, text: '/stats' };
    bot.processUpdate({ message: fakeMsg });
    return;
  }
  
  if (text === '🛒 فروشگاه') {
    await bot.sendMessage(chatId, '🛒 در حال بارگذاری فروشگاه...');
    // اجرای دستور /shop
    const fakeMsg = { ...msg, text: '/shop' };
    bot.processUpdate({ message: fakeMsg });
    return;
  }
  
  if (text === '💎 VIP') {
    await bot.sendMessage(chatId,
      `💎 *عضویت VIP*\n\n` +
      `با عضویت VIP:\n` +
      `• سوالات نامحدود AI 🤖\n` +
      `• دسترسی به کانال ویژه 📢\n` +
      `• پشتیبانی اولویت‌دار 🚀\n\n` +
      `برای اطلاعات بیشتر با ادمین تماس بگیر.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  if (text === '🛡️ ادمین' && chatId === ADMIN_CHAT_ID) {
    await bot.sendMessage(chatId,
      `🛡️ *پنل ادمین*\n\n` +
      `دستورات موجود:\n` +
      `• /set_token [توکن] - تنظیم توکن AI\n` +
      `• /set_channel [لینک] - تنظیم کانال\n` +
      `• /broadcast [پیام] - ارسال به همه\n` +
      `• /stats_all - آمار کلی`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // اگر هیچکدام از گزینه‌های بالا نبود
  if (text.trim().length > 0) {
    await bot.sendMessage(chatId,
      `🤔 متوجه نشدم!\n\n` +
      `می‌تونی از دکمه‌های منو استفاده کنی یا دستور /help رو بزنی.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ==================== راه‌اندازی سرور ====================

// Route اصلی
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'KaniaBot',
    time: new Date().toISOString(),
    bot: BOT_TOKEN ? 'configured' : 'not-configured',
    webhook: WEBHOOK_URL || 'not-set'
  });
});

// Route سلامت
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Route وب‌هوک تلگرام
app.post(`/webhook`, async (req, res) => {
  logger.info('Webhook received', { body: req.body });
  
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error processing webhook', { error: error.message });
    res.sendStatus(200); // همچنان 200 برگردان تا تلگرام دوباره نفرستد
  }
});

// Route جایگزین برای وب‌هوک (برای Railway)
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  logger.info('Telegram webhook received', { path: `/bot${BOT_TOKEN}` });
  
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error in Telegram webhook', { error: error.message });
    res.sendStatus(200);
  }
});

// Route تست وب‌هوک
app.get(`/setwebhook`, async (req, res) => {
  if (!WEBHOOK_URL) {
    return res.json({ error: 'WEBHOOK_URL not set' });
  }
  
  try {
    // حذف وب‌هوک قبلی
    await bot.deleteWebHook();
    logger.info('Old webhook deleted');
    
    // تنظیم وب‌هوک جدید
    const webhookUrl = `${WEBHOOK_URL}/bot${BOT_TOKEN}`;
    await bot.setWebHook(webhookUrl);
    
    logger.info('New webhook set', { url: webhookUrl });
    
    res.json({
      success: true,
      message: 'Webhook set successfully',
      url: webhookUrl,
      time: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Failed to set webhook', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== شروع برنامه ====================
async function startServer() {
  try {
    logger.info('🚀 Starting server...', { 
      port: PORT,
      nodeEnv: NODE_ENV 
    });
    
    // شروع سرور
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`✅ Server is running on port ${PORT}`);
      
      // اگر WEBHOOK_URL تنظیم شده، وب‌هوک را تنظیم کن
      if (WEBHOOK_URL && WEBHOOK_URL.trim() !== '') {
        setTimeout(async () => {
          try {
            await bot.deleteWebHook();
            const webhookUrl = `${WEBHOOK_URL}/bot${BOT_TOKEN}`;
            await bot.setWebHook(webhookUrl);
            logger.info('✅ Webhook set automatically', { url: webhookUrl });
            
            // اطلاع به ادمین
            await bot.sendMessage(ADMIN_CHAT_ID,
              `🟢 *سرور راه‌اندازی شد*\n\n` +
              `🌐 پورت: ${PORT}\n` +
              `🔗 وب‌هوک: ${webhookUrl}\n` +
              `⏰ زمان: ${new Date().toLocaleString('fa-IR')}\n\n` +
              `ربات آماده دریافت پیام است!`,
              { parse_mode: 'Markdown' }
            );
            
          } catch (webhookError) {
            logger.error('Failed to auto-set webhook', { error: webhookError.message });
            
            // شروع polling به عنوان جایگزین
            bot.startPolling();
            logger.info('📡 Started in polling mode');
            
            await bot.sendMessage(ADMIN_CHAT_ID,
              `⚠️ *ربات در حالت Polling راه‌اندازی شد*\n\n` +
              `وب‌هوک تنظیم نشد، اما ربات در حال polling است.\n` +
              `برای تنظیم وب‌هوک دستی، به این آدرس برو:\n` +
              `${WEBHOOK_URL}/setwebhook`,
              { parse_mode: 'Markdown' }
            );
          }
        }, 2000);
      } else {
        // اگر وب‌هوک نداریم، polling شروع کن
        logger.info('No WEBHOOK_URL, starting polling...');
        bot.startPolling();
        
        await bot.sendMessage(ADMIN_CHAT_ID,
          `📡 *ربات در حالت Polling راه‌اندازی شد*\n\n` +
          `🌐 پورت: ${PORT}\n` +
          `⏰ زمان: ${new Date().toLocaleString('fa-IR')}\n\n` +
          `ربات آماده دریافت پیام است!`,
          { parse_mode: 'Markdown' }
        );
      }
    });
    
    // مدیریت خاموشی
    process.on('SIGTERM', () => {
      logger.info('🛑 Received SIGTERM, shutting down...');
      server.close(() => {
        logger.info('✅ Server closed');
        process.exit(0);
      });
    });
    
    process.on('SIGINT', () => {
      logger.info('🛑 Received SIGINT, shutting down...');
      server.close(() => {
        logger.info('✅ Server closed');
        process.exit(0);
      });
    });
    
    // مدیریت خطاهای catch نشده
    process.on('uncaughtException', (error) => {
      logger.error('🔥 Uncaught Exception', { 
        error: error.message,
        stack: error.stack 
      });
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('🔥 Unhandled Rejection', { 
        reason: reason instanceof Error ? reason.message : reason 
      });
    });
    
  } catch (error) {
    logger.error('🔥 Failed to start server', { 
      error: error.message,
      stack: error.stack 
    });
    
    // تلاش برای اطلاع به ادمین
    try {
      await bot.sendMessage(ADMIN_CHAT_ID,
        `🔴 *خطای بحرانی در راه‌اندازی*\n\n` +
        `❌ ${error.message.substring(0, 100)}\n\n` +
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
