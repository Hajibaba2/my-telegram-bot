// server.js
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const moment = require('moment-jalaali');
moment.loadPersian({usePersianDigits:false});

// --- Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT
});

// --- ایجاد جدول‌ها ---
async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50),
      chat_id BIGINT UNIQUE,
      name VARCHAR(100),
      age INT,
      city VARCHAR(50),
      region VARCHAR(50),
      gender VARCHAR(20),
      job VARCHAR(50),
      goal TEXT,
      phone VARCHAR(20),
      vip_status BOOLEAN DEFAULT FALSE,
      vip_date TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_requests (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      payment_proof TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      message_text TEXT,
      is_answered BOOLEAN DEFAULT FALSE,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ جدول‌ها آماده شدند');
}
createTables().catch(console.error);

// --- توابع کمکی ---
function persianToEnglish(str){if(!str)return'';const map={'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};return str.replace(/[۰-۹]/g,w=>map[w]);}

// --- اتصال ربات ---
const bot = new TelegramBot(TOKEN, { polling: true });

// --- داده موقت ---
const userStates = {};
const userQuestions = {};

// --- منوها ---
const mainMenu = { reply_markup:{ keyboard:[['📺 کانال رایگان','💎 عضویت VIP'],['💬 چت با ادمین','🤖 چت با هوش مصنوعی'],['📝 ثبت‌نام / ✏️ ویرایش اطلاعات']], resize_keyboard:true, one_time_keyboard:false } };
const editMenu = { reply_markup:{ keyboard:[['📝 نام','🎂 سن'],['🏙️ شهر','📍 منطقه'],['⚧ جنسیت','💼 شغل'],['🎯 هدف','📞 شماره'],['↩️ بازگشت به منو اصلی']], resize_keyboard:true, one_time_keyboard:true } };
const vipMenu = { reply_markup:{ keyboard:[['💳 ارسال رسید','↩️ بازگشت به منو اصلی']], resize_keyboard:true, one_time_keyboard:true } };
const adminMenu = { reply_markup:{ keyboard:[['🤖 هوش مصنوعی','📺 کانال‌ها'],['👥 کاربران','📨 پیامرسانی'],['📊 آمار','🔄 راه‌اندازی دوباره ربات']], resize_keyboard:true, one_time_keyboard:true } };
const aiAdminMenu = { reply_markup:{ keyboard:[['⚙️ تنظیم توکن API','📂 ارسال فایل پرامپت'],['🗑️ حذف فایل پرامپت'],['↩️ بازگشت']], resize_keyboard:true, one_time_keyboard:true } };
const channelsAdminMenu = { reply_markup:{ keyboard:[['📺 لینک کانال رایگان','💎 لینک کانال VIP'],['💳 مبلغ عضویت','💰 آدرس کیف پول'],['🌐 شبکه انتقال'],['↩️ بازگشت']], resize_keyboard:true, one_time_keyboard:true } };
const usersAdminMenu = { reply_markup:{ keyboard:[['👤 لیست کاربران عادی','💎 لیست کاربران VIP'],['📊 آمار کاربران'],['📂 بایگانی پیام‌ها'],['↩️ بازگشت']], resize_keyboard:true, one_time_keyboard:true } };
const messagingAdminMenu = { reply_markup:{ keyboard:[['📨 پیام همگانی','📩 پیام کاربران عادی'],['💌 پیام کاربران VIP'],['📂 بایگانی پیام‌های ارسال شده'],['↩️ بازگشت']], resize_keyboard:true, one_time_keyboard:true } };

// --- شروع ربات ---
bot.onText(/\/start/, async(msg)=>{
  const chatId=msg.chat.id;
  const username=msg.from.username||msg.from.first_name;
  let res=await pool.query('SELECT * FROM users WHERE chat_id=$1',[chatId]);
  if(res.rows.length===0){
    userStates[chatId]={step:0,data:{username,chat_id:chatId}};
    bot.sendMessage(chatId,`👋 سلام ${username}!\nبه ربات 𝕂𝕒𝕟𝕚𝕒ℂ𝕙𝕒𝕥𝕓𝕠𝕥 خوش آمدی ✨\n\nبرای ادامه از گزینه‌های زیر استفاده کنید 👇`,mainMenu);
  }else{
    bot.sendMessage(chatId,`🌸 خوش برگشتی ${username}!\nاز منوی زیر می‌تونی ادامه بدی 👇`,mainMenu);
  }
});

// --- مدیریت پیام‌ها ---
bot.on('message',async(msg)=>{
  const chatId=msg.chat.id; const text=msg.text; if(text==='/start') return;

  // --- ادمین ---
  if(chatId===ADMIN_CHAT_ID){
    if(text.startsWith('🛡️ ادمین')){ bot.sendMessage(chatId,'✅ منوی ادمین فعال شد:',adminMenu); return; }
    if(text==='↩️ بازگشت'){ bot.sendMessage(chatId,'🔙 منوی اصلی ادمین:',adminMenu); return; }
    if(text==='🤖 هوش مصنوعی'){ bot.sendMessage(chatId,'⚡ منوی هوش مصنوعی:',aiAdminMenu); return; }
    if(text==='📺 کانال‌ها'){ bot.sendMessage(chatId,'📌 منوی کانال‌ها:',channelsAdminMenu); return; }
    if(text==='👥 کاربران'){ bot.sendMessage(chatId,'👤 منوی کاربران:',usersAdminMenu); return; }
    if(text==='📨 پیامرسانی'){ bot.sendMessage(chatId,'✉️ منوی پیامرسانی:',messagingAdminMenu); return; }
    if(text==='📊 آمار'){
      const total=await pool.query('SELECT COUNT(*) FROM users');
      const vip=await pool.query('SELECT COUNT(*) FROM users WHERE vip_status=true');
      bot.sendMessage(chatId,`📊 آمار کاربران:\n👤 کل کاربران: ${total.rows[0].count}\n💎 کاربران VIP: ${vip.rows[0].count}`);
      return;
    }
    if(text==='🔄 راه‌اندازی دوباره ربات'){ bot.sendMessage(chatId,'🔄 ربات در حال راه‌اندازی دوباره است...'); process.exit(0); return; }
  }

  // --- ثبت‌نام مرحله‌ای ---
  if(userStates[chatId] && typeof userStates[chatId].step==='number'){
    let state=userStates[chatId]; let step=state.step; let data=state.data;
    switch(step){
      case 0: bot.sendMessage(chatId,'📝 لطفاً نام خود را وارد کنید:'); state.step++; break;
      case 1: data.name=text; bot.sendMessage(chatId,'🎂 لطفاً سن خود را وارد کنید:'); state.step++; break;
      case 2: data.age=parseInt(persianToEnglish(text))||0; bot.sendMessage(chatId,'🏙️ لطفاً شهر خود را وارد کنید:'); state.step++; break;
      case 3: data.city=text; bot.sendMessage(chatId,'📍 لطفاً منطقه زندگی خود را وارد کنید:'); state.step++; break;
      case 4: data.gender=text; bot.sendMessage(chatId,'💼 لطفاً شغل خود را وارد کنید:'); state.step++; break;
      case 5: data.job=text; bot.sendMessage(chatId,'🎯 لطفاً هدف خود را از ورود به ربات وارد کنید:'); state.step++; break;
      case 6: data.goal=text; bot.sendMessage(chatId,'📞 لطفاً شماره تماس خود را وارد کنید (اختیاری، رد کردن = 0):'); state.step++; break;
      case 7:
        data.phone=text||'0';
        await pool.query(`INSERT INTO users (username,chat_id,name,age,city,region,gender,job,goal,phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (chat_id) DO UPDATE SET name=$3,age=$4,city=$5,region=$6,gender=$7,job=$8,goal=$9,phone=$10`,[data.username,data.chat_id,data.name,data.age,data.city,data.region,data.gender,data.job,data.goal,data.phone]);
        bot.sendMessage(chatId,'✅ ثبت‌نام شما با موفقیت انجام شد!',mainMenu);
        const report=`📋 ثبت‌نام جدید:\n👤 یوزرنیم: @${data.username}\n📝 نام: ${data.name}\n🎂 سن: ${data.age}\n🏙️ شهر: ${data.city}\n📍 منطقه: ${data.region}\n⚧ جنسیت: ${data.gender}\n💼 شغل: ${data.job}\n🎯 هدف: ${data.goal}\n📞 شماره: ${data.phone}\n🕒 زمان: ${moment().format('jYYYY/jMM/jDD HH:mm')}`;
        bot.sendMessage(ADMIN_CHAT_ID,report);
        delete userStates[chatId]; break;
    }
    return;
  }

  // --- ویرایش اطلاعات ---
  if(text==='📝 ثبت‌نام / ✏️ ویرایش اطلاعات'){
    let res=await pool.query('SELECT * FROM users WHERE chat_id=$1',[chatId]);
    if(res.rows.length===0){bot.sendMessage(chatId,'❌ شما هنوز ثبت‌نام نکرده‌اید! لطفاً ابتدا ثبت‌نام کنید.',mainMenu); return;}
    userStates[chatId]={step:'edit',data:res.rows[0]}; bot.sendMessage(chatId,'🔹 فیلد موردنظر برای ویرایش را انتخاب کنید:',editMenu); return;
  }
  if(userStates[chatId] && userStates[chatId].step==='edit'){
    const fieldsMap={'📝 نام':'name','🎂 سن':'age','🏙️ شهر':'city','📍 منطقه':'region','⚧ جنسیت':'gender','💼 شغل':'job','🎯 هدف':'goal','📞 شماره':'phone'};
    if(text==='↩️ بازگشت به منو اصلی'){delete userStates[chatId]; bot.sendMessage(chatId,'🔙 بازگشت به منوی اصلی',mainMenu); return;}
    const field=fieldsMap[text]; if(!field) return;
    userStates[chatId].fieldEditing=field; bot.sendMessage(chatId,`✏️ مقدار جدید برای ${text} را وارد کنید (مقدار قبلی: ${userStates[chatId].data[field]})`);
    userStates[chatId].step='edit_input'; return;
  }
  if(userStates[chatId] && userStates[chatId].step==='edit_input'){
    const field=userStates[chatId].fieldEditing; let newValue=text;
    if(field==='age') newValue=parseInt(persianToEnglish(text))||0;
    if(field==='phone' && !newValue) newValue='0';
    const oldValue=userStates[chatId].data[field];
    await pool.query(`UPDATE users SET ${field}=$1 WHERE chat_id=$2`,[newValue,chatId]);
    const report=`📝 ویرایش اطلاعات:\n👤 @${userStates[chatId].data.username}\n⚡ فیلد ${field}: ${oldValue} → ${newValue}\n🕒 زمان: ${moment().format('jYYYY/jMM/jDD HH:mm')}`;
    bot.sendMessage(ADMIN_CHAT_ID,report);
    delete userStates[chatId].fieldEditing; userStates[chatId].step='edit'; bot.sendMessage(chatId,`✅ فیلد ${field} با موفقیت ویرایش شد!`,editMenu); return;
  }

  // --- مدیریت VIP ---
  if(text==='💎 عضویت VIP'){bot.sendMessage(chatId,'💎 برای عضویت VIP لطفاً مبلغ 10 USDT به آدرس زیر واریز کنید:\n\n🔹 آدرس کیف پول: `YOUR_WALLET_ADDRESS`\n🔹 شبکه: TRC20\n\nسپس روی دکمه زیر کلیک کنید:',vipMenu); return;}
  if(text==='💳 ارسال رسید'){userStates[chatId]={step:'vip_proof'}; bot.sendMessage(chatId,'📎 لطفاً رسید پرداخت خود را ارسال کنید (عکس یا متن):'); return;}
  if(userStates[chatId] && userStates[chatId].step==='vip_proof'){
    const proof=msg.photo?'عکس دریافت شد':text;
    await pool.query('INSERT INTO vip_requests (user_id,payment_proof) VALUES ((SELECT id FROM users WHERE chat_id=$1),$2)',[chatId,proof]);
    bot.sendMessage(chatId,'✅ رسید شما ثبت شد! پس از تایید ادمین، لینک VIP برای شما ارسال می‌شود.');
    bot.sendMessage(ADMIN_CHAT_ID,`💎 درخواست VIP از @${msg.from.username || msg.from.first_name}\n📎 رسید: ${proof}\n🕒 زمان: ${moment().format('jYYYY/jMM/jDD HH:mm')}`);
    delete userStates[chatId]; return;
  }

  // --- چت با ادمین ---
  if(text==='💬 چت با ادمین'){
    const res=await pool.query('SELECT * FROM users WHERE chat_id=$1',[chatId]);
    if(res.rows.length===0){bot.sendMessage(chatId,'❌ برای چت با ادمین ابتدا ثبت‌نام کنید.',mainMenu); return;}
    userStates[chatId]={step:'chat_admin'}; bot.sendMessage(chatId,'💬 پیام خود را به ادمین ارسال کنید:'); return;
  }
  if(userStates[chatId] && userStates[chatId].step==='chat_admin'){
    await pool.query('INSERT INTO messages (user_id,message_text) VALUES ((SELECT id FROM users WHERE chat_id=$1),$2)',[chatId,msg.text]);
    bot.sendMessage(ADMIN_CHAT_ID,`📩 پیام از @${msg.from.username || msg.from.first_name}:\n${msg.text}\n🕒 ${moment().format('jYYYY/jMM/jDD HH:mm')}\n🔘 برای پاسخ، روی /reply_${chatId} کلیک کنید`);
    bot.sendMessage(chatId,'✅ پیام شما برای ادمین ارسال شد!'); delete userStates[chatId]; return;
  }
  if(chatId===ADMIN_CHAT_ID && text.startsWith('/reply_')){
    const targetId=parseInt(text.split('_')[1]);
    userStates[ADMIN_CHAT_ID]={step:'reply',target:targetId}; bot.sendMessage(chatId,'✏️ پیام خود را برای کاربر وارد کنید:'); return;
  }
  if(userStates[ADMIN_CHAT_ID] && userStates[ADMIN_CHAT_ID].step==='reply' && chatId===ADMIN_CHAT_ID){
    const targetId=userStates[ADMIN_CHAT_ID].target;
    bot.sendMessage(targetId,`📬 پاسخ ادمین:\n${text}`);
    bot.sendMessage(ADMIN_CHAT_ID,'✅ پاسخ ارسال شد.'); delete userStates[ADMIN_CHAT_ID]; return;
  }

  // --- چت با AI 🤖 ---
  if(text==='🤖 چت با هوش مصنوعی'){
    const res=await pool.query('SELECT vip_status FROM users WHERE chat_id=$1',[chatId]);
    if(res.rows.length===0){bot.sendMessage(chatId,'❌ لطفاً ابتدا ثبت‌نام کنید.',mainMenu); return;}
    const vip=res.rows[0].vip_status;
    if(!vip){userQuestions[chatId]=userQuestions[chatId]||0; if(userQuestions[chatId]>=5){bot.sendMessage(chatId,'❌ شما به سقف سوالات رایگان رسیدید.\n💎 برای سوالات نامحدود، VIP شوید.',mainMenu); return;} userQuestions[chatId]++;}
    bot.sendMessage(chatId,'🤖 لطفاً سوال خود را وارد کنید:'); userStates[chatId]={step:'ai'}; return;
  }
  if(userStates[chatId] && userStates[chatId].step==='ai'){const answer=`💡 پاسخ هوش مصنوعی (نمونه): ${msg.text}`; bot.sendMessage(chatId,answer); delete userStates[chatId]; return;}
});
