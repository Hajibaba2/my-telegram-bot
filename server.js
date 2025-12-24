// server.js

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import axios from 'axios';

// ---------- تنظیمات ----------
const TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const AI_API_KEY = 'YOUR_OPENAI_API_KEY';
const PORT = process.env.PORT || 3000;

// ---------- دیتابیس ----------
let db;
(async () => {
  db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT,
      username TEXT,
      name TEXT,
      age TEXT,
      city TEXT,
      job TEXT,
      goal TEXT
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT,
      username TEXT,
      message TEXT
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS vip_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT,
      username TEXT,
      payment_status TEXT
    )
  `);
})();

// ---------- بات تلگرام ----------
const bot = new TelegramBot(TOKEN, { polling: true });

// ---------- منوی کاربر ----------
function userMenu(userRegistered = false) {
  return {
    reply_markup: {
      keyboard: [
        ['💬 ارسال پیام به ادمین', '🤖 هوش مصنوعی'],
        ['📢 کانال رایگان', '💎 عضویت VIP'],
        [userRegistered ? '✏️ ویرایش اطلاعات' : '📝 ثبت نام']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

// ---------- استارت ----------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username ? '@' + msg.from.username : '';
  const user = await db.get(`SELECT * FROM users WHERE telegram_id = ?`, [chatId]);

  bot.sendMessage(chatId, `سلام! به ربات خوش آمدید. منو را مشاهده کنید:`, userMenu(!!user));
});

// ---------- مدیریت منو ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const username = msg.from.username ? '@' + msg.from.username : '';

  // بررسی ثبت نام
  let user = await db.get(`SELECT * FROM users WHERE telegram_id = ?`, [chatId]);

  // ---------- ثبت نام / ویرایش ----------
  if (text === '📝 ثبت نام' || text === '✏️ ویرایش اطلاعات') {
    bot.sendMessage(chatId, `لطفاً نام خود را وارد کنید:`);
    bot.once('message', async (nameMsg) => {
      const name = nameMsg.text;

      bot.sendMessage(chatId, `سن خود را وارد کنید:`);
      bot.once('message', async (ageMsg) => {
        const age = ageMsg.text;

        bot.sendMessage(chatId, `شهر خود را وارد کنید:`);
        bot.once('message', async (cityMsg) => {
          const city = cityMsg.text;

          bot.sendMessage(chatId, `شغل خود را وارد کنید:`);
          bot.once('message', async (jobMsg) => {
            const job = jobMsg.text;

            bot.sendMessage(chatId, `هدف خود را وارد کنید:`);
            bot.once('message', async (goalMsg) => {
              const goal = goalMsg.text;

              if (user) {
                await db.run(
                  `UPDATE users SET name=?, age=?, city=?, job=?, goal=?, username=? WHERE telegram_id=?`,
                  [name, age, city, job, goal, username, chatId]
                );
              } else {
                await db.run(
                  `INSERT INTO users (telegram_id, username, name, age, city, job, goal) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [chatId, username, name, age, city, job, goal]
                );
              }

              bot.sendMessage(chatId, `✅ ثبت نام شما با موفقیت انجام شد.`, userMenu(true));

              // ---------- گزارش کامل ثبت نام به ادمین ----------
              const adminId = 'YOUR_ADMIN_TELEGRAM_ID';
              bot.sendMessage(adminId, `
🆔 کاربر جدید:
Username: ${username}
نام: ${name}
سن: ${age}
شهر: ${city}
شغل: ${job}
هدف: ${goal}
              `);
            });
          });
        });
      });
    });
    return;
  }

  // ---------- ارسال پیام به ادمین ----------
  if (text === '💬 ارسال پیام به ادمین') {
    bot.sendMessage(chatId, `پیام خود را ارسال کنید:`);
    bot.once('message', async (userMsg) => {
      const message = userMsg.text;
      await db.run(
        `INSERT INTO messages (telegram_id, username, message) VALUES (?, ?, ?)`,
        [chatId, username, message]
      );
      const adminId = 'YOUR_ADMIN_TELEGRAM_ID';
      bot.sendMessage(adminId, `پیام جدید از ${username}:\n\n${message}`);
      bot.sendMessage(chatId, `پیام شما با موفقیت ارسال شد.`);
    });
    return;
  }

  // ---------- هوش مصنوعی ----------
  if (text === '🤖 هوش مصنوعی') {
    bot.sendMessage(chatId, `سوالی دارید؟`);
    bot.once('message', async (aiMsg) => {
      const question = aiMsg.text;
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: question }]
          },
          {
            headers: { 'Authorization': `Bearer ${AI_API_KEY}` }
          }
        );
        const answer = response.data.choices[0].message.content;
        bot.sendMessage(chatId, answer);
      } catch (e) {
        bot.sendMessage(chatId, `خطا در اتصال به هوش مصنوعی.`);
      }
    });
    return;
  }

  // ---------- کانال رایگان ----------
  if (text === '📢 کانال رایگان') {
    bot.sendMessage(chatId, `📌 لینک کانال رایگان: https://t.me/freechannel`);
    return;
  }

  // ---------- عضویت VIP ----------
  if (text === '💎 عضویت VIP') {
    bot.sendMessage(chatId, `برای عضویت VIP لطفاً مبلغ را به آدرس کریپتو ارسال کرده و رسید را بفرستید.`);
    return;
  }
});

// ---------- سرور اکسپرس ----------
const app = express();
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));