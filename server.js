const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
app.use(express.json());

// ==================== Environment Variables ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const RAILWAY_PUBLIC_URL = process.env.RAILWAY_PUBLIC_URL;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// ==================== Health Check Endpoints ====================
app.get('/', (req, res) => {
  res.json({ 
    status: 'online',
    service: 'KaniaChatBot',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ==================== Initialize Database ====================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('connect', () => {
  console.log('✅ اتصال دیتابیس موفق');
});

pool.on('error', (err) => {
  console.error('❌ خطای دیتابیس:', err.message);
});

// ==================== Initialize Bot ====================
const bot = new TelegramBot(BOT_TOKEN, {
  polling: false,
  filepath: false
});

// ==================== Global Variables ====================
const states = {};
const rateLimit = {};
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

// ==================== Webhook Route ====================
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ==================== Telegram Bot Handlers ====================
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  
  if (!checkRateLimit(id)) {
    await bot.sendMessage(id, '⚠️ درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.');
    return;
  }
  
  try {
    const admin = id === ADMIN_CHAT_ID;
    
    // ثبت کاربر در دیتابیس اگر وجود ندارد
    await pool.query(
      `INSERT INTO users (telegram_id, username) 
       VALUES ($1, $2) 
       ON CONFLICT (telegram_id) 
       DO UPDATE SET username = EXCLUDED.username`,
      [id, msg.from.username || null]
    );
    
    await bot.sendMessage(
      id,
      '🌟 به ربات KaniaChatBot خوش آمدید! 🌟\n\nلطفاً از منوی زیر استفاده کنید 👇',
      mainKeyboard(true, admin)
    );
    
    logActivity(id, 'استارت کرد');
  } catch (err) {
    console.error('❌ خطا در دستور /start:', err.message, err.stack);
    await bot.sendMessage(id, '❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
  }
});

// ==================== Message Handler ====================
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text || '';
  const admin = id === ADMIN_CHAT_ID;
  
  if (!checkRateLimit(id)) {
    await bot.sendMessage(id, '⚠️ درخواست‌های شما زیاد است. لطفاً ۱ دقیقه صبر کنید.');
    return;
  }
  
  console.log(`📨 User ${id}: "${text.substring(0, 50)}"`);
  
  // پاسخ به پیام‌های متنی
  if (text) {
    // اگر پیام راه‌اندازی از ادمین است، منوی اصلی را بفرست
    if (admin && text.includes('ربات راه‌اندازی شد')) {
      await bot.sendMessage(
        id,
        '🌟 *به پنل ادمین KaniaChatBot خوش آمدید!* 🌟\n\nلطفاً از منوی زیر استفاده کنید 👇',
        mainKeyboard(true, true)
      );
    }
    
    // پاسخ به سایر پیام‌ها
    if (text === '🛡️ پنل ادمین' && admin) {
      await bot.sendMessage(id, '🛡️ *پنل ادمین فعال شد*', { 
        parse_mode: 'Markdown', 
        ...mainKeyboard(true, true) 
      });
    }
  }
});

// ==================== Startup Function ====================
async function startServer() {
  try {
    console.log('🚀 شروع راه‌اندازی KaniaChatBot...');
    console.log(`🔧 BOT_TOKEN: ${BOT_TOKEN ? '✅' : '❌'}`);
    console.log(`🔧 ADMIN_CHAT_ID: ${ADMIN_CHAT_ID || '❌'}`);
    console.log(`🔧 PORT: ${PORT}`);
    console.log(`🔧 RAILWAY_PUBLIC_URL: ${RAILWAY_PUBLIC_URL || '❌'}`);
    
    // تنظیم Webhook برای Railway
    if (RAILWAY_PUBLIC_URL) {
        // تنظیم webhook
  const webhookUrl = `\( {RAILWAY_PUBLIC_URL}/bot \){BOT_TOKEN}`;
      console.log(`🌍 تنظیم Webhook: ${webhookUrl}`);
      
      try {
        // await bot.deleteWebHook();
        await bot.setWebHook(webhookUrl, {
          max_connections: 100,
          allowed_updates: ['message', 'callback_query']
        });
        console.log('✅ Webhook تنظیم شد.');
      } catch (err) {
        console.error('❌ خطا در تنظیم Webhook:', err.message);
        throw err;
      }
    } else {
      console.error('❌ RAILWAY_PUBLIC_URL تنظیم نشده است!');
      process.exit(1);
    }
    
    // راه‌اندازی سرور HTTP
    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ سرور HTTP روی پورت ${PORT} راه‌اندازی شد`);
      console.log('🎉 KaniaChatBot آماده است! 🚀');
      
      // ارسال پیام به ادمین
      if (ADMIN_CHAT_ID) {
        setTimeout(async () => {
          try {
            await bot.sendMessage(ADMIN_CHAT_ID, 
              `🚀 *ربات راه‌اندازی شد!*\n\n` +
              `📍 *آدرس:* ${RAILWAY_PUBLIC_URL}\n` +
              `📅 *زمان:* ${new Date().toLocaleString('fa-IR')}\n\n` +
              `✅ ربات آماده ارائه خدمات است.`,
              { parse_mode: 'Markdown' }
            );
          } catch (err) {
            console.log('⚠️ نتوانست به ادمین پیام بفرستد:', err.message);
          }
        }, 2000);
      }
    });
    
    // مدیریت خطاهای سرور
    server.on('error', (err) => {
      console.error('❌ خطای سرور:', err.message);
      if (err.code === 'EADDRINUSE') {
        console.log('🔄 تلاش برای پورت دیگر...');
        const altPort = parseInt(PORT) + 1;
        server = app.listen(altPort, '0.0.0.0', () => {
          console.log(`✅ سرور روی پورت ${altPort} راه‌اندازی شد`);
        });
      }
    });
    
  } catch (err) {
    console.error('❌ خطا در راه‌اندازی سرور:', err.message, err.stack);
    process.exit(1);
  }
}

// ==================== Graceful Shutdown ====================
async function gracefulShutdown() {
  console.log('🛑 در حال خاموش کردن ربات...');
  
  //try {
   // console.log('🗑️ حذف Webhook...');
   // await bot.deleteWebHook();
 //   console.log('✅ Webhook حذف شد.');
//  } catch (err) {
//    console.error('❌ خطا در حذف Webhook:', err.message);  
 // }
  
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
}

// ==================== Error Handlers ====================
process.on('SIGTERM', () => {
  console.log('📡 دریافت SIGTERM - خاموش کردن تمیز...');
  gracefulShutdown().finally(() => {
    console.log('✅ خاموش‌سازی کامل شد');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📡 دریافت SIGINT - خاموش کردن تمیز...');
  gracefulShutdown().finally(() => {
    console.log('✅ خاموش‌سازی کامل شد');
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message, error.stack);
  gracefulShutdown().then(() => {
    process.exit(1);
  });
});

bot.on('error', (err) => {
  console.error('❌ خطای Telegram Bot:', err.message);
});

// ==================== Start the Server ====================
startServer();