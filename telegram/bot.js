// backend/telegram/bot.js
// ------------------------------------------------------------------
// Telegram bot moduli.
// Vazifasi: belgilangan Telegram guruhiga (TELEGRAM_GROUP_ID) tovar
// sotilgani, o'chirilgani va boshqa hodisalar haqida chiroyli formatda
// xabar yuborish. Shu bilan birga, admin guruhga botni qo'shgach,
// guruhda "/chatid" buyrug'ini yuborsa, bot o'sha guruhning chat_id
// raqamini javob qilib yuboradi - shu raqamni .env faylidagi
// TELEGRAM_GROUP_ID ga qo'yish kerak bo'ladi.
// ------------------------------------------------------------------

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;

let bot = null;

if (BOT_TOKEN) {
    // MUHIM: polling: false qilib qo'yilgan (guruhdagi xabarlarni "tinglamaydi").
    // Sabab: agar shu bot tokeni boshqa bir serverda/eski loyihada allaqachon
    // polling yoki webhook rejimida ishlab turgan bo'lsa, bitta tokenga bir vaqtda
    // 2 ta polling ulanish taqiqlangan (Telegram "409 Conflict" xatosini beradi).
    // Bizga polling shart emas - chunki bot faqat guruhga xabar YUBORADI,
    // guruhdan xabar o'qishi kerak emas.
    bot = new TelegramBot(BOT_TOKEN, { polling: false });

    console.log('🤖 Telegram bot tayyor (faqat xabar yuborish rejimi, polling o\'chirilgan).');
} else {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN topilmadi. Telegram bildirishnomalari o\'chirilgan holda ishlaydi.');
}

/**
 * Belgilangan Telegram guruhiga xabar yuboradi.
 * @param {string} message - HTML formatidagi xabar matni
 * @returns {Promise<boolean>} - xabar yuborilgan bo'lsa true, aks holda false
 */
const notifyGroup = async (message) => {
    if (!bot || !GROUP_ID) {
        console.warn('⚠️  Telegramga xabar yuborilmadi (bot yoki GROUP_ID sozlanmagan).');
        return false;
    }

    try {
        await bot.sendMessage(GROUP_ID, message, { parse_mode: 'HTML' });
        return true;
    } catch (err) {
        console.error('❌ Telegramga xabar yuborishda xatolik:', err.message);
        return false;
    }
};

module.exports = { bot, notifyGroup };