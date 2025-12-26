const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
const express = require('express');
const { OpenAI } = require('openai');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;

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

const bot = new TelegramBot(BOT_TOKEN);
let openai = null;
const states = {};

// ================== KEYBOARD HELPERS ==================
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

function mainKeyboard(registered, admin) {
  const k = [
    [{ text: '📺 کانال رایگان' }, { text: '💎 عضویت VIP' }],
    [{ text: '💬 ارسال پیام به کانیا' }, { text: '🤖 چت با هوش مصنوعی' }],
    [{ text: registered ? '✏️ ویرایش اطلاعات' : '📝 ثبت‌نام' }],
    [{ text: '📊 آمار من' }]
  ];
  if (admin) k.push([{ text: '🛡️ پنل ادمین' }]);
  return createReplyKeyboard(k, { placeholder: 'گزینه مورد نظر را انتخاب کنید' });
}

function adminKeyboard() {
  return createReplyKeyboard([
    [{ text: '🤖 هوش مصنوعی' }, { text: '📺 کانال‌ها' }],
    [{ text: '👥 کاربران' }, { text: '📨 پیامرسانی' }],
    [{ text: '📊 آمار' }, { text: '🔄 ریست دیتابیس' }],
    [{ text: '↩️ بازگشت به منو اصلی' }]
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

function backKeyboard() {
  return createReplyKeyboard([[{ text: '↩️ بازگشت' }]], { one_time: true });
}

// ================== DATABASE SETUP ==================
async function createTables() {
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
        score INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        ai_token TEXT,
        free_channel TEXT,
        vip_channel TEXT,
        membership_fee VARCHAR(100),
        wallet_address TEXT,
        network TEXT,
        prompt_content TEXT
      );
    `);
    await pool.query(`INSERT INTO settings(id) VALUES(1) ON CONFLICT DO NOTHING;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS broadcast_messages (
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
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_messages (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        message_text TEXT,
        media_type VARCHAR(50),
        media_file_id TEXT,
        is_from_user BOOLEAN DEFAULT TRUE,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_chats (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        user_question TEXT,
        ai_response TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('تمام جدول‌ها آماده شدند.');
  } catch (err) {
    console.error('خطا در ساخت جدول‌ها:', err.message);
  }
}

async function addScore(id, points) {
  try {
    await pool.query(
      'UPDATE users SET score = COALESCE(score,0)+$1, level = FLOOR((COALESCE(score,0)+$1)/50)+1 WHERE telegram_id=$2',
      [points, id]
    );
  } catch (err) {
    console.error('خطا در اضافه کردن امتیاز:', err.message);
  }
}

async function isVip(id) {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM vips WHERE telegram_id=$1 AND approved AND end_date>NOW()',
      [id]
    );
    return rows.length>0;
  } catch {
    return false;
  }
}

async function isRegistered(id) {
  try {
    const { rows } = await pool.query('SELECT name FROM users WHERE telegram_id=$1', [id]);
    return rows.length>0 && rows[0].name!=null;
  } catch {
    return false;
  }
}

async function downloadFile(fileId) {
  try {
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('دانلود ناموفق');
    return await res.text();
  } catch (err) {
    console.error('خطا در دانلود فایل:', err.message);
    return null;
  }
}

// ================== BOT WEBHOOK ==================
app.post(`/bot${BOT_TOKEN}`, (req,res)=>{
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== GRACEFUL SHUTDOWN ==================
async function gracefulShutdown() {
  try{ await bot.stopPolling(); } catch {}
  try{ await bot.deleteWebHook(); } catch {}
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:',reason));
bot.on('error', err => console.error('Bot Error:',err.message));

// ================== BOT START ==================
app.listen(PORT, async ()=>{
  await createTables();

  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || process.env.RENDER_EXTERNAL_URL;
  if(domain && domain.trim()!==''){
    const webhookUrl = `https://${domain.trim()}/bot${BOT_TOKEN}`;
    try{ await bot.setWebHook(webhookUrl); console.log(`Webhook تنظیم شد: ${webhookUrl}`); } 
    catch(err){ console.error('خطا در تنظیم webhook, سوئیچ به polling:',err.message); bot.startPolling(); }
  } else { bot.startPolling(); }

  console.log('KaniaChatBot آماده است! 🚀');
});

// ================== BOT ON START ==================
bot.onText(/\/start/, async msg=>{
  const id = msg.chat.id;
  const username = msg.from.username?`@${msg.from.username}`:null;
  await pool.query(
    'INSERT INTO users(telegram_id,username) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username',
    [id,username]
  );
  const registered = await isRegistered(id);
  const admin = id===ADMIN_CHAT_ID;
  bot.sendMessage(id,'🌟 به ربات KaniaChatBot خوش آمدید! 🌟\nلطفاً از منو استفاده کنید 👇', mainKeyboard(registered, admin));
});

// ================== MESSAGE HANDLER ==================
bot.on('message', async msg=>{
  const id = msg.chat.id;
  const text = msg.text || '';
  const admin = id===ADMIN_CHAT_ID;

  if(states[id]) await handleState(id,text,msg);
});

// ================== HANDLE STATE FUNCTION ==================
async function handleState(id,text,msg){
  const state = states[id];
  if(!state) return;
  const admin = id===ADMIN_CHAT_ID;

  try{
    // ========= AI CHAT =========
    if(state.type==='ai_chat'){
      if(text==='↩️ بازگشت'){ delete states[id]; bot.sendMessage(id,'↩️ چت با هوش مصنوعی بسته شد.', mainKeyboard(true, admin)); return; }
      const vip = await isVip(id);
      const { rows: usedRows } = await pool.query('SELECT ai_questions_used FROM users WHERE telegram_id=$1',[id]);
      const used = usedRows[0]?.ai_questions_used || 0;
      if(!vip && used>=5){ bot.sendMessage(id,'⚠️ تعداد سوالات رایگان شما تمام شد.', mainKeyboard(true,admin)); delete states[id]; return; }

      const { rows } = await pool.query('SELECT ai_token,prompt_content FROM settings');
      if(!rows[0]?.ai_token){ bot.sendMessage(id,'⚠️ هوش مصنوعی تنظیم نشده است.',mainKeyboard(true,admin)); delete states[id]; return; }
      if(!openai) openai = new OpenAI({apiKey:rows[0].ai_token});
      const messages = rows[0].prompt_content? [{role:'system',content:rows[0].prompt_content}]:[];
      messages.push({role:'user',content:text});
      try{
        const res = await openai.chat.completions.create({model:'gpt-3.5-turbo',messages});
        const reply = res.choices[0].message.content||'پاسخی دریافت نشد.';
        bot.sendMessage(id,reply,backKeyboard());
        await pool.query('UPDATE users SET ai_questions_used=ai_questions_used+1 WHERE telegram_id=$1',[id]);
        await pool.query('INSERT INTO ai_chats(telegram_id,user_question,ai_response) VALUES($1,$2,$3)',[id,text,reply]);
        await addScore(id,3);
      }catch(err){ bot.sendMessage(id,'❌ خطا در ارتباط با هوش مصنوعی.',mainKeyboard(true,admin)); delete states[id]; }
      return;
    }

    // ========= BROADCAST =========
    if(state.type==='broadcast_target'){
      const targetType = state.target;
      let usersQuery='';
      if(targetType==='all') usersQuery='SELECT telegram_id FROM users';
      else if(targetType==='normal') usersQuery='SELECT u.telegram_id FROM users u LEFT JOIN vips v ON u.telegram_id=v.telegram_id WHERE v.telegram_id IS NULL';
      else if(targetType==='vip') usersQuery='SELECT u.telegram_id FROM users u JOIN vips v ON u.telegram_id=v.telegram_id WHERE v.approved AND v.end_date>NOW()';
      const res = await pool.query(usersQuery);
      const recipients = res.rows.map(r=>r.telegram_id);

      let mediaType=null, mediaFileId=null, caption=null;
      if(msg.photo){ mediaType='photo'; mediaFileId=msg.photo[msg.photo.length-1].file_id; caption=msg.caption||text; }
      else if(msg.document){ mediaType='document'; mediaFileId=msg.document.file_id; caption=msg.caption||text; }
      const messageText = mediaType?caption:text;

      let sentCount=0, failedCount=0;
      for(const uid of recipients){
        try{
          if(mediaType==='photo') await bot.sendPhoto(uid,mediaFileId,{caption});
          else if(mediaType==='document') await bot.sendDocument(uid,mediaFileId,{caption});
          else await bot.sendMessage(uid,messageText);
          sentCount++;
        }catch(err){ failedCount++; console.error('خطا در ارسال broadcast:',err.message);}
      }

      await pool.query('INSERT INTO broadcast_messages(admin_id,target_type,message_text,media_type,media_file_id,caption,sent_count,failed_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id,targetType,messageText,mediaType,mediaFileId,caption,sentCount,failedCount]
      );
      bot.sendMessage(id,`✅ ارسال انجام شد!\nموفق: ${sentCount}\nناموفق: ${failedCount}`,adminKeyboard());
      delete states[id];
      return;
    }

  }catch(err){ console.error('خطا در handleState:',err.message); bot.sendMessage(id,'❌ خطای داخلی رخ داد.'); delete states[id]; }
}

console.log('KaniaChatBot — نسخه نهایی، آماده اجرا 🚀');