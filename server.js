// server.js
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');

// ======== CONFIG ========
const TOKEN = 'YOUR_BOT_TOKEN';
const ADMIN_ID = 123456789; // Telegram ID ادمین
const FREE_CHANNEL = 'https://t.me/free_channel';
const VIP_CHANNEL = 'https://t.me/vip_channel';
const VIP_PRICE_TEXT = 'لطفاً مبلغ X را به آدرس Y منتقل کنید و رسید را ارسال کنید.';

// ======== POSTGRES POOL ========
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'telegram_bot',
  password: 'postgres',
  port: 5432,
});

// ======== CREATE TABLES IF NOT EXISTS ========
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      username TEXT,
      name TEXT,
      age TEXT,
      city TEXT,
      job TEXT,
      goal TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_requests (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      username TEXT,
      status TEXT DEFAULT 'pending',
      receipt TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      username TEXT,
      message TEXT
    );
  `);
})();

// ======== BOT ========
const bot = new TelegramBot(TOKEN, { polling: true });

// ======== HELPER FUNCTIONS ========
function getPersianDate() {
  return moment().tz('Asia/Tehran').format('jYYYY/jMM/jDD HH:mm');
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ['💬 ارسال پیام به ادمین', '🤖 هوش مصنوعی'],
        ['📢 کانال رایگان', '🌟 عضویت VIP'],
        ['📝 ثبت نام / ✏️ ویرایش اطلاعات'],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

async function getUser(telegram_id) {
  const res = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [telegram_id]);
  return res.rows[0];
}

// ======== HANDLERS ========
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  let user = await getUser(chatId);
  if (!user) {
    await bot.sendMessage(chatId, `سلام! 👋\nشما هنوز ثبت‌نام نکرده‌اید. می‌توانید با انتخاب "📝 ثبت نام / ✏️ ویرایش اطلاعات" ثبت‌نام کنید.`, mainMenu());
  } else {
    await bot.sendMessage(chatId, `سلام ${user.name || ''} 👋\nبه ربات خوش آمدید!`, mainMenu());
  }
});

// ======== MENU BUTTONS ========
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  let user = await getUser(chatId);

  // ثبت نام / ویرایش
  if (text === '📝 ثبت نام / ✏️ ویرایش اطلاعات') {
    if (!user) {
      bot.sendMessage(chatId, 'لطفاً نام خود را وارد کنید:');
      bot.once('message', async (m1) => {
        const name = m1.text;
        bot.sendMessage(chatId, 'سن خود را وارد کنید:');
        bot.once('message', async (m2) => {
          const age = m2.text;
          bot.sendMessage(chatId, 'شهر خود را وارد کنید:');
          bot.once('message', async (m3) => {
            const city = m3.text;
            bot.sendMessage(chatId, 'شغل خود را وارد کنید:');
            bot.once('message', async (m4) => {
              const job = m4.text;
              bot.sendMessage(chatId, 'هدف خود را وارد کنید:');
              bot.once('message', async (m5) => {
                const goal = m5.text;
                const username = msg.from.username || '';
                await pool.query(
                  'INSERT INTO users (telegram_id, username, name, age, city, job, goal) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                  [chatId, username, name, age, city, job, goal]
                );
                bot.sendMessage(chatId, '✅ ثبت‌نام با موفقیت انجام شد.', mainMenu());

                // گزارش کامل ثبت نام به ادمین
                bot.sendMessage(
                  ADMIN_ID,
                  `📝 ثبت‌نام کاربر جدید\n👤 نام: ${name}\n🎂 سن: ${age}\n🏙 شهر: ${city}\n💼 شغل: ${job}\n🎯 هدف: ${goal}\n@${username}\n🕒 ${getPersianDate()}`
                );
              });
            });
          });
        });
      });
    } else {
      bot.sendMessage(chatId, 'ویرایش اطلاعات:');
      bot.sendMessage(chatId, 'لطفاً نام خود را وارد کنید:');
      bot.once('message', async (m1) => {
        const name = m1.text;
        bot.sendMessage(chatId, 'سن خود را وارد کنید:');
        bot.once('message', async (m2) => {
          const age = m2.text;
          bot.sendMessage(chatId, 'شهر خود را وارد کنید:');
          bot.once('message', async (m3) => {
            const city = m3.text;
            bot.sendMessage(chatId, 'شغل خود را وارد کنید:');
            bot.once('message', async (m4) => {
              const job = m4.text;
              bot.sendMessage(chatId, 'هدف خود را وارد کنید:');
              bot.once('message', async (m5) => {
                const goal = m5.text;
                await pool.query(
                  'UPDATE users SET name=$1, age=$2, city=$3, job=$4, goal=$5 WHERE telegram_id=$6',
                  [name, age, city, job, goal, chatId]
                );
                bot.sendMessage(chatId, '✅ اطلاعات با موفقیت ویرایش شد.', mainMenu());

                // گزارش ویرایش به ادمین
                bot.sendMessage(
                  ADMIN_ID,
                  `✏️ ویرایش اطلاعات کاربر\n👤 نام: ${name}\n🎂 سن: ${age}\n🏙 شهر: ${city}\n💼 شغل: ${job}\n🎯 هدف: ${goal}\n@${user.username}\n🕒 ${getPersianDate()}`
                );
              });
            });
          });
        });
      });
    }
  }

  // ارسال پیام به ادمین
  else if (text === '💬 ارسال پیام به ادمین') {
    bot.sendMessage(chatId, 'پیام خود را وارد کنید:');
    bot.once('message', async (m) => {
      const msgText = m.text;
      const username = msg.from.username || '';
      await pool.query(
        'INSERT INTO messages (telegram_id, username, message) VALUES ($1,$2,$3)',
        [chatId, username, msgText]
      );
      bot.sendMessage(chatId, '✅ پیام شما برای ادمین ارسال شد.', mainMenu());
      bot.sendMessage(ADMIN_ID, `💬 پیام از کاربر\n@${username}\n${msgText}\n🕒 ${getPersianDate()}`);
    });
  }

  // هوش مصنوعی
  else if (text === '🤖 هوش مصنوعی') {
    bot.sendMessage(chatId, 'سوال خود را برای هوش مصنوعی وارد کنید:');
    bot.once('message', async (m) => {
      const question = m.text;
      // پاسخ هوش مصنوعی (مثال ساده)
      const answer = `💡 پاسخ به سوال شما: ${question}`;
      bot.sendMessage(chatId, answer, mainMenu());
    });
  }

  // کانال رایگان
  else if (text === '📢 کانال رایگان') {
    bot.sendMessage(chatId, `📢 کانال رایگان: ${FREE_CHANNEL}`, mainMenu());
  }

  // عضویت VIP
  else if (text === '🌟 عضویت VIP') {
    bot.sendMessage(chatId, `🌟 عضویت VIP\n${VIP_PRICE_TEXT}\nلطفاً رسید را ارسال کنید:`);
    bot.once('message', async (m) => {
      const receipt = m.text;
      const username = msg.from.username || '';
      await pool.query(
        'INSERT INTO vip_requests (telegram_id, username, receipt) VALUES ($1,$2,$3)',
        [chatId, username, receipt]
      );
      bot.sendMessage(chatId, '✅ درخواست VIP شما ثبت شد. بعد از تایید ادمین، لینک کانال VIP ارسال خواهد شد.', mainMenu());
      bot.sendMessage(ADMIN_ID, `🌟 درخواست VIP\n@${username}\nرسید: ${receipt}\n🕒 ${getPersianDate()}`);
    });
  }
});